"""Back to 5-second slicing — reverts patch-3s-windows.py.

At three seconds a piece is too short: the model does not hear a word in full and recognises
worse than at five. The user checked and asked to restore the previous setup — 15s + 5s.

The script is the exact inverse of patch-3s-windows.py: the same places, the same strings, reversed.
Replacements again go from longest to shortest, otherwise "15s + 3s" would fall apart into halves.
Offline is not touched — its short version stayed at five seconds anyway.
"""
import io
import json
import re
import sys
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
KEY = open('.n8n-key', encoding='utf-8').read().strip()
BASE = 'http://127.0.0.1:5678/api/v1'
WORKFLOW = 'kNUDLra3Oypao9UP-4xEO'

OLD_CFG = "{ name: '3s',  MIN: 2,   TARGET: 3,  MAX: 4,   OVERLAP: 0.5, prompt: 'ro' },"
NEW_CFG = "{ name: '5s',  MIN: 3.5, TARGET: 5,  MAX: 6.5, OVERLAP: 0.5, prompt: 'ro' },"

SWAPS = [
    ("// Two slicings: 15s (context, better Romanian) and 3s (base of the text, keeps the language).",
     "// Two slicings: 15s (better Romanian) and 5s (loses nothing, keeps the language)."),
    ('pieces of 2-4 s', 'pieces of 3-5 s'),
    ('pieces of 2-4 seconds', 'pieces of 3-5 seconds'),
    ('15s + 3s', '15s + 5s'),
    ('15s and 3s', '15s and 5s'),
    ('15s, 3s', '15s, 5s'),
    ("'3s'", "'5s'"),
    ('V3', 'V5'),
    ('v3:', 'v5:'),
]
NODES = ['Slicing variants', 'Number segments', 'Join versions', '5-minute windows',
         'Transcribe 15s + 3s (gpt-4o-transcribe)', 'Merge 15s + 3s + speakers (gpt-4.1)',
         'Build files', 'Source versions (text)', 'Note B', 'Note C']
RENAME = {'Transcribe 15s + 3s (gpt-4o-transcribe)': 'Transcribe 15s + 5s (gpt-4o-transcribe)',
          'Merge 15s + 3s + speakers (gpt-4.1)': 'Merge 15s + 5s + speakers (gpt-4.1)'}


def req(method, url, data=None):
    r = urllib.request.Request(
        BASE + url, method=method,
        data=json.dumps(data).encode() if data else None,
        headers={'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(r))


def swap(text):
    for a, b in SWAPS:
        text = text.replace(a, b)
    return text


w = req('GET', '/workflows/' + WORKFLOW)
if "name: '5s'" in json.dumps(w, ensure_ascii=False):
    print('already sliced at 5 seconds — nothing to change')
    sys.exit()

for node in w['nodes']:
    if node['name'] not in NODES:
        continue
    p = node['parameters']
    if node['name'] == 'Slicing variants':
        if OLD_CFG not in p['jsCode']:
            print('could not find the 3s config line — look at the "Slicing variants" node by eye')
            sys.exit(1)
        p['jsCode'] = p['jsCode'].replace(OLD_CFG, NEW_CFG, 1)
    node['parameters'] = json.loads(swap(json.dumps(p, ensure_ascii=False)))

for node in w['nodes']:
    if node['name'] in RENAME:
        node['name'] = RENAME[node['name']]
conns = json.loads(re.sub('|'.join(re.escape(k) for k in RENAME),
                          lambda m: RENAME[m.group(0)],
                          json.dumps(w['connections'], ensure_ascii=False)))

req('PUT', '/workflows/' + WORKFLOW, {
    'name': w['name'], 'nodes': w['nodes'], 'connections': conns,
    'settings': w.get('settings', {})})
print('online: the short version is 5 seconds again (target 5, bounds 3.5–6.5), the long one 15 — unchanged')
