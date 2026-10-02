"""Adds to the offline branch what cannot be copied from online verbatim.

"Build files" and "Row: meeting" in offline refer to local nodes, so they are not
copied over whole. Only the new parts are added here: the "Original recording" block
at the end of every report and the language-statistics and mentioned-people fields for the site.
"""
import io
import json
import sys
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
KEY = open('.n8n-key', encoding='utf-8').read().strip()
BASE = 'http://127.0.0.1:5678/api/v1'
WID = 'rQkljhVk4odN5YoP'

FILES_OLD = "const langs = $('Three languages').all().map(i => i.json.lang);\nconst out ="
FILES_NEW = """const langs = $('Three languages').all().map(i => i.json.lang);

// The original recording is appended to the end of every report: you can see that part of the speech was
// in Russian, part in Romanian, part in English — and compare it with the minutes.
const L = $('Three languages').first().json;
const tail = ['', '---', '', '## Original recording (as spoken)', '',
  `Languages in the recording: ${L.langLine || '—'}.`,
  'The tag at the start of a line is the utterance language. The text was not translated or edited.', '',
  '```', L.original || '', '```', ''].join('\\n');
const out ="""

FILES_OLD2 = "return { json: { lang, fileName: `${base}.${lang}.md`, content } };"
FILES_NEW2 = "return { json: { lang, fileName: `${base}.${lang}.md`, content: content + '\\n' + tail } };"

MEET_OLD = "const fin = $('Transcript with names').first().json;\nreturn [{ json: {"
MEET_NEW = ("const fin = $('Transcript with names').first().json;\n"
            "const L = $('Three languages').first().json;\nreturn [{ json: {")

MEET_OLD2 = "  ru: mom.ru || '', ro: mom.ro || '', en: mom.en || '',\n} }];"
MEET_NEW2 = ("  ru: mom.ru || '', ro: mom.ro || '', en: mom.en || '',\n"
             "  original: L.original || '', langStats: L.langStats || [], langLine: L.langLine || '',\n"
             "  mentioned: fin.mentioned || [],\n} }];")


def req(method, url, data=None):
    r = urllib.request.Request(
        BASE + url, method=method,
        data=json.dumps(data).encode() if data is not None else None,
        headers={'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(r))


w = req('GET', '/workflows/' + WID)
N = {n['name']: n for n in w['nodes']}
done = []


def sub(node, old, new, label):
    cur = node['parameters']['jsCode']
    if new in cur:
        print(f'already applied: {label}')
        return
    if old not in cur:
        print(f'SKIPPED: fragment not found — {label}')
        return
    node['parameters']['jsCode'] = cur.replace(old, new, 1)
    done.append(label)


sub(N['Build files'], FILES_OLD, FILES_NEW, 'Build files: "Original recording" block')
sub(N['Build files'], FILES_OLD2, FILES_NEW2, 'Build files: append the block to the report')
sub(N['Row: meeting'], MEET_OLD, MEET_NEW, 'Row: meeting: reference to "Three languages"')
sub(N['Row: meeting'], MEET_OLD2, MEET_NEW2, 'Row: meeting: languages and mentioned people')

if done:
    req('PUT', '/workflows/' + WID, {
        'name': w['name'], 'nodes': w['nodes'],
        'connections': w['connections'], 'settings': w.get('settings', {})})
print('Updated:', ', '.join(done) if done else 'nothing')
