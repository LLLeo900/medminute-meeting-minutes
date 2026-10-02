"""Shows the state of an n8n execution: python tools/exec.py [id]"""
import io, json, os, sys, urllib.request

BASE = os.environ.get('N8N_BASE', 'http://localhost:5678')
KEY = open(os.path.join(os.path.dirname(__file__), '..', '.n8n-key'), encoding='utf-8').read().strip()
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')


def api(path):
    r = urllib.request.Request(BASE + '/api/v1' + path, headers={'X-N8N-API-KEY': KEY})
    return json.loads(urllib.request.urlopen(r).read().decode('utf-8'))


def shorten(v, n=400):
    s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
    return s[:n]


eid = sys.argv[1] if len(sys.argv) > 1 else None
if not eid:
    for st in ('running', 'error', 'success'):
        d = api(f'/executions?status={st}&limit=5')
        for e in d.get('data', []):
            print(st, e['id'], e['startedAt'], e.get('workflowId'))
    sys.exit()

d = api(f'/executions/{eid}?includeData=true')
print('status:', d['status'], '| started', d['startedAt'], '| finished', d.get('stoppedAt'))
data = d.get('data')
if isinstance(data, str):
    data = json.loads(data)
rd = (data or {}).get('resultData', {})
print('last node:', rd.get('lastNodeExecuted'))
err = rd.get('error')
if err:
    print('ERROR in', (err.get('node') or {}).get('name'), '::', shorten(err.get('message'), 800))
    if err.get('description'):
        print('  description:', shorten(err['description'], 600))
for name, runs in (rd.get('runData') or {}).items():
    for i, r in enumerate(runs):
        e = r.get('error')
        if e:
            print('  X', name, '::', shorten(e.get('message'), 500))
        else:
            main = ((r.get('data') or {}).get('main') or [[]])[0] or []
            print('  ok', name, f'({len(main)} items)', shorten(main[0].get('json') if main else '', 180))
