import { describe, it, expect, vi } from 'vitest'
import {
  hashKey, topLevelHashes, normalizeState, mergeStates, resolveMerge,
  pushWithMerge, addTombstone, removeTombstone, withNewEpoch, PUSH_MAX_RETRIES
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

  it('a thrown send (offline) reports failure', async () => {
    const { deps } = mkDeps({ responses: [() => { throw new Error('offline') }] })
    const r = await pushWithMerge(deps)
    expect(r.ok).toBe(false)
    expect(r.failed).toBe(true)
    expect(r.error.message).toBe('offline')
  })
})
