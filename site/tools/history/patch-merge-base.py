"""The base of the final transcript becomes the 15-second slicing, not the 5-second one.

Before: the merge relied on V5 ("treat the language of V5 as the original"), so the text was assembled
from five-second pieces. They have a short context, the model does not hear the beginning of a phrase and
guesses words — errors accumulated in the original.

After: the skeleton of a fragment is taken from V15 (its context is three times wider), and V5 is used only for
spot corrections — a single word, the preserved original language and pieces that V15
skipped. One node of the online workflow is edited; offline has no such slicing at all —
there the local Whisper transcribes the whole recording.
"""
import io
import json
import sys
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
KEY = open('.n8n-key', encoding='utf-8').read().strip()
BASE = 'http://127.0.0.1:5678/api/v1'
WID = 'kNUDLra3Oypao9UP-4xEO'
NODE = 'Merge 15s + 5s + speakers (gpt-4.1)'
WIN_NODE = '5-minute windows'

OLD = (
    'DIAR — recognition with speaker labels: the «Participant N» label is reliable, the text may '
    'contain errors or a translation. V15 — 15 s pieces: writes Romanian words more accurately, but '
    'sometimes TRANSLATES a phrase into another language or skips a piece. V5 — 5 s pieces: skips almost '
    'nothing and keeps the original language, but distorts individual words. People speak '
    'Russian, Romanian and English mixed together, sometimes within one sentence. Rules: '
    '1) the language of each phrase is as in the original; if the versions give the same phrase in different languages, '
    'treat the language of V5 as the original; 2) choose specific words so that they are confirmed '
    'by most versions or clearly sound better; 3) take the speaker from DIAR by timecodes; '
)
NEW = (
    'V15 — 15-second pieces: this is the BASE of the transcript. It has the widest context, so '
    'take phrase boundaries, word order and wording from it. V5 — 5-second pieces: the context '
    'is short and individual words are distorted, so V5 is needed only for corrections. DIAR — recognition '
    'with speaker labels: the «Participant N» label is reliable, the text may contain errors or a translation. '
    'People speak Russian, Romanian and English mixed together, sometimes within one sentence. '
    'Rules: 1) write the text from V15; take from V5 ONLY spot corrections — a single word or a short '
    'phrase, and only if it clearly fits the meaning of the phrase better or if V15 translated a word '
    'into another language while V5 kept the language it was spoken in; 2) if V15 skipped a piece '
    'of the recording entirely (it is in V5 but not in V15) — insert that piece from V5 in its place by timecode; '
    '3) do not replace V15 with whole V5 phrases and do not restructure the fragment to match V5: V5 corrects '
    'words, not sentences; 4) take the speaker from DIAR by timecodes; '
)
# The same roles are labelled right in the text sent to the model — otherwise the section
# headings ("V15", "V5") tell it nothing and it easily confuses the base with the corrections.
WIN_OLD = "=== V15 (15 s pieces) ===\\n${v15 || '—'}\\n\\n=== V5 (5 s pieces) ==="
WIN_NEW = ("=== V15 (15 s pieces — BASE) ===\\n${v15 || '—'}\\n\\n"
           "=== V5 (5 s pieces — only for spot word corrections) ===")

RENUM = [
    ('4) translate nothing', '5) translate nothing'),
    ('5) Russian — in Cyrillic', '6) Russian — in Cyrillic'),
    ('6) if a choice is impossible', '7) if a choice is impossible'),
    ('7) remove repeats at the seams', '8) remove repeats at the seams'),
]


def req(method, url, data=None):
    r = urllib.request.Request(
        BASE + url, method=method,
        data=json.dumps(data).encode() if data else None,
        headers={'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(r))


w = req('GET', '/workflows/' + WID)
N = {n['name']: n for n in w['nodes']}
done = []

node = N[NODE]
cur = node['parameters']['jsonBody']
if NEW in cur:
    print('already applied: the "Merge" prompt')
elif OLD not in cur:
    print('SKIPPED: the prompt in "Merge" is already different, look at it in n8n by eye')
else:
    body = cur.replace(OLD, NEW, 1)
    for old, new in reversed(RENUM):   # from the end, otherwise the shifted numbers would overlap
        body = body.replace(old, new, 1)
    node['parameters']['jsonBody'] = body
    done.append('the "Merge" prompt')

win = N[WIN_NODE]
if WIN_NEW in win['parameters']['jsCode']:
    print('already applied: section labels')
elif WIN_OLD not in win['parameters']['jsCode']:
    print('SKIPPED: could not find the section headings in "5-minute windows"')
else:
    win['parameters']['jsCode'] = win['parameters']['jsCode'].replace(WIN_OLD, WIN_NEW, 1)
    done.append('V15/V5 section labels')

if done:
    req('PUT', '/workflows/' + WID, {
        'name': w['name'], 'nodes': w['nodes'],
        'connections': w['connections'], 'settings': w.get('settings', {})})
print('Updated:', ', '.join(done) if done else 'nothing')
