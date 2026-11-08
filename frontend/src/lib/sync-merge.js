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
  const map = new Map()
  for (const item of server || []) { const k = keyOf(listKey, item); if (k != null && !tombstones.has(k)) map.set(k, item) }
  for (const item of local || []) { const k = keyOf(listKey, item); if (k != null && !tombstones.has(k)) map.set(k, item) } // local wins shared keys
  return [...map.values()]
}
function unionTombstones(a, b) {
  const s = [...(a || [])]
  for (const x of b || []) if (!s.includes(x)) s.push(x)
  return s.slice(-TOMBSTONE_CAP) // keep the most recent additions
}
const tombSet = (ln, sn, kind) => unionTombstones(ln.deletedIds?.[kind], sn.deletedIds?.[kind])

/* ---------- tombstones ---------- */
// Every deletion of a synced record writes one of these, so a deletion made offline (or on
// device A) survives the union on device B instead of reviving the row.
export function addTombstone(state, kind, key) {
  if (!state || key == null) return
  const d = (state.deletedIds && typeof state.deletedIds === 'object') ? state.deletedIds : (state.deletedIds = {})
  const list = Array.isArray(d[kind]) ? d[kind] : []
  if (!list.includes(key)) list.push(key)
  d[kind] = list.slice(-TOMBSTONE_CAP)
}

/* ---------- the merge itself ---------- */
export function mergeStates({ baseHashes, local, server }) {
  const ln = normalizeState(local), sn = normalizeState(server)
  // epoch: "this state was wholly replaced" — never auto-merge across that boundary
  if (ln.epoch != null && sn.epoch != null && ln.epoch !== sn.epoch) {
    return { merged: local, conflicts: ['epoch'], epochConflict: true }
  }
  const merged = { ...ln }
  const conflicts = []
  const keys = new Set([...Object.keys(baseHashes || {}), ...Object.keys(ln), ...Object.keys(sn)])
  for (const k of keys) {
    if (DEVICE_KEYS.includes(k) || COACH_KEYS.includes(k) || LIST_KEYS.includes(k)) continue
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
  // append-only lists: union of both sides minus the merged tombstones
  const tw = tombSet(ln, sn, 'workouts'), tb = tombSet(ln, sn, 'bodyweight')
  merged.workouts = unionList('workouts', ln.workouts, sn.workouts, new Set(tw))
  merged.bodyweight = unionList('bodyweight', ln.bodyweight, sn.bodyweight, new Set(tb))
  if (tw.length || tb.length) merged.deletedIds = { workouts: tw, bodyweight: tb }
  else delete merged.deletedIds
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
    deps.setBase({ rev: resp.rev ?? null, hashes: topLevelHashes(normalizeState(deps.getLocal())) })
    return { ok: true, rev: resp.rev ?? null }
  }
  const m = mergeStates({ baseHashes: base?.hashes || null, local: deps.getLocal(), server: resp.state })
  if (m.epochConflict || m.conflicts.length) {
    return { ok: false, conflict: true, conflicts: m.conflicts, epochConflict: m.epochConflict, serverState: resp.state, serverRev: resp.rev, merged: m.merged }
  }
  if (retries >= PUSH_MAX_RETRIES) return { ok: false, failed: true, exhausted: true }
  // the server view rides along so the caller can re-inject coach-owned content (it is
  // normalized out of merged — see normalizeState)
  deps.applyLocal(m.merged, resp.state)
  deps.setBase({ rev: resp.rev, hashes: topLevelHashes(normalizeState(m.merged)) })
  return pushWithMerge(deps, retries + 1)
}

/* ---------- full-replace marker ---------- */
// Operations that replace the whole profile (backup import, reset, sample data) stamp a
// fresh epoch; the merge refuses to auto-combine states with different epochs.
export function withNewEpoch(state) {
  if (state && typeof state === 'object') state.epoch = 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  return state
}
