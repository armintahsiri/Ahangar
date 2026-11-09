// Pure three-way state merge for sync — no store, DOM or network imports, so vitest can
// hammer every branch. The policy mirrors what the server already enforces on its side:
// append-only lists union by key, tombstones never revive, coach-owned content always comes
// from the server, device-only content always stays with the device, and a full-replace
// (epoch change) on either side is never auto-merged over the other.

/* ---------- stable hashing: FNV-1a 32-bit over sorted-key JSON ---------- */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}'
}
export function hashKey(value) {
  const s = stableStringify(value)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(16).padStart(8, '0')
}
export function topLevelHashes(state) {
  const out = {}
  if (!state || typeof state !== 'object') return out
  for (const k of Object.keys(state)) out[k] = hashKey(state[k])
  return out
}

/* ---------- normalization: the shared comparison space ---------- */
// Device-only and server-owned content is stripped before any hash or merge, so one state
// hashes identically no matter which side serialized it. rev/_ts/active are metadata that
// never round-trips meaningfully; coachProgram, coachManaged routines and the coach's week
// days belong to the server and are re-injected by withCoachProgram after the merge.
export function normalizeState(state) {
  if (!state || typeof state !== 'object') return state
  const s = JSON.parse(JSON.stringify(state))
  delete s.rev; delete s._ts; delete s.active; delete s.coachProgram
  const coachIds = new Set((s.routines || []).filter(r => r && r.coachManaged).map(r => r.id))
  if (coachIds.size) {
    s.routines = s.routines.filter(r => !(r && r.coachManaged))
    if (s.week) {
      const w = { ...s.week }
      for (const [d, id] of Object.entries(w)) if (coachIds.has(id)) delete w[d]
      s.week = w
    }
  }
  return s
}

/* ---------- key classes ---------- */
const DEVICE_KEYS = ['active', '_ts', 'rev']                 // never compared — device keeps its own
const COACH_KEYS = ['coachProgram']                          // always the server's word
const LIST_KEYS = ['workouts', 'bodyweight', 'deletedIds']   // unioned by key, never conflicted
export const TOMBSTONE_CAP = 1000

// workouts are id-keyed; bodyweight has no id — it is keyed by date (one weigh-in per day,
// same-day re-logs edit in place), so tombstones for it store dates.
const keyOf = (listKey, item) => (listKey === 'bodyweight' ? item?.d : item?.id)

function unionList(listKey, local, server, tombstones) {
  const put = item => {
    const k = keyOf(listKey, item)
    if (k == null || tombstones.has(k)) return
    const cur = map.get(k)
    if (!cur) { map.set(k, item); return }
    // two readings of the same day: the later measurement wins (both carry a `t` stamp),
    // tie → local (it is inserted first). Workouts are immutable rows — same id, same content.
    if (listKey === 'bodyweight' && (item.t || 0) > (cur.t || 0)) map.set(k, item)
  }
  const map = new Map()
  for (const item of local || []) put(item)
  for (const item of server || []) put(item)
  return [...map.values()]
}
function unionTombstones(a, b) {
  const s = [...(a || [])]
  for (const x of b || []) if (!s.includes(x)) s.push(x)
  return s.slice(-TOMBSTONE_CAP) // keep the most recent additions
}
const tombSet = (ln, sn, kind) => unionTombstones(ln.deletedIds?.[kind], sn.deletedIds?.[kind])

/* ---------- custom per-key merges (phase 7b: exWeights, dayPlan) ---------- */
// Both sides changed the key relative to the base → today that meant a whole-key conflict.
// These two keys are safe (and much nicer) to merge mechanically:
//  - exWeights is monotonic-up by design (the heaviest confirmed working weight), so the
//    heavier value wins; ties go to the newer date. A floor keeps the merged entry honest
//    against the merged workouts — upgrade only, never created from thin air.
//  - dayPlan merges per date; on genuine divergence the pushing device wins (local).

// mirrors history.js bestWeightFor (max of done-set weights and topW) — reimplemented here
// as a pure scan so this module stays dependency-free
const bestLoad = (workouts, exId) => {
  let best = 0
  for (const w of workouts || []) {
    for (const e of w.entries || []) {
      if (e.id !== exId) continue
      for (const s of e.sets || []) if (s.done && (s.w || 0) > best) best = s.w
      if ((e.topW || 0) > best) best = e.topW
    }
  }
  return best
}

// the date of the session that produced the best load, for the floor upgrade's `d`
const bestLoadDate = (workouts, exId) => {
  let best = 0, d = null
  for (const w of workouts || []) {
    for (const e of w.entries || []) {
      if (e.id !== exId) continue
      for (const s of e.sets || []) if (s.done && (s.w || 0) > best) { best = s.w; d = w.d || null }
      if ((e.topW || 0) > best) { best = e.topW; d = w.d || null }
    }
  }
  return d
}

export function mergeExWeights({ local, server, mergedWorkouts, baseCustomIds }) {
  // a custom exercise deleted anywhere in the ancestry takes its weight entry with it;
  // without a base snapshot only the two live sides are known (an orphan can then survive
  // a both-sides-deleted edge — harmless, gc-free display blank)
  const customIds = new Set([...(baseCustomIds || [])])
  for (const c of local?.customEx || []) if (c?.id) customIds.add(c.id)
  for (const c of server?.customEx || []) if (c?.id) customIds.add(c.id)
  const stillExists = id => !customIds.has(id) || (local?.customEx || []).some(c => c?.id === id) || (server?.customEx || []).some(c => c?.id === id)

  const lw = local?.exWeights || {}, sw = server?.exWeights || {}
  const out = {}
  for (const id of new Set([...Object.keys(lw), ...Object.keys(sw)])) {
    if (customIds.has(id) && !stillExists(id)) continue   // deleted custom exercise
    const L = lw[id], S = sw[id]
    let win
    if (!S) win = L
    else if (!L) win = S
    else if ((S.w || 0) > (L.w || 0)) win = S
    else if ((L.w || 0) > (S.w || 0)) win = L
    else win = String(S.d || '') >= String(L.d || '') ? S : L   // equal weight → newer date
    if (!win) continue
    // floor against the merged workouts — upgrade only, never create an entry from nothing
    const floor = bestLoad(mergedWorkouts, id)
    if (floor > (win.w || 0)) win = { w: floor, d: bestLoadDate(mergedWorkouts, id) || win.d || null }
    out[id] = { ...win }
  }
  return out
}

export function mergeDayPlan({ baseDayPlan, local, server }) {
  const b = baseDayPlan || {}, l = local || {}, s = server || {}
  const out = {}
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
  for (const k of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(s)])) {
    const bv = has(b, k) ? b[k] : undefined
    const lv = has(l, k) ? l[k] : undefined
    const sv = has(s, k) ? s[k] : undefined
    if (lv === sv) { if (lv !== undefined) out[k] = lv; continue }   // same on both sides
    if (lv === bv) { if (sv !== undefined) out[k] = sv; continue }   // local untouched → server (incl. deletion)
    if (sv === bv) { if (lv !== undefined) out[k] = lv; continue }   // server untouched → local (incl. deletion)
    if (lv !== undefined) out[k] = lv                                // genuine divergence → pushing device wins
  }
  return out
}

// classification for the custom keys — skipped by the generic three-way loop
const CUSTOM_KEYS = ['exWeights', 'dayPlan']                 // merged by their own rules

// Bodyweight tombstones carry the deletion time ({d, at}) so a later re-log can beat them;
// phase-2 legacy strings read as "deleted at 0" (older than anything stamped). The map keeps
// the newest deletion time per date.
function bwTombstoneMap(ln, sn) {
  const m = new Map()
  const add = x => {
    const e = typeof x === 'string' ? { d: x, at: 0 } : x
    if (!e?.d) return
    const prev = m.get(e.d)
    if (prev === undefined || (e.at || 0) > prev) m.set(e.d, e.at || 0)
  }
  for (const x of ln.deletedIds?.bodyweight || []) add(x)
  for (const x of sn.deletedIds?.bodyweight || []) add(x)
  // a live reading stamped at or after the deletion beats the tombstone — the user logged
  // the day again after removing it, so the removal is history, not a pending deletion
  for (const list of [ln.bodyweight || [], sn.bodyweight || []]) {
    for (const b of list) { const at = m.get(b.d); if (at !== undefined && (b.t || 0) >= at) m.delete(b.d) }
  }
  return m
}

/* ---------- tombstones ---------- */
// Every deletion of a synced record writes one of these, so a deletion made offline (or on
// device A) survives the union on device B instead of reviving the row. Workouts keep plain
// ids (an id is never re-issued); bodyweight tombstones are {d, at} because a day can be
// legitimately re-logged after its deletion — the timestamp is what tells the two apart.
export function addTombstone(state, kind, key) {
  if (!state || key == null) return
  const d = (state.deletedIds && typeof state.deletedIds === 'object') ? state.deletedIds : (state.deletedIds = {})
  const list = Array.isArray(d[kind]) ? d[kind] : []
  const entry = kind === 'bodyweight' ? { d: key, at: Date.now() } : key
  if (!list.some(x => (typeof x === 'string' ? x === key : x.d === key))) list.push(entry)
  d[kind] = list.slice(-TOMBSTONE_CAP)
}
// A fresh log for a key clears its deletion record — without this, the next union would
// drop the new weigh-in as if it were still deleted.
export function removeTombstone(state, kind, key) {
  if (!state?.deletedIds || key == null) return
  const list = state.deletedIds[kind]
  if (!Array.isArray(list)) return
  const next = list.filter(x => (typeof x === 'string' ? x !== key : x.d !== key))
  if (next.length) state.deletedIds[kind] = next
  else delete state.deletedIds[kind]
  if (!Object.keys(state.deletedIds).length) delete state.deletedIds
}

/* ---------- the merge itself ---------- */
export function mergeStates({ baseHashes, baseSnap, local, server }) {
  const ln = normalizeState(local), sn = normalizeState(server)
  // epoch: "this state was wholly replaced" — never auto-merge across that boundary
  if (ln.epoch != null && sn.epoch != null && ln.epoch !== sn.epoch) {
    return { merged: local, conflicts: ['epoch'], epochConflict: true }
  }
  const merged = { ...ln }
  const conflicts = []
  const keys = new Set([...Object.keys(baseHashes || {}), ...Object.keys(ln), ...Object.keys(sn)])
  for (const k of keys) {
    if (DEVICE_KEYS.includes(k) || COACH_KEYS.includes(k) || LIST_KEYS.includes(k) || CUSTOM_KEYS.includes(k)) continue
    const hB = baseHashes && k in baseHashes ? baseHashes[k] : undefined
    const hL = k in ln ? hashKey(ln[k]) : undefined
    const hS = k in sn ? hashKey(sn[k]) : undefined
    const lc = hL !== hB, sc = hS !== hB
    if (!lc && !sc) continue                                    // untouched
    if (lc && !sc) continue                                     // local changed → keep local
    if (!lc && sc) { if (k in sn) merged[k] = sn[k]; else delete merged[k] }  // server changed → server
    else if (hL === hS) continue                                // both changed to the same thing
    else conflicts.push(k)                                      // both changed, differently
  }
  // append-only lists: union of both sides minus the merged tombstones. Bodyweight
  // tombstones are time-aware (bwTombstoneMap) so a post-deletion re-log survives.
  const tw = tombSet(ln, sn, 'workouts')
  const bwTomb = bwTombstoneMap(ln, sn)
  const bwTombKeys = new Set(bwTomb.keys())
  merged.workouts = unionList('workouts', ln.workouts, sn.workouts, new Set(tw))
  merged.bodyweight = unionList('bodyweight', ln.bodyweight, sn.bodyweight, bwTombKeys)
  if (tw.length || bwTomb.size) {
    merged.deletedIds = {
      workouts: tw,
      bodyweight: [...bwTomb.entries()].slice(-TOMBSTONE_CAP).map(([d, at]) => ({ d, at }))
    }
  } else delete merged.deletedIds
  // custom per-key merges — only when BOTH sides changed (one-side-changed already keeps
  // the changed side through the {...local} spread above)
  for (const k of CUSTOM_KEYS) {
    const hB = baseHashes && k in baseHashes ? baseHashes[k] : undefined
    const hL = k in ln ? hashKey(ln[k]) : undefined
    const hS = k in sn ? hashKey(sn[k]) : undefined
    const lc = hL !== hB, sc = hS !== hB
    if (!lc && !sc) continue                                  // untouched → keep local
    if (!sc) continue                                         // only local changed → keep local
    if (!lc) {                                                // only server changed → take server (incl. deletion)
      if (k in sn) merged[k] = sn[k]
      else delete merged[k]
      continue
    }
    if (k === 'exWeights') merged.exWeights = mergeExWeights({ local: ln, server: sn, mergedWorkouts: merged.workouts, baseCustomIds: baseSnap?.customIds })
    else if (k === 'dayPlan') {
      // without the base snapshot a per-date deletion is indistinguishable from absence —
      // fall back to the old whole-key conflict rather than guessing
      if (!baseSnap || !('dayPlan' in baseSnap)) { conflicts.push(k); continue }
      merged.dayPlan = mergeDayPlan({ baseDayPlan: baseSnap.dayPlan, local: ln.dayPlan, server: sn.dayPlan })
    }
  }
  return { merged, conflicts, epochConflict: false }
}

// The conflict sheet's two buttons. 'local' is already what merged carries; 'server' takes
// the server's values for the conflicted keys. Lists stay unioned either way — that is the point.
export function resolveMerge(merged, server, conflicts, choice) {
  if (choice !== 'server') return merged
  const sn = normalizeState(server)
  const out = { ...merged }
  for (const k of conflicts) { if (k in sn) out[k] = sn[k]; else delete out[k] }
  return out
}

/* ---------- base snapshot (dayPlan + custom ids) ---------- */
// The base normally carries { rev, hashes } only. Attaching a small snapshot of the accepted
// state lets the custom per-key merges (dayPlan, exWeights) tell a deletion from an absence.
// An oversized or failing snapshot is silently dropped — those merges then fall back to
// today's behaviour (whole-key conflict). Nothing here throws on a full localStorage.
export const BASE_SNAP_MAX = 50 * 1024
export function withSnap(base, state) {
  if (!base) return base
  try {
    const snap = {
      dayPlan: state?.dayPlan || {},
      customIds: (state?.customEx || []).map(c => c && c.id).filter(Boolean)
    }
    if (JSON.stringify(snap).length > BASE_SNAP_MAX) return base
    return { ...base, snap }
  } catch { return base }
}

/* ---------- push controller: send → on 409 merge → retry ---------- */
export const PUSH_MAX_RETRIES = 3
// deps: getBase() → {rev, hashes} | null · getLocal() → state · applyLocal(state)
//       setBase({rev, hashes}) · send(baseRev, state) → {ok, rev} | {ok:false, rev, state}
//       (send throws for network/offline failures). Pure against its deps — tests use fakes.
export async function pushWithMerge(deps, retries = 0) {
  const base = deps.getBase() || null
  let resp
  try { resp = await deps.send(base?.rev ?? null, deps.getLocal()) }
  catch (e) { return { ok: false, failed: true, error: e } }
  if (resp.ok) {
    // base pinning: normalize(local) is exactly how the server's stored copy normalizes,
    // so the next three-way compares like-for-like. A legacy server without rev keeps
    // rev null → no baseRev is ever sent → old behavior.
    deps.setBase({ rev: resp.rev ?? null, hashes: topLevelHashes(normalizeState(deps.getLocal())) }, deps.getLocal())
    return { ok: true, rev: resp.rev ?? null }
  }
  const m = mergeStates({ baseHashes: base?.hashes || null, baseSnap: base?.snap, local: deps.getLocal(), server: resp.state })
  if (m.epochConflict || m.conflicts.length) {
    return { ok: false, conflict: true, conflicts: m.conflicts, epochConflict: m.epochConflict, serverState: resp.state, serverRev: resp.rev, merged: m.merged }
  }
  if (retries >= PUSH_MAX_RETRIES) return { ok: false, failed: true, exhausted: true }
  // the server view rides along so the caller can re-inject coach-owned content (it is
  // normalized out of merged — see normalizeState)
  deps.applyLocal(m.merged, resp.state)
  // the merged state rides along so the caller can snapshot it into the base
  deps.setBase({ rev: resp.rev, hashes: topLevelHashes(normalizeState(m.merged)) }, m.merged)
  return pushWithMerge(deps, retries + 1)
}

/* ---------- full-replace marker ---------- */
// Operations that replace the whole profile (backup import, reset, sample data) stamp a
// fresh epoch; the merge refuses to auto-combine states with different epochs.
export function withNewEpoch(state) {
  if (state && typeof state === 'object') state.epoch = 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  return state
}
