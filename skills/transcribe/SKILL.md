---
name: transcribe
description: Transcribes local audio files and YouTube videos. Use when asked to "transcribe audio", "transcribe youtube", "convert speech to text", "make subtitles", or "turn voice memo/video into text". For YouTube, it first tries direct subtitles with yt-dlp, then falls back to audio download plus whisper.cpp.
allowed-tools: Bash, Read
---

Transcribe local audio or YouTube content with a subtitle-first strategy.

## Step 1: Identify source type

- If input is a local file path, use `scripts/transcribe_whispercpp.py`.
- If input is a YouTube URL, use `scripts/transcribe_youtube.py`.

## Step 2: Local audio transcription

```bash
uv run ${CLAUDE_SKILL_ROOT}/scripts/transcribe_whispercpp.py \
  "/path/to/audio.wav" \
  --server-url http://lptr:8082/inference \
  --format txt
```

## Step 3: YouTube transcription (priority flow)

Use this exact priority:
1. Try subtitles directly from YouTube with `yt-dlp`
2. If unavailable, download audio with `yt-dlp` and transcribe via whisper.cpp

```bash
uv run ${CLAUDE_SKILL_ROOT}/scripts/transcribe_youtube.py \
  "https://www.youtube.com/watch?v=VIDEO_ID" \
  --server-url http://lptr:8082/inference
```

Default behavior:
- Saves transcript to disk as SRT: `<video_id>.srt` in current directory.

Optional flags:
- `--save-to /path/to/output.srt`
- `--preferred-langs "en.*,en"`
- `--whisper-format {txt|srt|vtt|json}` (default: `srt`)
- `--timeout <seconds>`

## Step 4: Handle results

Both scripts output JSON with `ok` and `text`.

- If `ok=true`, return transcription text to the user.
- If `ok=false`, return the error fields and suggest the next fix (install `yt-dlp`, verify server URL, retry with language settings).

## Notes

- Default whisper.cpp endpoint: `http://lptr:8082/inference`
- Endpoint can be overridden with `--server-url` or `WHISPER_CPP_URL`.
