# -*- coding: utf-8 -*-
"""The transcript is built on short pieces (3-5 s), 15 s is context, diarize gives only the labels.

Three edits, all idempotent:
  1. "Number segments" (online only) — the ^\\d+_ anchor did not match a jobId like
     20260927094732-95b9d4, all 186 segments went into the '?' bucket, V15 and V5 came out
     empty, and the transcript was silently built from diarize alone. Plus a guard against a repeat.
  2. "5-minute windows" — order and labels of the blocks: V5 is the base, V15 the context,
     DIAR without text. Plus a failure if there are no recognitions at all.
  3. The merge prompt — the rules are rewritten for the same scheme.
"""
import json
import urllib.request

BASE = 'http://127.0.0.1:5678/api/v1'
KEY = open('C:/medminute/site/.n8n-key', encoding='utf-8').read().strip()
ONLINE, OFFLINE = 'kNUDLra3Oypao9UP-4xEO', 'rQkljhVk4odN5YoP'


def call(path, method='GET', body=None):
    data = json.dumps(body, ensure_ascii=False).encode() if body else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req))


def node(wf, name):
    for n in wf['nodes']:
        if n['name'] == name:
            return n
    return None


def swap(node, key, old, new, what):
    """Replacement with a check: a silent miss has already caused edits to be rolled back."""
    body = node['parameters'][key]
    if new in body:
        print(f'    {what}: already in place')
        return False
    if old not in body:
        raise SystemExit(f'    {what}: source text NOT FOUND — edit by hand')
    node['parameters'][key] = body.replace(old, new)
    print(f'    {what}: updated')
    return True


# --- 1. Number segments -----------------------------------------------------
NUM_OLD = r"""  const m = name.match(/^\d+_(.+)__seg_(\d+)\.mp3$/);"""
NUM_NEW = r"""  // jobId contains a hyphen and letters (20260927094732-95b9d4), so the ^\d+_ anchor did not match:
  // all segments fell into the '?' bucket, V15 and V5 came out empty, and the transcript was silently
  // built from diarize alone. The config name is taken as the piece before __seg_.
  const m = name.match(/_([^_]+)__seg_(\d+)\.mp3$/);"""

NUM_TAIL_OLD = """items.sort((a, b) => a.json.config.localeCompare(b.json.config) || a.json.segIndex - b.json.segIndex);
return items;"""
NUM_TAIL_NEW = """items.sort((a, b) => a.json.config.localeCompare(b.json.config) || a.json.segIndex - b.json.segIndex);
// Fail loudly: without this check, empty V15 and V5 reached the merge step and the transcript
// was built from diarize alone — plausible-looking text, but completely different.
if (!items.length || items.every(i => i.json.config === '?')) {
  throw new Error('could not parse segment names: ' + (items[0]?.binary?.data?.fileName || 'no files'));
}
return items;"""

# --- 2. 5-minute windows ----------------------------------------------------
WIN_ON_OLD = r"""    input: `=== DIAR (who speaks) ===\n${diar || '—'}\n\n=== V15 (15 s pieces — BASE) ===\n${v15 || '—'}\n\n=== V5 (5 s pieces — only for spot word corrections) ===\n${v5 || '—'}` } });
}
return items;"""
WIN_ON_NEW = r"""    input: `=== DIAR (only who speaks; do not take text from here) ===\n${diar || '—'}\n\n=== V5 (3-5 s pieces — BASE of the text) ===\n${v5 || '—'}\n\n=== V15 (15 s pieces — context for joining and disputed places) ===\n${v15 || '—'}` } });
}
// The dialogue is built from V15 and V5. Having neither is a recognition failure, not an empty recording:
// previously in this case the text was silently built from diarize.
if (!(V['15s'] || []).length && !(V['5s'] || []).length) {
  throw new Error('recognition produced neither V15 nor V5 — nothing to build the transcript from');
}
return items;"""

WIN_OFF_OLD = r"""    input: `=== DIAR (who speaks) ===\n${diar || '—'}\n\n`
      + `=== V15 (15 s windows — BASE) ===\n${s15 || '—'}\n\n`
      + `=== V5 (5 s windows — only for spot word corrections) ===\n${s5 || '—'}` } });"""
WIN_OFF_NEW = r"""    input: `=== DIAR (only who speaks; this block has no text) ===\n${diar || '—'}\n\n`
      + `=== V5 (3-5 s windows — BASE of the text) ===\n${s5 || '—'}\n\n`
      + `=== V15 (15 s windows — context for joining and disputed places) ===\n${s15 || '—'}` } });"""

# --- 3. Merge prompt --------------------------------------------------------
HEAD = 'You are assembling a VERBATIM transcript'
TAIL = 'Output only the transcript, with no explanations.'
MARK = 'NEVER TAKE TEXT FROM DIAR'
PROMPT = (
    "You are assembling a VERBATIM transcript of a fragment of a medical meeting (' + $json.win + ') "
    'from automatic recognitions of the same recording. '
    'V5 — 3-5 second pieces: this is the BASE of the transcript. Short pieces swallow nothing '
    'and better preserve the language in which a word was spoken. '
    'V15 — 15-second pieces: wide context. Needed where a short V5 piece is cut off '
    'mid-word, does not form a coherent phrase, or a word in it is clearly distorted. '
    'DIAR — speaker labels: the «Participant N» label and the timecode are reliable, but NEVER TAKE TEXT FROM DIAR, '
    'even if V5 and V15 are empty at that point. '
    'People speak Russian, Romanian and English mixed together, sometimes within one sentence. '
    'Rules: '
    '1) write the text from V5, going through the timecodes in order; '
    '2) V15 is for joining and checking: if V5 pieces do not form a coherent phrase or a word '
    'in V5 is distorted — restore that place from V15; '
    '3) if a piece is missing in V5 but present in V15 — insert it from V15 by timecode; '
    '4) take the speaker from DIAR by timecodes, and ignore the DIAR text; '
    '5) translate nothing, do not paraphrase, add or correct the meaning; numbers, doses, '
    'drugs, names — only as spoken; '
    '6) Russian — in Cyrillic, Romanian — in Latin script with diacritics (ă â î ș ț), English — in English; '
    '7) if a choice is impossible — [inaudible]; '
    '8) remove repeats at the seams of the pieces. '
    'Format: each utterance on a new line: [mm:ss] Participant N: text. '
    'Start a new line when the speaker changes. Output only the transcript, with no explanations.'
)


def patch_prompt(n, key='jsonBody'):
    body = n['parameters'][key]
    if MARK in body:
        print('    merge prompt: already in place')
        return False
    a, b = body.find(HEAD), body.find(TAIL)
    if a < 0 or b < 0:
        raise SystemExit('    merge prompt: block boundaries NOT FOUND')
    n['parameters'][key] = body[:a] + PROMPT + body[b + len(TAIL):]
    print('    merge prompt: updated')
    return True


for wid, merge in ((ONLINE, 'Merge 15s + 5s + speakers (gpt-4.1)'),
                   (OFFLINE, 'Merge 15s + 5s + voices (qwen3:8b)')):
    wf = call(f'/workflows/{wid}')
    print(f'{wf["name"]}:')
    changed = False

    num = node(wf, 'Number segments')
    if num:                                    # offline slices inside the ASR service, there is no such node
        changed |= swap(num, 'jsCode', NUM_OLD, NUM_NEW, 'segment name parsing')
        changed |= swap(num, 'jsCode', NUM_TAIL_OLD, NUM_TAIL_NEW, 'guard against empty versions')

    win = node(wf, '5-minute windows')
    old, new = (WIN_ON_OLD, WIN_ON_NEW) if num else (WIN_OFF_OLD, WIN_OFF_NEW)
    changed |= swap(win, 'jsCode', old, new, 'windows: V5 base, V15 context')

    changed |= patch_prompt(node(wf, merge))

    if not changed:
        print('  everything is already in place\n')
        continue
    call(f'/workflows/{wid}', 'PUT', {k: wf[k] for k in ('name', 'nodes', 'connections', 'settings')})
    print('  saved\n')
