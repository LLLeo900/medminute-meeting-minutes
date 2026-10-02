# Pipeline history

These scripts are the history of how the n8n pipeline was tuned. Each one patched the live
workflows through the n8n API; the header of every script explains which problem it fixed.

**All of them are already applied to the workflows in `n8n/`. Do not run them again** — they contain
the workflow ids of the original installation and search for code fragments of older workflow
versions.

Most instructive:

| Script | Lesson |
|---|---|
| `patch-transcript-verbatim.py`, `patch-offline-verbatim.py` | removed the LLM "merge" step — it distorted the transcript |
| `patch-mom-no-guessing.py` | the "restore, never invent" rule of the MoM prompt |
| `patch-3s-windows.py` → `patch-5s-windows.py` | 3-second windows were worse; 15 s + 5 s is the working pair |
| `patch-mom-onelang.py`, `patch-mom-headings.py` | one language per set of minutes, translated headings |
| `patch-offline-prompt.py`, `patch-offline-junk.py` | Whisper priming prompt vs instruction; junk filter |
