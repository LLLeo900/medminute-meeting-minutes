# Security policy

MedMinute processes recordings of doctors' meetings. Recordings, transcripts, reports and the
database contain **patients' personal and health data**.

## Before you deploy

- **The website has no authentication.** By default it listens on all interfaces (`HOST=0.0.0.0`).
  Set `HOST=127.0.0.1`, restrict port 7777 with a firewall, or put it behind a reverse proxy with
  authentication and HTTPS.
- Keep n8n (5678), the ASR service (7778) and Ollama (11434) unreachable from the network.
- n8n must be started with `NODES_EXCLUDE=[]` to run ffmpeg — only on an instance that nobody else can edit.
- **Online mode sends audio and transcripts to OpenAI.** Make sure that is allowed under your data
  protection law and your agreements with the provider; otherwise use offline mode.
- Restrict file-system access to `site/data/`, `audio/`, `reports/` and `voices/`, and back them up.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's
[private vulnerability reporting](../../security/advisories/new) for this repository
and describe the issue and how to reproduce it. Never include real recordings or patient data.
