#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "httpx>=0.28.1",
# ]
# ///
"""Transcribe YouTube videos with priority fallback:
1) Try YouTube subtitles via yt-dlp
2) Download audio via yt-dlp and transcribe via whisper.cpp server

By default, writes output to disk as SRT.
Outputs structured JSON for agent use.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import tempfile
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


def run_cmd(cmd: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True)


def _parse_video_id(url: str) -> str:
    patterns = [
        r"v=([A-Za-z0-9_-]{6,})",
        r"youtu\.be/([A-Za-z0-9_-]{6,})",
        r"youtube\.com/shorts/([A-Za-z0-9_-]{6,})",
    ]
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    return "youtube_transcript"


def _fmt_timestamp(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h = ms // 3_600_000
    m = (ms % 3_600_000) // 60_000
    s = (ms % 60_000) // 1000
    milli = ms % 1000
    return f"{h:02d}:{m:02d}:{s:02d},{milli:03d}"


def vtt_to_srt(vtt_content: str) -> str:
    lines = vtt_content.splitlines()
    out: list[str] = []
    idx = 1

    for line in lines:
        line = line.rstrip("\n")
        if not line.strip() or line.startswith("WEBVTT") or line.startswith("Kind:") or line.startswith("Language:"):
            continue

        if "-->" in line:
            # 00:00:01.000 --> 00:00:03.000 to comma format
            cue = re.sub(r"\.(\d{3})", r",\1", line)
            out.append(str(idx))
            out.append(cue)
            idx += 1
            continue

        # strip simple tags
        cleaned = re.sub(r"<[^>]+>", "", line).strip()
        if cleaned:
            out.append(cleaned)
            out.append("")

    return "\n".join(out).strip() + "\n"


def clean_vtt_to_text(vtt_content: str) -> str:
    text = re.sub(r"^WEBVTT.*$", "", vtt_content, flags=re.MULTILINE)
    text = re.sub(r"^Kind:.*$", "", text, flags=re.MULTILINE)
    text = re.sub(r"^Language:.*$", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\d+$", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}.*$", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}\.\d{3}.*$", "", text, flags=re.MULTILINE)
    text = re.sub(r"<[^>]+>", "", text)
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]

    deduped: list[str] = []
    prev = None
    for ln in lines:
        if ln != prev:
            deduped.append(ln)
        prev = ln
    return "\n".join(deduped)


def default_output_path(url: str, output_format: str) -> Path:
    vid = _parse_video_id(url)
    return Path.cwd() / f"{vid}.{output_format}"


def save_output(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def whisper_json_to_srt(payload: dict) -> str:
    segments = payload.get("segments") if isinstance(payload, dict) else None
    if not isinstance(segments, list):
        text = payload.get("text", "") if isinstance(payload, dict) else ""
        return f"1\n00:00:00,000 --> 00:00:10,000\n{text.strip()}\n"

    out: list[str] = []
    idx = 1
    for seg in segments:
        if not isinstance(seg, dict):
            continue
        start = float(seg.get("start", 0.0))
        end = float(seg.get("end", start + 2.0))
        txt = str(seg.get("text", "")).strip()
        if not txt:
            continue
        out.append(str(idx))
        out.append(f"{_fmt_timestamp(start)} --> {_fmt_timestamp(end)}")
        out.append(txt)
        out.append("")
        idx += 1
    return "\n".join(out).strip() + "\n"


def try_youtube_subtitles(url: str, tmp: Path, preferred_langs: str) -> dict:
    cmd = [
        "yt-dlp",
        "--skip-download",
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs",
        preferred_langs,
        "--sub-format",
        "srt/vtt",
        "-o",
        "%(id)s.%(ext)s",
        url,
    ]
    proc = run_cmd(cmd, tmp)
    if proc.returncode != 0:
        return fail("yt-dlp subtitle extraction failed.", stderr=proc.stderr.strip(), stdout=proc.stdout.strip())

    sub_files = sorted([*tmp.glob("*.srt"), *tmp.glob("*.vtt")])
    if not sub_files:
        return fail("No YouTube subtitle files found.")

    sub_files.sort(key=lambda p: (".en" not in p.name, p.suffix != ".srt", p.name))
    sub_file = sub_files[0]
    raw = sub_file.read_text(encoding="utf-8", errors="replace")

    if sub_file.suffix.lower() == ".srt":
        srt = raw
        text = re.sub(r"^\d+$", "", raw, flags=re.MULTILINE)
        text = re.sub(r"^\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}.*$", "", text, flags=re.MULTILINE)
        text = "\n".join([ln.strip() for ln in text.splitlines() if ln.strip()])
    else:
        srt = vtt_to_srt(raw)
        text = clean_vtt_to_text(raw)

    return {
        "ok": True,
        "source": "youtube_subtitles",
        "subtitle_file": str(sub_file),
        "text": text,
        "srt": srt,
    }


def transcribe_with_whisper(audio_file: Path, server_url: str, timeout_seconds: int, response_format: str) -> dict:
    ext = audio_file.suffix.lower()
    mime = MIME_TYPES.get(ext, "application/octet-stream")

    try:
        with audio_file.open("rb") as f, httpx.Client(timeout=timeout_seconds) as client:
            response = client.post(
                server_url,
                files={"file": (audio_file.name, f, mime)},
                data={
                    "temperature": "0.0",
                    "temperature_inc": "0.2",
                    "response_format": response_format,
                },
            )
    except httpx.ConnectError:
        return fail("Could not connect to whisper.cpp server.", server_url=server_url)
    except httpx.TimeoutException:
        return fail("whisper.cpp request timed out.", server_url=server_url, timeout_seconds=timeout_seconds)
    except Exception as exc:
        return fail("Unexpected whisper.cpp request error.", details=str(exc), server_url=server_url)

    if response.status_code != 200:
        return fail(
            "whisper.cpp server returned non-200 response.",
            status_code=response.status_code,
            response_text=response.text,
            server_url=server_url,
        )

    if response_format == "json":
        try:
            payload = response.json()
            text = payload.get("text", "") if isinstance(payload, dict) else ""
            return {"ok": True, "source": "whisper_cpp", "text": text, "raw": payload}
        except Exception:
            return {"ok": True, "source": "whisper_cpp", "text": response.text, "raw": None}

    return {"ok": True, "source": "whisper_cpp", "text": response.text, "raw": None}


def download_audio(url: str, tmp: Path) -> dict:
    cmd = [
        "yt-dlp",
        "-f",
        "bestaudio/best",
        "-x",
        "--audio-format",
        "mp3",
        "-o",
        "audio.%(ext)s",
        url,
    ]
    proc = run_cmd(cmd, tmp)
    if proc.returncode != 0:
        return fail("yt-dlp audio download failed.", stderr=proc.stderr.strip(), stdout=proc.stdout.strip())

    candidates = list(tmp.glob("audio.*"))
    audio_files = [p for p in candidates if p.suffix.lower() in MIME_TYPES]
    if not audio_files:
        return fail("Audio download completed but no supported file found.")

    audio_files.sort(key=lambda p: p.stat().st_size, reverse=True)
    audio_file = audio_files[0]
    return {"ok": True, "audio_file": str(audio_file)}


def main() -> int:
    parser = argparse.ArgumentParser(description="Transcribe YouTube with subtitle-first fallback")
    parser.add_argument("url", help="YouTube video URL")
    parser.add_argument("--preferred-langs", default="en.*,en", help="yt-dlp sub-langs value")
    parser.add_argument("--server-url", default=os.environ.get("WHISPER_CPP_URL", DEFAULT_SERVER))
    parser.add_argument("--whisper-format", choices=["txt", "srt", "vtt", "json"], default="srt")
    parser.add_argument("--save-to", help="Output file path (default: <video_id>.srt in current directory)")
    parser.add_argument("--timeout", type=int, default=1200)

    args = parser.parse_args()

    if shutil.which("yt-dlp") is None:
        print(json.dumps(fail("yt-dlp is not installed or not on PATH."), indent=2, ensure_ascii=False))
        return 1

    out_path = Path(args.save_to) if args.save_to else default_output_path(args.url, "srt")

    with tempfile.TemporaryDirectory(prefix="yt-transcribe-") as tmpdir:
        tmp = Path(tmpdir)

        # Priority 1: direct subtitles
        subs_result = try_youtube_subtitles(args.url, tmp, args.preferred_langs)
        if subs_result.get("ok"):
            srt_content = str(subs_result.get("srt", ""))
            save_output(out_path, srt_content)
            out = {
                "ok": True,
                "url": args.url,
                "method": "youtube_subtitles",
                "text": subs_result.get("text", ""),
                "saved_to": str(out_path),
                "format": "srt",
            }
            print(json.dumps(out, indent=2, ensure_ascii=False))
            return 0

        # Priority 2: audio + whisper.cpp
        dl = download_audio(args.url, tmp)
        if not dl.get("ok"):
            out = {
                "ok": False,
                "url": args.url,
                "method": "youtube_subtitles_then_whisper_cpp",
                "subtitle_error": subs_result,
                "audio_error": dl,
            }
            print(json.dumps(out, indent=2, ensure_ascii=False))
            return 1

        whisper_result = transcribe_with_whisper(
            audio_file=Path(str(dl["audio_file"])),
            server_url=args.server_url,
            timeout_seconds=args.timeout,
            response_format=args.whisper_format,
        )
        if not whisper_result.get("ok"):
            out = {
                "ok": False,
                "url": args.url,
                "method": "youtube_subtitles_then_whisper_cpp",
                "subtitle_error": subs_result,
                "audio_file": dl.get("audio_file"),
                "whisper_error": whisper_result,
            }
            print(json.dumps(out, indent=2, ensure_ascii=False))
            return 1

        # Convert fallback output to SRT for default storage
        srt_content = ""
        if args.whisper_format == "srt":
            srt_content = whisper_result.get("text", "")
        elif args.whisper_format == "json" and isinstance(whisper_result.get("raw"), dict):
            srt_content = whisper_json_to_srt(whisper_result["raw"])
        else:
            text = whisper_result.get("text", "")
            srt_content = f"1\n00:00:00,000 --> 00:10:00,000\n{text.strip()}\n"

        save_output(out_path, srt_content)

        out = {
            "ok": True,
            "url": args.url,
            "method": "whisper_cpp_fallback",
            "audio_file": dl.get("audio_file"),
            "server_url": args.server_url,
            "text": whisper_result.get("text", ""),
            "saved_to": str(out_path),
            "format": "srt",
        }
        print(json.dumps(out, indent=2, ensure_ascii=False))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
