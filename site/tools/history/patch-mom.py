"""Packaging of the minutes: a people directory (who spoke + who was talked about)
and the original recording with language tags in every report."""
import io
import json
import sys
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
KEY = open('.n8n-key', encoding='utf-8').read().strip()
BASE = 'http://127.0.0.1:5678/api/v1'
WID = 'kNUDLra3Oypao9UP-4xEO'


def req(method, url, data=None):
    r = urllib.request.Request(
        BASE + url, method=method,
        data=json.dumps(data).encode() if data else None,
        headers={'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(r))


# ---------- 1. "Who is who" — additionally collect those who were TALKED ABOUT ----------
WHO_OLD = ('Return ONLY JSON: {"speakers": [{"speaker": "Participant 1", "name": "", '
           '"role": "", "confidence": "", "evidence": "[mm:ss] short quote"}]}')
WHO_NEW = (
    'SEPARATELY collect everyone who was TALKED ABOUT but is not among the speakers: patients, '
    'doctors and relatives mentioned in the conversation. For each: first name/surname or how they were '
    'referred to («the patient in bed 3»), kind (patient / doctor / nurse / relative / other), '
    'about — one line on who this is and what is going on with them, bed — bed or ward, if spoken. '
    'DO NOT anonymise patients: write the name and bed exactly as spoken. '
    'If a person was talked about but never named — leave name empty and describe in about '
    'how they were referred to in the conversation.\\n\\n'
    'Return ONLY JSON: {"speakers": [{"speaker": "Participant 1", "name": "", '
    '"role": "", "confidence": "", "evidence": "[mm:ss] short quote"}], '
    '"mentioned": [{"name": "", "kind": "", "about": "", "bed": "", '
    '"evidence": "[mm:ss] short quote"}]}')

# ---------- 2. "Transcript with names" — pass mentioned further on ----------
NAMES_OLD = "return [{ json: { text, speakers, nameMap: map, evidence: data.speakers || [] } }];"
NAMES_NEW = ("return [{ json: { text, speakers, nameMap: map, evidence: data.speakers || [],\n"
             "  mentioned: data.mentioned || [] } }];")

# ---------- 3. "Three languages" — people directory, original and per-language split ----------
LANGS_NEW = r"""// Three minutes languages + people directory + original recording with language tags
const tz = 'Europe/Chisinau';
const sub = $('Job').first().json.submittedAt;
const meetingDate = (sub ? DateTime.fromISO(sub) : $now).setZone(tz).toFormat('dd.LL.yyyy');
const src = $json;
const text = src.text;

// Utterance language: Cyrillic → Russian. Latin script is Romanian or English, told apart by
// diacritics and words that do not exist in English (in/la/de/are cannot be used — they are shared).
const RO_WORDS = /\b(si|este|sunt|pentru|dupa|acum|foarte|doamna|domnul|domnule|pacientul|pacienta|tensiunea|trebuie|avem|bine|multumesc|multumim|nostru|noastra|asa|despre|daca|cand|adica|inca|deja|nimic|totul|vorbim|spune|spuneti)\b/gi;
const strip = (l) => l.replace(/^\[[\d:]+\]\s*/, '').replace(/^[^:]{0,60}:\s*/, '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '');
function langOf(line) {
  const raw = line.replace(/^\[[\d:]+\]\s*/, '').replace(/^[^:]{0,60}:\s*/, '');
  const t = strip(line);
  const cyr = (raw.match(/[\u0430-\u044f\u0451]/gi) || []).length;
  const lat = (t.match(/[a-z]/gi) || []).length;
  const dia = (raw.match(/[ăâîșțĂÂÎȘȚ]/g) || []).length;
  const ro = dia * 3 + (t.match(RO_WORDS) || []).length * 3;
  const latin = ro >= 3 ? 'ro' : 'en';
  if (!cyr) return latin;
  if (lat < 4) return 'ru';
  return cyr >= lat ? `ru+${latin}` : `${latin}+ru`;   // both languages were spoken in the utterance
}
const LNAME = { ru: 'Russian', ro: 'Romanian', en: 'English' };
const lines = String(text || '').split('\n').filter((l) => l.trim());
const counts = { ru: 0, ro: 0, en: 0 };
const marked = lines.map((l) => {
  const g = langOf(l);
  counts[g.split('+')[0]]++;          // the statistics count the main language of the utterance
  return `\`${g.toUpperCase().replace('+', '+')}\` ${l}`;
});
const totalLines = lines.length || 1;
const langStats = Object.entries(counts).filter(([, c]) => c)
  .sort((a, b) => b[1] - a[1])
  .map(([g, c]) => ({ lang: g, name: LNAME[g], lines: c, percent: Math.round((c / totalLines) * 100) }));
const langLine = langStats.map((s) => `${s.name} — ${s.percent}% (${s.lines} ${s.lines === 1 ? 'utterance' : 'utterances'})`).join(', ');

// Directory: who spoke and who was talked about. Goes into the model prompt so that the minutes are not anonymous.
const spk = (src.evidence || []).filter((s) => s.name)
  .map((s) => `- ${s.name}${s.role ? `, ${s.role}` : ''} — is ${s.speaker}` + (s.evidence ? ` (${s.evidence})` : ''));
const men = (src.mentioned || [])
  .map((m) => `- ${m.name || 'name not mentioned'}${m.kind ? ` — ${m.kind}` : ''}`
    + `${m.bed ? `, bed/ward ${m.bed}` : ''}${m.about ? `: ${m.about}` : ''}`
    + (m.evidence ? ` (${m.evidence})` : ''));
let roster = '';
if (spk.length || men.length) {
  roster = '\n\nPEOPLE DIRECTORY (established in advance, use exactly these names):\n'
    + (spk.length ? 'Speakers at the meeting:\n' + spk.join('\n') + '\n' : '')
    + (men.length ? 'People who were talked about (mostly patients):\n' + men.join('\n') + '\n' : '')
    + 'In the minutes call these people by name. Keep "Participant N" only where there is no name '
    + 'either in the directory or in the transcript. In the "Patients and prescriptions" section make the heading of each '
    + 'block the patient name and bed, not "patient not named".';
}

const original = marked.join('\n');
const common = { meetingDate, text, roster, original, langStats, langLine };
return [
  { json: { ...common, lang: 'ru', langName: 'Russian' } },
  { json: { ...common, lang: 'ro', langName: 'Romanian (limba română)' } },
  { json: { ...common, lang: 'en', langName: 'English' } },
];"""

# ---------- 4. MoM prompt — insert the directory before the rules ----------
MOM_OLD = r"\n\nMoM RULES:"
MOM_NEW = r"' + $json.roster + '\n\nMoM RULES:"

# ---------- 5. "Build files" — the original recording at the end of every report ----------
FILES_OLD = """  if (!content) throw new Error(`Empty model response for language ${lang}`);
  return { json: { lang, fileName: `${base}.${lang}.md`, content } };
});"""
FILES_NEW = """  if (!content) throw new Error(`Empty model response for language ${lang}`);
  return { json: { lang, fileName: `${base}.${lang}.md`, content: content + '\\n' + tail } };
});"""

FILES_TAIL_ANCHOR = """const langs = $('Three languages').all().map(i => i.json.lang);"""
FILES_TAIL = """const langs = $('Three languages').all().map(i => i.json.lang);

// The original recording is appended to the end of every report: you can see that part of the speech was
// in Russian, part in Romanian, part in English — and compare it with the minutes.
const L = $('Three languages').first().json;
const tail = ['', '---', '', '## Original recording (as spoken)', '',
  `Languages in the recording: ${L.langLine || '—'}.`,
  'The tag at the start of a line is the utterance language. The text was not translated or edited.', '',
  '```', L.original || '', '```', ''].join('\\n');"""

# ---------- 6. "Row: meeting" — the original and the languages go to the site ----------
ROW_OLD = """  ru: mom.ru || '', ro: mom.ro || '', en: mom.en || '',
} }];"""
ROW_NEW = """  ru: mom.ru || '', ro: mom.ro || '', en: mom.en || '',
  original: L.original || '', langStats: L.langStats || [], langLine: L.langLine || '',
  mentioned: fin.mentioned || [],
} }];"""
ROW_ANCHOR = "const fin = $('Transcript with names').first().json;"
ROW_ANCHOR_NEW = ("const fin = $('Transcript with names').first().json;\n"
                  "const L = $('Three languages').first().json;")

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


sub(N['Who is who (names, gpt-4.1)'], WHO_OLD, WHO_NEW, 'Who is who')
sub(N['Transcript with names'], NAMES_OLD, NAMES_NEW, 'Transcript with names')
N['Three languages']['parameters']['jsCode'] = LANGS_NEW
done.append('Three languages')
sub(N['MoM report (per language, gpt-4.1)'], MOM_OLD, MOM_NEW, 'MoM report')
sub(N['Build files'], FILES_TAIL_ANCHOR, FILES_TAIL, 'Build files (tail)')
sub(N['Build files'], FILES_OLD, FILES_NEW, 'Build files (join)')
sub(N['Row: meeting'], ROW_ANCHOR, ROW_ANCHOR_NEW, 'Row: meeting (reference)')
sub(N['Row: meeting'], ROW_OLD, ROW_NEW, 'Row: meeting (fields)')

req('PUT', '/workflows/' + WID, {
    'name': w['name'], 'nodes': w['nodes'],
    'connections': w['connections'], 'settings': w.get('settings', {})})
print('Updated:', ', '.join(done))
