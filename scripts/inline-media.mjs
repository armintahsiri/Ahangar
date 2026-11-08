// Rollback path for the media migration: convert every server-side media reference in the
// state files back into inline base64 data-URLs (the pre-phase-4 shape), so the states are
// self-contained again and the media folder can be dropped.
//
// ⚠  STOP THE API FIRST:  docker compose stop api
// Writes every changed state file atomically at 0600 and bumps its rev by one, so clients
// pull the inlined state instead of fighting it with their newer rev.
//
// Usage:
//   node scripts/inline-media.mjs [--data <dir>] [--apply]   (default: dry run)

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined };
const has = name => args.includes(name);

const DATA = arg('--data') || process.env.DATA_DIR || '/data';
const APPLY = has('--apply');
const mediaDir = path.join(DATA, 'media');
if (APPLY) console.log('⚠ --apply given: state files will be rewritten inline. Make sure the API is stopped (docker compose stop api).');
else console.log('Dry run — pass --apply to rewrite (and stop the API first).');

// server.js validates db.json on import and owns the atomic 0600 write — reuse, don't copy
process.env.DATA_DIR = DATA;
const { atomicWrite } = await import(new URL('../api/server.js', import.meta.url).href);

const toDataUrl = (h, e) => {
  const file = path.join(mediaDir, `${h}.${e}`);
  const mime = e === 'gif' ? 'image/gif' : 'video/mp4';
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
};

let files = 0, items = 0, missing = 0;
for (const f of fs.readdirSync(DATA)) {
  if (!/^state-[A-Za-z0-9_-]+\.json$/.test(f)) continue;
  const file = path.join(DATA, f);
  let st;
  try { st = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error(`⚠ skipping unreadable ${f}: ${e.message}`); continue }
  let changed = 0;
  const inlineItem = (item, isCustom) => {
    const r = item && item.mediaRef;
    if (!r || !/^[a-f0-9]{64}$/.test(r.h || '')) return;
    try {
      const dataUrl = toDataUrl(r.h, r.e);
      if (isCustom) { item.gif = dataUrl; delete item.mediaRef }
      else { item.gifData = dataUrl; delete item.mediaRef }
      changed++;
    } catch (e) {
      if (e.code === 'ENOENT') { missing++; console.error(`⚠ media file for a reference in ${f} is missing (${r.h}) — reference kept`) }
      else throw e;
    }
  };
  for (const r of st.routines || []) for (const e of r.ex || []) inlineItem(e, false);
  for (const c of st.customEx || []) inlineItem(c, true);
  if (changed) {
    st.rev = (typeof st.rev === 'number' ? st.rev : 0) + 1;
    files++; items += changed;
    console.log(`${APPLY ? '✓' : '·'} ${f}: ${changed} reference(s) inlined, rev → ${st.rev}`);
    if (APPLY) atomicWrite(file, JSON.stringify(st));
  }
}
// Coach assignments live in db.json (not a state file) and can reference the coach's media —
// the member's client reads those routines, so they must inline too.
const dbFile = path.join(DATA, 'db.json');
let dbChanged = 0;
try {
  const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  for (const a of db.coachAssignments || []) {
    for (const r of a.routines || []) {
      for (const e of r.ex || []) {
        const r2 = e && e.mediaRef;
        if (!r2 || !/^[a-f0-9]{64}$/.test(r2.h || '')) continue;
        try { e.gifData = toDataUrl(r2.h, r2.e); delete e.mediaRef; dbChanged++ }
        catch (err) {
          if (err.code === 'ENOENT') { missing++; console.error(`⚠ media file for a reference in db.json is missing (${r2.h}) — reference kept`) }
          else throw err;
        }
      }
    }
  }
  if (dbChanged) {
    console.log(`${APPLY ? '✓' : '·'} db.json: ${dbChanged} coach-assignment reference(s) inlined`);
    if (APPLY) atomicWrite(dbFile, JSON.stringify(db, null, 2));
    items += dbChanged;
  }
} catch (e) { if (e.code !== 'ENOENT') console.error(`⚠ db.json skipped: ${e.message}`) }
console.log(`\n${APPLY ? 'Done' : 'Dry run'}: ${items} reference(s) processed${missing ? ` · ${missing} dangling reference(s) kept as-is` : ''}.`);
console.log(APPLY ? 'Start the API again: docker compose start api' : 'Re-run with --apply to write.');
