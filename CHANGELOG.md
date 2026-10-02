# Changelog

## 1.0.0 — 2026-10-02

First public release.

- Website and API (Node.js, SQLite via WASM, no build step), browser recorder, PDF export, email.
- n8n workflows: online (OpenAI `gpt-4o-transcribe`, `gpt-4o-transcribe-diarize`, `gpt-4.1`),
  offline (local Whisper large-v3-turbo + `qwen3:8b` via Ollama) and mailing.
- Local ASR service: windowed Whisper transcription, VAD + ECAPA/WeSpeaker speaker separation,
  cross-meeting voice registry.
- Minutes in Russian, Romanian and English; decisions, tasks and prescriptions tables.
- Codebase, prompts and UI translated to English; client-specific naming removed.
- The duplicate mailing nodes were removed from the online workflow (the mailing workflow is separate).
