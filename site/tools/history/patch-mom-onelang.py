"""The minutes are in one language throughout, with no fragments from the recording.

Before: the Russian minutes kept "blood pressure", "oxygen saturation", "alert",
"intravenous fluids", the English ones kept the Russian words for "doctor", "nurse", "patient", and a drug
from a Romanian utterance came out as "norepinefrină" in all three languages. The cause was the rule
"do not translate names, drugs, abbreviations and numbers": the model read it broadly
and treated as "do not translate" everything that was not spoken in the minutes language.

After: the language rule is rewritten and placed first in importance. The transcript is mixed —
that is normal, and the model's job is exactly to bring everything into one language.
A closed list stays unchanged: people's first names and surnames, drug brand names,
numbers with units and common abbreviations. A role ("doctor", "nurse",
"patient") is not a name and is always translated; the international drug name is written
in the spelling of the minutes language (Romanian norepinefrină → English norepinephrine).

Both branches are edited: online (gpt-4.1) and offline (qwen3).
"""
import io
import json
import sys
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
KEY = open('.n8n-key', encoding='utf-8').read().strip()
BASE = 'http://127.0.0.1:5678/api/v1'
WORKFLOWS = ['kNUDLra3Oypao9UP-4xEO', 'rQkljhVk4odN5YoP']

MARK = 'Not a SINGLE word in another language'   # shows that the patch is already applied
HEAD = 'LANGUAGE IS THE MAIN RULE'              # the block runs from "LANGUAGE" to "DATES"
TAIL = 'DATES:'

# The drug rule said "names — strictly as spoken": exactly that made the model
# keep norepinefrină in the Russian minutes. Align it with the language rule.
RULE_OLD = 'Names, doses and numbers — strictly as spoken, never guess.'
RULE_NEW = ('Doses, units and numbers — strictly as spoken, never guess; '
            'write the drug name itself in the spelling of the minutes language (see the language rule).')

# The text goes inside a single-quoted JS string: there must be no apostrophes,
# line breaks are written as the two characters \n, substitutions break the quotes.
BLOCK = (
    r"""LANGUAGE IS THE MAIN RULE, MORE IMPORTANT THAN ALL OTHERS. The transcript is mixed: Russian, Romanian """
    r"""and English are mixed within one sentence — that is how people spoke at the meeting, it is normal. """
    r"""Your job is to bring EVERYTHING into one language. Write the whole minutes (the email subject, section """
    r"""headings, agenda item headings, every item, every word) in ' + $json.langName + '. """
    r"""Not a SINGLE word in another language may remain in the finished minutes.\n"""
    r"""This includes medical terms (blood pressure, oxygen saturation, intravenous fluids), """
    r"""states (alert, confused), roles (doctor, nurse, patient, urologist) and any everyday words — """
    r"""no matter which language they were spoken in. A person’s role is not a name, it is always translated.\n"""
    r"""Bad: «The physician checked tensiunea arterială and saturația».\n"""
    r"""Good in English: «The physician checked blood pressure and oxygen saturation».\n"""
    r"""Good in Romanian: «Medicul a verificat tensiunea arterială și saturația».\n"""
    r"""Leave ONLY these unchanged: first names and surnames of people; brand names of drugs; """
    r"""numbers, doses and units of measurement; common abbreviations (ECG / EKG, CT). """
    r"""Write the international drug name in the spelling of the minutes language: Romanian norepinefrină → """
    r"""English norepinephrine. Do not invent the dose or the route — only what was spoken.\n"""
    r"""SECTION HEADINGS in the response schema are written in English only as a template — in the response itself """
    r"""write them in the minutes language exactly like this: ' + $json.heads + '.\n\n"""
)


def req(method, url, data=None):
    r = urllib.request.Request(
        BASE + url, method=method,
        data=json.dumps(data).encode() if data else None,
        headers={'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(r))


for wid in WORKFLOWS:
    w = req('GET', '/workflows/' + wid)
    mom = next((n for n in w['nodes'] if 'MoM' in n['name']), None)
    body = mom['parameters']['jsonBody'] if mom else ''
    if MARK in body and RULE_NEW in body:
        print(f'{wid}: the one-language rule is already in place')
        continue
    if HEAD not in body or TAIL not in body:
        print(f'{wid}: could not find the language block — look at the node by eye')
        continue
    new = body[:body.index(HEAD)] + BLOCK + body[body.index(TAIL):]
    if RULE_OLD not in new:
        print(f'{wid}: drug rule 8 has changed — check it against the language rule')
    mom['parameters']['jsonBody'] = new.replace(RULE_OLD, RULE_NEW, 1)
    req('PUT', '/workflows/' + wid, {
        'name': w['name'], 'nodes': w['nodes'],
        'connections': w['connections'], 'settings': w.get('settings', {})})
    print(f'{wid}: the minutes are now written entirely in one language ({mom["name"]})')
