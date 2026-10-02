"""Duration from ffmpeg: recordings from the in-browser recorder (WebM from MediaRecorder) have no
duration in the header (Duration: N/A), so a fallback parse of the time= progress line is added."""
import io
import json
import re
import sys
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
KEY = open('.n8n-key', encoding='utf-8').read().strip()
BASE = 'http://127.0.0.1:5678/api/v1'

PAT = re.compile(
    r"const dm = log\.match\(.*?const total = \(\+dm\[1\]\) \* 3600 \+ \(\+dm\[2\]\) \* 60 \+ parseFloat\(dm\[3\]\);",
    re.S)

NEW = r"""const hms = (m) => (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
let total = null;
const dm = log.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
if (dm) total = hms(dm);
else {
  // Recording from the in-browser recorder: Chrome writes WebM as a stream, there is no duration in the header (Duration: N/A).
  // Take the last ffmpeg progress line — time=00:00:17.75.
  const ts = [...log.matchAll(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  if (ts.length) total = hms(ts[ts.length - 1]);
}
if (!total || !isFinite(total) || total <= 0) {
  throw new Error('ffmpeg did not return a duration. Log:\n' + log.slice(0, 800));
}"""


def req(method, url, data=None):
    r = urllib.request.Request(
        BASE + url, method=method,
        data=json.dumps(data).encode() if data else None,
        headers={'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(r))


for wid, label in [('kNUDLra3Oypao9UP-4xEO', 'Online'), ('rQkljhVk4odN5YoP', 'Offline')]:
    w = req('GET', '/workflows/' + wid)
    hit = 0
    for n in w['nodes']:
        code = (n.get('parameters') or {}).get('jsCode')
        if code and PAT.search(code):
            n['parameters']['jsCode'] = PAT.sub(lambda _: NEW, code)
            hit += 1
            print(f'{label}: patched node "{n["name"]}"')
    if not hit:
        print(f'{label}: no node with this code found')
        continue
    req('PUT', '/workflows/' + wid, {
        'name': w['name'], 'nodes': w['nodes'],
        'connections': w['connections'], 'settings': w.get('settings', {})})
    print(f'{label}: saved')
