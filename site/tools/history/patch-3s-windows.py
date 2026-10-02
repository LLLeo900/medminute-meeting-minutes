"""Finer slicing — 3 seconds instead of 5.

Two recognition versions remain: the long 15s one gives context, the short one is the base of the text.
The short one was 5 seconds; the user asked for finer slices: at 5 seconds the model manages
to "drift" off Romanian and add a word of its own, at 3 seconds it almost never does.
The prompt in the merge node already says to take the text from the short version and to use the long one
where a short piece is cut off or clearly distorted — this rule is not changed,
only the numbers in it.

The online workflow is edited. Everything where the version is named is touched: slicing, joining,
windows, the merge prompt, the export of source versions and the notes on the canvas. Node names
with "15s + 5s" are renamed too — together with the connections, otherwise the canvas falls apart.

Offline is not touched: there the short version is set by a single number in the request body
("Whisper windows 5s"), and it has a separate problem — neither the language nor the
prompt is passed to the windows, so Romanian drifts into Russian transliteration. That is fixed separately.
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

OLD_CFG = "{ name: '5s',  MIN: 3.5, TARGET: 5,  MAX: 6.5, OVERLAP: 0.5, prompt: 'ro' },"
NEW_CFG = "{ name: '3s',  MIN: 2,   TARGET: 3,  MAX: 4,   OVERLAP: 0.5, prompt: 'ro' },"

# Replacements in the parameter text. Order matters: long phrases first, then short tokens,
# otherwise "15s + 5s" would only half turn into "15s + 3s".
SWAPS = [
    ("// Two slicings: 15s (better Romanian) and 5s (loses nothing, keeps the language).",
     "// Two slicings: 15s (context, better Romanian) and 3s (base of the text, keeps the language)."),
    ('pieces of 3-5 s', 'pieces of 2-4 s'),
    ('pieces of 3-5 seconds', 'pieces of 2-4 seconds'),
    ('15s + 5s', '15s + 3s'),
    ('15s and 5s', '15s and 3s'),
    ('15s, 5s', '15s, 3s'),
    ("'5s'", "'3s'"),
    ('V5', 'V3'),
    ('v5:', 'v3:'),
]
# "Final transcript" also contains "5 s", but that is the utterance length in the dialogue, not a
# recognition version — it is not included here.
NODES = ['Slicing variants', 'Number segments', 'Join versions', '5-minute windows',
         'Transcribe 15s + 5s (gpt-4o-transcribe)', 'Merge 15s + 5s + speakers (gpt-4.1)',
         'Build files', 'Source versions (text)', 'Note B', 'Note C']
RENAME = {'Transcribe 15s + 5s (gpt-4o-transcribe)': 'Transcribe 15s + 3s (gpt-4o-transcribe)',
          'Merge 15s + 5s + speakers (gpt-4.1)': 'Merge 15s + 3s + speakers (gpt-4.1)'}


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
if "name: '3s'" in json.dumps(w, ensure_ascii=False):
    print('already sliced at 3 seconds — nothing to change')
    sys.exit()

for node in w['nodes']:
    if node['name'] not in NODES:
        continue
    p = node['parameters']
    if node['name'] == 'Slicing variants':
        if OLD_CFG not in p['jsCode']:
            print('could not find the 5s config line — look at the "Slicing variants" node by eye')
            sys.exit(1)
        p['jsCode'] = p['jsCode'].replace(OLD_CFG, NEW_CFG, 1)
    # Parameters can be nested (the merge prompt lives inside jsonBody), so the whole
    # serialized representation is edited.
    node['parameters'] = json.loads(swap(json.dumps(p, ensure_ascii=False)))

# Node names are keys in connections, so the rename goes both ways.
for node in w['nodes']:
    if node['name'] in RENAME:
        node['name'] = RENAME[node['name']]
conns = json.loads(re.sub('|'.join(re.escape(k) for k in RENAME),
                          lambda m: RENAME[m.group(0)],
                          json.dumps(w['connections'], ensure_ascii=False)))

req('PUT', '/workflows/' + WORKFLOW, {
    'name': w['name'], 'nodes': w['nodes'], 'connections': conns,
    'settings': w.get('settings', {})})
print('online: the short version is now 3 seconds (target 3, bounds 2–4), the long one 15 — unchanged')
