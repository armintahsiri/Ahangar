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
// the shared in-process server does dozens of registrations/logins from 127.0.0.1 — lift the
// per-IP caps here; the throttle suites use spawned children with their own tight caps
process.env.REGISTER_IP_MAX = '1000'
process.env.LOGIN_IP_MAX = '1000'
// INVITE_ONLY stays off for the shared in-process server; the invite suite spawns its own child.

const { createServer, reminderDue, _setPasswordVerifier, passwordMatches, _buckets, _pruneBuckets, _bucketHit } = await import('./server.js')
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

// raw variant for header-level tests (Origin, X-Forwarded-For, …)
async function raw(method, url, { body, token, headers = {}, base = BASE } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { cookie: `gymsid=${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  let json = null
  try { json = await res.json() } catch { /* no body */ }
  return { status: res.status, json }
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

/* ---------- origin guard + login timing ---------- */
test('origin.guard: state-changing verbs refuse foreign origins, GET never refused', async () => {
  const u = await registerUser('Origin Guard')
  const evil = { origin: 'https://evil.example' }
  assert.equal((await raw('POST', '/api/login', { headers: evil, body: { phone: u.phone, password: u.password } })).status, 403)
  assert.equal((await raw('PUT', '/api/data', { headers: evil, token: u.token, body: { state: { unit: 'kg', workouts: [], routines: [] } } })).status, 403)
  assert.equal((await raw('DELETE', '/api/nothing', { headers: evil, token: u.token })).status, 403)
  // GET is read-only — never refused, foreign origin or not
  assert.equal((await raw('GET', '/api/health', { headers: evil })).status, 200)
  // allowed: no Origin at all (curl / tools)
  assert.equal((await raw('POST', '/api/login', { body: { phone: u.phone, password: 'wrong-pass' } })).status, 401)
  // allowed: exact ORIGIN match (the default test ORIGIN is http://localhost:8080)
  assert.equal((await raw('POST', '/api/login', { headers: { origin: 'http://localhost:8080' }, body: { phone: u.phone, password: u.password } })).status, 200)
  // allowed: same-host origin (direct LAN access — Origin host === Host header)
  const port = BASE.split(':').pop()
  assert.equal((await raw('POST', '/api/login', { headers: { origin: `http://127.0.0.1:${port}` }, body: { phone: u.phone, password: u.password } })).status, 200)
})

test('login.timing: unknown phone runs the same one scrypt verification as a wrong password', async () => {
  const calls = { n: 0 }
  _setPasswordVerifier((pw, rec) => { calls.n++; return passwordMatches(pw, rec) })
  try {
    const u = await registerUser('Timing Tom')
    calls.n = 0
    assert.equal((await call('POST', '/api/login', { body: { phone: u.phone, password: 'wrong-pass' } })).status, 401)
    const known = calls.n
    calls.n = 0
    assert.equal((await call('POST', '/api/login', { body: { phone: nextPhone(), password: 'wrong-pass' } })).status, 401)
    const unknown = calls.n
    assert.equal(known, 1, 'wrong password must run exactly one scrypt verification')
    assert.equal(unknown, 1, 'unknown phone must run exactly one scrypt verification')
  } finally {
    _setPasswordVerifier() // restore the real verifier for the remaining suites
  }
})

/* ---------- throttles: proxy-aware client IP, per-IP caps, prune, size cap ---------- */
// Runs against spawned children so the TRUST_PROXY / cap envs are isolated from the shared
// in-process server (whose buckets would otherwise be polluted for the other suites).
async function spawnWith(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-api-throttle-'))
  seedDb(dir)
  const child = spawn(process.execPath, [path.join(HERE, 'server.js')], {
    cwd: HERE,
    env: { ...process.env, DATA_DIR: dir, PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const port = await new Promise((resolve, reject) => {
    let buf = ''
    child.stdout.on('data', d => { buf += d; const m = buf.match(/gym-api on :(\d+)/); if (m) resolve(+m[1]) })
    child.stderr.on('data', d => { buf += d })
    child.on('exit', code => reject(new Error(`server exited early: ${code}\n${buf}`)))
  })
  return {
    child, dir, B: `http://127.0.0.1:${port}`,
    c: async (method, url, opt = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}${url}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(opt.headers || {}), ...(opt.token ? { cookie: `gymsid=${opt.token}` } : {}) },
        body: opt.body === undefined ? undefined : JSON.stringify(opt.body)
      })
      const json = await res.json().catch(() => null)
      return { status: res.status, json, token: (res.headers.get('set-cookie') || '').match(/gymsid=([^;]*)/)?.[1] || null }
    },
    cleanup: () => { child.kill('SIGTERM'); try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* fine */ } }
  }
}

test('throttle.trust-proxy: with TRUST_PROXY=1 the rightmost XFF entry is the client, spoofed entries are ignored', { timeout: 30000 }, async () => {
  const s = await spawnWith({ TRUST_PROXY: '1', LOGIN_IP_MAX: '3', REGISTER_IP_MAX: '2' })
  try {
    // one trusted hop: the rightmost XFF entry is the real client (the proxy appended it);
    // anything to its left is client-controlled and never looked at
    const viaA = { 'x-forwarded-for': '203.0.113.7' }
    const viaB = { 'x-forwarded-for': '203.0.113.9' }
    // register cap: 10/h default is lowered to 2 — both attempts from IP 203.0.113.7 burn it
    const r1 = await s.c('POST', '/api/register', { headers: viaA, body: { name: 'A One', phone: nextPhone(), password: 'password123' } })
    assert.equal(r1.status, 200)
    assert.equal((await s.c('POST', '/api/register', { headers: viaA, body: { name: 'A Two', phone: nextPhone(), password: 'password123' } })).status, 200)
    assert.equal((await s.c('POST', '/api/register', { headers: viaA, body: { name: 'A Three', phone: nextPhone(), password: 'password123' } })).status, 429)
    // a different real client IP has its own register budget
    assert.equal((await s.c('POST', '/api/register', { headers: viaB, body: { name: 'B One', phone: nextPhone(), password: 'password123' } })).status, 200)
    // per-IP failed-login cap (3): three wrong passwords from 203.0.113.7 close the tap
    for (let i = 0; i < 3; i++) {
      assert.equal((await s.c('POST', '/api/login', { headers: viaA, body: { phone: '+989130000001', password: `nope-${i}` } })).status, 401)
    }
    assert.equal((await s.c('POST', '/api/login', { headers: viaA, body: { phone: '+989130000001', password: 'nope-4' } })).status, 429)
    // and the spoofed leftmost entry cannot open a fresh bucket for the same real client
    assert.equal((await s.c('POST', '/api/login', { headers: { 'x-forwarded-for': `9.9.9.9, 203.0.113.7` }, body: { phone: '+989130000001', password: 'nope-5' } })).status, 429)
    // while the other real IP is untouched
    assert.equal((await s.c('POST', '/api/login', { headers: viaB, body: { phone: '+989130000003', password: 'nope' } })).status, 401)
  } finally { s.cleanup() }
})

test('throttle.no-proxy: with TRUST_PROXY=0 a spoofed X-Forwarded-For is ignored entirely', { timeout: 30000 }, async () => {
  const s = await spawnWith({ TRUST_PROXY: '0', LOGIN_IP_MAX: '2' })
  try {
    // both fake addresses land in the same bucket — the socket IP (127.0.0.1)
    assert.equal((await s.c('POST', '/api/login', { headers: { 'x-forwarded-for': '8.8.8.8' }, body: { phone: '+989130000001', password: 'nope' } })).status, 401)
    assert.equal((await s.c('POST', '/api/login', { headers: { 'x-forwarded-for': '8.8.8.8' }, body: { phone: '+989130000002', password: 'nope' } })).status, 401)
    // cap hit on the real IP…
    assert.equal((await s.c('POST', '/api/login', { headers: { 'x-forwarded-for': '8.8.8.8' }, body: { phone: '+989130000003', password: 'nope' } })).status, 429)
    // …and a *different* fake XFF does not dodge it — proof the header was never read
    assert.equal((await s.c('POST', '/api/login', { headers: { 'x-forwarded-for': '7.7.7.7' }, body: { phone: '+989130000004', password: 'nope' } })).status, 429)
  } finally { s.cleanup() }
})

test('throttle.prune drops expired buckets and the map is size-capped', () => {
  _buckets.clear()
  const old = { start: Date.now() - 10 * 60_000, count: 5, windowMs: 60_000 }
  _buckets.set('expired', old)
  _buckets.set('fresh', { start: Date.now(), count: 1, windowMs: 60_000 })
  const size = _pruneBuckets()
  assert.equal(_buckets.has('expired'), false)
  assert.equal(_buckets.has('fresh'), true)
  assert.equal(size, 1)
  // size cap: one more hit over the cap evicts the oldest entries
  const cap = Math.max(1000, Math.trunc(+(process.env.BUCKET_CAP || 10000)) || 10000)
  for (let i = 0; i < cap; i++) _buckets.set(`filler-${i}`, { start: Date.now(), count: 1, windowMs: 60_000 })
  _bucketHit('the-drop', 60_000)
  assert.ok(_buckets.size <= cap, `bucket size ${_buckets.size} exceeds cap ${cap}`)
  assert.equal(_buckets.has('the-drop'), true)
  _buckets.clear()
})

/* ---------- sync versioning (rev / baseRev) ---------- */
test('sync.put-baserev-roundtrip', async () => {
  const u = await registerUser('Rev Rider')
  // first push without a base — legacy LWW path — still stamps rev 1
  const p1 = await call('PUT', '/api/data', { token: u.token, body: { state: { unit: 'kg', workouts: [], routines: [] } } })
  assert.equal(p1.status, 200)
  assert.equal(p1.json.rev, 1)
  // matching base advances rev
  const p2 = await call('PUT', '/api/data', { token: u.token, body: { baseRev: 1, state: { unit: 'kg', workouts: [{ id: 'w1', d: '2026-11-09' }], routines: [] } } })
  assert.equal(p2.status, 200)
  assert.equal(p2.json.rev, 2)
  const get = await call('GET', '/api/data', { token: u.token })
  assert.equal(get.json.state.rev, 2)
  assert.equal(get.json.state.workouts.length, 1)
})

test('sync.put-stale-baserev-409-writes-nothing', async () => {
  const u = await registerUser('Stale Sally')
  await call('PUT', '/api/data', { token: u.token, body: { state: { unit: 'kg', workouts: [], routines: [] } } })
  const newer = await call('PUT', '/api/data', { token: u.token, body: { baseRev: 1, state: { unit: 'kg', workouts: [{ id: 'w9', d: '2026-11-09' }], routines: [] } } })
  assert.equal(newer.json.rev, 2)
  // another device pushes from rev 1 — stale
  const stale = await call('PUT', '/api/data', { token: u.token, body: { baseRev: 1, state: { unit: 'lb', workouts: [], routines: [] } } })
  assert.equal(stale.status, 409)
  assert.equal(stale.json.error, 'conflict')
  assert.equal(stale.json.rev, 2)
  // the conflict body carries the server's current view (rev + data), coach-style fields included
  assert.equal(stale.json.state.rev, 2)
  assert.equal(stale.json.state.workouts[0].id, 'w9')
  // nothing was written: GET still returns rev 2 with the winner's data
  const get = await call('GET', '/api/data', { token: u.token })
  assert.equal(get.json.state.rev, 2)
  assert.equal(get.json.state.workouts.length, 1)
})

test('sync.put-no-baserev-legacy-lww', async () => {
  const u = await registerUser('Legacy Luke')
  await call('PUT', '/api/data', { token: u.token, body: { state: { unit: 'kg', workouts: [], routines: [] } } })
  await call('PUT', '/api/data', { token: u.token, body: { baseRev: 1, state: { unit: 'kg', workouts: [], routines: [] } } })
  // an old client sends no baseRev at all — behavior stays last-write-wins, rev still advances
  const legacy = await call('PUT', '/api/data', { token: u.token, body: { state: { unit: 'lb', workouts: [], routines: [] } } })
  assert.equal(legacy.status, 200)
  assert.equal(legacy.json.rev, 3)
})

test('sync.client-rev-ignored', async () => {
  const u = await registerUser('Rev Spoofer')
  await call('PUT', '/api/data', { token: u.token, body: { state: { unit: 'kg', workouts: [], routines: [] } } })
  // a client trying to dictate its own rev is ignored — the server owns the counter
  const sneaky = await call('PUT', '/api/data', { token: u.token, body: { baseRev: 1, state: { rev: 999, unit: 'kg', workouts: [], routines: [] } } })
  assert.equal(sneaky.status, 200)
  assert.equal(sneaky.json.rev, 2)
  const get = await call('GET', '/api/data', { token: u.token })
  assert.equal(get.json.state.rev, 2)
})

test('sync.concurrent-put-one-wins', async () => {
  const u = await registerUser('Racer Ray')
  await call('PUT', '/api/data', { token: u.token, body: { state: { unit: 'kg', workouts: [], routines: [] } } }) // rev 1
  // two devices push from the same base simultaneously — exactly one may win
  const [a, b] = await Promise.all([
    call('PUT', '/api/data', { token: u.token, body: { baseRev: 1, state: { unit: 'kg', workouts: [{ id: 'wa', d: '2026-11-09' }], routines: [] } } }),
    call('PUT', '/api/data', { token: u.token, body: { baseRev: 1, state: { unit: 'kg', workouts: [{ id: 'wb', d: '2026-11-09' }], routines: [] } } })
  ])
  const statuses = [a.status, b.status].sort()
  assert.deepEqual(statuses, [200, 409])
  const get = await call('GET', '/api/data', { token: u.token })
  assert.equal(get.json.state.rev, 2)
  assert.equal(get.json.state.workouts.length, 1)
})

test('sync.corrupt-file-still-500-with-baserev', async () => {
  const u = await registerUser('Corrupt Again')
  assert.equal((await call('PUT', '/api/data', { token: u.token, body: { state: { unit: 'kg', workouts: [], routines: [] } } })).status, 200)
  const file = path.join(TMP, `state-${u.id}.json`)
  fs.writeFileSync(file, '{oops', { mode: 0o600 })
  // the corrupt pre-check fires before the rev gate — a 500, never a 409 or a write
  const r = await call('PUT', '/api/data', { token: u.token, body: { baseRev: 1, state: { unit: 'kg', workouts: [], routines: [] } } })
  assert.equal(r.status, 500)
  assert.equal(fs.readFileSync(file, 'utf8'), '{oops')
})
