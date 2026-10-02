// MedMinute 7777 — website for transcribing meetings.
// Accepts audio, puts it into C:/medminute/audio, triggers n8n via a webhook,
// collects the results back piece by piece and shows them in the browser.
// Storage is a local SQLite (WASM, no internet and no build step).

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const store = require('./db');

const PORT = Number(process.env.PORT || 7777);
const HOST = process.env.HOST || '0.0.0.0';
// 127.0.0.1, not localhost: n8n resolves localhost to ::1, while the server listens on IPv4
const SELF_URL = process.env.SELF_URL || `http://127.0.0.1:${PORT}`;
// Address for outgoing emails. SELF_URL is no good here: 127.0.0.1 will not open for the recipient,
// and there is no reason to expose the system's internals in an email. Empty = no link in the email.
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const N8N_BASE = process.env.N8N_BASE || 'http://localhost:5678';
const HOOKS = {
  online: process.env.N8N_HOOK_ONLINE || `${N8N_BASE}/webhook/medminute-online`,
  offline: process.env.N8N_HOOK_OFFLINE || `${N8N_BASE}/webhook/medminute-offline`,
  email: process.env.N8N_HOOK_EMAIL || `${N8N_BASE}/webhook/medminute-email`,
};
// We take voice prints ourselves as soon as a meeting is ready (the online transcription does not provide them).
const AUTO_VOICEID = process.env.AUTO_VOICEID !== '0';

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const AUDIO_DIR = (process.env.AUDIO_DIR || 'C:/medminute/audio').replace(/\\/g, '/');
const REPORTS_DIR = (process.env.REPORTS_DIR || 'C:/medminute/reports').replace(/\\/g, '/');
const VOICES_DIR = (process.env.VOICES_DIR || 'C:/medminute/voices').replace(/\\/g, '/');
const ASR_BASE = process.env.ASR_BASE || 'http://127.0.0.1:7778';

const MAX_UPLOAD = 2 * 1024 * 1024 * 1024; // 2 GB
const ALLOWED_EXT = new Set(['m4a', 'mp3', 'wav', 'ogg', 'webm', 'mp4', 'aac', 'opus', 'amr', 'wma', 'flac']);
const PARTS = new Set(['transcript', 'mom', 'decisions', 'tasks', 'patients', 'files', 'sources']);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

const listeners = new Map(); // jobId -> Set<res> (SSE)

// ---------- helpers ----------

function log(level, msg) {
  console.log(`${new Date().toISOString().slice(11, 19)} [${level}] ${msg}`);
}

function send(res, code, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(code, { 'Content-Length': buf.length, ...headers });
  res.end(buf);
}

const sendJson = (res, code, obj) =>
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });

function safeName(raw) {
  const base = String(raw || 'audio').replace(/\\/g, '/').split('/').pop();
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').slice(0, 180) || 'audio';
}

function extOf(name) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name || '');
  const ext = m ? m[1].toLowerCase() : '';
  return ALLOWED_EXT.has(ext) ? ext : '';
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('request too large'), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, 128 * 1024 * 1024);
  return buf.length ? JSON.parse(buf.toString('utf8')) : {};
}

// ---------- job representation ----------

function summary(row) {
  const c = store.counts(row.id);
  return {
    id: row.id,
    mode: row.mode,
    status: row.status,
    stage: row.stage,
    error: row.error,
    fileName: row.file_name,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    title: row.title,
    meetingDate: row.meeting_date,
    hidden: row.hidden ? 1 : 0,
    emailTo: row.email_to || '',
    emailSentAt: row.email_sent_at || null,
    have: store.partNames(row.id).sort(),
    counts: c,
  };
}

function fullJob(id) {
  const row = store.jobRow(id);
  if (!row) return null;
  return {
    ...summary(row), inputPath: row.input_path, result: store.jobParts(id),
    speakers: store.jobSpeakers(id),   // the cross-meeting voice_id lives here, the result parts do not have it
    recipients: recipientsFor(id),     // addresses from the voice registry + those entered at upload
  };
}

function emit(id) {
  const set = listeners.get(id);
  if (!set || !set.size) return;
  const row = store.jobRow(id);
  if (!row) return;
  const frame = `data: ${JSON.stringify(summary(row))}\n\n`;
  for (const res of set) res.write(frame);
}

// ---------- triggering n8n ----------

async function triggerN8n(job) {
  const hook = HOOKS[job.mode] || HOOKS.online;
  const payload = {
    jobId: job.id,
    mode: job.mode,
    fileName: job.fileName,
    ext: job.ext,
    inputPath: job.inputPath,
    audioDir: AUDIO_DIR,
    reportsDir: REPORTS_DIR,
    sizeBytes: job.sizeBytes,
    submittedAt: job.createdAt,
    siteUrl: SELF_URL,
    callbackUrl: `${SELF_URL}/api/jobs/${job.id}`,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const r = await fetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const text = (await r.text()).slice(0, 400);
    if (!r.ok) throw new Error(`${r.status} ${text}`);
    store.updateJob(job.id, { status: 'processing', stage: 'n8n accepted the job' });
    log('info', `job ${job.id}: n8n accepted the job (${job.mode})`);
  } catch (e) {
    const msg = `n8n webhook unavailable (${hook}): ${e.message}. Check that the workflow is active.`;
    store.updateJob(job.id, { status: 'error', stage: 'failed to start n8n', error: msg });
    log('error', `job ${job.id}: ${msg}`);
  } finally {
    clearTimeout(timer);
    emit(job.id);
  }
}

// ---------- handlers ----------

async function createJob(req, res, url) {
  const fileName = safeName(decodeURIComponent(req.headers['x-file-name'] || 'audio.m4a'));
  const ext = extOf(fileName);
  if (!ext) return sendJson(res, 400, { error: `Unsupported format. Allowed: ${[...ALLOWED_EXT].join(', ')}` });

  const mode = (req.headers['x-mode'] || url.searchParams.get('mode') || 'online') === 'offline' ? 'offline' : 'online';
  const buf = await readBody(req, MAX_UPLOAD);
  if (buf.length < 1024) return sendJson(res, 400, { error: 'The file is empty or too small' });

  const id = `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
  await fsp.mkdir(AUDIO_DIR, { recursive: true });
  await fsp.mkdir(REPORTS_DIR, { recursive: true });
  const inputPath = `${AUDIO_DIR}/${id}_input.${ext}`;
  await fsp.writeFile(inputPath, buf);

  // Addresses entered by the moderator at upload: the minutes are sent automatically as soon as they are ready.
  const emailTo = parseAddrs(decodeURIComponent(req.headers['x-email-to'] || ''))
    .filter((a) => MAIL_RE.test(a)).join(', ');

  const job = {
    id, mode, status: 'queued', stage: 'file received, starting n8n',
    fileName, ext, sizeBytes: buf.length, inputPath, emailTo, createdAt: new Date().toISOString(),
  };
  store.insertJob(job);
  log('info', `job ${id}: ${fileName} (${(buf.length / 1048576).toFixed(1)} MB, ${mode}) -> ${inputPath}`);

  triggerN8n(job); // do not wait: processing takes long
  sendJson(res, 201, summary(store.jobRow(id)));
}

async function putPart(req, res, id, part) {
  const row = store.jobRow(id);
  if (!row) return sendJson(res, 404, { error: 'job not found' });
  if (!PARTS.has(part)) return sendJson(res, 400, { error: `unknown part: ${part}` });

  const body = await readJson(req);
  if (part === 'files') await writeReports(body);
  store.savePart(id, part, body);
  const have = new Set(store.partNames(id));
  const done = have.has('mom') && have.has('transcript');
  store.updateJob(id, {
    status: row.status === 'error' ? 'error' : (done ? 'done' : 'processing'),
    stage: done ? 'done' : `received: ${part}`,
    ...(done ? { finishedAt: new Date().toISOString() } : {}),
  });
  emit(id);
  log('info', `job ${id}: part "${part}"${done ? ' → done' : ''}`);
  if (done) { queueVoiceId(id); queueEmail(id); }
  sendJson(res, 200, { ok: true, have: [...have] });
}

// Reports are written to disk by the site, not by n8n: n8n nodes have file-system access restricted to ~/.n8n-files.
async function writeReports(body) {
  await fsp.mkdir(REPORTS_DIR, { recursive: true });
  for (const row of body.rows || []) {
    const name = safeName(String(row.fileName || ''));
    if (!name || !row.content) continue;
    const full = path.join(REPORTS_DIR, name);
    if (!path.resolve(full).startsWith(path.resolve(REPORTS_DIR))) continue;
    await fsp.writeFile(full, String(row.content), 'utf8');
    row.path = full.replace(/\\/g, '/');
    delete row.content;
  }
}

async function putStatus(req, res, id) {
  if (!store.jobRow(id)) return sendJson(res, 404, { error: 'job not found' });
  const b = await readJson(req);
  const fields = {};
  if (b.stage) fields.stage = String(b.stage).slice(0, 300);
  if (b.error) { fields.status = 'error'; fields.error = String(b.error).slice(0, 4000); }
  else if (['queued', 'processing', 'done', 'error'].includes(b.status)) {
    fields.status = b.status;
    if (b.status === 'done') fields.finishedAt = new Date().toISOString();
  }
  store.updateJob(id, fields);
  emit(id);
  sendJson(res, 200, { ok: true });
}

function subscribe(req, res, id) {
  if (!store.jobRow(id)) return sendJson(res, 404, { error: 'job not found' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write(`data: ${JSON.stringify(summary(store.jobRow(id)))}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  if (!listeners.has(id)) listeners.set(id, new Set());
  listeners.get(id).add(res);
  req.on('close', () => { clearInterval(ping); listeners.get(id)?.delete(res); });
}

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden');
  try {
    const stat = await fsp.stat(file);
    if (stat.isDirectory()) throw new Error('dir');
    // Page, script and styles — strictly no cache. With 'no-cache' Chrome still showed
    // the old app.js after edits: buttons seemed missing although the server served the new file.
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ['.html', '.js', '.css'].includes(ext) ? 'no-store, must-revalidate' : 'no-cache',
      'Last-Modified': stat.mtime.toUTCString(),
    });
    fs.createReadStream(file).pipe(res);
  } catch {
    send(res, 404, 'not found');
  }
}

// The browser must not call 7778 directly — the site proxies the ASR service.
async function asrGet(res, tail) {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(`${ASR_BASE}${tail}`, { signal: ctrl.signal });
    return sendJson(res, r.status, await r.json());
  } catch (e) {
    return sendJson(res, 200, { ok: false, error: `ASR service is not responding (${ASR_BASE}): ${e.message}` });
  }
}

/** Reference voice: the site saves the recording to disk, the ASR service computes the vector from the file path. */
async function enrollVoice(req, res, url) {
  const name = String(url.searchParams.get('name') || '').trim();
  if (!name) return sendJson(res, 400, { error: 'name is missing' });
  const fileName = safeName(decodeURIComponent(req.headers['x-file-name'] || 'voice.webm'));
  const ext = extOf(fileName) || 'webm';
  const buf = await readBody(req, 64 * 1024 * 1024);
  if (buf.length < 1024) return sendJson(res, 400, { error: 'the recording is empty' });

  const dir = `${VOICES_DIR}/refs`;
  await fsp.mkdir(dir, { recursive: true });
  const full = `${dir}/${Date.now()}-${crypto.randomBytes(2).toString('hex')}.${ext}`;
  await fsp.writeFile(full, buf);
  try {
    const r = await fetch(`${ASR_BASE}/voices/enroll`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, path: full }),
    });
    return sendJson(res, r.status, await r.json());
  } catch (e) {
    return sendJson(res, 502, { error: `ASR service is not responding (${ASR_BASE}): ${e.message}` });
  }
}

/** Transcript labels and voice clusters are numbered independently, so a matching
    "Participant 2" label means nothing by itself: a fragment at 11:40 got attached to a doctor
    who spoke throughout the recording. Which cluster belongs to whom is decided by time — by
    the overlap of utterances with the stretches of speech. A cluster goes to one label only: two people
    with the same vector is not true, better leave the field empty.
    Returns {cluster → speaker label}; null if there is nothing to match. */
function alignByTime(transcript, segments) {
  const secs = (t) => {
    const p = t.split(':').map(Number);
    return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
  };
  // The text says "John Smith (Participant 2)", while the speakers table has "Participant 2".
  const toBase = new Map(Object.entries(transcript?.nameMap || {}).map(([b, d]) => [d, b]));
  const base = (s) => toBase.get(s) || /\((Participant\s*\d+)\)/.exec(s)?.[1] || s;

  const lines = [];
  for (const line of String(transcript?.text || '').split('\n')) {
    const m = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*([^:]{1,60}?):/.exec(line.trim());
    if (m) lines.push({ t: secs(m[1]), label: base(m[2].trim()) });
  }
  if (!lines.length || !segments?.length) return null;

  // The transcript does not store where an utterance ends: extend it to the next one, but no longer than 30 s —
  // otherwise a pause in the conversation would stretch the last utterance over the rest of the recording.
  const overlap = new Map();
  lines.forEach((l, i) => {
    const a = l.t;
    const b = Math.min(lines[i + 1]?.t ?? a + 5, a + 30);
    for (const g of segments) {
      const x = Math.min(b, g.end) - Math.max(a, g.t);
      if (x <= 0) continue;
      const k = `${g.spk}\u0000${l.label}`;
      overlap.set(k, (overlap.get(k) || 0) + x);
    }
  });

  // A cluster is used only if it consists of one person's speech. When speaker separation
  // failed, the cluster spans the whole recording and is shared by everyone (44/24/19/…%) — such
  // a print belongs to nobody, and it must not be attributed to the most talkative person.
  const clusterSec = {};
  for (const g of segments) clusterSec[g.spk] = (clusterSec[g.spk] || 0) + (g.end - g.t);

  const pairs = [...overlap].map(([k, sec]) => [...k.split('\u0000'), sec])
    .sort((x, y) => y[2] - x[2]);
  const map = {};
  const taken = new Set();
  for (const [spk, label, sec] of pairs) {
    if (map[spk] || taken.has(label)) continue;
    if (sec < 0.6 * (clusterSec[spk] || 0)) continue;
    map[spk] = label;
    taken.add(label);
  }
  return Object.keys(map).length ? map : null;
}

/** Re-attaches the Voice ID result from clusters to speaker labels. Clusters that got no label
    are dropped — there is no point storing a print without knowing whose it is. */
function remapVoiceId(data, map) {
  const pick = (o) => Object.fromEntries(
    Object.entries(o || {}).filter(([k]) => map[k]).map(([k, v]) => [map[k], v]));
  return {
    ...data,
    vectors: pick(data.vectors),
    stats: pick(data.stats),
    names: pick(data.names),
    scores: pick(data.scores),
    segments: (data.segments || []).map((s) => ({ ...s, spk: map[s.spk] || s.spk })),
  };
}

/** Voice print for an already processed meeting. Runs only the voice embedder,
    the transcription model is not loaded — the online version is already done, only the voice id is needed.
    The vector is linked to the cross-meeting registry: one person always has the same voice_id. */
async function runVoiceId(id) {
  const row = store.jobRow(id);
  if (!row) throw Object.assign(new Error('job not found'), { code: 404 });
  if (!row.input_path) throw Object.assign(new Error('the source audio was not saved'), { code: 400 });
  try { await fsp.access(row.input_path); } catch {
    throw Object.assign(new Error('the recording file has been deleted'), { code: 410 });
  }

  let data;
  try {
    const r = await fetch(`${ASR_BASE}/diarize`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: row.input_path }),
      signal: AbortSignal.timeout(30 * 60 * 1000),
    });
    data = await r.json();
    if (!r.ok) throw Object.assign(new Error(data.error || `ASR replied ${r.status}`), { code: r.status });
  } catch (e) {
    if (e.code) throw e;
    throw Object.assign(new Error(`ASR service is not responding (${ASR_BASE}): ${e.message}`), { code: 502 });
  }
  const map = alignByTime(store.jobParts(id).transcript, data.segments);
  if (map) data = remapVoiceId(data, map);

  const saved = store.saveVoiceId(id, data);
  store.savePart(id, 'voiceid', { ...data, vectors: undefined, ids: saved.ids });   // the vector lives in speakers
  const list = Object.entries(saved.ids).map(([l, v]) => `${l}=${v.voiceId || '—'}`).join(' ');
  log('info', `job ${id}: voice id — ${saved.prints} prints (${data.voiceIdModel || data.method})`
    + `${map ? ', aligned by time' : ''} ${list}`);
  return {
    ok: true, prints: saved.prints, ids: saved.ids, model: data.voiceIdModel || data.method,
    dim: data.dim, names: data.names, scores: data.scores, stats: data.stats,
  };
}

async function jobVoiceId(res, id) {
  try {
    return sendJson(res, 200, await runVoiceId(id));
  } catch (e) {
    return sendJson(res, e.code || 500, { error: e.message });
  }
}

// Prints are computed by a local model — run strictly one at a time so as not to overload the machine.
let voiceQueue = Promise.resolve();
function queueVoiceId(id) {
  if (!AUTO_VOICEID) return;
  const row = store.jobRow(id);
  if (!row?.input_path) return;
  if (store.db.get('SELECT COUNT(*) c FROM speakers WHERE job_id = ? AND vector IS NOT NULL', [id]).c) return;
  voiceQueue = voiceQueue
    .then(() => runVoiceId(id))
    .then(() => emit(id))
    .catch((e) => log('warn', `job ${id}: voice prints not taken — ${e.message}`));
}

// ---------- PDF ----------
// Printing is done by the browser already installed on the system: --headless --print-to-pdf. No separate
// library is needed, and Cyrillic and Romanian diacritics come out correctly — the fonts
// are the system ones. The layout is built by the server, not the page: the PDF is also needed by the automatic mailing,
// when nobody has opened the browser.
// Localised word for the PDF header line; the 'ru' value is Russian on purpose (it goes into the Russian PDF).
const MEETING_WORD = { ru: 'заседание', ro: 'ședința din', en: 'meeting of' };

/** Only the minutes go into the PDF: without the letter on top and without the transcript below. We split on the
    "---" line (headings are translated into the minutes' language, but the separator is the same in all languages) and
    take the part right after the letter. Taking the last part is wrong: in the report file the minutes are followed
    by the "Original recording" section — this already bit us once, the PDF doubled in size. */
const protocolPart = (md) => {
  const parts = String(md || '').replace(/\r/g, '').split(/^---\s*$/m);
  return (parts.length > 1 ? parts[1] : parts[0]).trim();
};

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Markdown → HTML for printing. Levels are shifted by one, as in `markdown()` on the page:
    "## Minutes of the meeting" → h3, agenda item → h4. */
function printMarkdown(src) {
  const inline = (s) => escHtml(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of String(src || '').replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    const hd = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hd) { closeList(); const n = Math.min(4, hd[1].length + 1); out.push(`<h${n}>${inline(hd[2])}</h${n}>`); continue; }
    const li = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (li) { if (list !== 'ul') { closeList(); list = 'ul'; out.push('<ul>'); } out.push(`<li>${inline(li[1])}</li>`); continue; }
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ol) { if (list !== 'ol') { closeList(); list = 'ol'; out.push('<ol>'); } out.push(`<li>${inline(ol[1])}</li>`); continue; }
    if (!line.trim()) { closeList(); continue; }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

/** Layout of the printed minutes: short, without the letter and without the transcript. */
function printHtml({ lang, markdown, title, meetingDate }) {
  const when = meetingDate ? ` · ${MEETING_WORD[lang] || MEETING_WORD.ru} ${escHtml(meetingDate)}` : '';
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">`
    + `<title>${escHtml(title || 'Minutes')}</title><style>`
    + '@page{margin:18mm 16mm}'
    + 'body{font:14px/1.55 Arial,Helvetica,sans-serif;color:#0f172a;max-width:800px;margin:0 auto}'
    + '.src{color:#64748b;font-size:11px;margin:0 0 14px;border-bottom:1px solid #e2e8f0;padding-bottom:8px}'
    + 'h3{font-size:19px;margin:0 0 10px}h4{font-size:15px;margin:16px 0 6px}'
    + 'p{margin:6px 0}ul,ol{margin:6px 0 6px 20px;padding:0}li{margin:3px 0}'
    + 'h4,li{break-inside:avoid;page-break-inside:avoid}'
    + '</style></head><body>'
    + `<p class="src">MedMeet · MedMinute${when}</p>`
    + printMarkdown(protocolPart(markdown))
    + '</body></html>';
}

const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

async function chromePath() {
  for (const c of CHROME) { try { await fsp.access(c); return c; } catch { /* try the next one */ } }
  throw Object.assign(new Error('Chrome or Edge not found for PDF printing'), { code: 501 });
}

/** Minutes in the chosen language → PDF. Returns the file name in the reports folder. */
async function buildPdf(id, lang) {
  const exe = await chromePath();
  const row = store.jobRow(id);
  const rows = store.jobParts(id).files?.rows || [];
  const src = rows.find((r) => r.lang === lang) || rows[0];
  if (!src?.fileName) throw Object.assign(new Error('the report is not ready yet'), { code: 400 });
  const base = safeName(src.fileName).replace(/\.[a-z]+\.md$/i, '');
  const md = await fsp.readFile(path.join(REPORTS_DIR, safeName(src.fileName)), 'utf8');
  const html = printHtml({
    lang, markdown: md,
    title: row?.title || row?.file_name || id,
    meetingDate: row?.meeting_date || '',
  });
  const name = `${base}.${lang}.pdf`;
  const out = path.join(REPORTS_DIR, name);
  const tmp = path.join(REPORTS_DIR, `.${id}.${lang}.tmp.html`);
  const profile = path.join(REPORTS_DIR, `.chrome-profile`);
  await fsp.mkdir(REPORTS_DIR, { recursive: true });
  await fsp.writeFile(tmp, html, 'utf8');
  try {
    await new Promise((ok, bad) => {
      const ps = spawn(exe, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        `--user-data-dir=${profile}`, '--no-pdf-header-footer',
        `--print-to-pdf=${out}`, pathToFileURL(tmp).href,
      ], { windowsHide: true });
      const kill = setTimeout(() => { ps.kill(); bad(new Error('printing did not finish within 60 s')); }, 60_000);
      ps.on('error', bad);
      ps.on('close', (code) => { clearTimeout(kill); code === 0 ? ok() : bad(new Error(`the browser returned code ${code}`)); });
    });
    const stat = await fsp.stat(out);
    log('info', `job ${id}: PDF ${lang} — ${name} (${Math.round(stat.size / 1024)} KB)`);
    return { fileName: name, size: stat.size };
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

async function jobPdf(req, res, id) {
  const b = await readJson(req);
  const lang = ['ru', 'ro', 'en'].includes(b.lang) ? b.lang : 'ru';
  try {
    if (!store.jobRow(id)) throw Object.assign(new Error('job not found'), { code: 404 });
    return sendJson(res, 200, { ok: true, lang, ...await buildPdf(id, lang) });
  } catch (e) {
    log('error', `job ${id}: PDF build failed — ${e.message}`);
    return sendJson(res, e.code || 500, { error: e.message });
  }
}

const MAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;
const parseAddrs = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,;\s]+/)).filter(Boolean);

/** Sends the minutes to the participants. The report itself is read by the site (n8n has no disk access)
    and handed to the workflow as a ready email + attachment. Sending is via SMTP; the offline branch
    leads to a separate disabled node, because there is no local mail server on the network. */
async function sendReport(id, { to, lang: wanted, note = '', subject = '' } = {}) {
  const row = store.jobRow(id);
  if (!row) throw Object.assign(new Error('job not found'), { code: 404 });
  const bad = to.filter((a) => !MAIL_RE.test(a));
  if (!to.length) throw Object.assign(new Error('no address given'), { code: 400 });
  if (bad.length) throw Object.assign(new Error(`does not look like an address: ${bad.join(', ')}`), { code: 400 });

  const lang = ['ru', 'ro', 'en'].includes(wanted) ? wanted : 'ru';
  const parts = store.jobParts(id);
  const rows = parts.files?.rows || [];
  const file = rows.find((r) => r.lang === lang) || rows[0];
  const name = file?.fileName ? safeName(file.fileName) : '';
  if (!name) throw Object.assign(new Error('the report is not ready yet'), { code: 400 });
  let markdown;
  try {
    markdown = await fsp.readFile(path.join(REPORTS_DIR, name), 'utf8');
  } catch { throw Object.assign(new Error(`report file not found: ${name}`), { code: 410 }); }

  // The attachment is always a PDF: the recipient needs a readable document, not markdown.
  // The automatic mailing fires before anyone has opened the site, so
  // a missing PDF is printed right here.
  const pdfName = `${name.replace(/\.[a-z]+\.md$/i, '')}.${lang}.pdf`;
  let attach = { fileName: name, base64: Buffer.from(markdown, 'utf8').toString('base64'), mimeType: 'text/markdown', ext: 'md' };
  try {
    let pdf = await fsp.readFile(path.join(REPORTS_DIR, pdfName)).catch(() => null);
    if (!pdf) { await buildPdf(id, lang); pdf = await fsp.readFile(path.join(REPORTS_DIR, pdfName)); }
    attach = { fileName: pdfName, base64: pdf.toString('base64'), mimeType: 'application/pdf', ext: 'pdf' };
  } catch (e) {
    log('warn', `job ${id}: PDF build failed (${e.message}) — attaching markdown instead`);
  }

  const title = row.title || row.file_name || id;
  const payload = {
    jobId: id, mode: row.mode, lang, to,
    subject: subject || `Meeting minutes: ${title}${row.meeting_date ? ` (${row.meeting_date})` : ''}`,
    title, meetingDate: row.meeting_date || '', note: String(note).slice(0, 2000),
    participants: parts.mom?.participants || '',
    markdown,
    fileName: attach.fileName, fileBase64: attach.base64,
    mimeType: attach.mimeType, fileExtension: attach.ext,
    siteUrl: PUBLIC_URL, meetingUrl: PUBLIC_URL ? `${PUBLIC_URL}/#/m/${id}` : '',
  };
  const r = await fetch(HOOKS.email, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(60_000),
  });
  const text = (await r.text()).slice(0, 600);
  if (!r.ok) throw Object.assign(new Error(`${r.status} ${text}`), { code: 502 });

  const sent = { at: new Date().toISOString(), to, lang, fileName: attach.fileName, response: text };
  store.savePart(id, 'email', { ...(parts.email || {}), last: sent, log: [...(parts.email?.log || []), sent].slice(-20) });
  store.updateJob(id, { emailSentAt: sent.at });
  log('info', `job ${id}: minutes sent — ${to.join(', ')}`);
  return { ok: true, to, lang, fileName: attach.fileName, attached: attach.ext, response: text };
}

async function emailReport(req, res, id) {
  const b = await readJson(req);
  try {
    return sendJson(res, 200, await sendReport(id, { ...b, to: parseAddrs(b.to) }));
  } catch (e) {
    log('error', `job ${id}: mailing failed — ${e.message}`);
    return sendJson(res, e.code === 502 || !e.code ? 502 : e.code, {
      error: e.code ? e.message : `Mailing workflow unavailable (${HOOKS.email}): ${e.message}`,
    });
  }
}

/** Meeting addresses: first the voice registry (whoever spoke gets the email),
    then whatever the moderator entered when uploading the recording. */
function recipientsFor(id) {
  const row = store.jobRow(id);
  const byVoice = store.jobRecipients(id);
  return [...new Set([...byVoice, ...parseAddrs(row?.email_to)])].filter((a) => MAIL_RE.test(a));
}

/** The minutes are ready — send them automatically if there is anyone to send to. Never send twice. */
function queueEmail(id) {
  const row = store.jobRow(id);
  if (!row || row.email_sent_at) return;
  const to = recipientsFor(id);
  if (!to.length) return;
  sendReport(id, { to, lang: 'ru' }).then(() => emit(id))
    .catch((e) => log('warn', `job ${id}: automatic sending failed — ${e.message}`));
}

async function n8nPing(res) {
  const out = { ok: false, hooks: HOOKS };
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch(`${N8N_BASE}/healthz`, { signal: ctrl.signal });
    out.ok = r.ok;
  } catch { /* n8n is not responding */ }
  sendJson(res, 200, out);
}

// ---------- routing ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  try {
    if (req.method === 'POST' && p === '/api/jobs') return await createJob(req, res, url);
    if (req.method === 'GET' && p === '/api/jobs') {
      const withHidden = url.searchParams.get('hidden') === '1';
      return sendJson(res, 200, { jobs: store.allJobs({ hidden: withHidden }).map(summary) });
    }
    if (req.method === 'GET' && p === '/api/health') {
      return sendJson(res, 200, { ok: true, port: PORT, hooks: HOOKS, audioDir: AUDIO_DIR, reportsDir: REPORTS_DIR, db: store.DB_PATH });
    }
    if (req.method === 'GET' && p === '/api/n8n-ping') return await n8nPing(res);
    if (req.method === 'GET' && p === '/api/meta') {
      return sendJson(res, 200, {
        extensions: [...ALLOWED_EXT].map((e) => `.${e}`),
        maxUploadMb: Math.round(MAX_UPLOAD / 1048576),
        parts: [...PARTS], hooks: HOOKS, audioDir: AUDIO_DIR, reportsDir: REPORTS_DIR, db: store.DB_PATH,
      });
    }
    if (req.method === 'GET' && p === '/api/asr/health') return await asrGet(res, '/health');
    if (req.method === 'GET' && p === '/api/asr/voices') return await asrGet(res, '/voices');
    if (req.method === 'POST' && p === '/api/asr/voices/enroll') return await enrollVoice(req, res, url);

    const rep = /^\/api\/reports\/(.+)$/.exec(p);
    if (req.method === 'GET' && rep) {
      const name = safeName(decodeURIComponent(rep[1]));
      const full = path.join(REPORTS_DIR, name);
      if (!path.resolve(full).startsWith(path.resolve(REPORTS_DIR))) return send(res, 403, 'forbidden');
      try {
        if (/\.pdf$/i.test(name)) {                       // serve PDF as is, not as text
          const buf = await fsp.readFile(full);
          return send(res, 200, buf, { 'Content-Type': 'application/pdf', 'Content-Length': buf.length });
        }
        const text = await fsp.readFile(full, 'utf8');
        return send(res, 200, text, { 'Content-Type': 'text/markdown; charset=utf-8' });
      } catch { return sendJson(res, 404, { error: 'file not found' }); }
    }

    // summary queries straight from SQL — the site itself serves results across all meetings
    if (req.method === 'GET' && p === '/api/db/overview') return sendJson(res, 200, store.overview());
    if (req.method === 'GET' && p === '/api/db/people') return sendJson(res, 200, { rows: store.people() });
    if (req.method === 'GET' && p === '/api/db/voices') {
      return sendJson(res, 200, {
        rows: store.voices({ hidden: url.searchParams.get('hidden') === '1' }),
        prints: store.voicePrints(),
      });
    }
    if (req.method === 'GET' && p === '/api/db/patients/summary') return sendJson(res, 200, { rows: store.patients() });
    const dbm = /^\/api\/db\/(decisions|tasks|patients|speakers)$/.exec(p);
    if (req.method === 'GET' && dbm) {
      return sendJson(res, 200, store.tableRows(dbm[1], {
        q: url.searchParams.get('q') || '',
        jobId: url.searchParams.get('jobId') || '',
        limit: url.searchParams.get('limit') || 500,
        offset: url.searchParams.get('offset') || 0,
        hidden: url.searchParams.get('hidden') === '1',
        named: url.searchParams.get('named') === '1',
      }));
    }
    // "Hide" — the record stays in the database but no longer clutters the lists (nothing needs deleting)
    const hidem = /^\/api\/db\/(decisions|tasks|patients|speakers)\/hide$/.exec(p);
    if (req.method === 'POST' && hidem) {
      const b = await readJson(req);
      if (!b.rowid) return sendJson(res, 400, { error: 'rowid is missing' });
      return sendJson(res, 200, { ok: true, row: store.hideRow(hidem[1], b.rowid, b.hidden ?? 1) });
    }
    if (req.method === 'POST' && p === '/api/db/voiceprints/reindex') {
      const b = await readJson(req);
      return sendJson(res, 200, { ok: true, ...store.reindexVoices({ all: !!b.all }) });
    }
    // A name and email set once apply to all meetings of this voice
    const namem = /^\/api\/db\/voiceprints\/(V-\d+)\/name$/.exec(p);
    if (req.method === 'POST' && namem) {
      const b = await readJson(req);
      const name = String(b.name || '').trim();
      const email = String(b.email || '').trim();
      if (!name) return sendJson(res, 400, { error: 'name is missing' });
      if (email && !MAIL_RE.test(email)) return sendJson(res, 400, { error: `does not look like an address: ${email}` });
      const n = store.nameVoice(namem[1], name, b.role ? String(b.role).trim() : null, email || null);
      if (n === null) return sendJson(res, 404, { error: 'no such voice id' });
      return sendJson(res, 200, { ok: true, voiceId: namem[1], name, email, updated: n });
    }

    const m = /^\/api\/jobs\/([A-Za-z0-9-]+)(\/[a-z/]*)?$/.exec(p);
    if (m) {
      const id = m[1];
      const tail = m[2] || '';
      if (req.method === 'GET' && tail === '') {
        const job = fullJob(id);
        return job ? sendJson(res, 200, job) : sendJson(res, 404, { error: 'job not found' });
      }
      if (req.method === 'GET' && tail === '/events') return subscribe(req, res, id);
      if (req.method === 'POST' && tail === '/voiceid') return await jobVoiceId(res, id);
      if (req.method === 'POST' && tail === '/email') return await emailReport(req, res, id);
      if (req.method === 'POST' && tail === '/pdf') return await jobPdf(req, res, id);
      if (req.method === 'POST' && tail === '/hide') {
        if (!store.jobRow(id)) return sendJson(res, 404, { error: 'job not found' });
        const b = await readJson(req);
        return sendJson(res, 200, { ok: true, job: store.hideJob(id, b.hidden ?? 1) });
      }
      if (req.method === 'POST' && tail === '/status') return await putStatus(req, res, id);
      const pm = /^\/(?:part|result)\/([a-z]+)$/.exec(tail);
      if (req.method === 'POST' && pm) return await putPart(req, res, id, pm[1]);
      if (req.method === 'POST' && tail === '/result') {
        const body = await readJson(req);
        if (!store.jobRow(id)) return sendJson(res, 404, { error: 'job not found' });
        for (const [k, v] of Object.entries(body)) if (PARTS.has(k)) store.savePart(id, k, v);
        store.updateJob(id, { status: 'done', stage: 'done', finishedAt: new Date().toISOString() });
        emit(id);
        queueVoiceId(id);
        return sendJson(res, 200, { ok: true });
      }
    }

    if (req.method === 'GET') return await serveStatic(req, res, p);
    sendJson(res, 405, { error: 'method not supported' });
  } catch (e) {
    log('error', `${req.method} ${p}: ${e.stack || e.message}`);
    if (!res.headersSent) sendJson(res, e.code === 413 ? 413 : 500, { error: e.message });
  }
});

server.requestTimeout = 0; // a large file may take long to upload
server.headersTimeout = 60_000;

// If a workflow fails, n8n does not tell the site — the job would hang in "processing" forever.
// A job is considered stalled if neither a status nor result parts have arrived for a long time.
const STALL_MS = Number(process.env.STALL_MIN || 20) * 60_000;

function checkStalled() {
  const edge = new Date(Date.now() - STALL_MS).toISOString();
  for (const row of store.db.all(
    "SELECT id, stage FROM jobs WHERE status IN ('queued','processing') AND updated_at < ?", [edge])) {
    const msg = `No response from n8n for more than ${STALL_MS / 60_000} min (last stage: ${row.stage || '—'}). `
      + 'Open the execution in n8n, the cause will be there.';
    store.updateJob(row.id, { status: 'error', stage: 'n8n is not responding', error: msg });
    emit(row.id);
    log('error', `job ${row.id}: ${msg}`);
  }
}
setInterval(checkStalled, 60_000).unref();

server.listen(PORT, HOST, () => {
  log('info', `MedMinute → http://localhost:${PORT}`);
  log('info', `webhooks: online ${HOOKS.online} | offline ${HOOKS.offline}`);
  log('info', `audio ${AUDIO_DIR} · reports ${REPORTS_DIR} · database ${store.DB_PATH}`);
});
