"""Minutes headings — in the minutes language.

Before: when switching to another language the text was translated, but the section headings
stayed in the schema language ("Letter", "Participants", "Agenda", "Decisions"). The model copied them
from the response schema, because the schema has them in one language only.

After: the "Three languages" node gives each language a ready list of headings, and the MoM prompt
says outright — in the schema they are given only as a template, and they must be written in the minutes
language, topic headings too. Names, drugs and abbreviations are still left alone.

Both branches are edited: online (gpt-4.1) and offline (qwen3) — code and text in them are identical.
The 'ru' map below is intentionally in Russian: it is the heading text of the Russian minutes.
"""
import io
import json
import sys
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
KEY = open('.n8n-key', encoding='utf-8').read().strip()
BASE = 'http://127.0.0.1:5678/api/v1'
WORKFLOWS = ['kNUDLra3Oypao9UP-4xEO', 'rQkljhVk4odN5YoP']

LANG_NODE = 'Three languages'
LANG_OLD = """const common = { meetingDate, text, roster, original, langStats, langLine };
return [
  { json: { ...common, lang: 'ru', langName: 'Russian' } },
  { json: { ...common, lang: 'ro', langName: 'Romanian (limba română)' } },
  { json: { ...common, lang: 'en', langName: 'English' } },
];"""
LANG_NEW = """// Section headings in the minutes language. Without this the model translated the text but copied the headings
// from the response schema as they were — and an untranslated heading stayed in the other-language minutes.
const HEADS = {
  ru: 'Letter → Письмо; Subject → Тема; Participants → Участники; Agenda → Повестка; '
    + 'Objectives → Цели; Decisions → Решения; Action items → Действия; Minutes of the meeting → Протокол встречи; '
    + 'Date → Дата; Open questions → Открытые вопросы; Next meeting → Следующая встреча',
  ro: 'Letter → Scrisoare; Subject → Subiect; Participants → Participanți; Agenda → Ordinea de zi; '
    + 'Objectives → Obiective; Decisions → Decizii; Action items → Acțiuni; Minutes of the meeting → Proces-verbal al ședinței; '
    + 'Date → Data; Open questions → Întrebări deschise; Next meeting → Următoarea ședință',
  en: 'they are already in English, write them as in the schema',
};

const common = { meetingDate, text, roster, original, langStats, langLine };
return [
  { json: { ...common, lang: 'ru', langName: 'Russian', heads: HEADS.ru } },
  { json: { ...common, lang: 'ro', langName: 'Romanian (limba română)', heads: HEADS.ro } },
  { json: { ...common, lang: 'en', langName: 'English', heads: HEADS.en } },
];"""

MOM_OLD = ('Do not translate or change names, surnames, drugs, doses, abbreviations and numbers — '
           'write them as spoken.')
MOM_NEW = (MOM_OLD + ' SECTION HEADINGS in the response schema are written in English only as a template — '
           "in the response itself write them in the minutes language exactly like this: ' + $json.heads + '. "
           'Write topic headings (patient, department, area, question) in the minutes language too; '
           'keep people names, drug names and abbreviations as they are.')


def req(method, url, data=None):
    r = urllib.request.Request(
        BASE + url, method=method,
        data=json.dumps(data).encode() if data else None,
        headers={'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(r))


for wid in WORKFLOWS:
    w = req('GET', '/workflows/' + wid)
    N = {n['name']: n for n in w['nodes']}
    done = []

    node = N.get(LANG_NODE)
    code = node['parameters']['jsCode'] if node else ''
    if 'HEADS' in code:
        print(f'{wid}: headings are already provided ("{LANG_NODE}")')
    elif LANG_OLD not in code:
        print(f'{wid}: could not find the three-language output — look at "{LANG_NODE}" by eye')
    else:
        node['parameters']['jsCode'] = code.replace(LANG_OLD, LANG_NEW, 1)
        done.append(LANG_NODE)

    mom = next((n for n in w['nodes'] if 'MoM' in n['name']), None)
    body = mom['parameters']['jsonBody'] if mom else ''
    if '$json.heads' in body:
        print(f'{wid}: the headings instruction is already in place')
    elif MOM_OLD not in body:
        print(f'{wid}: could not find the language rule in the MoM prompt')
    else:
        mom['parameters']['jsonBody'] = body.replace(MOM_OLD, MOM_NEW, 1)
        done.append(mom['name'])

    if done:
        req('PUT', '/workflows/' + wid, {
            'name': w['name'], 'nodes': w['nodes'],
            'connections': w['connections'], 'settings': w.get('settings', {})})
    print(f'{wid}: updated — {", ".join(done) if done else "nothing"}')
