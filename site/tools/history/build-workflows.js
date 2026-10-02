/* Rebuilds the n8n workflows from the original "MedMinute Online":
   - form → webhook from the site localhost:7777
   - Google Sheets → sending the result back to the site
   Run: node tools/history/build-workflows.js [--push]
*/
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'wf-online-current.json');
const OUT = path.join(__dirname, '..', '..', 'workflows');
fs.mkdirSync(OUT, { recursive: true });

const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const byName = (nodes, name) => nodes.find((n) => n.name === name);

// ---------- shared pieces ----------

const JOB = 'Job';
const cb = `{{ $('${JOB}').first().json.callbackUrl }}`;
const jobId = `$('${JOB}').first().json.jobId`;

function webhookNode(pathName, pos) {
  return {
    parameters: {
      httpMethod: 'POST',
      path: pathName,
      responseMode: 'onReceived',
      responseData: 'noData',
      options: {},
    },
    id: `hook-${pathName}`,
    name: 'Start (webhook from site)',
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    position: pos,
    webhookId: `medminute-${pathName}`,
  };
}

function jobNode(pos) {
  return {
    parameters: {
      jsCode: `// Job data from the site localhost:7777 (one flat record for the whole run)
const b = $input.first().json.body || $input.first().json;
if (!b.jobId) throw new Error('Webhook called without jobId — it must be started from the site http://localhost:7777');
const audioDir = (b.audioDir || 'C:/medminute/audio').replace(/\\\\/g, '/');
return [{ json: {
  jobId: b.jobId,
  mode: b.mode || 'online',
  fileName: b.fileName || 'audio',
  ext: b.ext || 'm4a',
  inputPath: (b.inputPath || \`\${audioDir}/\${b.jobId}_input.\${b.ext || 'm4a'}\`).replace(/\\\\/g, '/'),
  audioDir,
  reportsDir: (b.reportsDir || 'C:/medminute/reports').replace(/\\\\/g, '/'),
  submittedAt: b.submittedAt || new Date().toISOString(),
  callbackUrl: b.callbackUrl || \`http://localhost:7777/api/jobs/\${b.jobId}\`,
} }];`,
    },
    id: 'job-ctx',
    name: JOB,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: pos,
  };
}

function postNode(name, id, part, bodyExpr, pos) {
  return {
    parameters: {
      method: 'POST',
      url: `=${cb}/part/${part}`,
      sendBody: true,
      specifyBody: 'json',
      jsonBody: bodyExpr,
      options: { timeout: 120000 },
    },
    id,
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: pos,
    onError: 'continueRegularOutput',
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 2000,
  };
}

function stageNode(name, id, stage, pos) {
  return {
    parameters: {
      method: 'POST',
      url: `=${cb}/status`,
      sendBody: true,
      specifyBody: 'json',
      jsonBody: `={{ JSON.stringify({ stage: ${JSON.stringify(stage)} }) }}`,
      options: { timeout: 20000 },
    },
    id,
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: pos,
    onError: 'continueRegularOutput',
    executeOnce: true,
  };
}

// ---------- replacements in code and expressions ----------

function retarget(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/\$\('Audio upload \(form\)'\)/g, `$('${JOB}')`)
    .replace(/form\.binary\?\.audio\?\.fileName/g, 'form.json.fileName')
    .replace(/\.first\(\)\.binary\.audio\.fileExtension \|\| 'm4a'/g, ".first().json.ext")
    .replace(/\$execution\.id/g, jobId.replace('$(', "$("))
    .replace(/\{\{ \$\('Job'\)\.first\(\)\.json\.jobId \}\}/g, `{{ ${jobId} }}`);
}

function walk(obj) {
  if (typeof obj === 'string') return retarget(obj);
  if (Array.isArray(obj)) return obj.map(walk);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = walk(v);
    return out;
  }
  return obj;
}

// ---------- building the online workflow ----------

function buildOnline() {
  const nodes = JSON.parse(JSON.stringify(src.nodes));
  const conn = JSON.parse(JSON.stringify(src.connections));

  // 1. the form and "Save source file" are no longer needed — the file is already on disk
  const drop = new Set(['Audio upload (form)', 'Save source file', 'Save files to disk',
    'Google Sheets: Decisions', 'Google Sheets: Tasks', 'Google Sheets: Meetings', 'Google Sheets: Prescriptions1']);
  const filesPos = byName(nodes, 'Save files to disk').position;
  let out = nodes.filter((n) => !drop.has(n.name));
  for (const name of drop) delete conn[name];

  // 2. entry point
  const base = byName(nodes, 'Audio upload (form)').position;
  out.unshift(jobNode([base[0] + 224, base[1]]));
  out.unshift(webhookNode('medminute-online', base));

  // 3. substitutions of $execution.id / references to the form
  out = out.map((n) => (n.type === 'n8n-nodes-base.stickyNote' ? n : walk(n)));

  // 4. segment numbering: the file name now starts with a text jobId
  const num = byName(out, 'Number segments');
  num.parameters.jsCode = num.parameters.jsCode.replace(
    /const m = name\.match\([^)]*\);/,
    'const m = name.match(/_([^_]+)__seg_(\\d+)\\.mp3$/);',
  );

  // 5. delete only derived files, keep the source for a re-run.
  // PowerShell, not del: the path needs forward slashes (backslashes break n8n expression parsing).
  byName(out, 'Delete temp files').parameters.command =
    '=powershell -NoProfile -Command "Remove-Item -Force -ErrorAction SilentlyContinue '
    + `'C:/medminute/audio/{{ ${jobId} }}_full.mp3','C:/medminute/audio/{{ ${jobId} }}_*__seg_*.mp3'"`;

  // 6. reports are built as text — the site writes them to disk (n8n nodes have restricted file-system access)
  byName(out, 'Build files').parameters.jsCode = `// Reports RU / RO / EN + transcript + source versions. The files are written by the site.
const tz = 'Europe/Chisinau';
const form = $('${JOB}').first();
const rec = form.json.submittedAt ? DateTime.fromISO(form.json.submittedAt).setZone(tz) : $now.setZone(tz);
const created = $now.setZone(tz);
let src = (form.json.fileName || 'audio').replace(/\\.[^.]+$/, '').replace(/[^\\p{L}\\p{N}_-]+/gu, '_');
if (!/^medminute/i.test(src)) src = 'MedMinute_' + src;
const base = \`\${src}__recorded-\${rec.toFormat('yyyy-LL-dd_HH-mm')}__report-\${created.toFormat('yyyy-LL-dd_HH-mm')}\`;
const head = (title) => [\`# \${title}\`, '', \`File: \${form.json.fileName || '—'}\`,
  \`Recording uploaded: \${rec.toFormat('dd.LL.yyyy HH:mm')}\`, \`Report created: \${created.toFormat('dd.LL.yyyy HH:mm')}\`, '', '---', ''].join('\\n');

const langs = $('Three languages').all().map(i => i.json.lang);
const out = $input.all().map((it, i) => {
  const lang = langs[i] || \`lang\${i}\`;
  const content = String(it.json.choices?.[0]?.message?.content ?? '').replace(/^\\\`\\\`\\\`(?:markdown|md)?\\s*|\\s*\\\`\\\`\\\`$/g, '').trim();
  if (!content) throw new Error(\`Empty model response for language \${lang}\`);
  return { json: { lang, fileName: \`\${base}.\${lang}.md\`, content } };
});

// final transcript (assembled, with speakers, in the original languages)
const fin = $('Transcript with names').first().json;
out.push({ json: { lang: 'transcript', fileName: \`\${base}.transcript.md\`,
  content: head('Meeting transcript (original languages, with speakers)')
    + \`Participants (by voice): \${(fin.speakers || []).join(', ') || '—'}\\n\\n\` + fin.text + '\\n' } });

// source recognitions — for manual checking of disputed places
const fmt = (s) => { s = Math.max(0, Math.round(+s || 0)); const p = n => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600); return (h ? p(h) + ':' : '') + p(Math.floor((s % 3600) / 60)) + ':' + p(s % 60); };
const V = $('Join versions').first().json.variants || {};
const D = $('Speakers (format)').first().json.segments || [];
out.push({ json: { lang: 'sources', fileName: \`\${base}.sources.md\`, content: [head('Source recognitions (no AI edits)'),
  '## Speaker labels (diarize)', '', ...D.map(x => \`[\${fmt(x.t)}] \${x.spk}: \${x.text}\`), '',
  '## Version 15s', '', ...(V['15s'] || []).map(x => \`[\${fmt(x.t)}] \${x.text}\`), '',
  '## Version 5s', '', ...(V['5s'] || []).map(x => \`[\${fmt(x.t)}] \${x.text}\`), ''].join('\\n') } });
return out;`;

  // 7. tables → one item with an array of rows
  const RET = 'return [{ json: { rows: rows.map(r => r.json ?? r) } }];';
  const single = (name) => {
    const n = byName(out, name);
    n.parameters.jsCode = n.parameters.jsCode
      .replace(/^return \(data\./m, 'const rows = (data.')
      .replace(/\}\)\);\s*$/, `}));\n${RET}\n`)
      .replace(/^const out = \[\];$/m, 'const rows = [];')
      .replace(/\bout\.push\(/g, 'rows.push(')
      .replace(/^return out;$/m, RET);
    if (!n.parameters.jsCode.includes(RET)) throw new Error(`could not rewrite node "${name}"`);
    return n;
  };
  single('Rows: decisions');
  single('Rows: tasks');
  single('Rows: prescriptions');

  // 8. "Row: meeting" → the minutes object for the site
  byName(out, 'Row: meeting').parameters.jsCode = `// Minutes in 3 languages for the site
const tz = 'Europe/Chisinau';
const j = $('${JOB}').first().json;
const meetingDate = DateTime.fromISO(j.submittedAt).setZone(tz).toFormat('dd.LL.yyyy');
const clean = (s) => String(s || '').replace(/^\\\`\\\`\\\`(?:markdown|md)?\\s*|\\s*\\\`\\\`\\\`$/g, '').trim();
const langs = $('Three languages').all().map(i => i.json.lang);
const mom = {};
$input.all().forEach((it, i) => { mom[langs[i]] = clean(it.json.choices?.[0]?.message?.content); });
const m = (mom.ru || '').match(/MoM:\\s*(.+?)\\s*\\[/);
const fin = $('Transcript with names').first().json;
return [{ json: {
  title: m ? m[1].trim() : 'Meeting',
  meetingDate,
  participants: fin.speakers || [],
  fileName: j.fileName,
  ru: mom.ru || '', ro: mom.ro || '', en: mom.en || '',
} }];`;

  // 9. new nodes that send to the site
  const P = (x, y) => [x, y];
  const siteNodes = [
    stageNode('Site: status (audio received)', 'st-1', 'audio received, preparing the slicing', P(base[0] + 448, base[1] + 220)),
    postNode('Site: transcript', 'site-transcript', 'transcript',
      '={{ JSON.stringify({ text: $json.text, speakers: $json.speakers, nameMap: $json.nameMap, evidence: $json.evidence }) }}',
      P(15360, 5840)),
    postNode('Site: minutes', 'site-mom', 'mom', '={{ JSON.stringify($json) }}', P(15680, 6352)),
    postNode('Site: decisions', 'site-decisions', 'decisions', '={{ JSON.stringify({ rows: $json.rows }) }}', P(15472, 6464)),
    postNode('Site: tasks', 'site-tasks', 'tasks', '={{ JSON.stringify({ rows: $json.rows }) }}', P(15472, 6640)),
    postNode('Site: prescriptions', 'site-patients', 'patients', '={{ JSON.stringify({ rows: $json.rows }) }}', P(15472, 6848)),
    Object.assign(postNode('Site: files', 'site-files', 'files',
      '={{ JSON.stringify({ rows: $input.all().map(i => i.json) }) }}',
      filesPos), { executeOnce: true }),
    {
      parameters: {
        jsCode: `// Source recognitions — to the site, "Source versions" tab
const fmt = (s) => { s = Math.max(0, Math.round(+s || 0)); const p = n => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600); return (h ? p(h) + ':' : '') + p(Math.floor((s % 3600) / 60)) + ':' + p(s % 60); };
const V = $('Join versions').first().json.variants || {};
const D = $('Speakers (format)').first().json.segments || [];
return [{ json: {
  diar: D.map(x => \`[\${fmt(x.t)}] \${x.spk}: \${x.text}\`).join('\\n'),
  v15: (V['15s'] || []).map(x => \`[\${fmt(x.t)}] \${x.text}\`).join('\\n'),
  v5: (V['5s'] || []).map(x => \`[\${fmt(x.t)}] \${x.text}\`).join('\\n'),
} }];`,
      },
      id: 'src-build',
      name: 'Source versions (text)',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: P(14592, 6000),
    },
    postNode('Site: source versions', 'site-sources', 'sources', '={{ JSON.stringify($json) }}', P(14800, 5840)),
  ];
  out.push(...siteNodes);

  // 10. connections
  conn['Start (webhook from site)'] = { main: [[{ node: JOB, type: 'main', index: 0 }]] };
  conn[JOB] = { main: [[
    { node: 'Compress whole recording (ffmpeg)', type: 'main', index: 0 },
    { node: 'Find pauses (ffmpeg)', type: 'main', index: 0 },
    { node: 'Site: status (audio received)', type: 'main', index: 0 },
  ]] };

  conn['Transcript with names'].main[0].push({ node: 'Site: transcript', type: 'main', index: 0 });
  conn['Wait for both branches'].main[0].push({ node: 'Source versions (text)', type: 'main', index: 0 });
  conn['Source versions (text)'] = { main: [[{ node: 'Site: source versions', type: 'main', index: 0 }]] };
  conn['Row: meeting'] = { main: [[{ node: 'Site: minutes', type: 'main', index: 0 }]] };
  conn['Rows: decisions'] = { main: [[{ node: 'Site: decisions', type: 'main', index: 0 }]] };
  conn['Rows: tasks'] = { main: [[{ node: 'Site: tasks', type: 'main', index: 0 }]] };
  conn['Rows: prescriptions'] = { main: [[{ node: 'Site: prescriptions', type: 'main', index: 0 }]] };
  conn['Build files'] = { main: [[{ node: 'Site: files', type: 'main', index: 0 }]] };

  // notes
  const notes = out.filter((n) => n.type === 'n8n-nodes-base.stickyNote');
  byName(notes, 'Note D').parameters.content =
    '## Result → site localhost:7777\nDecisions, tasks, prescriptions, minutes and transcript go to the site as POST requests\n(`/api/jobs/<jobId>/part/...`), the site stores them in the local SQLite.\nGoogle Sheets are no longer needed.';

  return { name: 'MedMinute Online', nodes: out, connections: conn, settings: src.settings || { executionOrder: 'v1' } };
}

// ---------- building the offline workflow ----------
// Everything is local: Whisper large-v3-turbo (CTranslate2) + voice id (ECAPA/WeSpeaker) on 127.0.0.1:7778,
// minutes — Ollama on 127.0.0.1:11434. No internet needed.

const ASR = process.env.ASR_URL || 'http://127.0.0.1:7778';
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3:8b';

function asrNode(name, id, endpoint, bodyExpr, pos, stage) {
  return {
    parameters: {
      method: 'POST',
      url: `${ASR}${endpoint}`,
      sendBody: true,
      specifyBody: 'json',
      jsonBody: bodyExpr,
      options: { timeout: 10_800_000 }, // up to 3 hours: on a weak CPU a recording takes long
    },
    id,
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: pos,
    executeOnce: true,
    notes: stage,
  };
}

function buildOffline() {
  const wf = buildOnline();
  const conn = wf.connections;

  // 1. the whole online recognition (diarize + 15s/5s slicing + merge) is replaced by one
  //    local service, so these nodes go away
  const drop = new Set([
    'Compress whole recording (ffmpeg)', 'Read compressed recording',
    'Who speaks (gpt-4o-transcribe-diarize)', 'Speakers (format)',
    'Find pauses (ffmpeg)', 'Slicing variants', 'Cut segments (ffmpeg)',
    'Read segments', 'Number segments', 'Transcribe 15s + 5s (gpt-4o-transcribe)',
    'Join versions', 'Wait for both branches', '5-minute windows',
    'Merge 15s + 5s + speakers (gpt-4.1)', 'Delete temp files',
    'Final transcript', // replaced by stitching Whisper + voice id
  ]);
  let out = wf.nodes.filter((n) => !drop.has(n.name));
  for (const name of drop) delete conn[name];
  for (const k of Object.keys(conn)) {
    conn[k].main = (conn[k].main || []).map((br) => (br || []).filter((c) => !drop.has(c.node)));
  }

  // 2. offline webhook
  const hook = byName(out, 'Start (webhook from site)');
  hook.parameters.path = 'medminute-offline';
  hook.webhookId = 'medminute-offline';
  hook.id = 'hook-medminute-offline';

  const base = hook.position;
  const P = (dx, dy) => [base[0] + dx, base[1] + dy];

  // 3. transcription and voice id — two nodes, as online, but local and sequential
  //    (both load the CPU, they cannot run in parallel)
  out.push(
    asrNode('Local Whisper (large-v3-turbo)', 'asr-transcribe', '/transcribe',
      `={{ JSON.stringify({ path: $('${JOB}').first().json.inputPath }) }}`,
      P(448, 0), 'Local transcription without internet'),
    asrNode('Voice ID (who spoke)', 'asr-voiceid', '/diarize',
      `={{ JSON.stringify({ path: $('${JOB}').first().json.inputPath }) }}`,
      P(672, 0), 'ECAPA/WeSpeaker voice print + matching against the reference voices in C:/medminute/voices'),
    stageNode('Site: status (transcribing)', 'st-asr', 'local Whisper is transcribing the recording (this takes a while)',
      P(448, 220)),
    stageNode('Site: status (identifying voices)', 'st-vid', 'identifying who spoke (voice id)',
      P(672, 220)),
  );
  // 4. stitch the Whisper text with the speaker labels
  out.push({
    parameters: {
      jsCode: `// Give every Whisper utterance a speaker from voice id (by the largest overlap)
const tr = $('Local Whisper (large-v3-turbo)').first().json;
const vid = $('Voice ID (who spoke)').first().json;
const dseg = Array.isArray(vid.segments) ? vid.segments : [];
const fmt = (s) => { s = Math.max(0, Math.round(+s || 0)); const p = n => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600); return (h ? p(h) + ':' : '') + p(Math.floor((s % 3600) / 60)) + ':' + p(s % 60); };
const who = (a, b) => {
  let best = dseg[0]?.spk || 'Participant 1', bestOv = 0;
  for (const d of dseg) {
    const ov = Math.min(b, d.end) - Math.max(a, d.t);
    if (ov > bestOv) { best = d.spk; bestOv = ov; }
  }
  return best;
};
const segs = (tr.segments || []).filter(s => s.text).map(s => ({
  t: s.t, end: s.end, spk: who(s.t, s.end), text: s.text,
}));
const speakers = [...new Set(segs.map(s => s.spk))].sort();
const text = segs.map(s => \`[\${fmt(s.t)}] \${s.spk}: \${s.text}\`).join('\\n');
if (!text.trim()) throw new Error('local Whisper produced no text — check C:/medminute/site/data/asr.log');
return [{ json: { text, speakers, segments: segs, language: tr.language, method: vid.method } }];`,
    },
    id: 'asr-merge',
    name: 'Final transcript',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: P(896, 0),
  });

  // 5. offline "source versions": raw Whisper + raw voice labels
  byName(out, 'Source versions (text)').parameters.jsCode =
    `// Raw results of the local models — for manual checking of disputed places
const fmt = (s) => { s = Math.max(0, Math.round(+s || 0)); const p = n => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600); return (h ? p(h) + ':' : '') + p(Math.floor((s % 3600) / 60)) + ':' + p(s % 60); };
const tr = $('Local Whisper (large-v3-turbo)').first().json;
const vid = $('Voice ID (who spoke)').first().json;
return [{ json: {
  diar: (vid.segments || []).map(x => \`[\${fmt(x.t)}] \${x.name || x.spk} (\${fmt(x.end - x.t)})\`).join('\\n'),
  v15: (tr.segments || []).map(x => \`[\${fmt(x.t)}] \${x.text}\`).join('\\n'),
  v5: \`model: \${tr.model} · language: \${tr.language} · voice id: \${vid.method}\\nreference voices: \${JSON.stringify(vid.names || {})}\`,
} }];`;

  // 5a. in the "source versions" report, one local recognition instead of the three online ones
  const cf = byName(out, 'Build files');
  cf.parameters.jsCode = cf.parameters.jsCode
    .replace(/const V = \$\('Join versions'\)\.first\(\)\.json\.variants \|\| \{\};\nconst D = \$\('Speakers \(format\)'\)\.first\(\)\.json\.segments \|\| \[\];/,
      "const tr = $('Local Whisper (large-v3-turbo)').first().json;\nconst D = ($('Voice ID (who spoke)').first().json.segments) || [];")
    .replace(/'## Speaker labels \(diarize\)', '', \.\.\.D\.map\(x => `\[\$\{fmt\(x\.t\)\}\] \$\{x\.spk\}: \$\{x\.text\}`\), '',\n  '## Version 15s', '', \.\.\.\(V\['15s'\] \|\| \[\]\)\.map\(x => `\[\$\{fmt\(x\.t\)\}\] \$\{x\.text\}`\), '',\n  '## Version 5s', '', \.\.\.\(V\['5s'\] \|\| \[\]\)\.map\(x => `\[\$\{fmt\(x\.t\)\}\] \$\{x\.text\}`\), ''/,
      "`Model: ${tr.model} · language: ${tr.language}`, '',\n  '## Speaker labels (voice id)', '', ...D.map(x => `[${fmt(x.t)}–${fmt(x.end)}] ${x.name || x.spk}`), '',\n  '## Whisper, as is', '', ...(tr.segments || []).map(x => `[${fmt(x.t)}] ${x.text}`), ''");
  for (const g of ['Join versions', 'Speakers (format)']) {
    if (cf.parameters.jsCode.includes(g)) throw new Error(`"Build files" still references "${g}"`);
  }

  // 6. LLM: OpenAI → Ollama
  for (const n of out) {
    const p = n.parameters || {};
    if (typeof p.url !== 'string' || !p.url.includes('api.openai.com')) continue;
    p.url = `${OLLAMA}/v1/chat/completions`;
    delete p.authentication;
    delete p.nodeCredentialType;
    delete n.credentials;
    // reasoning_effort: 'none' — the only way to really turn off qwen3 "thinking"
    // in the OpenAI-compatible Ollama endpoint (verified: 0 reasoning tokens)
    p.jsonBody = String(p.jsonBody)
      .replace(/model: 'gpt-4\.1'/g, `model: '${OLLAMA_MODEL}', reasoning_effort: 'none'`);
    p.options = { ...(p.options || {}), timeout: 3_600_000 };
    delete p.options.batching; // there is one local model, nothing to parallelise
  }

  // 7. code nodes read the model response — strip qwen3 <think>…</think>
  const THINK = ".replace(/<think>[\\s\\S]*?<\\/think>/g, '')";
  for (const n of out) {
    if (n.type !== 'n8n-nodes-base.code') continue;
    const c = n.parameters.jsCode;
    if (!c.includes('choices')) continue;
    n.parameters.jsCode = c
      .replace(/(\.\.\.|)(String\((?:it|\$)[^)]*choices[^;]*?\))(\.replace)/g, `$1$2${THINK}$3`)
      .replace(/clean\(it\.json\.choices\?\.\[0\]\?\.message\?\.content\)/g,
        `clean(String(it.json.choices?.[0]?.message?.content || '')${THINK})`);
  }

  // 8. connections
  conn['Start (webhook from site)'] = { main: [[{ node: JOB, type: 'main', index: 0 }]] };
  conn[JOB] = { main: [[
    { node: 'Site: status (audio received)', type: 'main', index: 0 },
    { node: 'Local Whisper (large-v3-turbo)', type: 'main', index: 0 },
  ]] };
  conn['Local Whisper (large-v3-turbo)'] = { main: [[
    { node: 'Site: status (identifying voices)', type: 'main', index: 0 },
    { node: 'Voice ID (who spoke)', type: 'main', index: 0 },
  ]] };
  conn['Site: status (audio received)'] = { main: [[
    { node: 'Site: status (transcribing)', type: 'main', index: 0 },
  ]] };
  conn['Site: status (transcribing)'] = { main: [[]] };
  conn['Site: status (identifying voices)'] = { main: [[]] };
  conn['Voice ID (who spoke)'] = { main: [[
    { node: 'Final transcript', type: 'main', index: 0 },
    { node: 'Source versions (text)', type: 'main', index: 0 },
  ]] };
  conn['Final transcript'] = { main: [[
    { node: 'Who is who (names, gpt-4.1)', type: 'main', index: 0 },
  ]] };
  // further — step 9: LLM node names are renamed, connections are fixed along with them

  // 9. LLM node names no longer say gpt-4.1
  const rename = {};
  for (const n of out) {
    if (!n.name.includes('gpt-4.1')) continue;
    const to = n.name.replace('gpt-4.1', OLLAMA_MODEL);
    rename[n.name] = to;
    n.name = to;
  }
  for (const [from, to] of Object.entries(rename)) {
    if (conn[from]) { conn[to] = conn[from]; delete conn[from]; }
    for (const v of Object.values(conn)) {
      for (const br of v.main || []) for (const c of br || []) if (c.node === from) c.node = to;
    }
    for (const n of out) {
      if (n.type !== 'n8n-nodes-base.code') continue;
      n.parameters.jsCode = n.parameters.jsCode.split(`$('${from}')`).join(`$('${to}')`);
    }
  }

  // 10. notes
  const notes = out.filter((n) => n.type === 'n8n-nodes-base.stickyNote');
  const note = (name, content) => { const n = byName(notes, name); if (n) n.parameters.content = content; };
  note('Note A', `## Offline mode\nEverything is computed on this computer, no internet needed.\n\n- transcription: Whisper large-v3-turbo (CTranslate2, int8) — \`${ASR}/transcribe\`\n- who spoke: ECAPA / WeSpeaker + clustering — \`${ASR}/diarize\`\n- names from reference voices in \`C:/medminute/voices\`\n- minutes: Ollama \`${OLLAMA_MODEL}\` — \`${OLLAMA}\`\n\nStart the service with: \`bash C:/medminute/site/tools/restart-asr.sh\``);
  note('Note D', '## Result → site localhost:7777\nEverything goes to the site as POST requests (`/api/jobs/<jobId>/part/...`),\nthe site stores it in the local SQLite and writes the reports to `C:/medminute/reports`.');

  return { name: 'MedMinute Offline', nodes: out, connections: conn, settings: wf.settings };
}

const online = buildOnline();
fs.writeFileSync(path.join(OUT, 'online.json'), JSON.stringify(online, null, 2), 'utf8');
console.log('online:', online.nodes.length, 'nodes');

const offline = buildOffline();
fs.writeFileSync(path.join(OUT, 'offline.json'), JSON.stringify(offline, null, 2), 'utf8');
console.log('offline:', offline.nodes.length, 'nodes');
