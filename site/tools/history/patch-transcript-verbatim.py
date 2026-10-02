"""The transcript is assembled by code, not by a model: only V5, the speaker by timecode.

There was an extra model between recognition and the minutes. The "Merge 15s + 5s +
speakers (gpt-4.1)" node received a 5-minute window in three forms at once — V5, V15 and the speaker
labels — and "merged" them as it saw fit. The prompt forbade it to take text from the
labels or to translate anything, but a prohibition is not a guarantee: the model edited words, reordered
utterances, paraphrased in places. This already damaged text then went into the MoM,
the decisions, the tasks and the prescriptions — the distortion got into everything at once.

So the merge is removed completely:
  • the text is taken as recognised — the V5 version (3-5 second pieces swallow nothing);
  • V15 is no longer combined with it — it stays as a separate branch of "Source versions";
  • the speaker is assigned mechanically, by the overlap of timecodes with the labels,
    and the text of the labels themselves is not used anywhere.
The model no longer touches the transcript text — it works only with the finished transcript
(names, minutes, decisions). As a bonus, N gpt-4.1 calls per meeting go away.

The script deletes the "5-minute windows" and "Merge…" nodes, connects "Wait for both branches"
straight to "Final transcript" and rewrites its code. Before editing it saves a full
copy of the workflow to tools/backup-online-<date>.json. Idempotent, does not run the workflow.
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
ONLINE = 'kNUDLra3Oypao9UP-4xEO'
DROP = ['5-minute windows', 'Merge 15s + 5s + speakers (gpt-4.1)']
FINAL = 'Final transcript'
MERGE = 'Wait for both branches'

CODE = r"""// Verbatim transcript — straight from recognition, without a model rewriting it.
// Previously gpt-4.1 merged 5-minute windows: it saw V5, V15 and the speaker labels at once
// and stitched them as it saw fit — edited words, inserted text from diarize,
// paraphrased in places. Exactly this distortion reached the minutes and all the tables.
// Now the text is taken as recognised (V5 — 3-5 second pieces, nothing gets swallowed),
// V15 is not combined with it, and the speaker is assigned by timecode. The model does not touch the text.
const V = $('Join versions').first().json.variants || {};
const D = $('Speakers (format)').first().json.segments || [];
const base = V['5s'] || [];
if (!base.length) {
  throw new Error('recognition did not produce the V5 version — nothing to build the transcript from');
}
const fmt = (s) => { s = Math.max(0, Math.round(+s || 0)); const p = n => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600); return (h ? p(h) + ':' : '') + p(Math.floor((s % 3600) / 60)) + ':' + p(s % 60); };

// Who was speaking at this moment: the one whose labelled utterance overlaps the start of the piece,
// otherwise the nearest in time. The diarize text is not used — only the label and the time.
const who = (t) => {
  const hit = D.find(x => t >= x.t && t < (x.end || x.t))
    || D.reduce((a, x) => (!a || Math.abs(x.t - t) < Math.abs(a.t - t) ? x : a), null);
  return hit ? hit.spk : 'Participant 1';
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
return [{ json: { text, speakers: $('Speakers (format)').first().json.speakers } }];"""


def req(method, url, data=None):
    r = urllib.request.Request(
        BASE + url, method=method,
        data=json.dumps(data).encode() if data else None,
        headers={'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(r))


w = req('GET', '/workflows/' + ONLINE)
names = {n['name'] for n in w['nodes']}
final = next((n for n in w['nodes'] if n['name'] == FINAL), None)
if not final:
    print(f'the workflow has no "{FINAL}" node — look at it by eye')
    sys.exit(1)
if not (names & set(DROP)) and final['parameters'].get('jsCode') == CODE:
    print('the transcript is already assembled by code from V5 — nothing to change')
    sys.exit()

os.makedirs('tools', exist_ok=True)
backup = f'tools/backup-online-{time.strftime("%Y%m%d-%H%M%S")}.json'
json.dump(w, open(backup, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

final['parameters']['jsCode'] = CODE
w['nodes'] = [n for n in w['nodes'] if n['name'] not in DROP]
# The merge node sat between the branch join and the transcript — reconnect directly.
conn = w['connections']
for name in DROP:
    conn.pop(name, None)
for branches in conn.values():
    for br in branches.get('main') or []:
        for c in br or []:
            if c['node'] in DROP:
                c['node'] = FINAL
                c['index'] = 0

req('PUT', '/workflows/' + ONLINE, {
    'name': w['name'], 'nodes': w['nodes'], 'connections': conn,
    'settings': w.get('settings', {})})
print('deleted nodes:', ', '.join(sorted(names & set(DROP))))
print(f'"{MERGE}" → "{FINAL}": the text is assembled by code from V5, the speaker by timecode')
print('copy of the workflow before the edit:', backup)
