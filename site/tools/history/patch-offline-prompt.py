"""Offline gets the language and the vocabulary of terms — the same thing online does with its prompt.

Offline sent only {path, window} to the service, and Romanian speech came out as Russian
transliteration (Romanian words spelled in Cyrillic). Measured on 27.09 on a one-minute clip.

The online prompt cannot be repeated verbatim — tested, the result is worse. For gpt-4o the
prompt is an instruction ("write in the language spoken, do not translate"), while for Whisper the
initial_prompt is "the beginning of the transcript", and it simply continues it: the text filled up with
"BIPAP, ECO, SIO, SIO, SIO…" and "Română — început să se întâmplă". So from online we
take only the second half of the prompt — the clinic's list of terms (that is exactly what Whisper
needs to hear "hidronefroză" and not a garbled Cyrillic lookalike), and the language instruction
is replaced by what Whisper really understands: the language parameter.

The list of terms is extracted straight from `PROMPTS.ro` of the online workflow (everything after
"MedMinute:"), so the branches do not drift apart: add a drug online — run the script.

The language is fixed by `ASR_LANG` (ro by default): on a one-minute clip Whisper auto-detection
said "Russian" with confidence 0.34 on clearly Romanian speech, and the whole text went off.
An empty ASR_LANG brings back auto-detection — it is now at least done once for the whole recording and
picks only from the ASR_LANGS languages (see asr/service.py).

The script is idempotent. The offline workflow is only edited, not run.
"""
import io
import json
import os
import re
import sys
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
KEY = open('.n8n-key', encoding='utf-8').read().strip()
BASE = 'http://127.0.0.1:5678/api/v1'
ONLINE = 'kNUDLra3Oypao9UP-4xEO'
OFFLINE = 'rQkljhVk4odN5YoP'
LANG = os.environ.get('ASR_LANG', 'ro')


def req(method, url, data=None):
    r = urllib.request.Request(
        BASE + url, method=method,
        data=json.dumps(data).encode() if data else None,
        headers={'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(r))


on = req('GET', '/workflows/' + ONLINE)
code = next(n['parameters']['jsCode'] for n in on['nodes'] if n['name'] == 'Slicing variants')
m = re.search(r"^\s*ro:\s*'((?:[^'\\]|\\.)*)'", code, re.M)
if not m:
    print('could not find PROMPTS.ro in the online "Slicing variants" node')
    sys.exit(1)
full = m.group(1).replace("\\'", "'").replace('\\\\', '\\')
if 'MedMinute:' not in full:
    print('PROMPTS.ro has no list of terms after "MedMinute:" — look at the prompt by eye')
    sys.exit(1)
prompt = 'Ședință medicală MedMinute:' + full.split('MedMinute:', 1)[1]

off = req('GET', '/workflows/' + OFFLINE)
changed = []
for node in off['nodes']:
    w = re.fullmatch(r'Whisper windows (\d+)s', node['name'])
    if not w:
        continue
    body = ('={{ JSON.stringify({ path: $(\'Job\').first().json.inputPath, '
            f'window: {w.group(1)}, language: {json.dumps(LANG)}, '
            f'prompt: {json.dumps(prompt, ensure_ascii=False)}'
            ' }) }}')
    if node['parameters'].get('jsonBody') == body:
        continue
    node['parameters']['jsonBody'] = body
    changed.append(node['name'])

if not changed:
    print('the offline windows already have the language and the vocabulary — nothing to change')
    sys.exit()

req('PUT', '/workflows/' + OFFLINE, {
    'name': off['name'], 'nodes': off['nodes'], 'connections': off['connections'],
    'settings': off.get('settings', {})})
print('fixed:', ', '.join(changed))
print('language:', LANG or 'auto-detection over the whole recording')
print('vocabulary:', prompt[:90] + '…')
