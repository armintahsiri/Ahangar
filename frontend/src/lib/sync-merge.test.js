import { describe, it, expect, vi } from 'vitest'
import {
  hashKey, topLevelHashes, normalizeState, mergeStates, resolveMerge,
  pushWithMerge, mergeExWeights, mergeDayPlan, addTombstone, removeTombstone, withNewEpoch, PUSH_MAX_RETRIES,
  withSnap, BASE_SNAP_MAX
} from './sync-merge.js'

// base hashes for a state, the way the store records them after a successful sync
const hashesOf = s => topLevelHashes(normalizeState(s))

describe('stable hashing', () => {
  it('ignores key order', () => {
    expect(hashKey({ a: 1, b: [1, { c: 2 }] })).toBe(hashKey({ b: [1, { c: 2 }], a: 1 }))
  })
  it('changes when the value changes', () => {
    expect(hashKey({ a: 1 })).not.toBe(hashKey({ a: 2 }))
  })
  it('topLevelHashes covers every top-level key', () => {
    const h = topLevelHashes({ unit: 'kg', workouts: [] })
    expect(Object.keys(h).sort()).toEqual(['unit', 'workouts'])
  })
})

describe('normalizeState', () => {
  it('strips device-only and server-owned content', () => {
    const s = normalizeState({
      rev: 7, _ts: 1, active: { id: 'w' }, coachProgram: { week: {} },
      unit: 'kg',
      routines: [{ id: 'r1' }, { id: 'rC', coachManaged: true }],
      week: { 1: 'r1', 2: 'rC' }
    })
    expect(s.rev).toBeUndefined()
    expect(s._ts).toBeUndefined()
    expect(s.active).toBeUndefined()
    expect(s.coachProgram).toBeUndefined()
    expect(s.routines).toEqual([{ id: 'r1' }])
    expect(s.week).toEqual({ 1: 'r1' }) // coach-owned day stripped
    expect(s.unit).toBe('kg')
  })
})

describe('mergeStates — append-only lists', () => {
  const base = { hashes: hashesOf({ unit: 'kg', workouts: [], bodyweight: [] }), }
  it('unions workouts added on either side', () => {
    const local = { workouts: [{ id: 'w1', d: '2026-11-01' }] }
    const server = { workouts: [{ id: 'w2', d: '2026-11-02' }] }
    const { merged, conflicts } = mergeStates({ baseHashes: base.hashes, local, server })
    expect(conflicts).toEqual([])
    expect(merged.workouts.map(w => w.id).sort()).toEqual(['w1', 'w2'])
  })
  it('a locally deleted workout stays dead even when the server still has it', () => {
    const local = { workouts: [], deletedIds: { workouts: ['w1'] } }
    const server = { workouts: [{ id: 'w1', d: '2026-11-01' }] }
    const { merged } = mergeStates({ baseHashes: base.hashes, local, server })
    expect(merged.workouts).toEqual([])
    expect(merged.deletedIds.workouts).toContain('w1')
  })
  it('a server-side deletion removes the local copy too', () => {
    const local = { workouts: [{ id: 'w1', d: '2026-11-01' }] }
    const server = { workouts: [], deletedIds: { workouts: ['w1'] } }
    const { merged } = mergeStates({ baseHashes: base.hashes, local, server })
    expect(merged.workouts).toEqual([])
  })
  it('union of tombstones from both sides, capped at the most recent 1000', () => {
    const local = { deletedIds: { workouts: Array.from({ length: 600 }, (_, i) => `L${i}`) } }
    const server = { deletedIds: { workouts: Array.from({ length: 600 }, (_, i) => `S${i}`) } }
    const { merged } = mergeStates({ baseHashes: base.hashes, local, server })
    expect(merged.deletedIds.workouts.length).toBe(1000)
    expect(merged.deletedIds.workouts[0]).toBe('L200') // oldest 200 local entries dropped
  })
  it('bodyweight unions by date and same-day re-logs keep the local reading', () => {
    const local = { bodyweight: [{ d: '2026-11-01', w: 80.2 }, { d: '2026-11-02', w: 80.0 }] }
    const server = { bodyweight: [{ d: '2026-11-01', w: 80.5 }, { d: '2026-11-03', w: 79.8 }] }
    const { merged } = mergeStates({ baseHashes: base.hashes, local, server })
    const first = merged.bodyweight.find(b => b.d === '2026-11-01')
    expect(first.w).toBe(80.2) // local wins shared days
    expect(merged.bodyweight.length).toBe(3)
  })
  it('bodyweight tombstones are dates and prevent revival', () => {
    // deletion happened at t=9000; the other device still carries the older reading (t=1000)
    const local = { bodyweight: [], deletedIds: { bodyweight: [{ d: '2026-11-01', at: 9000 }] } }
    const server = { bodyweight: [{ d: '2026-11-01', w: 80.0, t: 1000 }] }
    const { merged } = mergeStates({ baseHashes: base.hashes, local, server })
    expect(merged.bodyweight).toEqual([])
    expect(merged.deletedIds.bodyweight).toEqual([{ d: '2026-11-01', at: 9000 }])
  })
  it('a weigh-in re-logged AFTER its deletion survives the merge', () => {
    // device A deleted the 2026-11-01 weigh-in (tombstone at 9000); device B re-logged the
    // day afterwards (t=10000, its own tombstone copy already cleared by the write path)
    const local = { bodyweight: [{ d: '2026-11-01', w: 81.5, t: 10000 }] }
    const server = { bodyweight: [], deletedIds: { bodyweight: [{ d: '2026-11-01', at: 9000 }] } }
    const { merged } = mergeStates({ baseHashes: base.hashes, local, server })
    expect(merged.bodyweight.some(b => b.d === '2026-11-01')).toBe(true)
    expect(merged.bodyweight[0].w).toBe(81.5)
    expect(merged.deletedIds?.bodyweight || []).toEqual([]) // the stale tombstone is dropped
  })
  it('same-day weigh-in with two readings: the later measurement wins', () => {
    const local = { bodyweight: [{ d: '2026-11-01', w: 80.2, t: 1000 }] }
    const server = { bodyweight: [{ d: '2026-11-01', w: 80.5, t: 2000 }] }
    const { merged } = mergeStates({ baseHashes: base.hashes, local, server })
    expect(merged.bodyweight.find(b => b.d === '2026-11-01').w).toBe(80.5)
  })
})

describe('mergeStates — three-way per top-level key', () => {
  const B = { unit: 'kg', targetW: 80, restSec: 90 }
  const baseHashes = hashesOf(B)
  it('only local changed → local', () => {
    const { merged, conflicts } = mergeStates({ baseHashes, local: { ...B, unit: 'lb' }, server: { ...B } })
    expect(conflicts).toEqual([])
    expect(merged.unit).toBe('lb')
  })
  it('only server changed → server', () => {
    const { merged, conflicts } = mergeStates({ baseHashes, local: { ...B }, server: { ...B, unit: 'lb' } })
    expect(conflicts).toEqual([])
    expect(merged.unit).toBe('lb')
  })
  it('both changed to the same value → no conflict', () => {
    const { merged, conflicts } = mergeStates({ baseHashes, local: { ...B, unit: 'lb' }, server: { ...B, unit: 'lb' } })
    expect(conflicts).toEqual([])
    expect(merged.unit).toBe('lb')
  })
  it('both changed differently → conflict naming the key', () => {
    const { merged, conflicts } = mergeStates({ baseHashes, local: { ...B, targetW: 78 }, server: { ...B, targetW: 82 } })
    expect(conflicts).toEqual(['targetW'])
    expect(merged.targetW).toBe(78) // merged defaults to local until the user chooses
  })
  it('a key the server removed (local untouched) is removed', () => {
    const server = { unit: 'kg', restSec: 90 } // targetW gone
    const { merged, conflicts } = mergeStates({ baseHashes, local: { ...B }, server })
    expect(conflicts).toEqual([])
    expect('targetW' in merged).toBe(false)
  })
  it('a key added on one side arrives on the other', () => {
    const { merged, conflicts } = mergeStates({ baseHashes, local: { ...B, sound: true }, server: { ...B } })
    expect(conflicts).toEqual([])
    expect(merged.sound).toBe(true)
  })
})

describe('mergeStates — key classes and epoch', () => {
  it('coachProgram is never merged from local — the server re-injects it', () => {
    const baseHashes = hashesOf({ coachProgram: { week: {} } })
    const { merged, conflicts } = mergeStates({
      baseHashes,
      local: { coachProgram: { week: { 1: 'stale' } } },
      server: { coachProgram: { week: { 1: 'fresh' } } }
    })
    expect(conflicts).toEqual([])
    expect(merged.coachProgram).toBeUndefined() // stripped; withCoachProgram re-applies the server's
  })
  it('different epochs → whole-state conflict, no auto-merge', () => {
    const local = withNewEpoch({ unit: 'lb', workouts: [{ id: 'w1', d: 'x' }] })
    const server = withNewEpoch({ unit: 'kg', workouts: [] })
    const { epochConflict, conflicts, merged } = mergeStates({ baseHashes: hashesOf({}), local, server })
    expect(epochConflict).toBe(true)
    expect(conflicts).toEqual(['epoch'])
    expect(merged).toBe(local) // caller decides; nothing was combined
  })
  it('same epoch on both sides merges normally', () => {
    const e = withNewEpoch({}).epoch
    const { epochConflict, conflicts } = mergeStates({
      baseHashes: hashesOf({}),
      local: { epoch: e, unit: 'lb' },
      server: { epoch: e, unit: 'lb' }
    })
    expect(epochConflict).toBe(false)
    expect(conflicts).toEqual([])
  })
})

describe('mergeExWeights (phase 7b)', () => {
  // mergeStates with both sides having changed exWeights routes here; call the merger
  // directly with mergedWorkouts supplied by the union, exactly as mergeStates does.
  const ex = (w, d) => ({ w, d })
  const mergedWorkouts = [{ id: 'w1', d: '2026-01-02', entries: [{ id: 'x', sets: [{ done: true, w: 90 }], topW: 95 }] }]

  it('distinct ids union', () => {
    const r = mergeExWeights({ local: { exWeights: { a: ex(80, '2026-01-01') } }, server: { exWeights: { b: ex(60, '2026-01-02') } }, mergedWorkouts: [] })
    expect(r).toEqual({ a: ex(80, '2026-01-01'), b: ex(60, '2026-01-02') })
  })
  it('same id: heavier wins regardless of date', () => {
    const r = mergeExWeights({ local: { exWeights: { x: ex(100, '2026-01-01') } }, server: { exWeights: { x: ex(90, '2026-02-01') } }, mergedWorkouts: [] })
    expect(r.x).toEqual(ex(100, '2026-01-01'))
  })
  it('equal weight: newer ISO date wins; missing d counts as oldest', () => {
    expect(mergeExWeights({ local: { exWeights: { x: ex(90, '2026-02-01') } }, server: { exWeights: { x: ex(90, '2026-01-01') } }, mergedWorkouts: [] }).x.d).toBe('2026-02-01')
    expect(mergeExWeights({ local: { exWeights: { x: ex(90) } }, server: { exWeights: { x: ex(90, '2026-01-01') } }, mergedWorkouts: [] }).x.d).toBe('2026-01-01')
  })
  it('floor upgrades a lighter merged entry with the session date, and never creates an id', () => {
    const r = mergeExWeights({ local: { exWeights: { x: ex(80, '2026-01-01') } }, server: { exWeights: { x: ex(80, '2026-01-02') } }, mergedWorkouts: mergedWorkouts })
    expect(r.x).toEqual({ w: 95, d: '2026-01-02' }) // 95 (topW) > 80 → upgraded; date from that session
    const r2 = mergeExWeights({ local: { exWeights: {} }, server: { exWeights: {} }, mergedWorkouts })
    expect(r2).toEqual({})
  })
  it('a deleted custom exercise takes its weight entry away; an unknown non-custom id stays', () => {
    const local = { exWeights: { gone: ex(50, '2026-01-01'), keeper: ex(60, '2026-01-01'), '0001': ex(40, '2026-01-01') }, customEx: [{ id: 'keeper' }] }
    const server = { exWeights: { gone: ex(50, '2026-01-01'), keeper: ex(60, '2026-01-01'), '0001': ex(40, '2026-01-01') }, customEx: [{ id: 'keeper' }] }
    const baseCustomIds = ['gone', 'keeper', '0001']
    const r = mergeExWeights({ local, server, mergedWorkouts: [], baseCustomIds: ['gone', 'keeper'] })
    expect('gone' in r).toBe(false)       // custom deleted on one side → weight dropped
    expect('keeper' in r).toBe(true)
    expect('0001' in r).toBe(true)        // unknown non-custom id is never removed
  })
  it('idempotent and commutative; inputs are not mutated', () => {
    const l = { exWeights: { x: ex(80, '2026-01-01'), y: ex(50, '2026-01-03') } }
    const sv = { exWeights: { x: ex(82, '2026-01-02') } }
    const lCopy = JSON.parse(JSON.stringify(l)), sCopy = JSON.parse(JSON.stringify(sv))
    const ab = mergeExWeights({ local: l, server: sv, mergedWorkouts: [] })
    const ba = mergeExWeights({ local: sv, server: l, mergedWorkouts: [] })
    expect(ab).toEqual(ba)
    expect(mergeExWeights({ local: { exWeights: ab }, server: sv, mergedWorkouts: [] })).toEqual(ab)
    expect(l).toEqual(lCopy)
    expect(sv).toEqual(sCopy)
  })
})

describe('mergeDayPlan per-date (phase 7b)', () => {
  const B = { '2026-11-01': 'r1' }               // base: one override
  const run = (l, s, base = B) => mergeDayPlan({ baseDayPlan: base, local: l, server: s })

  it('different dates union without conflict', () => {
    expect(run({ '2026-11-02': 'r2' }, { '2026-11-03': 'r3' })).toEqual({ '2026-11-02': 'r2', '2026-11-03': 'r3' })
  })
  it('same date, same value → one', () => {
    expect(run({ '2026-11-01': 'r9' }, { '2026-11-01': 'r9' })).toEqual({ '2026-11-01': 'r9' })
  })
  it('deletion on one side + untouched other → deleted', () => {
    expect(run({}, {})).toEqual({})
    expect(run({ '2026-11-05': 'r5' }, { '2026-11-05': 'r5' })).toEqual({ '2026-11-05': 'r5' })
  })
  it('deletion on local + change on server → local deletion wins', () => {
    expect(run({}, { '2026-11-01': 'rNew' })).toEqual({})
  })
  it('change on local + deletion on server → local change wins', () => {
    expect(run({ '2026-11-01': 'rLocal' }, {})).toEqual({ '2026-11-01': 'rLocal' })
  })
  it('both changed, different values → local wins', () => {
    expect(run({ '2026-11-01': 'rA' }, { '2026-11-01': 'rB' })).toEqual({ '2026-11-01': 'rA' })
  })
  it("'rest' behaves like any value", () => {
    expect(run({ '2026-11-01': 'rest' }, B)).toEqual({ '2026-11-01': 'rest' })
  })
  it('inputs are not mutated', () => {
    const l = { '2026-11-02': 'r2' }, s = { '2026-11-01': 'r1' }
    run(l, s)
    expect(l).toEqual({ '2026-11-02': 'r2' })
    expect(s).toEqual({ '2026-11-01': 'r1' })
  })
  it('through mergeStates: both sides changed dayPlan with a snapshot → merged, not conflicted', () => {
    const baseHashes = { unit: hashKey('kg'), dayPlan: hashKey(B) }
    const m = mergeStates({ baseHashes, baseSnap: { dayPlan: B, customIds: [] }, local: { unit: 'kg', dayPlan: { '2026-11-02': 'r2' } }, server: { unit: 'kg', dayPlan: { '2026-11-03': 'r3' } } })
    expect(m.conflicts).toEqual([])
    expect(m.merged.dayPlan).toEqual({ '2026-11-02': 'r2', '2026-11-03': 'r3' })
  })
  it('through mergeStates without a snapshot → old whole-key conflict', () => {
    const baseHashes = { unit: hashKey('kg'), dayPlan: hashKey(B) }
    const m = mergeStates({ baseHashes, local: { unit: 'kg', dayPlan: { '2026-11-02': 'r2' } }, server: { unit: 'kg', dayPlan: { '2026-11-03': 'r3' } } })
    expect(m.conflicts).toEqual(['dayPlan'])
  })
})

describe('withSnap — base snapshot (phase 7b)', () => {
  it('attaches dayPlan and custom ids from the accepted state', () => {
    const st = { dayPlan: { '2026-11-09': 'r1' }, customEx: [{ id: 'c1' }, { id: null }] }
    const b = withSnap({ rev: 4, hashes: {} }, st)
    expect(b.snap).toEqual({ dayPlan: { '2026-11-09': 'r1' }, customIds: ['c1'] })
    expect(b.rev).toBe(4)
  })
  it('drops the snapshot when it would exceed the size cap', () => {
    const big = { dayPlan: {}, customEx: [] }
    for (let i = 0; i < 4000; i++) big.dayPlan['2026-01-' + String(1 + (i % 28)).padStart(2, '0') + '-' + i] = 'r' + i
    const b = withSnap({ rev: 1, hashes: {} }, big)
    expect(b.snap).toBeUndefined()
    expect(b.rev).toBe(1)
  })
  it('a null base stays null and an empty state yields an empty snap', () => {
    expect(withSnap(null, { dayPlan: {} })).toBeNull()
    const b = withSnap({ rev: 1, hashes: {} }, {})
    expect(b.snap).toEqual({ dayPlan: {}, customIds: [] })
  })
  it('the controller hands the accepted state to setBase for snapshotting', async () => {
    let seenState = null
    const deps = {
      getBase: () => null,
      getLocal: () => ({ unit: 'kg' }),
      applyLocal: () => {},
      setBase: (b, st) => { seenState = st },
      send: async () => ({ ok: true, rev: 1 })
    }
    await (await import('./sync-merge.js')).pushWithMerge(deps)
    expect(seenState).toEqual({ unit: 'kg' })
  })
  it('BASE_SNAP_MAX is 50 KB', () => {
    expect(BASE_SNAP_MAX).toBe(50 * 1024)
  })
})

describe('digits state key (phase 6)', () => {
  it('merges like any other top-level key', () => {
    const baseHashes = { unit: hashKey('kg') }
    const local = { unit: 'kg', digits: 'fa' }
    const server = { unit: 'lb' }
    const { conflicts, merged } = mergeStates({ baseHashes, local, server })
    expect(conflicts).toEqual([])
    expect(merged.digits).toBe('fa')
    expect(merged.unit).toBe('lb')
  })
  it('absent on both sides of an old state → no key, old behaviour', () => {
    const baseHashes = { unit: hashKey('kg') }
    const { merged, conflicts } = mergeStates({ baseHashes, local: { unit: 'kg' }, server: { unit: 'lb' } })
    expect(conflicts).toEqual([])
    expect('digits' in merged).toBe(false)
  })
})

describe('resolveMerge', () => {
  it("'server' takes the server's values for the conflicted keys only", () => {
    const server = { unit: 'lb', targetW: 82, restSec: 120 }
    const merged = { unit: 'kg', targetW: 78, restSec: 90 }
    const out = resolveMerge(merged, server, ['targetW'], 'server')
    expect(out.targetW).toBe(82)
    expect(out.unit).toBe('kg') // not a conflict key — stays local
  })
  it("'local' keeps merged as-is", () => {
    const merged = { unit: 'kg' }
    expect(resolveMerge(merged, { unit: 'lb' }, ['unit'], 'local')).toBe(merged)
  })
})

describe('addTombstone / removeTombstone', () => {
  it('records and caps; bodyweight tombstones carry the deletion time', () => {
    const s = {}
    for (let i = 0; i < 1005; i++) addTombstone(s, 'workouts', `w${i}`)
    expect(s.deletedIds.workouts.length).toBe(1000)
    expect(s.deletedIds.workouts[0]).toBe('w5')
    addTombstone(s, 'bodyweight', '2026-11-01')
    expect(s.deletedIds.bodyweight).toEqual([{ d: '2026-11-01', at: expect.any(Number) }])
  })
  it('re-logging a day clears its tombstone', () => {
    const s = { deletedIds: { bodyweight: [{ d: '2026-11-01', at: 1 }, { d: '2026-11-02', at: 2 }] } }
    removeTombstone(s, 'bodyweight', '2026-11-01')
    expect(s.deletedIds.bodyweight).toEqual([{ d: '2026-11-02', at: 2 }])
    removeTombstone(s, 'bodyweight', '2026-11-02')
    expect(s.deletedIds).toBeUndefined() // empty record is dropped entirely
  })
})

describe('pushWithMerge controller', () => {
  const mkDeps = ({ responses, base = null, local = {} }) => {
    const calls = { send: [], applyLocal: [], setBase: [] }
    let i = 0
    let cur = base
    return {
      calls,
      deps: {
        getBase: () => cur,
        getLocal: () => local,
        applyLocal: m => { calls.applyLocal.push(m); Object.assign(local, m) },
        setBase: b => { calls.setBase.push(b); cur = b }, // like the store: localStorage write, read back on retry
        send: async (baseRev, state) => { calls.send.push(baseRev); const r = responses[Math.min(i++, responses.length - 1)]; return typeof r === 'function' ? r(baseRev, state) : r }
      }
    }
  }

  it('clean push records the base and returns the rev', async () => {
    const { deps, calls } = mkDeps({ responses: [{ ok: true, rev: 5 }], local: { unit: 'kg' } })
    const r = await pushWithMerge(deps)
    expect(r.ok).toBe(true)
    expect(r.rev).toBe(5)
    expect(calls.setBase[0]).toEqual({ rev: 5, hashes: hashesOf({ unit: 'kg' }) })
  })

  it('a legacy server without rev pins rev null and never sends baseRev', async () => {
    const { deps, calls } = mkDeps({ responses: [{ ok: true }, { ok: true }], local: { unit: 'kg' } })
    await pushWithMerge(deps)
    expect(calls.setBase[0].rev).toBeNull()
    await pushWithMerge(deps)
    expect(calls.send[1]).toBeNull() // no baseRev → old LWW behavior on the wire
  })

  it('409 → clean merge → retry succeeds with the server rev', async () => {
    const B = { unit: 'kg', targetW: 80 }
    const base = { rev: 4, hashes: hashesOf(B) }
    const local = { ...B, targetW: 78 }             // local touched targetW
    const serverState = { rev: 5, ...B, restSec: 120 } // server touched restSec, rev 5
    const { deps, calls } = mkDeps({
      base,
      local,
      responses: [
        { ok: false, rev: 5, state: serverState },
        (baseRev) => { expect(baseRev).toBe(5); return { ok: true, rev: 6 } }
      ]
    })
    const r = await pushWithMerge(deps)
    expect(r.ok).toBe(true)
    expect(r.rev).toBe(6)
    expect(calls.applyLocal.length).toBe(1)
    expect(calls.applyLocal[0].restSec).toBe(120)   // server's change arrived
    expect(calls.applyLocal[0].targetW).toBe(78)    // local kept
    expect(calls.send[0]).toBe(4)
  })

  it('409 with a real conflict → returned to the caller, nothing retried', async () => {
    const B = { targetW: 80 }
    const base = { rev: 4, hashes: hashesOf(B) }
    const { deps, calls } = mkDeps({
      base,
      local: { ...B, targetW: 78 },
      responses: [{ ok: false, rev: 5, state: { rev: 5, ...B, targetW: 82 } }]
    })
    const r = await pushWithMerge(deps)
    expect(r.ok).toBe(false)
    expect(r.conflict).toBe(true)
    expect(r.conflicts).toEqual(['targetW'])
    expect(r.serverRev).toBe(5)
    expect(calls.applyLocal.length).toBe(0)
  })

  it('gives up after three clean-merge retries, then reports exhaustion', async () => {
    const B = { unit: 'kg' }
    const base = { rev: 1, hashes: hashesOf(B) }
    let n = 0
    const { deps, calls } = mkDeps({
      base,
      local: { ...B },
      responses: [() => ({ ok: false, rev: 2 + (n++), state: { rev: 2 + n, ...B } })] // always clean-mergeable
    })
    const r = await pushWithMerge(deps)
    expect(r.ok).toBe(false)
    expect(r.failed).toBe(true)
    expect(r.exhausted).toBe(true)
    expect(calls.send.length).toBe(PUSH_MAX_RETRIES + 1)
  })

  it('two devices, different dayPlan days + both changed exWeights → merges cleanly, no conflict sheet', async () => {
    const B = { unit: 'kg', dayPlan: {}, exWeights: {} }
    const base = { rev: 7, hashes: hashesOf(B), snap: { dayPlan: B.dayPlan, customIds: [] } }
    const local = { ...B, dayPlan: { '2026-11-10': 'rA' }, exWeights: { squat: { w: 120, d: '2026-11-10' } } }
    const serverState = { rev: 8, unit: 'kg', dayPlan: { '2026-11-11': 'rB' }, exWeights: { bench: { w: 80, d: '2026-11-11' } } }
    let applied = null
    const responses = [
      { ok: false, rev: 8, state: serverState },
      () => ({ ok: true, rev: 9 })
    ]
    let i = 0
    const deps = {
      getBase: () => base,
      getLocal: () => local,
      applyLocal: m => { applied = m },
      setBase: () => {},
      send: async () => { const r = responses[i++]; return typeof r === 'function' ? r() : r }
    }
    const r = await (await import('./sync-merge.js')).pushWithMerge(deps)
    expect(r.ok).toBe(true)
    expect(applied.dayPlan).toEqual({ '2026-11-10': 'rA', '2026-11-11': 'rB' })
    expect(applied.exWeights).toEqual({ squat: { w: 120, d: '2026-11-10' }, bench: { w: 80, d: '2026-11-11' } })
  })

  it('a thrown send (offline) reports failure', async () => {
    const { deps } = mkDeps({ responses: [() => { throw new Error('offline') }] })
    const r = await pushWithMerge(deps)
    expect(r.ok).toBe(false)
    expect(r.failed).toBe(true)
    expect(r.error.message).toBe('offline')
  })
})
