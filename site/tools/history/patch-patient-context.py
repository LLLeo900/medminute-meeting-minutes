"""Patient context: the people directory is built once in "Transcript with names"
and passed to all three branches — minutes, decisions/tasks and prescriptions.

Why: decisions and tasks used to come out anonymous ("patient not specified"),
and such a row is useless — it is unclear what to do and with whom.
"""
import io
import json
import sys
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
KEY = open('.n8n-key', encoding='utf-8').read().strip()
BASE = 'http://127.0.0.1:5678/api/v1'
WID = 'kNUDLra3Oypao9UP-4xEO'

# ---------- 1. "Transcript with names": the people directory is built here ----------
NAMES_OLD = ("return [{ json: { text, speakers, nameMap: map, evidence: data.speakers || [],\n"
             "  mentioned: data.mentioned || [] } }];")
NAMES_NEW = r"""const evidence = data.speakers || [];
const mentioned = data.mentioned || [];

// People directory: who spoke and who was talked about. It goes into the prompts of all three branches,
// so that decisions, tasks and prescriptions are linked to a specific patient rather than "not specified".
const spkList = evidence.filter((s) => s.name)
  .map((s) => `- ${s.name}${s.role ? `, ${s.role}` : ''} — is ${s.speaker}` + (s.evidence ? ` (${s.evidence})` : ''));
const menList = mentioned
  .map((m) => `- ${m.name || 'name not mentioned'}${m.kind ? ` — ${m.kind}` : ''}`
    + `${m.bed ? `, bed/ward ${m.bed}` : ''}${m.about ? `: ${m.about}` : ''}`
    + (m.evidence ? ` (${m.evidence})` : ''));
const patients = mentioned.filter((m) => !m.kind || /patient|pacient/i.test(m.kind))
  .map((m) => [m.name, m.bed && `bed/ward ${m.bed}`].filter(Boolean).join(', '))
  .filter(Boolean);
let roster = '';
if (spkList.length || menList.length) {
  roster = '\n\nPEOPLE DIRECTORY (established in advance, use exactly these names):\n'
    + (spkList.length ? 'Speakers at the meeting:\n' + spkList.join('\n') + '\n' : '')
    + (menList.length ? 'People who were talked about (mostly patients):\n' + menList.join('\n') + '\n' : '')
    + 'In the minutes call these people by name. Keep "Participant N" only where there is no name '
    + 'either in the directory or in the transcript. In the "Patients and prescriptions" section make the heading of each '
    + 'block the patient name and bed, not "patient not named".\n';
}
return [{ json: { text, speakers, nameMap: map, evidence, mentioned, roster, patients } }];"""

# ---------- 2. "Three languages": the directory is no longer built here, the ready one is used ----------
LANGS_OLD = """// Directory: who spoke and who was talked about. Goes into the model prompt so that the minutes are not anonymous.
const spk = (src.evidence || []).filter((s) => s.name)
  .map((s) => `- ${s.name}${s.role ? `, ${s.role}` : ''} — is ${s.speaker}` + (s.evidence ? ` (${s.evidence})` : ''));
const men = (src.mentioned || [])
  .map((m) => `- ${m.name || 'name not mentioned'}${m.kind ? ` — ${m.kind}` : ''}`
    + `${m.bed ? `, bed/ward ${m.bed}` : ''}${m.about ? `: ${m.about}` : ''}`
    + (m.evidence ? ` (${m.evidence})` : ''));
let roster = '';
if (spk.length || men.length) {
  roster = '\\n\\nPEOPLE DIRECTORY (established in advance, use exactly these names):\\n'
    + (spk.length ? 'Speakers at the meeting:\\n' + spk.join('\\n') + '\\n' : '')
    + (men.length ? 'People who were talked about (mostly patients):\\n' + men.join('\\n') + '\\n' : '')
    + 'In the minutes call these people by name. Keep "Participant N" only where there is no name '
    + 'either in the directory or in the transcript. In the "Patients and prescriptions" section make the heading of each '
    + 'block the patient name and bed, not "patient not named".';
}"""
LANGS_NEW = """// The people directory is built in "Transcript with names" — one for all minutes branches.
const roster = src.roster || '';"""

# ---------- 3. Decisions and tasks: linking to a patient ----------
DEC_ANCHOR = 'Return ONLY JSON of the form:'
DEC_NEW = (
    "' + $json.roster + 'LINKING TO A PATIENT is mandatory: if an utterance is about a patient from the directory "
    '(named by name, by bed or by a pronoun in the same fragment), fill the patient field with the name '
    'and bed exactly as in the directory. Leave patient empty only for truly '
    'organisational questions (schedule, equipment, reporting). '
    'Do not create a row that has neither a patient, nor an owner, nor a concrete action: '
    'such a record is useless. ' + DEC_ANCHOR)

# ---------- 4. Patients and prescriptions: the same names as in the directory ----------
PAT_ANCHOR = 'Return ONLY JSON:'
PAT_NEW = (
    "' + $json.roster + 'Take patient names and beds from the directory if they are there — otherwise the same "
    'person ends up in the table as two different records. Attribute the condition (status) to the '
    'patient who was discussed in the same fragment of the conversation. ' + PAT_ANCHOR)


def req(method, url, data=None):
    r = urllib.request.Request(
        BASE + url, method=method,
        data=json.dumps(data).encode() if data else None,
        headers={'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(r))


w = req('GET', '/workflows/' + WID)
N = {n['name']: n for n in w['nodes']}
done = []


def sub(node, old, new, label):
    key = 'jsCode' if 'jsCode' in node['parameters'] else 'jsonBody'
    cur = node['parameters'][key]
    if new in cur:
        print(f'already applied: "{label}"')
        return False
    if old not in cur:
        print(f'SKIPPED: fragment not found in "{label}"')
        return False
    node['parameters'][key] = cur.replace(old, new, 1)
    done.append(label)
    return True


sub(N['Transcript with names'], NAMES_OLD, NAMES_NEW, 'Transcript with names (directory)')
sub(N['Three languages'], LANGS_OLD, LANGS_NEW, 'Three languages (takes the ready directory)')
sub(N['Decisions and tasks (JSON, gpt-4.1)'], DEC_ANCHOR, DEC_NEW, 'Decisions and tasks (patient)')
sub(N['Patients and prescriptions (JSON, gpt-4.1)'], PAT_ANCHOR, PAT_NEW, 'Patients and prescriptions (patient)')

if done:
    req('PUT', '/workflows/' + WID, {
        'name': w['name'], 'nodes': w['nodes'],
        'connections': w['connections'], 'settings': w.get('settings', {})})
print('Updated:', ', '.join(done) if done else 'nothing')
