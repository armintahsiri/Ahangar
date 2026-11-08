import { create } from 'zustand'
import { api } from '../lib/api.js'
import { localTZ } from '../lib/format.js'
import { registerCustom } from '../lib/exercises.js'
import { DEMO, DEMO_SEEDED } from '../lib/demo.js'
import { MOBILE, nativeLoad, nativeSave, syncReminder } from '../lib/mobile.js'
import { nextSync } from '../lib/sync-status.js'
import {
  pushWithMerge, mergeStates, normalizeState, topLevelHashes, withNewEpoch, resolveMerge
} from '../lib/sync-merge.js'

const KEY = 'gym_state_v1'
const BASE_KEY = 'gym_sync_base'        // {rev, hashes} — the last state both sides agreed on
const DISCARD_KEY = 'gym_conflict_backup' // the version set aside at the last conflict resolution
export const DEF = {
  unit: 'kg', restSec: 90, sound: true, keepAwake: true, lang: 'en',
  theme: 'dark', accent: 'lime', body: 'male', targetW: null,
  bodyweight: [], routines: [], week: {}, dayPlan: {},
  exWeights: {}, workouts: [], active: null, customEx: [], gifSize: 'full',
  // effort: which per-set effort scale is logged — 'none' | 'rir' | 'rpe'. null, not 'none', so
  // that a profile which never chose (loaded state is overlaid on DEF, on every path: local,
  // server pull, backup import) still falls back to the `showRir` boolean this replaced and
  // keeps the column it had. See effortOf.
  reminder: { on: false, time: '08:00', tz: null }, effort: null
}
const clone = o => JSON.parse(JSON.stringify(o))

function loadState() {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return Object.assign(clone(DEF), JSON.parse(raw))
  } catch (e) { /* ignore */ }
  return clone(DEF)
}

const hasData = st => !!((st.workouts || []).length || (st.routines || []).length || (st.bodyweight || []).length)

// The sync base: what the server held at the last successful push/pull. Kept out of the
// synced state on purpose — it is this device's merge ancestry, never user data.
const readSyncBase = () => { try { return JSON.parse(localStorage.getItem(BASE_KEY)) || null } catch { return null } }
const writeSyncBase = b => { try { localStorage.setItem(BASE_KEY, JSON.stringify(b)) } catch { /* quota — merge falls back to LWW */ } }
// The server view (GET shape) normalized — exactly how its stored copy normalizes.
const pinBase = (rev, state) => writeSyncBase({ rev: rev ?? null, hashes: topLevelHashes(normalizeState(state)) })
// The version set aside the last time a conflict was resolved (Settings can restore it).
export const readDiscardedBackup = () => { try { return JSON.parse(localStorage.getItem(DISCARD_KEY)) || null } catch { return null } }

// Older sample-data versions forced a workout onto today's rest day. Remove that
// one generated override from existing sample profiles once, while preserving any
// other day changes the user may have made.
function clearLegacySampleReschedule(state) {
  if (!state || state.sampleSeedVersion || state.targetW !== 77 || state.effort !== 'rir') return false
  const routines = state.routines || []
  const push = routines.find(r => r.name === 'Push Day')
  const pull = routines.find(r => r.name === 'Pull Day')
  const legs = routines.find(r => r.name === 'Leg Day')
  const workouts = state.workouts || []
  const bodyweight = state.bodyweight || []
  const overrides = Object.keys(state.dayPlan || {})
  if (!push || !pull || !legs || workouts.length < 20 || bodyweight.length < 15 || overrides.length !== 1) return false

  const [iso] = overrides
  const day = new Date(iso + 'T12:00:00').getDay()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || state.week?.[day] || workouts.some(w => w.d === iso)) return false

  // This is the exact fallback the old seed used: rotate from the latest
  // Push/Pull/Leg session and assign it only to the current unplanned day.
  const lastName = workouts[workouts.length - 1]?.name
  const order = [push, pull, legs]
  const lastIndex = order.findIndex(r => r.name === lastName)
  const expected = order[(lastIndex + 1) % order.length]
  if (lastIndex < 0 || state.dayPlan[iso] !== expected.id) return false
  delete state.dayPlan[iso]
  return true
}

// The assignment comes from the coach-owned server record, never from the member's saved
// profile. Re-apply it even when the member's local workout history is newer than the server.
export function withCoachProgram(base, remote) {
  const next = clone(base)
  const oldIds = new Set((next.routines || []).filter(r => r.coachManaged).map(r => r.id))
  const assigned = (remote?.routines || []).filter(r => r.coachManaged)
  next.routines = [...(next.routines || []).filter(r => !r.coachManaged), ...assigned]
  const week = { ...(next.week || {}) }
  for (const [day, id] of Object.entries(week)) if (oldIds.has(id)) delete week[day]
  Object.assign(week, remote?.coachProgram?.week || {})
  next.week = week
  next.coachProgram = remote?.coachProgram || null
  return next
}

export const useStore = create((set, get) => {
  let pushTm = null
  let saveTm = null

  // Mobile build: mirror the state into a file in the app's data directory (survives WebView
  // storage eviction) and keep the native reminder schedule in step with the weekly plan.
  const nativePersist = () => {
    clearTimeout(saveTm)
    saveTm = setTimeout(() => { saveTm = null; nativeSave(get().S); syncReminder(get().S) }, 800)
  }

  const persist = (S, push = true) => {
    S._ts = Date.now()
    registerCustom(S.customEx)
    // QuotaExceeded must never take the calling handler down: the change stays in memory,
    // storageError flags it for the UI, and the next successful write clears the flag.
    let storageError = false
    try { localStorage.setItem(KEY, JSON.stringify(S)) }
    catch (e) { storageError = true; console.warn('openGym: could not write local state', e) }
    const sync = push && get().user ? nextSync(get().sync, { type: 'edit' }) : get().sync
    set({ S, storageError, sync })
    if (MOBILE) nativePersist()
    if (push && get().user) {
      clearTimeout(pushTm)
      pushTm = setTimeout(() => get().pushState(), 1500)
    }
  }

  // A setting changed right before switching away/closing the tab must not get lost mid-debounce
  // (e.g. setting the reminder time then immediately backgrounding to test it). On mobile the
  // same applies to the file mirror — backgrounding is often the last thing before the OS
  // kills the app.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return
    if (MOBILE && saveTm) {
      clearTimeout(saveTm)
      saveTm = null
      nativeSave(get().S)
    }
    if (pushTm) {
      clearTimeout(pushTm)
      pushTm = null
      get().pushState()
    }
  })

  // Everything a sign-out leaves behind on this device, whichever way it was triggered.
  const clearLocalSession = () => {
    get().setUser(null)
    localStorage.removeItem('gym_guest')
    localStorage.removeItem('gym_dirty')
    localStorage.removeItem(KEY)
    localStorage.removeItem(BASE_KEY)
    localStorage.removeItem(DISCARD_KEY)
    set({ sync: nextSync(null, { type: 'reset' }), storageError: false, syncConflict: null })
    persist(clone(DEF), false)
  }

  return {
    S: (() => { const s = loadState(); registerCustom(s.customEx); return s })(),
    user: (() => { try { return JSON.parse(localStorage.getItem('gym_user')) || null } catch { return null } })(),
    clubName: 'openGym',
    ready: false,
    // sync lives outside S on purpose — it is this device's connection state, never user
    // data, so it is neither persisted locally nor pushed to the server.
    sync: { status: 'idle', at: null },
    storageError: false,
    // parked 409 details while the conflict sheet waits for a decision (non-persistent)
    syncConflict: null,

    // Mutate a draft of S via producer fn, then persist + schedule sync.
    update(mut, push = true) {
      const S = clone(get().S)
      mut(S)
      persist(S, push)
    },
    replaceState(S, push = false) { persist(clone(S), push) },

    isGuest: () => localStorage.getItem('gym_guest') === '1',
    setGuest(v) { if (v) localStorage.setItem('gym_guest', '1'); else localStorage.removeItem('gym_guest'); set({}) },

    setUser(u) {
      if (u) { localStorage.setItem('gym_user', JSON.stringify(u)); localStorage.removeItem('gym_guest') }
      else localStorage.removeItem('gym_user')
      set({ user: u })
    },

    // Push through the merge controller: a 409 hands us the server's view, a clean merge is
    // applied and retried (up to 3×), a real conflict parks in syncConflict for the sheet.
    async pushState() {
      if (!get().user) return
      clearTimeout(pushTm)
      set({ sync: nextSync(get().sync, { type: 'send' }) })
      const r = await pushWithMerge({
        getBase: readSyncBase,
        getLocal: () => get().S,
        // the in-progress workout never leaves this device; coach-owned content is
        // re-injected from the server view the merge just came back with
        applyLocal: (merged, serverState) => {
          const next = withCoachProgram(clone(merged), serverState)
          const a = get().S.active
          if (a) next.active = a
          persist(next, false)
        },
        setBase: writeSyncBase,
        send: async (baseRev, state) => {
          const body = { state }
          if (baseRev != null) body.baseRev = baseRev
          try {
            const resp = await api('/api/data', { method: 'PUT', body: JSON.stringify(body) })
            return { ok: true, rev: resp.rev }
          } catch (e) {
            if (e.status === 409 && e.data?.state) return { ok: false, rev: e.data.rev, state: e.data.state }
            throw e
          }
        }
      })
      if (r.ok) {
        localStorage.removeItem('gym_dirty')
        set({ sync: nextSync(get().sync, { type: 'success', at: Date.now() }) })
      } else if (r.conflict) {
        localStorage.setItem('gym_dirty', '1')
        set({ sync: nextSync(get().sync, { type: 'conflict' }), syncConflict: r })
      } else {
        localStorage.setItem('gym_dirty', '1')
        set({ sync: nextSync(get().sync, { type: 'failure', at: Date.now() }) })
      }
    },
    async pullState() {
      try {
        const { state: serverRaw } = await api('/api/data')
        const S = get().S
        const dirty = localStorage.getItem('gym_dirty') === '1'
        const base = readSyncBase()
        const adopt = raw => {
          const active = S.active
          const next = withCoachProgram(Object.assign(clone(DEF), raw), raw)
          if (active) next.active = active
          persist(next, false)
          set({ sync: nextSync(get().sync, { type: 'pull', at: Date.now() }) })
        }
        if (!serverRaw) { persist(withCoachProgram(S, serverRaw), false); return }
        const serverRev = typeof serverRaw.rev === 'number' ? serverRaw.rev : null
        // Without a pinned base (first run after this update, a fresh sign-in) or without a
        // rev-speaking server, the old _ts policy stands — then the base gets pinned.
        if (!base || serverRev == null || base.rev == null) {
          if (serverRaw && (!hasData(S) || ((serverRaw._ts || 0) >= (S._ts || 0) && !dirty))) {
            adopt(serverRaw)
            pinBase(serverRev, serverRaw)
          } else if (hasData(S)) {
            persist(withCoachProgram(S, serverRaw), false)
            await get().pushState()
          } else {
            persist(withCoachProgram(S, serverRaw), false)
            pinBase(serverRev, serverRaw)
          }
          return
        }
        if (!dirty) {
          if (serverRev > base.rev) {
            adopt(serverRaw)
            pinBase(serverRev, serverRaw)
          }
          return
        }
        // Dirty: instead of the old "local always wins", merge over the pinned base so the
        // other device's work and this device's offline queue both survive.
        const m = mergeStates({ baseHashes: base.hashes, local: S, server: serverRaw })
        if (m.epochConflict || m.conflicts.length) {
          set({
            sync: nextSync(get().sync, { type: 'conflict' }),
            syncConflict: { conflicts: m.conflicts, epochConflict: m.epochConflict, serverState: serverRaw, serverRev, merged: m.merged }
          })
          return
        }
        const a = S.active
        // coach-owned content rides back in from the server view before anything persists
        const next = withCoachProgram(clone(m.merged), serverRaw)
        if (a) next.active = a
        persist(next, false)
        pinBase(serverRev, m.merged)
        localStorage.removeItem('gym_dirty')
        await get().pushState()
      } catch (e) { /* offline — keep local */ }
    },

    async signOut() {
      try { await get().pushState(); await api('/api/logout', { method: 'POST', body: '{}' }) } catch (e) { /* */ }
      clearLocalSession()
    },

    // "Sign out everywhere": the server bumps this profile's session version, which kills every
    // session it has on any device — this browser included, so the app has to end up exactly
    // where a normal signOut leaves it. Unlike signOut the request is NOT swallowed: if it fails
    // the sessions elsewhere are all still valid, and wiping this device's copy of the data
    // would sign the user out of the one place the bump didn't reach. Caller reports the error.
    async signOutAll() {
      await get().pushState()   // never throws — stores gym_dirty and moves on when offline
      await api('/api/logout/all', { method: 'POST', body: '{}' })
      clearLocalSession()
    },

    // Demo build only: drop the seeded example profile back in (Settings → "Reset demo data").
    // Dynamic import so the generator never ships in a self-hosted bundle.
    async resetDemo() {
      const { buildDemoState } = await import('../lib/demoSeed.js')
      localStorage.removeItem('gym_dirty')
      persist(Object.assign(clone(DEF), buildDemoState()), false)
    },

    // The conflict sheet's decision. Whichever version loses is stashed on this device
    // (Settings can restore it); the winner is applied and pushed over the server rev.
    resolveConflict(choice) {
      const info = get().syncConflict
      if (!info) return
      const loser = choice === 'local' ? info.serverState : get().S
      try { localStorage.setItem(DISCARD_KEY, JSON.stringify({ at: Date.now(), state: loser })) } catch { /* best effort */ }
      let winner
      if (info.epochConflict) winner = choice === 'local' ? clone(get().S) : clone(info.serverState)
      else {
        const base = resolveMerge(clone(info.merged), info.serverState, info.conflicts, choice)
        winner = withCoachProgram(base, info.serverState)
      }
      const a = get().S.active
      if (a) winner.active = a
      writeSyncBase({ rev: info.serverRev ?? null, hashes: topLevelHashes(normalizeState(winner)) })
      persist(clone(winner), false)
      set({ syncConflict: null })
      get().pushState()
    },

    // Settings → restore the version that was set aside at the last conflict resolution.
    restoreDiscarded(backup) {
      if (!backup?.state) return
      const a = get().S.active
      const next = clone(backup.state)
      if (a) next.active = a
      writeSyncBase({ rev: readSyncBase()?.rev ?? null, hashes: topLevelHashes(normalizeState(next)) })
      persist(next, false)
      try { localStorage.removeItem(DISCARD_KEY) } catch { /* fine */ }
      get().pushState()
    },

    // Load a realistic example training history into a self-hosted profile on request.
    async loadSampleData() {
      const { buildDemoState } = await import('../lib/demoSeed.js')
      const current = get().S
      const preferences = {
        lang: current.lang, unit: current.unit, theme: current.theme,
        accent: current.accent, sound: current.sound, keepAwake: current.keepAwake
      }
      // a full replace: stamp a new epoch so other devices conflict instead of auto-merging
      persist(withNewEpoch(Object.assign(clone(DEF), buildDemoState(), preferences)), true)
    },

    // Boot: ask the server who we are, then pull.
    async boot() {
      // Mobile build: no backend either — restore from the file mirror (the durable copy;
      // localStorage may have been evicted since the last run) and go straight in.
      if (MOBILE) {
        const saved = await nativeLoad()
        const S = get().S
        if (saved && (!hasData(S) || (saved._ts || 0) >= (S._ts || 0))) {
          persist(Object.assign(clone(DEF), saved), false)
        } else if (hasData(S)) {
          nativeSave(S)   // first run after an update from a file-less version: seed the mirror
        }
        get().setGuest(true)
        syncReminder(get().S)
        set({ ready: true })
        return
      }
      // Demo build (GitHub Pages): no backend at all — seed once, stay in guest mode.
      if (DEMO) {
        if (!localStorage.getItem(DEMO_SEEDED)) {
          localStorage.setItem(DEMO_SEEDED, '1')
          await get().resetDemo()
        }
        get().setGuest(true)
        set({ ready: true })
        return
      }
      // Guest mode is web-demo/native-only; a stale flag from an older web build must not linger.
      localStorage.removeItem('gym_guest')
      try {
        const config = await api('/api/config')
        set({ clubName: config.club_name || 'openGym' })
      } catch (e) { /* keep the default brand while the server is unavailable */ }
      try {
        const me = await api('/api/me')
        get().setUser(me.user)
        await get().pullState()
        // Re-stamp the reminder's timezone on every load — keeps it correct if you're travelling,
        // without needing to revisit Settings.
        const tz = localTZ()
        if (get().S.reminder?.on && get().S.reminder.tz !== tz) {
          get().update(s => { s.reminder = { ...s.reminder, tz } })
        }
      } catch (e) {
        if (e.status === 401) {
          get().setUser(null)
          set({ sync: nextSync(null, { type: 'reset' }) })
        }
      }
      const current = clone(get().S)
      if (clearLegacySampleReschedule(current)) get().replaceState(current, true)
      set({ ready: true })
    }
  }
})

export { hasData }
