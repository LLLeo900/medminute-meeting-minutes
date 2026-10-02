"""The minutes are forbidden to guess what recognition garbled.

The check on 27.09 across all 16 finished meetings (`node tools/check-mom-grounded.js --all`)
showed: the model invents nothing — every number and every name in the minutes is found
in the transcript. But it is found there in a distorted form, and the model restores it:
  "Clepsiella and Candida"           → Klebsiella (guessed correctly)
  "Anemica, auzeceșase hemoglobina"  → haemoglobin 86 (optzeci și șase)
  "tensiunele opt zeci pe" + "patruzeci" (the speaker was interrupted) → blood pressure 80/40
  "de zero douăci douăi de nor"      → norepinephrine dose 0.22
So far it guesses correctly, but the prompt had no rule drawing the line —
and since 27.09 the model gets the transcript without an intermediate proofreading pass (the merge node was removed),
so there is more raw text and more guessing.

Rule 1 is extended: recognised a word — write it correctly; did not — skip it, do not turn
a jumble of sounds into a drug, a diagnosis or a name; complete a number only if it was spoken
in full. Idempotent, does not run the workflow.
"""
import io
import json
import sys
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
KEY = open('.n8n-key', encoding='utf-8').read().strip()
BASE = 'http://127.0.0.1:5678/api/v1'
WORKFLOWS = {'online': 'kNUDLra3Oypao9UP-4xEO', 'offline': 'rQkljhVk4odN5YoP'}
NODE_HINT = 'MoM report'
OLD = ('1. Only facts from the conversation. Do not invent decisions, tasks, owners, '
       'deadlines or numbers.')
ADD = (' The transcript is raw speech recognition, and words in it can be garbled: «Clepsiella» '
       'instead of Klebsiella, «auzeceșase» instead of optzeci și șase. If you recognise a word confidently — write it '
       'correctly. If you do not — skip that place, but never turn a jumble of sounds into a drug, '
       'a diagnosis or a name. Convert a number spoken in words into digits only if it was '
       'spoken in full; never complete a cut-off number.')


def req(method, url, data=None):
    r = urllib.request.Request(
        BASE + url, method=method,
        data=json.dumps(data).encode() if data else None,
        headers={'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(r))


for label, wid in WORKFLOWS.items():
    w = req('GET', '/workflows/' + wid)
    nodes = [n for n in w['nodes'] if NODE_HINT in n['name']]
    if not nodes:
        print(f'{label}: no "{NODE_HINT}…" node — skipping')
        continue
    changed = []
    for n in nodes:
        body = n['parameters'].get('jsonBody') or ''
        if ADD.strip() in body:
            continue
        if OLD not in body:
            print(f'{label}: rule 1 not found in node "{n["name"]}" — edit the prompt by hand')
            sys.exit(1)
        n['parameters']['jsonBody'] = body.replace(OLD, OLD + ADD, 1)
        changed.append(n['name'])
    if not changed:
        print(f'{label}: the no-guessing rule is already there — nothing to change')
        continue
    req('PUT', '/workflows/' + wid, {
        'name': w['name'], 'nodes': w['nodes'], 'connections': w['connections'],
        'settings': w.get('settings', {})})
    print(f'{label}: fixed — {", ".join(changed)}')
