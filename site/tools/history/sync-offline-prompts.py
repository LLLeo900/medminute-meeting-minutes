"""Carries minutes improvements over from the online workflow to the offline one.

Both branches must produce the same minutes — the only difference is the model: online goes
to OpenAI, offline to the local qwen3:8b. So the online nodes are taken as the reference and
only the model line is swapped. The workflow is NOT run: edit and leave.

NOTE: the workflow ids below belong to the original installation — put your own ids here
(see the n8n URL of each workflow) before running this script.
"""
import io
import json
import sys
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
KEY = open('.n8n-key', encoding='utf-8').read().strip()
BASE = 'http://127.0.0.1:5678/api/v1'
ONLINE = 'kNUDLra3Oypao9UP-4xEO'
OFFLINE = 'rQkljhVk4odN5YoP'

# online node -> offline node. JS code is copied as is, prompts with the model swapped.
PAIRS = [
    ('Transcript with names', 'Transcript with names'),
    ('Three languages', 'Three languages'),
    ('Who is who (names, gpt-4.1)', 'Who is who (names, qwen3:8b)'),
    ('MoM report (per language, gpt-4.1)', 'MoM report (per language, qwen3:8b)'),
    ('Decisions and tasks (JSON, gpt-4.1)', 'Decisions and tasks (JSON, qwen3:8b)'),
    ('Patients and prescriptions (JSON, gpt-4.1)', 'Patients and prescriptions (JSON, qwen3:8b)'),
]


def req(method, url, data=None):
    r = urllib.request.Request(
        BASE + url, method=method,
        data=json.dumps(data).encode() if data is not None else None,
        headers={'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(r))


def to_local(body):
    """Online prompt → local-model prompt: its own model and "thinking" switched off."""
    out = body.replace("model: 'gpt-4.1'", "model: 'qwen3:8b', reasoning_effort: 'none'")
    if 'qwen3:8b' not in out:
        raise SystemExit('could not find the model line — check the prompt by hand')
    return out


# qwen thinks out loud in <think>…</think> — otherwise JSON.parse fails on the very first response.
THINK = r".replace(/<think>[\s\S]*?<\/think>/g, '')"


def to_local_code(code):
    """Online code → offline code: strip the model "thinking" before parsing the response."""
    return code.replace(
        ".message?.content || '{}').replace(",
        ".message?.content || '{}')" + THINK + '.replace(')


on = {n['name']: n for n in req('GET', '/workflows/' + ONLINE)['nodes']}
off_wf = req('GET', '/workflows/' + OFFLINE)
off = {n['name']: n for n in off_wf['nodes']}

changed = []
for src_name, dst_name in PAIRS:
    src, dst = on.get(src_name), off.get(dst_name)
    if not src or not dst:
        print(f'SKIPPED: no pair {src_name} → {dst_name}')
        continue
    key = 'jsCode' if 'jsCode' in src['parameters'] else 'jsonBody'
    new = src['parameters'][key]
    new = to_local(new) if key == 'jsonBody' else to_local_code(new)
    if dst['parameters'].get(key) == new:
        print(f'already identical: {dst_name}')
        continue
    dst['parameters'][key] = new
    changed.append(dst_name)

if changed:
    req('PUT', '/workflows/' + OFFLINE, {
        'name': off_wf['name'], 'nodes': off_wf['nodes'],
        'connections': off_wf['connections'], 'settings': off_wf.get('settings', {})})
print('Synchronised:', ', '.join(changed) if changed else 'nothing')
