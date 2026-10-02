# Architecture

## Overall scheme

```
browser (public/app.js, recorder.js)
      │  file upload or microphone recording
      ▼
site :7777 (server.js)  ──►  n8n :5678, webhook medminute-online / medminute-offline
      ▲                            │
      │   POST /api/jobs/<id>/...  │  ffmpeg → recognition → models
      └────────────────────────────┘
      │
      ├─► SQLite (site/data/medminute.db)
      ├─► voice prints: service :7778 → cross-meeting registry V-001, V-002…
      └─► reports in C:/medminute/reports
```

The site is not just a front end. It accepts the file, creates a job, calls n8n, receives the
results piece by piece, stores them in SQLite tables, computes voice prints itself and serves
everything to the frontend. n8n is responsible only for processing the recording.

## Frontend

A single file `public/app.js` — its own mini-framework built on an `h()` function (like createElement),
no React and no build step. `public/recorder.js` — microphone recording via MediaRecorder.
Job progress arrives via **SSE**: `GET /api/jobs/<id>/events`.

## Site API

**Jobs**

| Method and path | What it does |
|---|---|
| `POST /api/jobs` | upload a recording, create a job, call the n8n webhook |
| `GET /api/jobs` | list of meetings |
| `GET /api/jobs/<id>` | everything about a meeting: status, minutes, tables, speakers |
| `GET /api/jobs/<id>/events` | SSE status stream |
| `POST /api/jobs/<id>/status` | **called by n8n**: processing stage |
| `POST /api/jobs/<id>/part/<part>` | **called by n8n**: a piece of the result |
| `POST /api/jobs/<id>/result` | **called by n8n**: everything at once + mark as done |
| `POST /api/jobs/<id>/voiceid` | recompute voice prints |
| `POST /api/jobs/<id>/pdf` | build a PDF of the minutes |
| `POST /api/jobs/<id>/email` | send the minutes to participants |
| `POST /api/jobs/<id>/hide` | hide a meeting from the list |

Result parts (`<part>`): `transcript`, `mom`, `decisions`, `tasks`, `patients`, `files`, `sources`.

**Summary tables across all meetings**

`GET /api/db/overview`, `/api/db/people`, `/api/db/voices`, `/api/db/patients/summary`,
`/api/db/{decisions|tasks|patients|speakers}`, `POST /api/db/{...}/hide`,
`POST /api/db/voiceprints/<V-00N>/name` (give a voice a name),
`POST /api/db/voiceprints/reindex`.

**Other**

`GET /api/health`, `/api/n8n-ping`, `/api/meta`, `/api/asr/health`, `/api/asr/voices`,
`POST /api/asr/voices/enroll` (record a reference voice), `GET /api/reports/<file>`.

## Database

SQLite (`node-sqlite3-wasm` — no native build, works anywhere). Tables:

- `jobs` — meetings: status, stage, mode, error;
- `job_parts` — raw result parts from n8n;
- `decisions`, `tasks`, `medications` — decisions, tasks, prescriptions (one row each, so they
  can be queried across all meetings at once);
- `speakers` — who spoke at a specific meeting;
- `voice_prints` — the **cross-meeting voice registry**: one person = one `V-00N` in all
  meetings, even if their name was never spoken.

The rows n8n sends use English column keys (`Meeting date`, `Patient`, `Decision`, …) — `db.js`
maps them onto the table columns. If you rename a key in a workflow, rename it in `db.js` as well.

## Voice print (voice ID)

It is computed by the **site**, not by n8n — for online mode too. Once a meeting is ready, the
server calls `POST :7778/diarize`, receives ECAPA vectors, maps them to utterances by time and
compares them with the cross-meeting registry. Match — the same `V-00N`; no match — a new one. A voice
can then be given a name and email once, and in all future meetings that person will be recognised.

Speaker separation regularly splits one person into two clusters — the print fixes this: if two
"Participant N" labels have the same `V-00N`, the interface shows them as one person and merges
their utterances.

## n8n pipeline — online

```
webhook medminute-online
  ├─ "who spoke" branch: ffmpeg compresses the whole recording → gpt-4o-transcribe-diarize
  │                       → labels "Participant 1, 2, 3…" with timecodes
  └─ "text" branch: ffmpeg finds pauses → the recording is cut TWICE:
        V15 (~15 s windows) and V5 (~5 s windows), 0.5 s overlap, cut in silence
        → gpt-4o-transcribe on each piece → join, de-duplication at the seams
  ▼
"Final transcript" — assembles the text WITH CODE, no model
  ▼
"Who is who" (gpt-4.1) → names are inserted into the transcript
  ▼
├─ MoM minutes in RU / RO / EN (gpt-4.1)
├─ decisions and tasks (JSON)
└─ patients and prescriptions (JSON)
  ▼
everything is POSTed to the site
```

**An important place — do not break it.** There used to be a merge node between recognition and the
minutes: it received a 5-minute window in three forms at once (V5, V15, speaker labels) and stitched
them with a model. The model edited words, reordered utterances and in places paraphrased — and that
distortion went further into everything: the minutes, the decisions, the prescriptions. The node was
removed. Now the transcript is assembled with plain JS: V5 is taken as recognised, the speaker is
assigned by timecode overlap, nothing is rewritten. **V5 and V15 are not combined with each other** —
V15 stays separate, for manual checking of disputed places.

Why two slicings then: short pieces (3–5 s) swallow nothing and keep the language a word was spoken
in more reliably; long ones give context. Three-second windows were tried — worse: the model does not
hear the word in full. **The working pair is 15 s and 5 s; it is not worth changing.**

## n8n pipeline — offline

The same logic, different executors:

```
webhook medminute-offline
  → Whisper 15s windows (:7778/transcribe)
  → Whisper 5s windows
  → Voice ID (:7778/diarize)
  → "Final transcript" (the same code, text from V5, speaker by timecode)
  → "Who is who" (qwen3:8b) → MoM RU/RO/EN → decisions/tasks/prescriptions
  → to the site
```

The merge node was removed from offline the same way as from online, and for the same reason.

## Why the minutes do not invent things

This was checked separately, across all meetings: every number and every proper name in the minutes
was looked up in the transcript. Conclusion — the model **does not invent, it restores** garbled
recognition. Examples of real matches:

| In the minutes | What the transcript had |
|---|---|
| blood pressure 80/40 | `tensiunele opt zeci pe` … (cut off) … `patruzeci` |
| haemoglobin 86 | `Anemica, auzeceșase hemoglobina` |
| Klebsiella | `Clepsiella și Candida` |
| norepinephrine 0.22 | `de zero douăci douăi de nor` |

The line "restoring is allowed, inventing is not" is written directly into the MoM prompt, rule 1:
recognised a word confidently — write it correctly; did not — skip it, but never turn a jumble of
sounds into a drug, a diagnosis or a name; never complete a cut-off number.
**If you edit the prompts, do not touch this rule.**

The check can be repeated: `node site/tools/check-mom-grounded.js --all ru`.

## Languages of the output

- The minutes are generated in **three languages** (RU / RO / EN) — that is the product feature. The
  prompts themselves are in English; the "Three languages" node tells the model which language to write
  in and gives it the section headings for that language.
- The **decisions, tasks and prescriptions tables** are written in English
  (prompt "Decisions and tasks": *"Write the wording in English"*). Change that one phrase if you need
  another table language.
- The meeting title shown on the site is taken from the English minutes (falls back to Russian).

## Intentional Cyrillic left in the code

Everything was translated to English except a few places where Russian text is **data, not prose** —
changing it would break the behaviour:

| Where | Why it stays |
|---|---|
| online "Slicing variants": `Русский — кириллицей.` in the Whisper prompt | a priming prompt: it makes the model write Russian speech in Cyrillic |
| "Join versions" / offline "Final transcript": `субтитр`, `продолжение следует`, `спасибо за просмотр`, `кириллицей` in `junk()` | they match Whisper hallucinations in Russian and the regurgitated prompt |
| "Three languages": the `ru:` heading map (`Letter → Письмо` …) | these are the headings of the Russian minutes |
| "Transcript with names": `низ`, `сред`, `пациент`, `больн` | fallback if the model answers in Russian |
| `db.js` `NONAME`, `server.js` `MEETING_WORD.ru` | Russian placeholders; the word used in the Russian PDF |
| `tools/check-mom-grounded.js`, `tools/patch-mom-headings.py` | transliteration table / Russian heading map |

## Utility scripts

All in `site/tools/`, run from `C:/medminute/site`.

| Script | What it does |
|---|---|
| `restart.sh` | restart the site |
| `restart-asr.sh` | restart local recognition (port 7778) |
| `check-mom-grounded.js` | check that the minutes contain nothing that was not in the recording |
| `push.js` | upload a workflow JSON into n8n via the API and activate it |
| `exec.py` | show the state of an n8n execution |
| `make-email-workflow.py` | create the mailing workflow + SMTP credential via the API |
| `validate.js` | static checks used by CI (`npm test`) |
| `history/` | the history of how the pipeline was tuned (see below) |
| `autostart.vbs` | start the site and the ASR service at Windows login |

`history/patch-*.py` are the history of how the pipeline was refined. Reading them is useful: the header of
each one explains which problem it fixed. The most important: `patch-transcript-verbatim.py` and
`patch-offline-verbatim.py` (removed the model merge), `patch-mom-no-guessing.py` (ban on guessing),
`patch-5s-windows.py` (the working slicing). **All of them are already applied to the workflows in
`n8n/` — do not run them again.** They contain the workflow ids of the original installation.

All of them read the n8n API key from the `.n8n-key` file next to `server.js` — it is not in the
package; create your own: in n8n → Settings → n8n API → Create an API key, and put the key into that file.

## Things to know before you step on them

- **`localhost` vs `127.0.0.1`.** n8n resolves `localhost` to IPv6 `::1`, the site listens on IPv4.
  If `SELF_URL` is left as `localhost`, processing completes but the results never reach the site,
  and the job hangs in "processing".
- **A node name in n8n is a key in `connections`.** Rename a node in the UI and the links break
  silently — and so do the `$('Node name')` references in code nodes. The scripts in `tools/` rename
  a node together with its links, which is why they are written that way.
- **Whisper's `initial_prompt` is not an instruction, it is a primer.** Local Whisper sometimes simply
  copies the vocabulary from the prompt instead of the recognised text. That is why the code has the
  `junk()` filter: it drops such lines and the YouTube-style endings Whisper produces on silence.
- **A job is stuck.** The site itself marks as failed anything that n8n has not reported on for more
  than 20 minutes (`STALL_MIN`). The cause is always visible in n8n's execution history.
- **Local speaker separation on long recordings** tends to collapse everyone into one cluster. It
  works noticeably better on short recordings.
- **The site has no login.** Anyone who can reach port 7777 sees all meetings. See [SECURITY.md](../SECURITY.md).
