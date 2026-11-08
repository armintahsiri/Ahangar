// Garbage-collect unreferenced personal media in <DATA>/media.
//
// A media file is referenced when some state file's routines[].ex[] or customEx[] carries
// mediaRef { h, e } with that hash, or when db.json's coachAssignments routines reference it.
// Everything else in media/index.json older than the grace period (7 days, so an offline
// device that still shows the GIF on its screen doesn't lose it on its next sync) is garbage.
//
// ⚠  --apply writes under ./data — STOP THE API FIRST (docker compose stop api), same reason
// as reset-password: the running server keeps db.json/state in memory.
//
// Usage:
//   node scripts/gc-media.mjs [--data <dir>] [--days 7] [--apply]   (default: dry run)

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined };
const has = name => args.includes(name);

const DATA = arg('--data') || process.env.DATA_DIR || '/data';
const DAYS = Math.max(0, Math.trunc(+(arg('--days') || 7)) || 7);
const APPLY = has('--apply');
const mediaDir = path.join(DATA, 'media');
const indexFile = path.join(mediaDir, 'index.json');

if (!fs.existsSync(indexFile)) { console.log('No media index — nothing to collect.'); process.exit(0); }
if (APPLY) console.log('⚠ --apply given: unreferenced files will be deleted. Make sure the API is stopped (docker compose stop api).');
else console.log('Dry run — pass --apply to delete (and stop the API first).');

let index;
try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); }
catch (e) { console.error(`FATAL: media index unreadable (${e.message}).`); process.exit(1); }

// ---- collect every hash any state or coach assignment still references ----
const referenced = new Set();
const hashOf = item => { const r = item && item.mediaRef; return r && /^[a-f0-9]{64}$/.test(r.h || '') ? r.h : null };
const walk = st => {
  for (const r of st.routines || []) for (const e of r.ex || []) { const h = hashOf(e); if (h) referenced.add(h) }
  for (const c of st.customEx || []) { const h = hashOf(c); if (h) referenced.add(h) }
};
for (const f of fs.readdirSync(DATA)) {
  if (!/^state-[A-Za-z0-9_-]+\.json$/.test(f)) continue;
  try { walk(JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'))); }
  catch (e) { console.error(`⚠ skipping unreadable ${f}: ${e.message}`) }
}
try {
  const db = JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8'));
  for (const a of db.coachAssignments || []) for (const r of a.routines || []) for (const e of r.ex || []) { const h = hashOf(e); if (h) referenced.add(h) }
} catch (e) { console.error(`⚠ db.json unreadable for reference scan: ${e.message}`) }

// ---- decide: unreferenced AND older than the grace period ----
const cutoff = Date.now() - DAYS * 86400000;
const garbage = [], keep = [];
for (const [h, m] of Object.entries(index)) {
  const created = Date.parse(m.created || '') || 0;
  const file = path.join(mediaDir, `${h}.${m.ext}`);
  const mtime = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
  const age = Math.max(created, mtime);
  if (!referenced.has(h) && age < cutoff) garbage.push([h, m]);
  else keep.push([h, m]);
}

console.log(`\nindex: ${Object.keys(index).length} · referenced anywhere: ${referenced.size} · garbage (unreferenced & >${DAYS}d): ${garbage.length}`);
for (const [h, m] of garbage) console.log(`  - ${h}.${m.ext}  ${(m.size / 1024).toFixed(1)} KB  created ${m.created || '?'}  owners ${(m.owners || []).length}`);
if (!garbage.length) { console.log('Nothing to collect.'); process.exit(0); }
if (!APPLY) {
  const kb = (garbage.reduce((a, [, m]) => a + (m.size || 0), 0) / 1024).toFixed(1);
  console.log(`\nDry run: ${garbage.length} file(s), ${kb} KB would be freed. Re-run with --apply.`);
  process.exit(0);
}

let freed = 0;
for (const [h, m] of garbage) {
  const file = path.join(mediaDir, `${h}.${m.ext}`);
  try { fs.unlinkSync(file); freed += m.size || 0 } catch (e) { if (e.code !== 'ENOENT') console.error(`⚠ could not delete ${h}.${m.ext}: ${e.message}`) }
  delete index[h];
}
fs.writeFileSync(indexFile, JSON.stringify(index, null, 2), { mode: 0o600 });
console.log(`✓ deleted ${garbage.length} file(s), ${(freed / 1024).toFixed(1)} KB freed. Start the API again: docker compose start api`);
