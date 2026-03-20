#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "httpx>=0.28.1",
# ]
# ///
"""Transcribe audio using a whisper.cpp HTTP server.

Outputs structured JSON for agent use.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import httpx

DEFAULT_SERVER = "http://lptr:8082/inference"

MIME_TYPES: dict[str, str] = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".opus": "audio/ogg",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".webm": "audio/webm",
}


def fail(message: str, **extra: object) -> dict:
    payload = {"ok": False, "error": message}
    payload.update(extra)
    return payload


def transcribe(
    audio_file: Path,
    response_format: str,
    temperature: float,
    temperature_inc: float,
    server_url: str,
    timeout_seconds: int,
) -> dict:
    if not audio_file.exists() or not audio_file.is_file():
        return fail("Audio file not found.", audio_file=str(audio_file))

    ext = audio_file.suffix.lower()
    mime = MIME_TYPES.get(ext, "application/octet-stream")

    try:
        with audio_file.open("rb") as f, httpx.Client(timeout=timeout_seconds) as client:
            response = client.post(
                server_url,
                files={"file": (audio_file.name, f, mime)},
                data={
                    "temperature": str(temperature),
                    "temperature_inc": str(temperature_inc),
                    "response_format": response_format,
                },
            )
    except httpx.ConnectError:
        return fail(
            "Could not connect to whisper.cpp server.",
            server_url=server_url,
            hint="Verify whisper.cpp server is reachable and running.",
        )
    except httpx.TimeoutException:
        return fail(
            "Transcription request timed out.",
            server_url=server_url,
            timeout_seconds=timeout_seconds,
        )
    except Exception as exc:
        return fail("Unexpected request error.", details=str(exc), server_url=server_url)

    if response.status_code != 200:
        return fail(
            "whisper.cpp server returned non-200 response.",
            status_code=response.status_code,
            response_text=response.text,
            server_url=server_url,
        )

    text = ""
    raw = None
    if response_format == "json":
        try:
            raw = response.json()
            text = raw.get("text", "") if isinstance(raw, dict) else ""
        except Exception:
            raw = {"parse_error": "Failed to parse JSON response.", "body": response.text}
    else:
        text = response.text

    return {
        "ok": True,
        "audio_file": str(audio_file),
        "server_url": server_url,
        "response_format": response_format,
        "temperature": temperature,
        "temperature_inc": temperature_inc,
        "mime_type": mime,
        "text": text,
        "raw": raw,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Transcribe audio with whisper.cpp")
    parser.add_argument("audio_file", help="Path to audio file")
    parser.add_argument(
        "--server-url",
        default=os.environ.get("WHISPER_CPP_URL", DEFAULT_SERVER),
        help=f"Whisper.cpp inference endpoint (default: {DEFAULT_SERVER})",
    )
    parser.add_argument(
        "--format",
        choices=["srt", "txt", "vtt", "json"],
        default="txt",
        help="Output format returned by whisper.cpp (default: txt)",
    )
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--temperature-inc", type=float, default=0.2)
    parser.add_argument("--timeout", type=int, default=1200, help="Request timeout in seconds")

    args = parser.parse_args()

    result = transcribe(
        audio_file=Path(args.audio_file),
        response_format=args.format,
        temperature=args.temperature,
        temperature_inc=args.temperature_inc,
        server_url=args.server_url,
        timeout_seconds=args.timeout,
    )

    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
