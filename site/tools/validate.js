/* Static checks for the repository: run with `npm test` (or `node tools/validate.js`) from site/.
 *
 *  1. Every .js file in site/ (except node_modules) parses (`node --check`).
 *  2. Every n8n workflow in ../n8n/ is valid JSON, and:
 *     - every connection points to a node that exists;
 *     - every $('Node name') reference in code and expressions points to a node that exists
 *       (renaming a node in the n8n UI silently breaks these references);
 *     - every Code node and every ={{ … }} expression body parses as JavaScript;
 *     - no installation-specific credential ids are left in the export.
 *
 *  Exits with code 1 on the first category of failures, after printing all of them.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SITE = path.join(__dirname, '..');
const N8N = path.join(SITE, '..', 'n8n');
const errors = [];

// ---------- 1. JavaScript syntax ----------

function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = jsFiles(SITE);
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    errors.push(`${path.relative(SITE, f)}: ${String(e.stderr || e.message).split('\n').slice(0, 4).join(' ')}`);
  }
}
console.log(`js syntax: ${files.length} files checked`);

// ---------- 2. n8n workflows ----------

function parses(code, label) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(code);
  } catch (e) {
    errors.push(`${label}: ${e.message}`);
  }
}

let fragments = 0;
for (const file of fs.readdirSync(N8N).filter((f) => f.endsWith('.json'))) {
  let wf;
  try {
    wf = JSON.parse(fs.readFileSync(path.join(N8N, file), 'utf8'));
  } catch (e) {
    errors.push(`n8n/${file}: invalid JSON — ${e.message}`);
    continue;
  }
  const names = new Set(wf.nodes.map((n) => n.name));

  for (const [src, v] of Object.entries(wf.connections || {})) {
    if (!names.has(src)) errors.push(`n8n/${file}: connection from unknown node "${src}"`);
    for (const outs of v.main || []) {
      for (const c of outs || []) {
        if (!names.has(c.node)) errors.push(`n8n/${file}: "${src}" connects to unknown node "${c.node}"`);
      }
    }
  }

  for (const n of wf.nodes) {
    const label = `n8n/${file} › ${n.name}`;
    for (const cred of Object.values(n.credentials || {})) {
      if (cred && cred.id) errors.push(`${label}: credential id "${cred.id}" left in the export`);
    }
    for (const [key, value] of Object.entries(n.parameters || {})) {
      if (typeof value !== 'string') continue;
      for (const m of value.matchAll(/\$\((['"])(.+?)\1\)/g)) {
        if (!names.has(m[2])) errors.push(`${label}: references unknown node $('${m[2]}')`);
      }
      if (key === 'jsCode') {
        parses(`return (async () => {\n${value}\n});`, `${label} (jsCode)`);
        fragments++;
      } else if (/^=\{\{[\s\S]*\}\}\s*$/.test(value)) {
        parses(`return (${value.trim().slice(3, -2)});`, `${label} (${key})`);
        fragments++;
      }
    }
  }
}
console.log(`n8n workflows: ${fragments} code fragments checked`);

if (errors.length) {
  console.error(`\n${errors.length} problem(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('all checks passed');
