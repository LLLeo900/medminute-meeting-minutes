/* Uploads a workflow into n8n. node tools/push.js <file.json> [id] */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const KEY = fs.readFileSync(path.join(__dirname, '..', '.n8n-key'), 'utf8').trim();
const BASE = process.env.N8N_BASE || 'http://localhost:5678';
const [, , file, id] = process.argv;

const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
const body = { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings || { executionOrder: 'v1' } };

(async () => {
  const url = id ? `${BASE}/api/v1/workflows/${id}` : `${BASE}/api/v1/workflows`;
  const r = await fetch(url, {
    method: id ? 'PUT' : 'POST',
    headers: { 'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) { console.error('ERROR', r.status, t.slice(0, 1500)); process.exit(1); }
  const w = JSON.parse(t);
  console.log(`${id ? 'updated' : 'created'}: ${w.name} (${w.id}), nodes: ${w.nodes.length}`);

  const a = await fetch(`${BASE}/api/v1/workflows/${w.id}/activate`, {
    method: 'POST', headers: { 'X-N8N-API-KEY': KEY },
  });
  console.log('activation:', a.ok ? 'ok' : `failed (${a.status}) ${(await a.text()).slice(0, 300)}`);
})();
