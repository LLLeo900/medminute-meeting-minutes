"""Minutes format: no tables, no timecodes, no empty items.

Before: the model had to fill in every field — no deadline was spoken, it wrote "not specified";
no owner was spoken — "Owner: not specified". Plus two tables (drugs and
Action Items) and a timecode on every line. As a result half of the minutes were placeholders and times.

After: what was not in the conversation is not in the minutes — neither a line nor a heading. Instead of
tables — a topic heading and numbered items; timecodes are removed completely. Decisions and actions
must name who they concern and what to do. A topic is not necessarily a patient: it can be
an area, a department or a question.

The same prompt block is edited in online (gpt-4.1) and offline (qwen3) — the prompt
text in them is identical, only the model differs, so the block is replaced in the same way.
"""
import io
import json
import sys
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
KEY = open('.n8n-key', encoding='utf-8').read().strip()
BASE = 'http://127.0.0.1:5678/api/v1'
WORKFLOWS = ['kNUDLra3Oypao9UP-4xEO', 'rQkljhVk4odN5YoP']

HEAD = 'MoM RULES:'            # start of the block being replaced
TAIL = 'Return only Markdown'  # the first line after it

# "tables" in the language rule are out of place too
LANG_OLD = '(email subject, headings, text, tables)'
LANG_NEW = '(email subject, headings, items, text)'

BLOCK = (
    'MoM RULES:\\n'
    '1. Only facts from the conversation. Do not invent decisions, tasks, owners, deadlines or numbers.\\n'
    '2. WHAT WAS NOT SAID IS NOT IN THE MINUTES. No placeholders like «not specified», «not assigned», '
    '«no data», «to be clarified», «unclear»: simply leave such places out. No deadline was spoken — the task has no deadline. '
    'No owner was spoken — the task has no owner. No bed was spoken — do not write about the bed. '
    'Remove a section with nothing to write together with its heading.\\n'
    '3. NO TABLES. Only headings, short paragraphs and numbered lists.\\n'
    '4. NO TIMECODES AND NO RECORDING TIMES — neither in brackets nor in the text.\\n'
    '5. Short and to the point: a step-by-step, item-by-item summary. Each topic has its own heading, '
    'with numbered items of one short phrase each under it. Do not retell the transcript.\\n'
    '6. Write decisions and actions as concretely as possible: who it concerns (by name), which patient or which '
    'area, what exactly to do. Bad: «discuss the issue with the urologist». Good: «Andrei to agree the plan for the patient '
    'with the drain with the urologist».\\n'
    '7. A topic is not necessarily a patient: it can be a department, an area, a process or a manager. '
    'Write the topic heading by its substance: the patient name, the area name or the question itself.\\n'
    '8. Write the drug, dose and route as plain text and only what was actually spoken: '
    'if a single drug was spoken without a dose — write only the drug. Names, doses and numbers — strictly as '
    'spoken, never guess.\\n'
    '9. Neutral business tone, no emotions or judgements. No conclusions, recommendations or '
    'medical advice of your own.\\n'
    '\\n'
    'RESPONSE STRUCTURE (Markdown, strictly in this order; skip a section with no content '
    'entirely, together with its heading):\\n'
    '\\n'
    '## Letter\\n'
    "**Subject:** MoM: [short title of the meeting based on its content] [' + $json.meetingDate + ']\\n"
    '\\n'
    '**Participants:** [names separated by commas; role in brackets if it was spoken]\\n'
    '\\n'
    '**Agenda:** [one sentence on what the meeting was about; two at most]\\n'
    '\\n'
    '### [Topic 1 — patient, area or question]\\n'
    '1. [what was discussed — one short phrase]\\n'
    '2. [...]\\n'
    '\\n'
    '### [Topic 2 — and so on for every topic discussed]\\n'
    '1. [...]\\n'
    '\\n'
    '**Objectives:** [what needs to be achieved — only if it was spoken]\\n'
    '\\n'
    '**Decisions:**\\n'
    '1. [who it concerns] — [what was decided: for which patient or area and what to do]\\n'
    '\\n'
    '**Action items:**\\n'
    '1. [who] — [what they will do][ — deadline, only if it was spoken]\\n'
    '\\n'
    '---\\n'
    '\\n'
    '## Minutes of the meeting\\n'
    '- **Date:** ...\\n'
    '- **Participants:** [names separated by commas; role in brackets if clear]\\n'
    '- **Subject:** [one sentence]\\n'
    '\\n'
    '### [Topic 1 — patient, area or question]\\n'
    '1. [what matters: condition, prescription, agreement — one short phrase per item]\\n'
    '2. [...]\\n'
    '\\n'
    '### [Topic 2]\\n'
    '1. [...]\\n'
    '\\n'
    '### Decisions\\n'
    '1. [who it concerns] — [what was decided, as concretely as possible]\\n'
    '\\n'
    '### Action items\\n'
    '1. [who] — [what they will do][ — deadline, only if it was spoken]\\n'
    '\\n'
    '### Open questions\\n'
    '1. [what remained unresolved — only if this was explicitly said in the conversation]\\n'
    '\\n'
    '### Next meeting\\n'
    '[date and topic — only if spoken; if not spoken, this section is not in the response]\\n'
    '\\n'
)


def req(method, url, data=None):
    r = urllib.request.Request(
        BASE + url, method=method,
        data=json.dumps(data).encode() if data else None,
        headers={'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(r))


for wid in WORKFLOWS:
    w = req('GET', '/workflows/' + wid)
    node = next((n for n in w['nodes'] if 'MoM' in n['name']), None)
    if not node:
        print(f'{wid}: no MoM report node — skipping')
        continue
    body = node['parameters']['jsonBody']
    # patch-mom-ideal.py edits the same block and already includes everything from here. Without this check
    # running it "just in case" rolled the structure back to the previous version — this already happened.
    if 'Agenda item' in body:
        print(f'{wid}: the structure is newer — it is maintained by patch-mom-ideal.py, this script is not needed')
        continue
    if HEAD not in body or TAIL not in body:
        print(f'{wid}: could not find the boundaries of the rules block, look at the "{node["name"]}" node by eye')
        continue
    new = body[:body.index(HEAD)] + BLOCK + body[body.index(TAIL):]
    new = new.replace(LANG_OLD, LANG_NEW, 1)
    if new == body:
        print(f'{wid}: already applied ({node["name"]})')
        continue
    node['parameters']['jsonBody'] = new
    req('PUT', '/workflows/' + wid, {
        'name': w['name'], 'nodes': w['nodes'],
        'connections': w['connections'], 'settings': w.get('settings', {})})
    print(f'{wid}: prompt updated "{node["name"]}"')
