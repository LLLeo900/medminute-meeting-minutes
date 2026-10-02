// Local database (SQLite via WASM — no compilation, works offline).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Database } = require('node-sqlite3-wasm');

const DB_PATH = path.join(__dirname, 'data', 'medminute.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'online',
  status TEXT NOT NULL,
  stage TEXT,
  error TEXT,
  file_name TEXT,
  ext TEXT,
  size_bytes INTEGER,
  input_path TEXT,
  title TEXT,
  meeting_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS job_parts (
  job_id TEXT NOT NULL,
  part TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, part)
);
CREATE TABLE IF NOT EXISTS decisions (
  job_id TEXT, n INTEGER, meeting_date TEXT, meeting TEXT, patient TEXT, decision TEXT,
  proposed_by TEXT, approved_by TEXT, timecode TEXT, context TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  job_id TEXT, n INTEGER, meeting_date TEXT, meeting TEXT, patient TEXT, task TEXT,
  owner TEXT, deadline TEXT, timecode TEXT, status TEXT
);
CREATE TABLE IF NOT EXISTS medications (
  job_id TEXT, n INTEGER, meeting_date TEXT, patient TEXT, bed TEXT, condition TEXT,
  drug TEXT, drug_normalized TEXT, dose TEXT, route TEXT, action TEXT, by_whom TEXT,
  timecode TEXT, quote TEXT, confidence TEXT, note TEXT
);
CREATE TABLE IF NOT EXISTS speakers (
  job_id TEXT, label TEXT, name TEXT, role TEXT, confidence TEXT, evidence TEXT
);
-- Cross-meeting voice registry: one person = one row, the voice_id is the same in all meetings.
CREATE TABLE IF NOT EXISTS voice_prints (
  voice_id TEXT PRIMARY KEY,
  centroid TEXT NOT NULL,
  dim INTEGER,
  samples INTEGER NOT NULL DEFAULT 1,
  model TEXT,
  name TEXT,
  role TEXT,
  first_seen TEXT,
  last_seen TEXT
);
CREATE INDEX IF NOT EXISTS idx_dec_job ON decisions(job_id);
CREATE INDEX IF NOT EXISTS idx_task_job ON tasks(job_id);
CREATE INDEX IF NOT EXISTS idx_med_job ON medications(job_id);
CREATE INDEX IF NOT EXISTS idx_spk_job ON speakers(job_id);
`);

// Columns added later: old databases do not have them; ALTER inside try is the migration.
const MIGRATIONS = {
  speakers: [['vector', 'TEXT'], ['voice_model', 'TEXT'], ['seconds', 'REAL'], ['lines', 'INTEGER'],
    ['match_score', 'REAL'], ['matched_name', 'TEXT'], ['voice_id', 'TEXT'], ['voice_score', 'REAL'],
    ['hidden', 'INTEGER NOT NULL DEFAULT 0']],
  voice_prints: [['email', 'TEXT']],
  jobs: [['hidden', 'INTEGER NOT NULL DEFAULT 0'], ['email_to', 'TEXT'], ['email_sent_at', 'TEXT']],
  decisions: [['hidden', 'INTEGER NOT NULL DEFAULT 0']],
  tasks: [['hidden', 'INTEGER NOT NULL DEFAULT 0']],
  medications: [['hidden', 'INTEGER NOT NULL DEFAULT 0']],
};
for (const [table, cols] of Object.entries(MIGRATIONS)) {
  for (const [col, decl] of cols) {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`); } catch { /* already exists */ }
  }
}

const now = () => new Date().toISOString();

function insertJob(job) {
  db.run(
    `INSERT INTO jobs (id, mode, status, stage, file_name, ext, size_bytes, input_path, email_to, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [job.id, job.mode, job.status, job.stage, job.fileName, job.ext, job.sizeBytes, job.inputPath,
      job.emailTo || null, job.createdAt, now()],
  );
}

function updateJob(id, fields) {
  const map = {
    status: 'status', stage: 'stage', error: 'error', title: 'title',
    meetingDate: 'meeting_date', finishedAt: 'finished_at', mode: 'mode',
    emailTo: 'email_to', emailSentAt: 'email_sent_at',
  };
  const set = [];
  const vals = [];
  for (const [k, col] of Object.entries(map)) {
    if (k in fields) { set.push(`${col} = ?`); vals.push(fields[k] ?? null); }
  }
  set.push('updated_at = ?'); vals.push(now());
  vals.push(id);
  db.run(`UPDATE jobs SET ${set.join(', ')} WHERE id = ?`, vals);
}

function savePart(jobId, part, data) {
  db.run('INSERT OR REPLACE INTO job_parts (job_id, part, data, created_at) VALUES (?, ?, ?, ?)',
    [jobId, part, JSON.stringify(data), now()]);
  if (part === 'decisions') fillDecisions(jobId, data);
  if (part === 'tasks') fillTasks(jobId, data);
  if (part === 'patients') fillMedications(jobId, data);
  if (part === 'transcript') fillSpeakers(jobId, data);
  if (part === 'mom') {
    updateJob(jobId, { title: data?.title || null, meetingDate: data?.meetingDate || null });
  }
}

const g = (r, ...keys) => { for (const k of keys) if (r?.[k] != null && r[k] !== '') return String(r[k]); return ''; };

// The model writes "not specified" / "patient not named" — for the database that is the same as empty.
// Otherwise such rows cannot be filtered and look like a real patient named "not specified".
// The Cyrillic alternatives are intentional: they catch the same placeholders when the model answers in Russian.
const NONAME = /^(не\s|нет\b|—|-{1,2}$|н\/д|n\/a|unknown|not\s|none\b|unnamed)/i;
const person = (v) => (NONAME.test(String(v).trim()) ? '' : String(v).trim());

function fillDecisions(jobId, data) {
  db.run('DELETE FROM decisions WHERE job_id = ?', [jobId]);
  (data?.rows || []).forEach((r, i) => db.run(
    `INSERT INTO decisions (job_id, n, meeting_date, meeting, patient, decision,
                            proposed_by, approved_by, timecode, context) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [jobId, Number(g(r, '#')) || i + 1, g(r, 'Meeting date'), g(r, 'Meeting'), person(g(r, 'Patient')),
      g(r, 'Decision'), g(r, 'Proposed by'), g(r, 'Approved by'), g(r, 'Timecode'), g(r, 'Context')]));
}

function fillTasks(jobId, data) {
  db.run('DELETE FROM tasks WHERE job_id = ?', [jobId]);
  (data?.rows || []).forEach((r, i) => db.run(
    `INSERT INTO tasks (job_id, n, meeting_date, meeting, patient, task,
                        owner, deadline, timecode, status) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [jobId, Number(g(r, '#')) || i + 1, g(r, 'Meeting date'), g(r, 'Meeting'), person(g(r, 'Patient')),
      g(r, 'Task'), g(r, 'Owner'), g(r, 'Deadline'), g(r, 'Timecode'), g(r, 'Status') || 'New']));
}

function fillMedications(jobId, data) {
  db.run('DELETE FROM medications WHERE job_id = ?', [jobId]);
  (data?.rows || []).forEach((r, i) => db.run(
    `INSERT INTO medications (job_id, n, meeting_date, patient, bed, condition,
                             drug, drug_normalized, dose, route, action, by_whom,
                             timecode, quote, confidence, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [jobId, i + 1, g(r, 'Meeting date'), person(g(r, 'Patient')), g(r, 'Bed / ward'), g(r, 'Condition (as stated)'),
      g(r, 'Drug (as heard)'), g(r, 'Drug (probable)'), g(r, 'Dose'), g(r, 'Route'),
      g(r, 'Action'), g(r, 'Prescribed / reported by'), g(r, 'Timecode'), g(r, 'Quote'),
      g(r, 'Confidence'), g(r, 'Note')]));
}

function fillSpeakers(jobId, data) {
  const keep = db.all(`SELECT label, vector, voice_model, seconds, lines, match_score, matched_name,
                              voice_id, voice_score
                       FROM speakers WHERE job_id = ? AND vector IS NOT NULL`, [jobId]);
  db.run('DELETE FROM speakers WHERE job_id = ?', [jobId]);
  for (const s of data?.evidence || []) {
    const v = keep.find((k) => k.label === (s.speaker || '')) || {};
    db.run(`INSERT INTO speakers (job_id, label, name, role, confidence, evidence,
                                  vector, voice_model, seconds, lines, match_score, matched_name,
                                  voice_id, voice_score)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [jobId, s.speaker || '', s.name || '', s.role || '', s.confidence || '', s.evidence || '',
      v.vector ?? null, v.voice_model ?? null, v.seconds ?? null, v.lines ?? null,
      v.match_score ?? null, v.matched_name ?? null, v.voice_id ?? null, v.voice_score ?? null]);
  }
}

// ---------- cross-meeting voice id ----------

// Cosine threshold for "this is the same person". Below 0.6 the model starts confusing similar voices,
// above 0.75 the same person in different recordings splits into two ids.
const SAME_VOICE = Number(process.env.VOICE_MATCH || 0.66);

const cos = (a, b) => {
  let d = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return (na && nb) ? d / Math.sqrt(na * nb) : 0;
};

function nextVoiceId() {
  const last = db.get("SELECT voice_id FROM voice_prints ORDER BY voice_id DESC LIMIT 1");
  const n = last ? (Number(String(last.voice_id).replace(/\D/g, '')) || 0) + 1 : 1;
  return `V-${String(n).padStart(3, '0')}`;
}

/** Look the voice up in the registry and return a permanent voice_id.
    Found — refine the centroid (running average); not found — register a new person.
    This is exactly what keeps the id the same on the next recording of the same person. */
function resolveVoiceId(vec, { model = '', name = '', seconds = 0 } = {}) {
  const prints = db.all('SELECT * FROM voice_prints WHERE dim = ?', [vec.length]);
  let best = null;
  let score = 0;
  for (const p of prints) {
    let c;
    try { c = cos(vec, JSON.parse(p.centroid)); } catch { continue; }
    if (c > score) { score = c; best = p; }
  }
  const stamp = now();
  if (best && score >= SAME_VOICE) {
    const old = JSON.parse(best.centroid);
    const k = best.samples || 1;
    const mix = old.map((x, i) => (x * k + vec[i]) / (k + 1));
    db.run(`UPDATE voice_prints SET centroid = ?, samples = samples + 1, last_seen = ?,
                                    name = CASE WHEN name IS NULL OR name = '' THEN ? ELSE name END
            WHERE voice_id = ?`, [JSON.stringify(mix), stamp, name || '', best.voice_id]);
    return { voiceId: best.voice_id, score: Math.round(score * 1000) / 1000, name: best.name || name || '' };
  }
  // A short utterance gives a noisy vector; do not register a new person from it, or the registry gets cluttered.
  if (seconds && seconds < 3) return { voiceId: null, score: Math.round(score * 1000) / 1000, name };
  const id = nextVoiceId();
  db.run(`INSERT INTO voice_prints (voice_id, centroid, dim, samples, model, name, first_seen, last_seen)
          VALUES (?,?,?,1,?,?,?,?)`,
  [id, JSON.stringify(vec), vec.length, model, name || '', stamp, stamp]);
  return { voiceId: id, score: Math.round(score * 1000) / 1000, name };
}

/** Voice prints from the local voice id (ASR /diarize) — stored next to the "Participant N" labels
    and linked to the cross-meeting registry: one person's voice_id does not change between meetings. */
function saveVoiceId(jobId, data) {
  const model = data?.voiceIdModel || data?.method || '';
  // A recount replaces the whole set of prints: if a label got no vector this time,
  // the previous one must go, otherwise the speaker keeps a print that does not belong there.
  db.run(`UPDATE speakers SET vector = NULL, voice_model = NULL, seconds = NULL, lines = NULL,
                              match_score = NULL, matched_name = NULL, voice_id = NULL, voice_score = NULL
          WHERE job_id = ?`, [jobId]);
  const ids = {};
  for (const [label, vec] of Object.entries(data?.vectors || {})) {
    const st = data.stats?.[label] || {};
    const matched = data.names?.[label] || null;
    const score = data.scores?.[label] ?? null;
    const row = db.get('SELECT rowid, name FROM speakers WHERE job_id = ? AND label = ?', [jobId, label]);
    const reg = resolveVoiceId(vec, { model, name: matched || row?.name || '', seconds: st.seconds || 0 });
    ids[label] = { voiceId: reg.voiceId, score: reg.score, name: reg.name };
    const known = matched || reg.name || null;   // name from a reference recording or remembered for this voice_id
    const vals = [JSON.stringify(vec), model, st.seconds ?? null, st.lines ?? null, score, matched,
      reg.voiceId, reg.score];
    if (row) {
      db.run(`UPDATE speakers SET vector = ?, voice_model = ?, seconds = ?, lines = ?,
                                  match_score = ?, matched_name = ?, voice_id = ?, voice_score = ?
              WHERE rowid = ?`, [...vals, row.rowid]);
      if (known) db.run("UPDATE speakers SET name = ? WHERE rowid = ? AND (name IS NULL OR name = '')", [known, row.rowid]);
    } else {
      db.run(`INSERT INTO speakers (job_id, label, name, role, confidence, evidence,
                                    vector, voice_model, seconds, lines, match_score, matched_name,
                                    voice_id, voice_score)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [jobId, label, known || '', '', '', '', ...vals]);
    }
  }
  return { prints: db.get('SELECT COUNT(*) c FROM speakers WHERE job_id = ? AND vector IS NOT NULL', [jobId]).c, ids };
}

/** Rebuild the registry from already captured vectors: needed after changing the threshold or for old meetings
    that have a print but no cross-meeting voice_id yet. Audio and models are not touched. */
function reindexVoices({ all = false } = {}) {
  if (all) { db.run('DELETE FROM voice_prints'); db.run('UPDATE speakers SET voice_id = NULL, voice_score = NULL'); }
  const rows = db.all(`SELECT rowid, job_id, label, name, vector, voice_model, seconds
                       FROM speakers WHERE vector IS NOT NULL AND (voice_id IS NULL OR ? = 1)
                       ORDER BY job_id, label`, [all ? 1 : 0]);
  let n = 0;
  for (const r of rows) {
    let vec;
    try { vec = JSON.parse(r.vector); } catch { continue; }
    const reg = resolveVoiceId(vec, { model: r.voice_model || '', name: r.name || '', seconds: r.seconds || 0 });
    db.run('UPDATE speakers SET voice_id = ?, voice_score = ? WHERE rowid = ?', [reg.voiceId, reg.score, r.rowid]);
    if (reg.name) db.run("UPDATE speakers SET name = ? WHERE rowid = ? AND (name IS NULL OR name = '')", [reg.name, r.rowid]);
    n++;
  }
  return { linked: n, prints: db.get('SELECT COUNT(*) c FROM voice_prints').c };
}

/** A person's name is set once — after that it is filled into all their meetings via voice_id. */
function nameVoice(voiceId, name, role = null, email = null) {
  const p = db.get('SELECT voice_id FROM voice_prints WHERE voice_id = ?', [voiceId]);
  if (!p) return null;
  db.run('UPDATE voice_prints SET name = ?, role = COALESCE(?, role), email = COALESCE(?, email) WHERE voice_id = ?',
    [name, role, email, voiceId]);
  db.run('UPDATE speakers SET name = ? WHERE voice_id = ?', [name, voiceId]);
  if (role) db.run("UPDATE speakers SET role = ? WHERE voice_id = ? AND (role IS NULL OR role = '')", [role, voiceId]);
  return db.get('SELECT COUNT(*) c FROM speakers WHERE voice_id = ?', [voiceId]).c;
}

/** Voice registry: one row = one person, how many times heard and in which meetings. */
function voicePrints() {
  return db.all(`SELECT p.voice_id, p.name, p.role, p.email, p.samples, p.dim, p.model,
                        p.first_seen, p.last_seen,
                        COUNT(DISTINCT s.job_id) meetings,
                        ROUND(SUM(COALESCE(s.seconds, 0)), 1) seconds
                 FROM voice_prints p LEFT JOIN speakers s ON s.voice_id = p.voice_id
                 GROUP BY p.voice_id ORDER BY meetings DESC, p.voice_id`);
}

function jobRow(id) {
  return db.get('SELECT * FROM jobs WHERE id = ?', [id]);
}

function jobParts(id) {
  const out = {};
  for (const r of db.all('SELECT part, data FROM job_parts WHERE job_id = ?', [id])) {
    try { out[r.part] = JSON.parse(r.data); } catch { /* skip a corrupted part */ }
  }
  return out;
}

/** Speakers of one meeting together with the cross-meeting voice_id and the name from the registry. */
function jobSpeakers(id) {
  return db.all(`SELECT s.label, s.name, s.role, s.confidence, s.evidence, s.voice_id, s.voice_score,
                        s.voice_model, s.seconds, s.lines, s.matched_name, s.match_score,
                        p.name voice_name, p.email voice_email, p.samples voice_samples
                 FROM speakers s LEFT JOIN voice_prints p ON p.voice_id = s.voice_id
                 WHERE s.job_id = ? ORDER BY s.label`, [id]);
}

/** Email addresses of a meeting's participants — from the voice registry. An empty list = no link yet;
    then the moderator enters the addresses (at upload or on the meeting card). */
function jobRecipients(id) {
  return db.all(`SELECT DISTINCT p.email FROM speakers s JOIN voice_prints p ON p.voice_id = s.voice_id
                 WHERE s.job_id = ? AND p.email IS NOT NULL AND p.email <> ''`, [id])
    .map((r) => r.email);
}

function allJobs({ hidden = false } = {}) {
  return db.all(`SELECT * FROM jobs ${hidden ? '' : 'WHERE hidden = 0'} ORDER BY created_at DESC`);
}

/** "Hide" instead of delete: the record stays in the database but leaves the lists. */
function hideJob(id, hidden) {
  db.run('UPDATE jobs SET hidden = ?, updated_at = ? WHERE id = ?', [hidden ? 1 : 0, now(), id]);
  return db.get('SELECT id, hidden FROM jobs WHERE id = ?', [id]);
}

function hideRow(kind, rowid, hidden) {
  const t = TABLES[kind];
  if (!t) throw new Error(`unknown table: ${kind}`);
  db.run(`UPDATE ${t.table} SET hidden = ? WHERE rowid = ?`, [hidden ? 1 : 0, Number(rowid)]);
  return db.get(`SELECT rowid, hidden FROM ${t.table} WHERE rowid = ?`, [Number(rowid)]);
}

function counts(id) {
  const one = (t) => db.get(`SELECT COUNT(*) c FROM ${t} WHERE job_id = ?`, [id]).c;
  return { decisions: one('decisions'), tasks: one('tasks'), patients: one('medications') };
}

function partNames(id) {
  return db.all('SELECT part FROM job_parts WHERE job_id = ?', [id]).map((r) => r.part);
}

// ---------- summary queries across all meetings ----------

const TABLES = {
  decisions: {
    table: 'decisions', hasPatient: true,
    search: ['patient', 'decision', 'proposed_by', 'approved_by', 'meeting', 'context'],
    order: 'j.created_at DESC, d.n',
  },
  tasks: {
    table: 'tasks', hasPatient: true,
    search: ['patient', 'task', 'owner', 'deadline', 'meeting', 'status'],
    order: 'j.created_at DESC, d.n',
  },
  patients: {
    table: 'medications', hasPatient: true,
    search: ['patient', 'bed', 'condition', 'drug', 'drug_normalized', 'dose', 'by_whom', 'quote'],
    order: 'j.created_at DESC, d.patient, d.n',
  },
  speakers: {
    table: 'speakers',
    search: ['label', 'name', 'role', 'evidence', 'voice_id'],
    order: 'j.created_at DESC, d.label',
  },
};

/** Rows of one entity across all meetings: /api/db/decisions?q=...&limit=...
    hidden=1 — include hidden ones, named=1 — only records with a specific patient. */
function tableRows(kind, { q = '', jobId = '', limit = 500, offset = 0, hidden = false, named = false } = {}) {
  const t = TABLES[kind];
  if (!t) throw new Error(`unknown table: ${kind}`);
  const where = [];
  const vals = [];
  if (jobId) { where.push('d.job_id = ?'); vals.push(jobId); }
  if (!hidden) where.push('d.hidden = 0 AND j.hidden = 0');
  // An anonymous record ("patient not named") is useless for work — it can be filtered out.
  if (named && t.hasPatient) where.push("TRIM(COALESCE(d.patient, '')) <> ''");
  if (q) {
    where.push(`(${t.search.map((c) => `d.${c} LIKE ?`).join(' OR ')})`);
    for (const _ of t.search) vals.push(`%${q}%`);
  }
  const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.all(
    `SELECT d.rowid AS rowid, d.*, j.title AS job_title, j.meeting_date AS job_date, j.mode AS job_mode,
            j.file_name AS job_file, j.created_at AS job_created, j.hidden AS job_hidden
     FROM ${t.table} d JOIN jobs j ON j.id = d.job_id
     ${cond} ORDER BY ${t.order} LIMIT ? OFFSET ?`,
    [...vals, Math.min(Number(limit) || 500, 5000), Number(offset) || 0]);
  for (const r of rows) {
    if ('vector' in r) { r.has_print = r.vector ? 1 : 0; delete r.vector; }   // hundreds of numbers are not needed in a list
  }
  const total = db.get(
    `SELECT COUNT(*) c FROM ${t.table} d JOIN jobs j ON j.id = d.job_id ${cond}`, vals).c;
  return { kind, total, rows };
}

/** Numbers for the main page: how many meetings, decisions, tasks, prescriptions, people. */
function overview() {
  const one = (sql, v = []) => db.get(sql, v);
  return {
    jobs: one(`SELECT COUNT(*) total,
                 SUM(status = 'done') done,
                 SUM(status = 'error') failed,
                 SUM(status IN ('queued','processing')) active,
                 SUM(mode = 'online') online,
                 SUM(mode = 'offline') offline,
                 SUM(hidden = 1) hidden FROM jobs`),
    decisions: one('SELECT COUNT(*) c FROM decisions WHERE hidden = 0').c,
    tasks: one('SELECT COUNT(*) c FROM tasks WHERE hidden = 0').c,
    medications: one('SELECT COUNT(*) c FROM medications WHERE hidden = 0').c,
    patients: one("SELECT COUNT(DISTINCT patient) c FROM medications WHERE patient <> '' AND hidden = 0").c,
    people: one("SELECT COUNT(DISTINCT name) c FROM speakers WHERE name <> ''").c,
    voiceIds: one('SELECT COUNT(*) c FROM voice_prints').c,
    db: DB_PATH,
  };
}

/** People the system recognised by voice — for the "Voices" section. */
function people() {
  return db.all(`SELECT name, role, COUNT(DISTINCT job_id) meetings, MAX(confidence) confidence,
                        MAX(match_score) match_score,
                        SUM(CASE WHEN vector IS NULL THEN 0 ELSE 1 END) prints
                 FROM speakers WHERE name <> '' GROUP BY name, role ORDER BY meetings DESC, name`);
}

/** All voices across all meetings: is there a print, which model took it, how long they spoke, cross-meeting voice id. */
function voices({ hidden = false } = {}) {
  return db.all(`SELECT s.job_id, s.label, s.name, s.role, s.matched_name, s.match_score,
                        s.voice_model, s.seconds, s.lines, s.voice_id, s.voice_score,
                        CASE WHEN s.vector IS NULL THEN 0 ELSE 1 END has_print,
                        p.name voice_name, p.samples voice_samples,
                        j.title job_title, j.meeting_date job_date, j.mode job_mode, j.created_at job_created
                 FROM speakers s JOIN jobs j ON j.id = s.job_id
                 LEFT JOIN voice_prints p ON p.voice_id = s.voice_id
                 ${hidden ? '' : 'WHERE j.hidden = 0'}
                 ORDER BY j.created_at DESC, s.label`);
}

/** Patients with a summary of prescriptions. */
function patients() {
  return db.all(`SELECT patient, MAX(bed) bed, COUNT(*) records,
                        COUNT(DISTINCT job_id) meetings, MAX(job_id) last_job
                 FROM medications WHERE patient <> '' AND hidden = 0
                 GROUP BY patient ORDER BY records DESC, patient`);
}

module.exports = {
  db, insertJob, updateJob, savePart, saveVoiceId, nameVoice, voicePrints, reindexVoices,
  jobRow, jobParts, jobSpeakers, jobRecipients,
  allJobs, hideJob, hideRow, counts, partNames,
  tableRows, overview, people, voices, patients, DB_PATH,
};
