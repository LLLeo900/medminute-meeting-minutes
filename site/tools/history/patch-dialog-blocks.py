"""The original recording as a dialogue, not as a stream of two-second fragments.

Before: every recognised utterance went on its own line, and they are short — 2-3 seconds each.
People interrupt each other, so the text looked like ping-pong made of fragments.

After: the recording is divided into short spans, and inside a span everything said by one
person is gathered into one utterance — like dialogue in a book:
"[00:05] Andrei: …", then "[00:05] John: …", then the next span.

The span length is BLOCK below. It is kept at 5 seconds: at 15 seconds utterances from different
parts of the conversation got glued into one and the dialogue lost its liveliness. You can change BLOCK and
re-run the script as many times as you like — it rewrites the already inserted block.
The "[time] Who: text" line format is preserved, otherwise name substitution,
language tagging and parsing on the site would break.

The "Final transcript" node is edited in online and offline — both build the text with the same
line, so the insertion is identical. Nothing further down the chain needs changing:
"Three languages", the MoM prompts and the site all parse the same "[time] Who: text" format.
"""
import io
import json
import re
import sys
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
KEY = open('.n8n-key', encoding='utf-8').read().strip()
BASE = 'http://127.0.0.1:5678/api/v1'
WORKFLOWS = ['kNUDLra3Oypao9UP-4xEO', 'rQkljhVk4odN5YoP']
NODE = 'Final transcript'
BLOCK = 5

OLD = "const text = parts.map(p => p.text).filter(Boolean).join('\\n');"
# Header of the insertion: the comment and the span length. They are kept together — otherwise when BLOCK
# changed the number changed, but the comment stayed from the previous length and started lying.
HEAD = f"""// A dialogue, not a stream of fragments: cut the recording into spans of {BLOCK} seconds and inside
// a span gather everything said by one person into one utterance. People interrupt each
// other, so gluing only consecutive lines would achieve nothing.
const BLOCK = {BLOCK};"""
HEAD_RE = re.compile(r'// A dialogue, not a stream of fragments:.*?const BLOCK = \d+;', re.S)
NEW = """const raw = parts.map(p => p.text).filter(Boolean).join('\\n');

__HEAD__
const secs = (t) => { const p = t.split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
function dialog(src) {
  const out = [];
  for (const line of String(src).split('\\n').map(s => s.trim()).filter(Boolean)) {
    const m = /^\\[(\\d{1,2}:\\d{2}(?::\\d{2})?)\\]\\s*([^:]{1,60}?):\\s*(.*)$/.exec(line);
    if (!m) { out.push({ raw: line }); continue; }          // a line not in the format — leave it alone
    const [, tc, who, said] = m;
    if (!said.trim()) continue;
    let b = out[out.length - 1];
    if (!b || b.raw || secs(tc) - b.t >= BLOCK) { b = { t: secs(tc), tc, turns: new Map() }; out.push(b); }
    const prev = b.turns.get(who);
    b.turns.set(who, prev ? `${prev} ${said.trim()}` : said.trim());   // order — by the first word in the span
  }
  return out.flatMap(b => b.raw ? [b.raw] : [...b.turns].map(([who, said]) => `[${b.tc}] ${who}: ${said}`)).join('\\n');
}
const text = dialog(raw);"""


def req(method, url, data=None):
    r = urllib.request.Request(
        BASE + url, method=method,
        data=json.dumps(data).encode() if data else None,
        headers={'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(r))


for wid in WORKFLOWS:
    w = req('GET', '/workflows/' + wid)
    node = next((n for n in w['nodes'] if n['name'] == NODE), None)
    if not node:
        print(f'{wid}: no "{NODE}" node — skipping')
        continue
    code = node['parameters']['jsCode']
    if 'const text = dialog(raw);' in code:
        # The block is already inserted — rewrite the header entirely for the current BLOCK.
        if HEAD in code:
            print(f'{wid}: already at {BLOCK} s')
            continue
        code = HEAD_RE.sub(HEAD, code, count=1)
    elif OLD in code:
        code = code.replace(OLD, NEW.replace('__HEAD__', HEAD), 1)
    else:
        print(f'{wid}: could not find where the text is assembled, look at the node by eye')
        continue
    node['parameters']['jsCode'] = code
    req('PUT', '/workflows/' + wid, {
        'name': w['name'], 'nodes': w['nodes'],
        'connections': w['connections'], 'settings': w.get('settings', {})})
    print(f'{wid}: the transcript is assembled as a dialogue in ~{BLOCK}-second spans')
