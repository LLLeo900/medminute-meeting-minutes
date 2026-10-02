"""The same cure for offline: the transcript is assembled by code, not by qwen3.

Online, the merge node has already been removed (tools/history/patch-transcript-verbatim.py). Offline
had exactly the same one: "5-minute windows" prepared 5-minute windows in three forms at once —
V5, V15 and the speaker labels — and "Merge 15s + 5s + voices (qwen3:8b)" stitched them
as it saw fit. The prompt forbade taking text from the labels or translating anything,
but the model still edited words and reordered utterances, and this distortion went
further into everything: names, minutes, decisions, prescriptions.

Now the same as online:
  • the text is taken as recognised — the V5 version (3-5 second pieces swallow nothing);
  • V15 is not combined with it — it stays as a separate branch of "Source versions";
  • the speaker is assigned mechanically, by the overlap of timecodes with the voice labels;
  • the recognition junk filter (YouTube-style endings, vocabulary copied from the prompt)
    is moved over from "5-minute windows" — otherwise it would disappear together with the node.
As a bonus, N qwen3:8b calls per meeting go away — and that is the slowest part of offline.

The script deletes two nodes, connects "Voice ID (who spoke)" straight to "Final
transcript" and rewrites its code. Before editing it saves a full copy of the workflow
to tools/backup-offline-<date>.json. Idempotent, does not run the workflow.
"""
import io
import json
import os
import sys
import time
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
KEY = open('.n8n-key', encoding='utf-8').read().strip()
BASE = 'http://127.0.0.1:5678/api/v1'
OFFLINE = 'rQkljhVk4odN5YoP'
DROP = ['5-minute windows', 'Merge 15s + 5s + voices (qwen3:8b)']
FINAL = 'Final transcript'
SRC = 'Voice ID (who spoke)'

CODE = r"""// Verbatim transcript — straight from local recognition, without a model rewriting it.
// Previously qwen3:8b merged 5-minute windows: it saw V5, V15 and the voice labels at once
// and stitched them as it saw fit — edited words, reordered utterances, paraphrased
// in places. Exactly this distortion reached the minutes and all the tables.
// Now the text is taken as recognised (V5 — 3-5 second pieces, nothing gets swallowed),
// V15 is not combined with it, and the speaker is assigned by timecode. The model does not touch the text.
const v5 = $('Whisper windows 5s').first().json;
const vid = $('Voice ID (who spoke)').first().json;
const D = vid.segments || [];

// Recognition junk: YouTube-style endings on empty windows and lines where Whisper copied
// the vocabulary from the prompt. The filter was moved here from the "5-minute windows" node when it was removed.
const TERMS = ['noradrenalin', 'dobutamin', 'creatinin', 'uree', 'meropenem', 'amikacin', 'fluconazol', 'hidronefroz', 'nefrostom', 'bipap', 'hemoglobin', 'lactat'];
// The Russian phrases below are intentional: they match Whisper hallucinations in Russian (YouTube-style
// endings on silence) and the regurgitated priming prompt. Do not translate them.
const junk = (t) => {
  if (/(subtitr|vizionare|субтитр|продолжение следует|спасибо за просмотр|thanks for watching|amara\.org|transcrie exact|кириллицей|ședință medicală medminute|never translate|medical team meeting)/i.test(t)) return true;
  const low = t.toLowerCase();
  return TERMS.filter(x => low.includes(x)).length >= 3;
};

const base = (v5.segments || []).filter(x => x.text && !junk(x.text));
if (!base.length) {
  throw new Error('local Whisper produced no text — check C:/medminute/site/data/asr.log');
}
const fmt = (s) => { s = Math.max(0, Math.round(+s || 0)); const p = n => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600); return (h ? p(h) + ':' : '') + p(Math.floor((s % 3600) / 60)) + ':' + p(s % 60); };

// Who was speaking at this moment: the one whose labelled utterance overlaps the start of the piece,
// otherwise the nearest in time. The voice labels carry no text — only the label and the time are used.
const who = (t) => {
  const hit = D.find(x => t >= x.t && t < (x.end || x.t))
    || D.reduce((a, x) => (!a || Math.abs(x.t - t) < Math.abs(a.t - t) ? x : a), null);
  return hit ? (hit.name || hit.spk) : 'Participant 1';
};

// Dialogue: consecutive pieces from one person form one utterance, but no longer than 20 seconds,
// otherwise a labelling failure would glue the whole recording into one line.
const BLOCK = 20;
const out = [];
for (const x of base) {
  const said = String(x.text || '').trim();
  if (!said) continue;
  const spk = who(x.t);
  const last = out[out.length - 1];
  if (last && last.spk === spk && x.t - last.t < BLOCK) last.text += ' ' + said;
  else out.push({ t: x.t, spk, text: said });
}
const text = out.map(x => `[${fmt(x.t)}] ${x.spk}: ${x.text}`).join('\n');
const speakers = [...new Set(D.map(s => s.name || s.spk))].sort();
return [{ json: { text, speakers, segments: D, method: vid.method } }];"""


def req(method, url, data=None):
    r = urllib.request.Request(
        BASE + url, method=method,
        data=json.dumps(data).encode() if data else None,
        headers={'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(r))


w = req('GET', '/workflows/' + OFFLINE)
names = {n['name'] for n in w['nodes']}
final = next((n for n in w['nodes'] if n['name'] == FINAL), None)
if not final:
    print(f'the workflow has no "{FINAL}" node — look at it by eye')
    sys.exit(1)
if not (names & set(DROP)) and final['parameters'].get('jsCode') == CODE:
    print('the transcript is already assembled by code from V5 — nothing to change')
    sys.exit()

os.makedirs('tools', exist_ok=True)
backup = f'tools/backup-offline-{time.strftime("%Y%m%d-%H%M%S")}.json'
json.dump(w, open(backup, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

final['parameters']['jsCode'] = CODE
w['nodes'] = [n for n in w['nodes'] if n['name'] not in DROP]
# The merge nodes sat between voice separation and the transcript — reconnect directly.
conn = w['connections']
for name in DROP:
    conn.pop(name, None)
for branches in conn.values():
    for br in branches.get('main') or []:
        for c in br or []:
            if c['node'] in DROP:
                c['node'] = FINAL
                c['index'] = 0

req('PUT', '/workflows/' + OFFLINE, {
    'name': w['name'], 'nodes': w['nodes'], 'connections': conn,
    'settings': w.get('settings', {})})
print('deleted nodes:', ', '.join(sorted(names & set(DROP))))
print(f'"{SRC}" → "{FINAL}": the text is assembled by code from V5, the speaker by timecode')
print('copy of the workflow before the edit:', backup)
