"""Offline starts throwing away recognition junk — as online has done for a long time.

Online, the "Join versions" node has a `junk()` function: it cuts lines that
Whisper/gpt made up rather than heard. Offline had no such check at all, yet it produces
exactly the same junk — confirmed by measurements on 27.09 on `test-60s.mp3`:
  "Nu uitați să vă mulțumim pentru vizionare"   — a YouTube-style ending on an empty window
  "Să vă mulțumesc pentru like"                 — the same
  "noi avem uree, meropenem, amikacină"         — the model copied the vocabulary from the prompt
The first two are caught by the regexp, the third by the rule "three or more vocabulary terms in one
line means it is not speech but a retelling of the prompt".

The function is copied from the online node as a whole, not rewritten: the list of YouTube-style
endings and the list of terms must live in one place. Add new junk to online —
run the script, offline picks it up.

The offline "5-minute windows" node is edited: `junk` is inserted there, and both text versions
(V15 and V5) are filtered before the window is assembled. Idempotent. The workflow is not run.
"""
import io
import json
import re
import sys
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
KEY = open('.n8n-key', encoding='utf-8').read().strip()
BASE = 'http://127.0.0.1:5678/api/v1'
ONLINE = 'kNUDLra3Oypao9UP-4xEO'
OFFLINE = 'rQkljhVk4odN5YoP'
NODE = '5-minute windows'
ANCHOR = 'const line = (x) => `[${fmt(x.t)}] ${x.text}`;'


def req(method, url, data=None):
    r = urllib.request.Request(
        BASE + url, method=method,
        data=json.dumps(data).encode() if data else None,
        headers={'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(r))


on = req('GET', '/workflows/' + ONLINE)
src = next(n['parameters']['jsCode'] for n in on['nodes'] if n['name'] == 'Join versions')
m = re.search(r'^const TERMS = .*?^\};$', src, re.M | re.S)
if not m:
    print('could not find the junk function in the online "Join versions" node — look at it by eye')
    sys.exit(1)
block = m.group(0)

off = req('GET', '/workflows/' + OFFLINE)
node = next((n for n in off['nodes'] if n['name'] == NODE), None)
if not node:
    print(f'offline has no "{NODE}" node')
    sys.exit(1)
code = node['parameters']['jsCode']

if 'const junk' in code:
    # Already inserted — update the block itself to pick up online edits.
    new = re.sub(r'^const TERMS = .*?^\};$', lambda _: block, code, count=1, flags=re.M | re.S)
else:
    if ANCHOR not in code:
        print('could not find where to insert the filter (the anchor line changed) — edit the node by hand')
        sys.exit(1)
    new = code.replace(
        ANCHOR,
        ANCHOR + '\n// Recognition junk — the same filter as online ("Join versions"):\n'
        '// YouTube-style endings on empty windows and lines where the model copied the vocabulary from the prompt.\n'
        + block, 1)
    # Both versions are filtered the same way: junk shows up in long and short windows alike.
    new, n1 = re.subn(r'inWin\(x\.t, a, b\) && x\.text\)', 'inWin(x.t, a, b) && x.text && !junk(x.text))', new)
    if n1 != 2:
        print(f'expected two filtering places for V15 and V5, found {n1} — edit the node by hand')
        sys.exit(1)

if new == code:
    print('the offline junk filter is already the same as online — nothing to change')
    sys.exit()

node['parameters']['jsCode'] = new
req('PUT', '/workflows/' + OFFLINE, {
    'name': off['name'], 'nodes': off['nodes'], 'connections': off['connections'],
    'settings': off.get('settings', {})})
print(f'offline: the junk filter from online was moved into the "{NODE}" node')
