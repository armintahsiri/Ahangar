// API integration tests — node:test + fetch, temp DATA_DIR (never the real ./data).
// `node --test` runs each test file in its own process, so the single in-process server
// below boots from a fresh temp directory with a hand-seeded db.json. Suites that need a
// different env (invite-only) or process exit (corrupt db) spawn their own child servers.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/* ---------- temp data dir, seeded before server.js is imported ---------- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-api-test-'))
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* already gone */ } })

function pwRecord(pw) {
  const salt = crypto.randomBytes(16)
  return { salt: salt.toString('base64url'), hash: crypto.scryptSync(pw, salt, 64).toString('base64url') }
}
function seedDb(dir) {
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
    users: [
      { id: 'u-admin', name: 'Owner', phone: '+989120000001', password: pwRecord('adminpass123'), created: new Date().toISOString() },
      { id: 'u-admin2', name: 'Co-Owner', phone: '+989120000002', password: pwRecord('adminpass123'), created: new Date().toISOString() }
    ],
    creds: [], subs: [], invites: [], coachLinks: [], coachAssignments: []
  }))
}
seedDb(TMP)
process.env.DATA_DIR = TMP
process.env.ADMIN_UIDS = 'u-admin,u-admin2'
// INVITE_ONLY stays off for the shared in-process server; the invite suite spawns its own child.

const { createServer, reminderDue } = await import('./server.js')
const server = createServer()
await new Promise(resolve => server.listen(0, resolve))
const BASE = `http://127.0.0.1:${server.address().port}`
after(() => {
  server.closeAllConnections?.()
  return new Promise(resolve => server.close(resolve))
})

/* ---------- helpers ---------- */
let phoneSeq = 0
const nextPhone = () => '+989130' + String(100000 + ++phoneSeq)

async function call(method, url, { body, token, base = BASE } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { cookie: `gymsid=${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  let json = null
  try { json = await res.json() } catch { /* no body */ }
  const fresh = (res.headers.get('set-cookie') || '').match(/gymsid=([^;]*)/)?.[1] || null
  return { status: res.status, json, token: fresh }
}

async function registerUser(name, password = 'password123') {
  const phone = nextPhone()
  const r = await call('POST', '/api/register', { body: { name, phone, password } })
  assert.equal(r.status, 200, `register ${name}: ${JSON.stringify(r.json)}`)
  return { id: r.json.user.id, phone, password, token: r.token }
}

let adminToken = null
async function admin() {
  if (!adminToken) {
    const r = await call('POST', '/api/login', { body: { phone: '+989120000001', password: 'adminpass123' } })
    assert.equal(r.status, 200, 'admin login failed')
    adminToken = r.token
  }
  return adminToken
}

/* ---------- auth ---------- */
test('auth.register-login-flow', async () => {
  const u = await registerUser('Alice')
  const me = await call('GET', '/api/me', { token: u.token })
  assert.equal(me.status, 200)
  assert.equal(me.json.user.name, 'Alice')
  assert.equal(me.json.user.phone, u.phone)
  const bad = await call('POST', '/api/login', { body: { phone: u.phone, password: 'wrong-password' } })
  assert.equal(bad.status, 401)
  const good = await call('POST', '/api/login', { body: { phone: u.phone, password: u.password } })
  assert.equal(good.status, 200)
  assert.ok(good.token)
})

test('auth.login-throttle: 11 wrong attempts hit 429', async () => {
  const u = await registerUser('Throttled')
  for (let i = 0; i < 10; i++) {
    const r = await call('POST', '/api/login', { body: { phone: u.phone, password: `nope-${i}` } })
    assert.equal(r.status, 401, `attempt ${i + 1}`)
  }
  const blocked = await call('POST', '/api/login', { body: { phone: u.phone, password: 'nope-11' } })
  assert.equal(blocked.status, 429)
})

test('auth.disabled-account-locked-everywhere', async () => {
  const at = await admin()
  const u = await registerUser('Disabled Dave')
  assert.equal((await call('POST', '/api/admin/user/disable', { token: at, body: { id: u.id, disabled: true } })).status, 200)
  // the existing cookie dies with the flag, on every endpoint that reads a session
  assert.equal((await call('GET', '/api/me', { token: u.token })).status, 401)
  assert.equal((await call('GET', '/api/data', { token: u.token })).status, 401)
  assert.equal((await call('POST', '/api/login', { body: { phone: u.phone, password: u.password } })).status, 403)
  assert.equal((await call('POST', '/api/admin/user/disable', { token: at, body: { id: u.id, disabled: false } })).status, 200)
  assert.equal((await call('POST', '/api/login', { body: { phone: u.phone, password: u.password } })).status, 200)
})

test('auth.logout-all-invalidates-old-cookie', async () => {
  const u = await registerUser('Carol')
  const second = await call('POST', '/api/login', { body: { phone: u.phone, password: u.password } })
  assert.equal(second.status, 200)
  assert.equal((await call('POST', '/api/logout/all', { token: u.token, body: {} })).status, 200)
  assert.equal((await call('GET', '/api/me', { token: u.token })).status, 401)
  assert.equal((await call('GET', '/api/me', { token: second.token })).status, 401)
  const fresh = await call('POST', '/api/login', { body: { phone: u.phone, password: u.password } })
  assert.equal(fresh.status, 200)
  assert.equal((await call('GET', '/api/me', { token: fresh.token })).status, 200)
})

/* ---------- invites (needs INVITE_ONLY — own child server) ---------- */
test('register.invite-required-and-burned', { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-api-invite-'))
  seedDb(dir)
  const child = spawn(process.execPath, [path.join(HERE, 'server.js')], {
    cwd: HERE,
    env: { ...process.env, DATA_DIR: dir, PORT: '0', INVITE_ONLY: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  try {
    const port = await new Promise((resolve, reject) => {
      let buf = ''
      child.stdout.on('data', d => { buf += d; const m = buf.match(/gym-api on :(\d+)/); if (m) resolve(+m[1]) })
      child.stderr.on('data', d => { buf += d })
      child.on('exit', code => reject(new Error(`server exited early: ${code}\n${buf}`)))
    })
    const B = `http://127.0.0.1:${port}`
    const c = async (method, url, opt = {}) => {
      const res = await fetch(B + url, {
        method,
        headers: { 'Content-Type': 'application/json', ...(opt.token ? { cookie: `gymsid=${opt.token}` } : {}) },
        body: opt.body === undefined ? undefined : JSON.stringify(opt.body)
      })
      const json = await res.json().catch(() => null)
      return { status: res.status, json, token: (res.headers.get('set-cookie') || '').match(/gymsid=([^;]*)/)?.[1] || null }
    }
    const phone = nextPhone()
    assert.equal((await c('POST', '/api/register', { body: { name: 'NoCode', phone, password: 'password123' } })).status, 403)
    assert.equal((await c('POST', '/api/register', { body: { name: 'BadCode', phone, password: 'password123', code: 'NOTACODE' } })).status, 403)
    const at = (await c('POST', '/api/login', { body: { phone: '+989120000001', password: 'adminpass123' } })).token
    assert.ok(at)
    const inv = await c('POST', '/api/admin/invites/new', { token: at, body: {} })
    assert.equal(inv.status, 200)
    const code = inv.json.invite.code
    assert.equal((await c('POST', '/api/register', { body: { name: 'Invited', phone, password: 'password123', code } })).status, 200)
    // the burned code cannot register a second account
    assert.equal((await c('POST', '/api/register', { body: { name: 'Again', phone: nextPhone(), password: 'password123', code } })).status, 403)
    // a revoked invite is dead too
    const code2 = (await c('POST', '/api/admin/invites/new', { token: at, body: {} })).json.invite.code
    assert.equal((await c('POST', '/api/admin/invites/revoke', { token: at, body: { code: code2 } })).status, 200)
    assert.equal((await c('POST', '/api/register', { body: { name: 'Revoked', phone: nextPhone(), password: 'password123', code: code2 } })).status, 403)
  } finally {
    child.kill('SIGTERM')
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* fine */ }
  }
})

/* ---------- data sync ---------- */
test('data.put-rejects-coach-managed-and-active', async () => {
  const u = await registerUser('Sync Dave')
  const put = await call('PUT', '/api/data', { token: u.token, body: { state: {
    unit: 'kg', workouts: [],
    routines: [
      { id: 'r-mine', name: 'Mine', ex: [] },
      { id: 'r-ghost', name: 'Ghost', coachManaged: true, ex: [] }
    ],
    active: { id: 'w1', entries: [] },
    coachProgram: { coach: { id: 'x', name: 'X' }, week: {} }
  } } })
  assert.equal(put.status, 200)
  const get = await call('GET', '/api/data', { token: u.token })
  assert.equal(get.status, 200)
  const st = get.json.state
  assert.ok(st.routines.some(r => r.id === 'r-mine'))
  assert.ok(!st.routines.some(r => r.id === 'r-ghost'), 'coachManaged routine must be dropped')
  assert.equal(st.active, undefined, 'active workout stays device-local')
  assert.equal(st.coachProgram, undefined, 'coach assignment is never accepted from a member client')
})

/* ---------- coach ---------- */
test('coach.isolated-between-coaches', async () => {
  const at = await admin()
  const a = await registerUser('Coach A')
  const b = await registerUser('Coach B')
  const ma = await registerUser('Member A')
  const mb = await registerUser('Member B')
  for (const c of [a, b]) {
    assert.equal((await call('POST', '/api/admin/user/role', { token: at, body: { id: c.id, role: 'coach' } })).status, 200)
  }
  assert.equal((await call('POST', '/api/admin/user/coach', { token: at, body: { id: ma.id, coachId: a.id } })).status, 200)
  assert.equal((await call('POST', '/api/admin/user/coach', { token: at, body: { id: mb.id, coachId: b.id } })).status, 200)
  // Coach A reads their own member…
  assert.equal((await call('GET', `/api/coach/client?id=${encodeURIComponent(ma.id)}`, { token: a.token })).status, 200)
  // …but cannot read or assign Coach B's member
  assert.equal((await call('GET', `/api/coach/client?id=${encodeURIComponent(mb.id)}`, { token: a.token })).status, 404)
  assert.equal((await call('PUT', '/api/coach/assignment', { token: a.token, body: {
    memberId: mb.id,
    routines: [{ id: 'ra1', name: 'A Plan', ex: [{ id: '0025', sets: 3 }] }],
    week: { '1': 'ra1' }
  } })).status, 404)
  // and a plain member gets nothing at all
  assert.equal((await call('GET', '/api/coach/clients', { token: ma.token })).status, 403)
})

test('coach.assignment-validation', async () => {
  const at = await admin()
  const a = await registerUser('Coach V')
  const m = await registerUser('Member V')
  await call('POST', '/api/admin/user/role', { token: at, body: { id: a.id, role: 'coach' } })
  await call('POST', '/api/admin/user/coach', { token: at, body: { id: m.id, coachId: a.id } })
  const put = body => call('PUT', '/api/coach/assignment', { token: a.token, body: { memberId: m.id, ...body } })
  // more than 40 routines
  assert.equal((await put({ routines: Array.from({ length: 41 }, (_, i) => ({ id: `r${i}`, name: 'R', ex: [] })), week: {} })).status, 400)
  // duplicate routine ids
  assert.equal((await put({ routines: [{ id: 'dup', name: 'A', ex: [] }, { id: 'dup', name: 'B', ex: [] }], week: {} })).status, 400)
  // an exercise entry without an id
  assert.equal((await put({ routines: [{ id: 'r1', name: 'R', ex: [{}] }], week: {} })).status, 400)
  // weekday outside 0-6
  assert.equal((await put({ routines: [{ id: 'r1', name: 'R', ex: [] }], week: { '7': 'r1' } })).status, 400)
  // week references a routine that was not sent
  assert.equal((await put({ routines: [{ id: 'r1', name: 'R', ex: [] }], week: { '1': 'nope' } })).status, 400)
  // valid: version starts at 1 and increments
  const good = await put({ routines: [{ id: 'r1', name: 'Plan', ex: [{ id: '0025', sets: 3 }] }], week: { '1': 'r1' } })
  assert.equal(good.status, 200)
  assert.equal(good.json.assignment.version, 1)
  const good2 = await put({ routines: [{ id: 'r1', name: 'Plan', ex: [{ id: '0025', sets: 4 }] }], week: { '1': 'r1' } })
  assert.equal(good2.json.assignment.version, 2)
  // clearing the program removes the assignment
  const cleared = await put({ routines: [], week: {} })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.json.assignment, null)
})

/* ---------- admin guards ---------- */
test('admin.role-guards', async () => {
  const at = await admin()
  const plain = await registerUser('Plain')
  // a member cannot even list users
  assert.equal((await call('GET', '/api/admin/users', { token: plain.token })).status, 403)
  // admins cannot be disabled, self-demoted, or (for env admins) demoted at all
  assert.equal((await call('POST', '/api/admin/user/disable', { token: at, body: { id: 'u-admin', disabled: true } })).status, 400)
  assert.equal((await call('POST', '/api/admin/user/admin', { token: at, body: { id: 'u-admin', admin: false } })).status, 400)
  assert.equal((await call('POST', '/api/admin/user/admin', { token: at, body: { id: 'u-admin2', admin: false } })).status, 400)
  // an API-promoted admin can be promoted and demoted
  const tmp = await registerUser('Temp Admin')
  assert.equal((await call('POST', '/api/admin/user/admin', { token: at, body: { id: tmp.id, admin: true } })).status, 200)
  assert.equal((await call('POST', '/api/admin/user/admin', { token: at, body: { id: tmp.id, admin: false } })).status, 200)
  // password reset refuses admins outright
  assert.equal((await call('POST', '/api/admin/user/password', { token: at, body: { id: 'u-admin2', password: 'newpassword9' } })).status, 400)
})

test('admin.password-reset-bumps-sv', async () => {
  const at = await admin()
  const u = await registerUser('Reset Me')
  assert.equal((await call('POST', '/api/admin/user/password', { token: at, body: { id: u.id, password: 'fresh-password1' } })).status, 200)
  // the pre-reset cookie is dead (session version bumped)
  assert.equal((await call('GET', '/api/me', { token: u.token })).status, 401)
  assert.equal((await call('POST', '/api/login', { body: { phone: u.phone, password: u.password } })).status, 401)
  const fresh = await call('POST', '/api/login', { body: { phone: u.phone, password: 'fresh-password1' } })
  assert.equal(fresh.status, 200)
  assert.equal((await call('GET', '/api/me', { token: fresh.token })).status, 200)
})

/* ---------- storage hardening ---------- */
test('state.atomic-write-mode-0600', async () => {
  const u = await registerUser('Mode Check')
  assert.equal((await call('PUT', '/api/data', { token: u.token, body: { state: { unit: 'kg', workouts: [], routines: [] } } })).status, 200)
  // temp file was 0600 + fsynced, so the renamed file is owner-only — matching secret/vapid
  assert.equal((fs.statSync(path.join(TMP, `state-${u.id}.json`)).mode & 0o777).toString(8), '600')
  // db.json was rewritten by every registration on the way here — same rule
  assert.equal((fs.statSync(path.join(TMP, 'db.json')).mode & 0o777).toString(8), '600')
})

test('state.corrupt-state-not-overwritten', async () => {
  const u = await registerUser('Corrupt Me')
  assert.equal((await call('PUT', '/api/data', { token: u.token, body: { state: { unit: 'kg', workouts: [], routines: [] } } })).status, 200)
  const file = path.join(TMP, `state-${u.id}.json`)
  fs.writeFileSync(file, '{oops', { mode: 0o600 })
  // reads and writes both refuse; the broken file is snapshotted, never replaced
  assert.equal((await call('GET', '/api/data', { token: u.token })).status, 500)
  assert.equal((await call('PUT', '/api/data', { token: u.token, body: { state: { unit: 'kg', workouts: [], routines: [] } } })).status, 500)
  assert.equal(fs.readFileSync(file, 'utf8'), '{oops')
  assert.ok(fs.readdirSync(TMP).some(f => f.startsWith(`state-${u.id}.json.corrupt-`)), 'corrupt snapshot missing')
})

test('reminder.skips-disabled-user', () => {
  const now = { date: '2026-11-09', hhmm: '08:00' } // a Monday
  const S = (on, workouts = []) => ({
    week: { 1: 'r1' }, routines: [{ id: 'r1', name: 'Push' }], workouts,
    reminder: { on, time: '08:00', tz: 'UTC' }, dayPlan: {}
  })
  assert.equal(reminderDue({ disabled: true }, S(true), now), false)
  assert.equal(reminderDue({ disabled: false }, S(true), now), true)
  assert.equal(reminderDue({}, S(true), now), true) // undefined disabled ≡ enabled
  assert.equal(reminderDue({ disabled: false }, S(false), now), false) // reminder off
  assert.equal(reminderDue({ disabled: false }, S(true, [{ d: '2026-11-09' }]), now), false) // already trained today
  assert.equal(reminderDue({ disabled: false }, { ...S(true), week: {} }, now), false) // rest day
  assert.equal(reminderDue({ disabled: false, lastReminder: '2026-11-09' }, S(true), now), false) // already sent today
  assert.equal(reminderDue({ disabled: false }, { ...S(true), reminder: { on: true, time: '09:00', tz: 'UTC' } }, now), false) // wrong time
})

test('state.corrupt-db-fails-fast', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-api-corrupt-'))
  try {
    fs.writeFileSync(path.join(dir, 'db.json'), '{corrupt')
    const r = spawnSync(process.execPath, [path.join(HERE, 'server.js')], {
      cwd: HERE,
      env: { ...process.env, DATA_DIR: dir, PORT: '0' },
      encoding: 'utf8',
      timeout: 15000
    })
    assert.equal(r.signal, null, 'server was killed by timeout — it started instead of failing fast')
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstderr: ${r.stderr}`)
    assert.match(r.stderr, /not valid JSON/)
    assert.match(r.stderr, /db\.json/)
    // exactly one snapshot, and the broken original is untouched
    const copies = fs.readdirSync(dir).filter(f => f.startsWith('db.json.corrupt-'))
    assert.equal(copies.length, 1)
    assert.equal(fs.readFileSync(path.join(dir, copies[0]), 'utf8'), '{corrupt')
    assert.equal(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'), '{corrupt')
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* fine */ }
  }
})
