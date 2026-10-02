"""The minutes follow the "ideal MoM" template, and are extremely concise.

Before: each topic had its own items, but the items were long, with filler words ("the question was
discussed that…"). There were no absentees, key takeaways or mentioned materials —
and a proper meeting record has them.

After: the structure follows the paper MoM template — meeting title, participants,
absentees, objectives, agenda as items ("Agenda item 1"), key takeaways,
materials, decisions, actions. Each item is one line of up to 15 words, one fact,
no filler words. Still no tables and no timecodes; what was not spoken is not in the
minutes, a section without content is dropped together with its heading.

The new headings are also added to the translation ("Three languages"), otherwise the English and
Romanian minutes would keep "Absentees" and "Key takeaways" untranslated.

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

MARK = 'Agenda item 1'          # shows that the patch is already applied
HEAD = 'MoM RULES:'
TAIL = 'Return only Markdown'

# The text goes inside a single-quoted JS string, so there must be no apostrophes,
# and line breaks are written as the two characters \n.
BLOCK = r"""MoM RULES:\n1. Only facts from the conversation. Do not invent decisions, tasks, owners, deadlines or numbers.\n2. WHAT WAS NOT SAID IS NOT IN THE MINUTES. No placeholders like «not specified», «not assigned», «no data», «to be clarified», «unclear» (or their equivalents in any language): simply leave such places out. No deadline was spoken — the task has no deadline. No owner was spoken — the task has no owner. Remove a section with nothing to write together with its heading.\n3. NO TABLES. Only headings, short labels and numbered lists.\n4. NO TIMECODES AND NO RECORDING TIMES — neither in brackets nor in the text.\n5. EXTREMELY CONCISE. One item = one line of up to 15 words and one fact. Drop filler words: not «it was noted that creatinine is 200-240», but «Creatinine 200-240, urea 19». Do not retell the course of the conversation, keep the result. More than five items per topic means something is superfluous.\n6. Write decisions and actions as concretely as possible: who it concerns (by name), which patient or which area, what exactly to do. Bad: «discuss the issue with the urologist». Good: «Andrei to agree the plan for the patient with the drain with the urologist».\n7. An agenda item is not necessarily a patient: it can be a department, an area, a process or a manager. Write the heading by substance: the patient name, the area name or the question itself.\n8. Write the drug, dose and route as plain text and only what was actually spoken: if a single drug was spoken without a dose — write only the drug. Names, doses and numbers — strictly as spoken, never guess.\n9. Key takeaways — three to five lines for someone who was not at the meeting: the most important outcome, without repeating the agenda items word for word.\n10. Neutral business tone, no emotions or judgements. No conclusions, recommendations or medical advice of your own.\n\nRESPONSE STRUCTURE (Markdown, strictly in this order; skip a section with no content entirely, together with its heading):\n\n## Letter\n**Subject:** MoM: [short title of the meeting based on its content] [' + $json.meetingDate + ']\n\n**Participants:** [names separated by commas; role in brackets if it was spoken]\n\n**Absentees:** [names — only if the conversation explicitly said someone is absent]\n\n**Agenda:** [one sentence on what the meeting was about]\n\n**Objectives:** [what needs to be achieved — only if it was spoken]\n\n### Agenda item 1. [patient, area or question]\n1. [the point — one line]\n2. [...]\n\n### Agenda item 2. [and so on for every question discussed]\n1. [...]\n\n**Key takeaways:**\n1. [the most important outcome of the meeting — one line]\n\n**Decisions:**\n1. [who it concerns] — [what was decided: for which patient or area and what to do]\n\n**Action items:**\n1. [who] — [what they will do][ — deadline, only if it was spoken]\n\n**Materials:** [tests, images, discharge summaries, links — only those explicitly named]\n\n---\n\n## Minutes of the meeting\n- **Date:** ...\n- **Participants:** [names separated by commas; role in brackets if clear]\n- **Absentees:** [only if this was said]\n- **Subject:** [one sentence]\n\n### Agenda item 1. [patient, area or question]\n1. [what matters: condition, prescription, agreement — one line per item]\n2. [...]\n\n### Agenda item 2\n1. [...]\n\n### Key takeaways\n1. [...]\n\n### Decisions\n1. [who it concerns] — [what was decided, as concretely as possible]\n\n### Action items\n1. [who] — [what they will do][ — deadline, only if it was spoken]\n\n### Materials\n1. [what exactly was named]\n\n### Open questions\n1. [what remained unresolved — only if this was explicitly said in the conversation]\n\n### Next meeting\n[date and topic — only if spoken; if not spoken, this section is not in the response]\n\n"""

# New headings go into the translation. Appended to the lists already created by patch-mom-headings.py.
# (The Russian heading map is kept directly in the "Three languages" node.)
HEADS_ADD = {
    'ro': ('; Absentees → Absenți; Agenda item → Punct pe ordinea de zi; '
           'Key takeaways → Concluzii principale; Materials → Materiale'),
}
HEADS_ANCHOR = {
    'ro': "'Date → Data; Open questions → Întrebări deschise; Next meeting → Următoarea ședință'",
}


def req(method, url, data=None):
    r = urllib.request.Request(
        BASE + url, method=method,
        data=json.dumps(data).encode() if data else None,
        headers={'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(r))


for wid in WORKFLOWS:
    w = req('GET', '/workflows/' + wid)
    done = []

    mom = next((n for n in w['nodes'] if 'MoM' in n['name']), None)
    body = mom['parameters']['jsonBody'] if mom else ''
    if MARK in body:
        print(f'{wid}: the structure already follows the MoM template')
    elif HEAD not in body or TAIL not in body:
        print(f'{wid}: could not find the MoM rules in the prompt — look at the node by eye')
    else:
        mom['parameters']['jsonBody'] = body[:body.index(HEAD)] + BLOCK + body[body.index(TAIL):]
        done.append(mom['name'])

    lang = next((n for n in w['nodes'] if n['name'] == 'Three languages'), None)
    code = lang['parameters']['jsCode'] if lang else ''
    if 'Key takeaways → Concluzii principale' in code:
        print(f'{wid}: the new headings are already translated')
    elif not all(a in code for a in HEADS_ANCHOR.values()):
        print(f'{wid}: could not find the heading lists in "Three languages" — run patch-mom-headings.py first')
    else:
        for k, anchor in HEADS_ANCHOR.items():
            code = code.replace(anchor, anchor[:-1] + HEADS_ADD[k] + "'", 1)
        lang['parameters']['jsCode'] = code
        done.append('Three languages')

    if done:
        req('PUT', '/workflows/' + wid, {
            'name': w['name'], 'nodes': w['nodes'],
            'connections': w['connections'], 'settings': w.get('settings', {})})
    print(f'{wid}: updated — {", ".join(done) if done else "nothing"}')
