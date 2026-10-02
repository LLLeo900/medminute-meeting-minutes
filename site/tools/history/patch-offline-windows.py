"""Offline gets the same recognition logic as online: two slicings + a merge.

Before: one pass of the local Whisper over the whole recording. On a long recording it gets lazy —
it swallows pieces and glues utterances together.

After, as online:
  Whisper windows 15s  — the base of the transcript (wide context),
  Whisper windows 5s   — only spot word corrections and skipped pieces,
  Voice ID             — who spoke when (ECAPA, no Whisper and no LLM),
  Merge (qwen3)        — merges the three versions into one verbatim transcript.
There is no longer a "whole recording" pass: the windows replace it, and Voice ID reads the recording itself anyway.

Slicing into windows is done by `asr/service.py`: POST /transcribe {path, window: 15|5}.
Windows are cut in pauses (Silero VAD), with a 0.5 s overlap — like online "Slicing variants".

The script only edits the workflow. It will not start offline processing.
"""
import io
import json
import sys
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
KEY = open('.n8n-key', encoding='utf-8').read().strip()
BASE = 'http://127.0.0.1:5678/api/v1'
WID = 'rQkljhVk4odN5YoP'
OLD_ASR = 'Local Whisper (large-v3-turbo)'
ASR15, ASR5 = 'Whisper windows 15s', 'Whisper windows 5s'
WINS, MERGE = '5-minute windows', 'Merge 15s + 5s + voices (qwen3:8b)'

ASR_URL = 'http://127.0.0.1:7778/transcribe'
OLLAMA = 'http://127.0.0.1:11434/v1/chat/completions'


def asr_node(name, window, pos):
    return {
        'id': f'asr{window}', 'name': name, 'type': 'n8n-nodes-base.httpRequest',
        'typeVersion': 4.2, 'position': pos,
        'parameters': {
            'method': 'POST', 'url': ASR_URL, 'sendBody': True, 'specifyBody': 'json',
            'jsonBody': "={{ JSON.stringify({ path: $('Job').first().json.inputPath, window: "
                        f'{window} }}) }}}}',
            'options': {'timeout': 10800000},
        },
        'notes': f'Windows of ~{window} s, cut in pauses. They run one after another so the machine is not loaded with two Whispers at once.',
    }


WINS_CODE = r"""// Splits everything into 5-minute windows: each has who spoke + the 15s version + the 5s version
const WIN = 300;
const v15 = $('Whisper windows 15s').first().json;
const v5 = $('Whisper windows 5s').first().json;
const vid = $('Voice ID (who spoke)').first().json;
const total = Math.max(v15.duration || 0, v5.duration || 0);
const fmt = (s) => { s = Math.max(0, Math.round(+s || 0)); const p = n => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600); return (h ? p(h) + ':' : '') + p(Math.floor((s % 3600) / 60)) + ':' + p(s % 60); };
const inWin = (t, a, b) => t >= a && t < b;
const line = (x) => `[${fmt(x.t)}] ${x.text}`;
const items = [];
for (let a = 0; a < Math.max(total, 1); a += WIN) {
  const b = a + WIN;
  const diar = (vid.segments || []).filter(x => inWin(x.t, a, b))
    .map(x => `[${fmt(x.t)}] ${x.name || x.spk}: (speaks ${fmt(x.end - x.t)})`).join('\n');
  const s15 = (v15.segments || []).filter(x => inWin(x.t, a, b) && x.text).map(line).join('\n');
  const s5 = (v5.segments || []).filter(x => inWin(x.t, a, b) && x.text).map(line).join('\n');
  if (!diar && !s15 && !s5) continue;
  items.push({ json: { win: `${fmt(a)}–${fmt(Math.min(b, total))}`, winStart: a,
    input: `=== DIAR (who speaks) ===\n${diar || '—'}\n\n`
      + `=== V15 (15 s windows — BASE) ===\n${s15 || '—'}\n\n`
      + `=== V5 (5 s windows — only for spot word corrections) ===\n${s5 || '—'}` } });
}
if (!items.length) throw new Error('local Whisper produced no text — check C:/medminute/site/data/asr.log');
return items;"""

# The same prompt as online: the base is V15, V5 corrects words, the speaker comes from DIAR.
MERGE_PROMPT = (
    'You are assembling a VERBATIM transcript of a fragment of a medical meeting (\' + $json.win + \') '
    'from three automatic recognitions of the same recording. '
    'V15 — 15-second windows: this is the BASE of the transcript. It has the widest context, so '
    'take phrase boundaries, word order and wording from it. V5 — 5-second windows: the context '
    'is short and individual words are distorted, so V5 is needed only for corrections. DIAR — voice '
    'labels: who spoke and when, the label is reliable, it contains no text. People speak '
    'Russian, Romanian and English mixed together, sometimes within one sentence. '
    'Rules: 1) write the text from V15; take from V5 ONLY spot corrections — a single word or a '
    'short phrase, and only if it clearly fits the meaning of the phrase better or if V15 '
    'translated a word into another language while V5 kept the language it was spoken in; '
    '2) if V15 skipped a piece of the recording entirely (it is in V5 but not in V15) — insert that piece '
    'from V5 in its place by timecode; 3) do not replace V15 with whole V5 phrases and do not restructure '
    'the fragment to match V5: V5 corrects words, not sentences; 4) take the speaker from DIAR by '
    'timecodes; 5) translate nothing, do not paraphrase, add or correct the meaning; numbers, '
    'doses, drugs, names — only as spoken; 6) Russian — in Cyrillic, Romanian — in Latin script '
    'with diacritics (ă â î ș ț), English — in English; 7) if a choice is impossible — [inaudible]; '
    '8) remove repeats at the seams of the windows. Format: each utterance on a new line: '
    '[mm:ss] Participant N: text. Start a new line when the speaker changes. '
    'Output only the transcript, with no explanations.'
)

FINAL_CODE = r"""// Joins the windows into one final transcript (with speakers)
const wins = $('5-minute windows').all().map(i => i.json);
const vid = $('Voice ID (who spoke)').first().json;
const parts = $input.all().map((it, i) => ({
  start: wins[i]?.winStart ?? i,
  // qwen thinks out loud in <think>…</think> — these musings must not get into the transcript
  text: String(it.json.choices?.[0]?.message?.content || '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^```\w*\s*|\s*```$/g, '').trim(),
})).sort((a, b) => a.start - b.start);
const text = parts.map(p => p.text).filter(Boolean).join('\n');
if (!text.trim()) throw new Error('the merge produced no text — look at the qwen3 response in n8n');
const speakers = [...new Set((vid.segments || []).map(s => s.name || s.spk))].sort();
return [{ json: { text, speakers, segments: vid.segments || [], method: vid.method } }];"""

SOURCES_CODE = r"""// Raw versions of the local recognition — for manual checking of disputed places
const fmt = (s) => { s = Math.max(0, Math.round(+s || 0)); const p = n => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600); return (h ? p(h) + ':' : '') + p(Math.floor((s % 3600) / 60)) + ':' + p(s % 60); };
const v15 = $('Whisper windows 15s').first().json;
const v5 = $('Whisper windows 5s').first().json;
const vid = $('Voice ID (who spoke)').first().json;
const lines = (tr) => (tr.segments || []).filter(x => x.text).map(x => `[${fmt(x.t)}] ${x.text}`).join('\n');
return [{ json: {
  diar: (vid.segments || []).map(x => `[${fmt(x.t)}] ${x.name || x.spk} (${fmt(x.end - x.t)})`).join('\n'),
  v15: `windows: ${v15.windows} · language: ${v15.language} · model: ${v15.model}\n` + lines(v15),
  v5: `windows: ${v5.windows} · language: ${v5.language} · voice id: ${vid.method}\n` + lines(v5),
} }];"""


def req(method, url, data=None):
    r = urllib.request.Request(
        BASE + url, method=method,
        data=json.dumps(data).encode() if data else None,
        headers={'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(r))


w = req('GET', '/workflows/' + WID)
names = {n['name'] for n in w['nodes']}
if OLD_ASR not in names and ASR15 not in names:
    sys.exit(f'SKIPPED: found neither "{OLD_ASR}" nor "{ASR15}" — look at the workflow in n8n by eye')

nodes = [n for n in w['nodes'] if n['name'] != OLD_ASR]
N = {n['name']: n for n in nodes}
x, y = ({n['name']: n for n in w['nodes']}.get(OLD_ASR) or N[ASR15])['position']

if ASR15 not in N:
    nodes.append(asr_node(ASR15, 15, [x, y]))
    nodes.append(asr_node(ASR5, 5, [x, y + 200]))
    nodes.append({'id': 'wins', 'name': WINS, 'type': 'n8n-nodes-base.code', 'typeVersion': 2,
                  'position': [x + 448, y + 200], 'parameters': {'jsCode': WINS_CODE}})
    nodes.append({
        'id': 'merge', 'name': MERGE, 'type': 'n8n-nodes-base.httpRequest', 'typeVersion': 4.2,
        'position': [x + 672, y + 200],
        'parameters': {
            'method': 'POST', 'url': OLLAMA, 'sendBody': True, 'specifyBody': 'json',
            'jsonBody': ("={{ { model: 'qwen3:8b', reasoning_effort: 'none', temperature: 0, messages: [ "
                         "{ role: 'system', content: '" + MERGE_PROMPT + "' }, "
                         "{ role: 'user', content: $json.input } ] } }}"),
            'options': {'timeout': 3600000},
        },
    })

N['Final transcript']['parameters']['jsCode'] = FINAL_CODE
N['Source versions (text)']['parameters']['jsCode'] = SOURCES_CODE

# Both versions go into the .sources.md file: what the merge relied on and what it corrected with
files = N['Build files']['parameters']['jsCode']
files = files.replace(
    "const tr = $('Local Whisper (large-v3-turbo)').first().json;",
    f"const tr = $('{ASR15}').first().json;\nconst tr5 = $('{ASR5}').first().json;", 1)
files = files.replace(
    "`Model: ${tr.model} · language: ${tr.language}`, '',",
    "`Model: ${tr.model} · language: ${tr.language} · windows: 15 s (${tr.windows}) and 5 s (${tr5.windows})`, '',", 1)
files = files.replace(
    "'## Whisper, as is', '', ...(tr.segments || []).map(x => `[${fmt(x.t)}] ${x.text}`), ''",
    "'## Whisper, 15 s windows (base)', '', ...(tr.segments || []).map(x => `[${fmt(x.t)}] ${x.text}`), '',\n"
    "  '## Whisper, 5 s windows (corrections)', '', ...(tr5.segments || []).map(x => `[${fmt(x.t)}] ${x.text}`), ''", 1)
if OLD_ASR in files:
    sys.exit('SKIPPED: could not rewrite the references in "Build files" — the workflow was not touched')
N['Build files']['parameters']['jsCode'] = files

c = w['connections']
one = lambda *names: {'main': [[{'node': n, 'type': 'main', 'index': 0} for n in names]]}
c.pop(OLD_ASR, None)
c['Job'] = one('Site: status (audio received)', ASR15)
c[ASR15] = one(ASR5)                       # one after another: the machine cannot run two Whispers at once
c[ASR5] = one('Site: status (identifying voices)', 'Voice ID (who spoke)')
c['Voice ID (who spoke)'] = one(WINS, 'Source versions (text)')
c[WINS] = one(MERGE)
c[MERGE] = one('Final transcript')

req('PUT', '/workflows/' + WID, {
    'name': w['name'], 'nodes': nodes, 'connections': c, 'settings': w.get('settings', {})})
print('Updated: offline transcribes in 15s + 5s windows and merges them with qwen3 (like online)')
