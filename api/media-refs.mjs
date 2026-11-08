// Shared reference-scan for personal media — the single source of truth for "which hashes
// are still in use", used by scripts/gc-media.mjs (everything) and the release endpoint in
// api/server.js (one member's view). Keep every new media-carrying structure here.

import fs from 'node:fs';
import path from 'node:path';

const STATE_RE = /^state-[A-Za-z0-9_-]+\.json$/;
export const hashOf = item => {
  const r = item && item.mediaRef;
  return r && /^[a-f0-9]{64}$/.test(r.h || '') ? r.h : null;
};

// one state object: routines and custom exercises (the only media-carrying shapes in state)
export function collectStateMediaRefs(st, out = new Set()) {
  for (const r of st.routines || []) for (const e of r.ex || []) { const h = hashOf(e); if (h) out.add(h) }
  for (const c of st.customEx || []) { const h = hashOf(c); if (h) out.add(h) }
  return out;
}

// db.json: coach-owned assignments reference the coach's uploads
export function collectDbMediaRefs(db, out = new Set()) {
  for (const a of db.coachAssignments || []) {
    for (const r of a.routines || []) for (const e of r.ex || []) { const h = hashOf(e); if (h) out.add(h) }
  }
  return out;
}

// everything referenced anywhere — unreadable files are reported, never fatal (gc keeps going)
export function collectMediaRefs(DATA, onError = () => {}) {
  const out = new Set();
  for (const f of fs.readdirSync(DATA)) {
    if (!STATE_RE.test(f)) continue;
    try { collectStateMediaRefs(JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')), out) }
    catch (e) { onError(f, e) }
  }
  try { collectDbMediaRefs(JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8')), out) }
  catch (e) { onError('db.json', e) }
  return out;
}

// the references that keep ONE member's ownership alive: their own state, plus the
// assignments they authored as a coach (their members still render those blobs)
export function refsForUid(DATA, uid) {
  const out = new Set();
  try { collectStateMediaRefs(JSON.parse(fs.readFileSync(path.join(DATA, `state-${uid}.json`), 'utf8')), out) }
  catch (e) { if (e.code !== 'ENOENT') throw e }
  try {
    const db = JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8'));
    for (const a of db.coachAssignments || []) {
      if (a.coachId !== uid) continue;
      for (const r of a.routines || []) for (const e of r.ex || []) { const h = hashOf(e); if (h) out.add(h) }
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e }
  return out;
}
