# MedMinute — setup guide

A step-by-step guide to installing [MedMinute](../README.md) from scratch on one Windows machine. Do the steps in
order. Each step ends with a check, so you know it worked before you move on.

> **Platform.** The package targets **Windows 10/11**. Paths like `C:/medminute/...` are written
> into the n8n workflows, temp files are deleted with PowerShell, and PDFs are printed with
> Chrome/Edge from their standard Windows locations. To run it on Linux or macOS, see
> [Running on Linux/macOS](#running-on-linuxmacos) at the end.

---

## 0. Overview: what runs where

| Component | Port | Needed for | Required? |
|---|---|---|---|
| Website + API (`site/server.js`, Node.js) | 7777 | everything | yes |
| n8n (orchestrator) | 5678 | everything | yes |
| ffmpeg | — | online mode (slicing audio) | yes, for online |
| OpenAI API key | — | online mode | yes, for online |
| Local ASR service (`site/asr/service.py`, Python) | 7778 | offline mode; voice prints in both modes | offline: yes; online: recommended |
| Ollama + `qwen3:8b` | 11434 | offline mode (the minutes) | offline only |
| Chrome or Edge | — | PDF export and PDF attachments | recommended |
| SMTP mailbox | — | emailing the minutes | optional |

Everything must run **on the same machine**: n8n reads the audio files from disk and runs ffmpeg
itself, so n8n must be installed natively (not in Docker with a separate file system).

Final folder layout:

```
C:/medminute/
  site/                  ← the contents of site/ from this package
  audio/                 ← uploaded recordings and temporary slices (created automatically)
  reports/               ← finished .md / .pdf reports (created automatically)
  voices/                ← reference voices (created automatically)
  whisper-models/        ← offline models (step 7)
  ffmpeg/bin/ffmpeg.exe  ← ffmpeg (step 2)
```

---

## 1. Install the prerequisites

1. **Node.js 20 or newer** — https://nodejs.org (LTS). Check: `node --version`.
2. **n8n**: `npm install -g n8n`. Check: `n8n --version`.
3. **Git for Windows** (https://git-scm.com) — gives you *Git Bash*, which the `tools/*.sh` scripts need.
4. **Python 3.10+** — only for offline mode and the utility scripts. Tick "Add python.exe to PATH" in the installer.
5. **Google Chrome or Microsoft Edge** — for PDF export (usually already installed).

## 2. Lay out the folders and ffmpeg

1. Create `C:/medminute`.
2. Clone the repository and copy (or link) its `site/` folder to `C:/medminute/site`.
3. Download an ffmpeg build for Windows (for example the "essentials" build from https://www.gyan.dev/ffmpeg/builds/)
   and unpack it so that the executable ends up at exactly **`C:/medminute/ffmpeg/bin/ffmpeg.exe`**.

Check: `C:/medminute/ffmpeg/bin/ffmpeg.exe -version` prints the version.

> If you put ffmpeg somewhere else, you have to edit the path in the online workflow nodes
> **"Compress whole recording (ffmpeg)"**, **"Find pauses (ffmpeg)"** and in the code of
> **"Slicing variants"** (two places), and set the `FFMPEG` environment variable for the ASR service.

## 3. Start the website

```bash
cd C:/medminute/site
npm ci          # installs the only dependency, node-sqlite3-wasm (prebuilt WASM, no compiler needed)
npm start       # same as: node server.js
```

The SQLite database is created in `site/data/medminute.db` on first start.

> Air-gapped hospital machine? Run `npm ci` on a machine with internet and copy the resulting
> `site/node_modules/` folder over — it is pure JavaScript + WASM and works on any OS.

Check: open http://localhost:7777 — the "New meeting" page appears. The top bar will say
"n8n not responding" for now; that is expected.

### Website settings (environment variables, all optional)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `7777` | site port |
| `HOST` | `0.0.0.0` | interface to listen on. Set `127.0.0.1` to make the site reachable only from this machine (see Security) |
| `N8N_BASE` | `http://localhost:5678` | where n8n is |
| `N8N_HOOK_ONLINE` / `N8N_HOOK_OFFLINE` / `N8N_HOOK_EMAIL` | `<N8N_BASE>/webhook/medminute-online` etc. | webhook addresses |
| `SELF_URL` | `http://127.0.0.1:7777` | how n8n reaches the site. Use `127.0.0.1`, **not** `localhost` (n8n resolves `localhost` to IPv6 and the results never arrive) |
| `PUBLIC_URL` | empty | address used for links in emails. Empty = emails contain no link |
| `AUDIO_DIR` / `REPORTS_DIR` / `VOICES_DIR` | `C:/medminute/audio` / `reports` / `voices` | folders. **`AUDIO_DIR` must stay `C:/medminute/audio`** unless you also edit the online workflow nodes — the path is written into them |
| `ASR_BASE` | `http://127.0.0.1:7778` | local recognition service |
| `AUTO_VOICEID` | on (`0` = off) | take voice prints automatically after every meeting (needs the ASR service) |
| `STALL_MIN` | `20` | minutes without news from n8n before a job is marked as failed |
| `CHROME_PATH` | — | path to Chrome/Edge if it is not in the standard location |
| `VOICE_MATCH` | `0.66` | cosine threshold for "the same voice" in the voice registry |

On Windows set them in the same console before `node server.js`, e.g. `set HOST=127.0.0.1`
(cmd) or `$env:HOST="127.0.0.1"` (PowerShell).

## 4. Configure and start n8n

n8n 2.x blocks two things this project needs by default: the **Execute Command** node (runs ffmpeg)
and file access outside `~/.n8n-files` (the **Read/Write Files from Disk** node reads the slices from
`C:/medminute/audio`). Allow both before starting n8n:

PowerShell:

```powershell
$env:NODES_EXCLUDE = "[]"
$env:N8N_RESTRICT_FILE_ACCESS_TO = "C:/medminute/audio"
n8n start
```

cmd:

```bat
set NODES_EXCLUDE=[]
set N8N_RESTRICT_FILE_ACCESS_TO=C:/medminute/audio
n8n start
```

> `NODES_EXCLUDE=[]` re-enables all nodes, including Execute Command — which can run any command on
> this machine. Only do this on an n8n instance that nobody else can edit. On n8n 1.x these two
> variables are not needed.

Check: http://localhost:5678 opens; create the owner account on first launch.

## 5. Import the workflows

In n8n: **Workflows → Create → ⋯ → Import from File**, once per file.

### 5.1 Online workflow — `n8n/medminute-online.json`

1. Import it.
2. Create an **OpenAI** credential: Credentials → Add credential → *OpenAI API* → paste your API key
   (https://platform.openai.com/api-keys). The account must have access to `gpt-4o-transcribe`,
   `gpt-4o-transcribe-diarize` and `gpt-4.1`.
3. Open each of these six nodes and select that credential:
   - **Who speaks (gpt-4o-transcribe-diarize)**
   - **Transcribe 15s + 5s (gpt-4o-transcribe)**
   - **Who is who (names, gpt-4.1)**
   - **MoM report (per language, gpt-4.1)**
   - **Decisions and tasks (JSON, gpt-4.1)**
   - **Patients and prescriptions (JSON, gpt-4.1)**
4. Save and switch the workflow to **Active**.

### 5.2 Offline workflow — `n8n/medminute-offline.json`

1. Import it. It needs **no credentials** — everything goes over HTTP to `127.0.0.1`.
2. Save and switch to **Active**. (It will only work after step 7.)

### 5.3 Mailing workflow — `n8n/medminute-email.json` (optional)

1. Import it.
2. Create an **SMTP** credential: host, port, user, password of your mailbox. For Gmail / Google
   Workspace: `smtp.gmail.com`, port `465`, SSL on, and an *app password* (not your normal password).
3. In the node **Send (SMTP)** select that credential and replace `SENDER@example.com` in
   *From Email* with your sender address.
4. **Send (SMTP, offline)** is disabled on purpose: offline mode assumes there is no mail server on
   the hospital network. If there is one, enable the node, give it an SMTP credential and a sender
   address. (The site sends offline-mode emails through this branch.)
5. Save and switch to **Active**.

Check: on http://localhost:7777 the top bar now shows **"n8n connected"**.

> Do not rename nodes after import: code nodes refer to other nodes by name (`$('Job')`, `$('Final transcript')` …).

## 6. First test — online

1. Open http://localhost:7777, choose **Online**, upload a short recording (30–60 s, any of
   `.m4a .mp3 .wav .ogg .webm .mp4 .aac .opus .amr .wma .flac`).
2. You land on the processing page; the steps tick off: Transcript → Minutes → Decisions → Tasks →
   Prescriptions → Reports.
3. When it is done, the minutes page opens (Russian / Romanian / English / Original tabs).

If it stops: open the execution in n8n (**Executions**) — the failing node and its error are shown
there. See also [Troubleshooting](#troubleshooting).

## 7. Offline mode — local recognition and the local model

### 7.1 Python packages

```bash
cd C:/medminute/site
pip install -r asr/requirements.txt
```

Optional, for the better voice-print model (ECAPA, 192-number vectors). Without it the service falls
back to the WeSpeaker ONNX model (256 numbers):

```bash
pip install -r asr/requirements-optional.txt
```

Optional, pyannote diarization (needs a Hugging Face token with the pyannote terms accepted):
uncomment `pyannote.audio` in `asr/requirements-optional.txt`, install it, and set `HF_TOKEN` before step 7.2.

### 7.2 Download the models (once, with internet)

```bash
cd C:/medminute/site
python asr/download-models.py     # Whisper large-v3-turbo + small + WeSpeaker ONNX → C:/medminute/whisper-models
python asr/download-voiceid.py    # ECAPA voice-print model (+ pyannote if HF_TOKEN is set)
```

### 7.3 Start the ASR service

From **Git Bash**:

```bash
cd /c/medminute/site
bash tools/restart-asr.sh
```

or directly: `python asr/service.py`. After that it works without internet.

ASR service settings (environment variables, optional):

| Variable | Default | Purpose |
|---|---|---|
| `ASR_PORT` | `7778` | port |
| `MODELS_DIR` | `C:/medminute/whisper-models` | where the models are |
| `VOICES_DIR` | `C:/medminute/voices` | reference voices (`index.json`) |
| `FFMPEG` | `C:/medminute/ffmpeg/bin/ffmpeg.exe` | ffmpeg, used when enrolling reference voices |
| `WHISPER_MODEL` | `<MODELS_DIR>/faster-whisper-large-v3-turbo` | Whisper model folder (e.g. `…/faster-whisper-small` for a weak PC) |
| `WHISPER_COMPUTE` | `int8` | CTranslate2 compute type |
| `WHISPER_BEAM` | `1` | beam size |
| `ASR_LANGS` | `ro,ru,en` | languages allowed for auto-detection; the first is the default |

Check: http://127.0.0.1:7778/health and http://localhost:7777/api/asr/health return `"ok": true`.

### 7.4 Ollama

1. Install Ollama: https://ollama.com/download
2. `ollama pull qwen3:8b`
3. Ollama must listen on `http://127.0.0.1:11434` (the default).

### 7.5 First offline test

Upload a **short** recording (30–60 s) with mode **Offline**.

> **Hardware warning.** Local Whisper on a long recording heats the machine seriously and takes a
> long time — on an ordinary laptop a full meeting took several hours. Always start with a short file.

## 8. Voice IDs and reference voices (optional)

- After every finished meeting the site computes voice prints via the ASR service (if it is running)
  and links them to the cross-meeting registry `V-001, V-002, …`.
- On the **Voices** page:
  - add a *reference voice*: a person's name + 20–30 s of clean speech from that person;
  - in the *Voice registry*, give a `V-00N` a name and an email once — it is applied to all meetings
    of that voice, and the minutes are emailed to that address automatically.

## 9. Mailing (optional)

Requires step 5.3. Then:

- on the minutes page, enter addresses and press **Send** (a PDF is built and attached), or
- enter addresses in "Send the minutes to" when uploading — the minutes go out automatically as soon
  as they are ready (in Russian by default — `queueEmail` in `server.js`), or
- give voices an email in the registry — those participants get the minutes automatically.

`PUBLIC_URL` adds a link to the meeting in the email (only useful if recipients can reach the site).

## 10. Autostart on Windows (optional)

`site/tools/autostart.vbs` starts the site and the ASR service at login without console windows.

1. Edit the file: the Python path inside it (`C:\Users\user\AppData\Local\Programs\Python\Python313\python.exe`)
   is from the original machine — replace it with yours (`where python`).
2. Press Win+R → `shell:startup` → put a shortcut to `autostart.vbs` there.

n8n and Ollama need their own autostart (e.g. a scheduled task for `n8n start` with the variables
from step 4; Ollama installs itself as a background app).

## 11. API key for the utility scripts (optional)

`tools/push.js`, `tools/exec.py`, `tools/make-email-workflow.py` use the n8n public API:

1. n8n → **Settings → n8n API → Create an API key**.
2. Save the key into `C:/medminute/site/.n8n-key` (a single line).
3. Run the scripts from `C:/medminute/site`, e.g. `python tools/exec.py`.

`make-email-workflow.py` also needs `C:/medminute/site/.mail-from` with the sender address; it
creates the mailing workflow and the SMTP credential via the API (an alternative to step 5.3).

**Do not run** the scripts in `tools/history/`: they are the history of how the pipeline was built,
are already applied to the shipped workflows, and contain the workflow ids of the original installation.

## 12. Security

The recordings and the database contain **patients' personal data**.

- **The site has no login.** By default it listens on all interfaces (`HOST=0.0.0.0`), so anyone on
  the network who can reach port 7777 sees every meeting. Either set `HOST=127.0.0.1`, or close port
  7777 in the Windows firewall to everyone except the machines that need it, or put it behind a
  reverse proxy with authentication.
- n8n, the ASR service (7778) and Ollama (11434) should not be reachable from the network.
- The microphone recorder in the browser works only on `localhost` or over HTTPS.
- Online mode sends the audio and the transcript to OpenAI. Use offline mode when that is not allowed.
- Back up `site/data/medminute.db`, `C:/medminute/reports` and `C:/medminute/voices`; restrict access to them.

## 13. Check-list — everything is working when

- [ ] http://localhost:7777 opens, the top bar shows **local** and **n8n connected**
- [ ] all needed workflows are **Active** in n8n
- [ ] a 30-second online test produces minutes in three languages, and the Decisions / Tasks / Patients tables
- [ ] (offline) http://127.0.0.1:7778/health is ok, `ollama list` shows `qwen3:8b`, a 30-second offline test finishes
- [ ] **Export PDF** opens a PDF
- [ ] (mailing) a test email arrives with a PDF attached

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Job fails at once: "n8n webhook unavailable … Check that the workflow is active" | n8n is not running, or the workflow is not Active, or `N8N_BASE` is wrong |
| Job stays in "processing", then fails after 20 min | the results cannot reach the site: `SELF_URL` must use `127.0.0.1`; or a node failed — see n8n → Executions |
| "Unrecognized node type: n8n-nodes-base.executeCommand" | n8n 2.x: start n8n with `NODES_EXCLUDE=[]` (step 4) |
| "Read compressed recording" / "Read segments" fail with an access error | `N8N_RESTRICT_FILE_ACCESS_TO` does not include `C:/medminute/audio` (step 4) |
| ffmpeg node: "is not recognized" / file not found | ffmpeg is not at `C:/medminute/ffmpeg/bin/ffmpeg.exe` (step 2) |
| OpenAI nodes: 401 / "credentials not found" | the OpenAI credential is not selected in one of the six nodes (step 5.1) |
| Cannot activate the mailing workflow: webhook path already in use | another workflow already uses the `medminute-email` path (e.g. an older import) — deactivate it |
| Offline: "local Whisper produced no text — check …/asr.log" | the ASR service is not running or the models were not downloaded (step 7); look at `site/data/asr.log` |
| Offline minutes nodes fail / time out | Ollama is not running or `qwen3:8b` is not pulled; on a weak PC long meetings may hit the timeout |
| "Speakers not identified", no `V-00N` | the ASR service is not running (it computes voice prints for online mode too), or `AUTO_VOICEID=0`; press **Take voice prints** on the meeting page |
| "Chrome or Edge not found for PDF printing" | set `CHROME_PATH` to `chrome.exe` / `msedge.exe` |
| Email arrives with a `.md` attachment instead of PDF | the PDF build failed — see the site console; usually Chrome/Edge not found |
| The recorder says "Recording is not available here" | open the site via `http://localhost:7777` (not by IP) or serve it over HTTPS |

## Running on Linux/macOS

Possible, but the following must be adapted by hand:

1. **Online workflow:** replace `C:/medminute/ffmpeg/bin/ffmpeg.exe` with `ffmpeg` and `C:/medminute/audio`
   with your audio folder in the nodes *Compress whole recording*, *Read compressed recording*,
   *Find pauses*, *Slicing variants* (code), *Read segments*, *Delete temp files*. Replace the PowerShell
   command in *Delete temp files* with `rm -f '<dir>/{{…}}_full.mp3' <dir>/{{…}}_*__seg_*.mp3`.
2. **Site:** set `AUDIO_DIR`, `REPORTS_DIR`, `VOICES_DIR` to the same folders and `CHROME_PATH` to Chrome/Chromium.
3. **ASR service:** set `MODELS_DIR`, `VOICES_DIR`, `FFMPEG`; pass `MODELS_DIR` to the download scripts too.
4. `tools/restart*.sh` use Windows `netstat`/`taskkill` — just start `node server.js` and
   `python asr/service.py` directly (or as systemd/launchd services).
