"""The "MedMinute — minutes mailing" workflow.

The site (POST /api/jobs/:id/email) reads the finished md report from disk and sends here
the addresses + text + an attachment in base64. Sending goes via SMTP: online — through the sender's
external server, offline — through a separate node, which is disabled because there is
no local mail server on the network.

The sender address lives in `.mail-from` (next to `.n8n-key`), the app password
is entered once in n8n, in the "MedMinute SMTP (mailing)" credential — the password is not in the code or in
any correspondence. The id of the created credential is remembered in `.mail-cred`.
"""
import io
import json
import os
import sys
import urllib.error
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
KEY = open('.n8n-key', encoding='utf-8').read().strip()
BASE = 'http://127.0.0.1:5678/api/v1'
NAME = 'MedMinute — minutes mailing'
CRED_NAME = 'MedMinute SMTP (mailing)'
CRED_FILE = '.mail-cred'
MAIL_FROM = open('.mail-from', encoding='utf-8').read().strip()
# Defaults are for Gmail / Google Workspace. For another provider, change
# host and port in the credential itself in n8n; the workflow does not need to be rebuilt.
SMTP_HOST = os.environ.get('SMTP_HOST', 'smtp.gmail.com')
SMTP_PORT = int(os.environ.get('SMTP_PORT', 465))

LETTER = r"""// Build the email from the markdown report: subject, HTML body and the attachment
const src = $json.body || $json;
const to = (Array.isArray(src.to) ? src.to : String(src.to || '').split(/[,;\s]+/)).filter(Boolean);
if (!to.length) throw new Error('no addresses given');
if (!src.markdown) throw new Error('empty report');

// ONLY the first part of the report goes into the email body — the letter: participants, agenda, items by
// topic, decisions, actions. The minutes go as an attachment, otherwise the email is unreadable.
// Split on the "---" line, not on the "## Letter" heading: headings are translated into the minutes
// language (e.g. Scrisoare in Romanian), but the separator is the same in all languages.
const md = String(src.markdown);
const parts = md.replace(/\r/g, '').split(/^---\s*$/m);
let letter = parts[0].replace(/^##\s+.*$/m, '').trim();
// The very first line "**Subject:** …" (in any language) becomes the email subject and is removed
// from the body. Only the first line is checked: further down participants and dates have the same bold labels.
const lines = letter.split('\n');
const subjLine = /^\*\*[^*]+:\*\*\s*(.+)$/.exec(lines[0].trim());
if (subjLine) letter = lines.slice(1).join('\n').trim();

// Convert the markup into simple HTML: headings, lists, tables, bold.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
const out = [];
let list = null;
let table = false;
const closeAll = () => {
  if (list) { out.push(`</${list}>`); list = null; }
  if (table) { out.push('</table>'); table = false; }
};
for (const raw of letter.split('\n')) {
  const line = raw.replace(/\s+$/, '');
  const head = /^(#{1,4})\s+(.*)$/.exec(line);
  const li = /^[-*]\s+(.*)$/.exec(line);
  const num = /^(\d+)[.)]\s+(.*)$/.exec(line);
  const row = /^\|(.+)\|$/.exec(line);
  if (!line.trim()) { closeAll(); continue; }
  if (head) { closeAll(); out.push(`<h${head[1].length}>${inline(head[2])}</h${head[1].length}>`); continue; }
  if (/^\s*\|?\s*:?-{3,}/.test(line) && table) continue;          // the rule under the table header
  if (row) {
    if (!table) { closeAll(); out.push('<table cellpadding="6" border="1" style="border-collapse:collapse;font-size:14px">'); table = true; }
    const cells = row[1].split('|').map((c) => `<td>${inline(c.trim())}</td>`).join('');
    out.push(`<tr>${cells}</tr>`);
    continue;
  }
  if (table) { out.push('</table>'); table = false; }
  if (li) {
    if (list !== 'ul') { closeAll(); out.push('<ul>'); list = 'ul'; }
    out.push(`<li>${inline(li[1])}</li>`);
    continue;
  }
  if (num) {
    if (list !== 'ol') { closeAll(); out.push('<ol>'); list = 'ol'; }
    out.push(`<li>${inline(num[2])}</li>`);
    continue;
  }
  if (list) { out.push(`</${list}>`); list = null; }
  out.push(`<p>${inline(line)}</p>`);
}
closeAll();

const note = src.note ? `<p style="background:#f1f5f9;padding:10px;border-radius:8px">${esc(src.note)}</p>` : '';
const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;max-width:760px">`
  + `<p style="color:#64748b;font-size:13px">Meeting minutes prepared automatically (MedMeet, MedMinute).`
  + (src.meetingDate ? ` Meeting date: ${esc(src.meetingDate)}.` : '') + `</p>`
  + note + out.join('\n')
  + `<hr><p style="color:#64748b;font-size:12px">The full minutes are attached.`
  + (src.meetingUrl ? ` Meeting on the site: ${esc(src.meetingUrl)}` : '') + `</p></div>`;

return [{
  json: {
    jobId: src.jobId || '', mode: src.mode || 'online', lang: src.lang || 'ru',
    to: to.join(', '), recipients: to,
    subject: (subjLine ? subjLine[1].trim() : '') || src.subject
      || `Meeting minutes${src.title ? `: ${src.title}` : ''}`,
    html, fileName: src.fileName || 'protocol.md',
  },
  binary: {
    report: {
      // The site sends a PDF if it was built, otherwise markdown — the attachment type comes from there too.
      data: src.fileBase64 || Buffer.from(String(src.markdown), 'utf8').toString('base64'),
      mimeType: src.mimeType || 'text/markdown',
      fileName: src.fileName || 'protocol.md',
      fileExtension: src.fileExtension || 'md',
    },
  },
}];"""

ANSWER = r"""// What to return to the site: it writes this into the sending log of the meeting card
const first = $input.first().json;
const mail = $('Build email').first().json;
return [{ json: {
  ok: true, jobId: mail.jobId, to: mail.recipients, lang: mail.lang,
  subject: mail.subject, transport: mail.mode === 'offline' ? 'smtp (disabled)' : 'smtp',
  messageId: first.messageId || first.id || null,
} }];"""

NODES = [
    {
        'id': 'hook', 'name': 'Webhook: mailing', 'type': 'n8n-nodes-base.webhook',
        'typeVersion': 2, 'position': [-340, 0],
        'webhookId': 'medminute-email',
        'parameters': {'httpMethod': 'POST', 'path': 'medminute-email',
                       'responseMode': 'lastNode', 'options': {'rawBody': False}},
    },
    {
        'id': 'letter', 'name': 'Build email', 'type': 'n8n-nodes-base.code',
        'typeVersion': 2, 'position': [-120, 0], 'parameters': {'jsCode': LETTER},
    },
    {
        'id': 'split', 'name': 'Online?', 'type': 'n8n-nodes-base.if',
        'typeVersion': 2.2, 'position': [100, 0],
        'parameters': {'conditions': {
            'options': {'caseSensitive': True, 'leftValue': '', 'typeValidation': 'strict', 'version': 2},
            'conditions': [{
                'id': 'mode',
                'leftValue': '={{ $json.mode }}',
                'rightValue': 'offline',
                'operator': {'type': 'string', 'operation': 'notEquals'},
            }],
            'combinator': 'and',
        }, 'options': {}},
    },
    {
        'id': 'mail', 'name': 'Send (SMTP)', 'type': 'n8n-nodes-base.emailSend',
        'typeVersion': 2.1, 'position': [340, -110],
        'parameters': {
            'fromEmail': MAIL_FROM,
            'toEmail': '={{ $json.to }}',
            'subject': '={{ $json.subject }}',
            'emailFormat': 'html',
            'html': '={{ $json.html }}',
            'options': {'attachments': 'report', 'appendAttribution': False},  # no "sent with n8n" footer — the recipient does not need to know the internals
        },
    },
    {
        'id': 'smtp', 'name': 'Send (SMTP, offline)', 'type': 'n8n-nodes-base.emailSend',
        'typeVersion': 2.1, 'position': [340, 110], 'disabled': True,
        'parameters': {
            'fromEmail': 'medminute@clinic.local',
            'toEmail': '={{ $json.to }}',
            'subject': '={{ $json.subject }}',
            'emailFormat': 'html',
            'html': '={{ $json.html }}',
            'options': {'attachments': 'report', 'appendAttribution': False},  # no "sent with n8n" footer — the recipient does not need to know the internals
        },
        'notes': 'Disabled: there is no local SMTP on the network. Enable it and set the credential once a mail server is available.',
    },
    {
        'id': 'answer', 'name': 'Reply to site', 'type': 'n8n-nodes-base.code',
        'typeVersion': 2, 'position': [580, 0], 'parameters': {'jsCode': ANSWER},
    },
]

CONNECTIONS = {
    'Webhook: mailing': {'main': [[{'node': 'Build email', 'type': 'main', 'index': 0}]]},
    'Build email': {'main': [[{'node': 'Online?', 'type': 'main', 'index': 0}]]},
    'Online?': {'main': [
        [{'node': 'Send (SMTP)', 'type': 'main', 'index': 0}],
        [{'node': 'Send (SMTP, offline)', 'type': 'main', 'index': 0}],
    ]},
    'Send (SMTP)': {'main': [[{'node': 'Reply to site', 'type': 'main', 'index': 0}]]},
    'Send (SMTP, offline)': {'main': [[{'node': 'Reply to site', 'type': 'main', 'index': 0}]]},
}


def req(method, url, data=None):
    r = urllib.request.Request(
        BASE + url, method=method,
        data=json.dumps(data).encode() if data is not None else None,
        headers={'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json'})
    try:
        return json.load(urllib.request.urlopen(r))
    except urllib.error.HTTPError as e:
        print(f'{method} {url} → {e.code}: {e.read().decode("utf-8", "replace")[:600]}')
        raise


def smtp_credential():
    """SMTP credential: created once, the password is entered by hand in n8n.

    The public n8n API cannot list credentials, so the id and the name are stored next to it
    in `.mail-cred`. The password is not passed here — otherwise it would end up in the command history.
    """
    if os.path.exists(CRED_FILE):
        cred = json.load(open(CRED_FILE, encoding='utf-8'))
        print(f'using credential {cred["id"]} ({cred["name"]})')
        return cred
    cred = {'id': req('POST', '/credentials', {
        'name': CRED_NAME, 'type': 'smtp',
        'data': {'user': MAIL_FROM, 'password': '', 'host': SMTP_HOST,
                 'port': SMTP_PORT, 'secure': True},
    })['id'], 'name': CRED_NAME}
    json.dump(cred, open(CRED_FILE, 'w', encoding='utf-8'), ensure_ascii=False)
    print(f'credential {cred["id"]} created — enter the app password in n8n')
    return cred


for n in NODES:
    if n['id'] == 'mail':
        n['credentials'] = {'smtp': smtp_credential()}

body = {'name': NAME, 'nodes': NODES, 'connections': CONNECTIONS,
        'settings': {'executionOrder': 'v1'}}

existing = None
cursor = None
while True:
    page = req('GET', '/workflows?limit=100' + (f'&cursor={cursor}' if cursor else ''))
    for w in page['data']:
        if w['name'] == NAME:
            existing = w['id']
    cursor = page.get('nextCursor')
    if not cursor:
        break

if existing:
    req('PUT', f'/workflows/{existing}', body)
    wid = existing
    print(f'workflow {wid} updated')
else:
    wid = req('POST', '/workflows', body)['id']
    print(f'workflow {wid} created')

req('POST', f'/workflows/{wid}/activate')
print('activated, webhook: http://localhost:5678/webhook/medminute-email')
