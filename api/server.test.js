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

/* ---------- personal media: upload, serve, quota, range ---------- */
const gifBytes = n => Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(n || 64, 7)])
const mp4Bytes = n => Buffer.concat([Buffer.alloc(4, 1), Buffer.from('ftypisom'), Buffer.alloc(n || 64, 9)])

async function upload(token, buf, ctype, base = BASE) {
  const res = await fetch(base + '/api/media', {
    method: 'POST',
    headers: { 'Content-Type': ctype, ...(token ? { cookie: `gymsid=${token}` } : {}) },
    body: buf
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

test('media.upload: gif and mp4 accepted, magic bytes enforced, dedup shares owners', async () => {
  const a = await registerUser('Media A')
  const b = await registerUser('Media B')
  const gif = gifBytes(100)
  const up = await upload(a.token, gif, 'image/gif')
  assert.equal(up.status, 200)
  assert.match(up.json.h, /^[a-f0-9]{64}$/)
  assert.equal(up.json.e, 'gif')
  assert.equal(up.json.size, gif.length)
  const file = path.join(TMP, 'media', `${up.json.h}.gif`)
  assert.equal(fs.readFileSync(file).equals(gif), true)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  // mp4: ftyp at offset 4
  const mp4 = mp4Bytes(50)
  const up2 = await upload(a.token, mp4, 'video/mp4')
  assert.equal(up2.status, 200)
  assert.equal(up2.json.e, 'mp4')
  // same bytes, second user → same hash, no new file, owners grow
  const up3 = await upload(b.token, gif, 'image/gif')
  assert.equal(up3.status, 200)
  assert.equal(up3.json.h, up.json.h)
  const index = JSON.parse(fs.readFileSync(path.join(TMP, 'media', 'index.json'), 'utf8'))
  assert.equal(index[up.json.h].owners.length, 2)
  assert.equal(Object.keys(index).length, 2)
  // declared type without the magic → refused
  assert.equal((await upload(a.token, Buffer.from('not a gif at all'), 'image/gif')).status, 415)
  // magic without the declared type → refused
  assert.equal((await upload(a.token, gif, 'video/mp4')).status, 415)
  // over 1 MB → refused before reading it all
  assert.equal((await upload(a.token, Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(1048576)]), 'image/gif')).status, 413)
  // anonymous → 401
  assert.equal((await upload(null, gif, 'image/gif')).status, 401)
})

test('media.upload: quota counts files and bytes per owner, re-upload of owned media is free', async () => {
  process.env.MEDIA_MAX_FILES = '2'
  process.env.MEDIA_MAX_BYTES = String(2 * 1048576)
  try {
    const a = await registerUser('Quota User')
    assert.equal((await upload(a.token, gifBytes(10), 'image/gif')).status, 200)
    assert.equal((await upload(a.token, mp4Bytes(10), 'video/mp4')).status, 200)
    // a third distinct file breaks the 2-file quota → 413
    const third = await upload(a.token, Buffer.concat([Buffer.from('GIF87a'), Buffer.alloc(10, 3)]), 'image/gif')
    assert.equal(third.status, 413)
    assert.match(third.json.error, /quota/)
    // re-uploading an owned file consumes nothing — still 200 with the quota at its ceiling
    assert.equal((await upload(a.token, gifBytes(10), 'image/gif')).status, 200)
  } finally {
    delete process.env.MEDIA_MAX_FILES
    delete process.env.MEDIA_MAX_BYTES
  }
})

test('media.serve: content-type, cache headers, 404s and range requests', async () => {
  const a = await registerUser('Range Rider')
  const gif = gifBytes(64)
  const { json: up } = await upload(a.token, gif, 'image/gif')
  const h = up.h
  const get = async (p, opt = {}) => {
    const res = await fetch(BASE + p, { headers: { ...(opt.token ? { cookie: `gymsid=${opt.token}` } : {}), ...(opt.headers || {}) } })
    return { status: res.status, headers: res.headers, buf: res.status === 200 || res.status === 206 ? Buffer.from(await res.arrayBuffer()) : null }
  }
  const ok = await get(`/api/media/${h}.gif`, { token: a.token })
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('content-type'), 'image/gif')
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(ok.headers.get('cache-control'), 'private, max-age=31536000, immutable')
  assert.equal(ok.headers.get('etag'), `"${h}"`)
  assert.equal(ok.headers.get('accept-ranges'), 'bytes')
  assert.equal(ok.buf.equals(gif), true)
  // middle and suffix ranges
  const mid = await get(`/api/media/${h}.gif`, { token: a.token, headers: { range: 'bytes=2-5' } })
  assert.equal(mid.status, 206)
  assert.equal(mid.headers.get('content-range'), `bytes 2-5/${gif.length}`)
  assert.equal(mid.buf.equals(gif.subarray(2, 6)), true)
  const suf = await get(`/api/media/${h}.gif`, { token: a.token, headers: { range: 'bytes=-4' } })
  assert.equal(suf.status, 206)
  assert.equal(suf.buf.equals(gif.subarray(gif.length - 4)), true)
  // valid syntax, unsatisfiable → 416 with the right Content-Range
  const unsat = await get(`/api/media/${h}.gif`, { token: a.token, headers: { range: 'bytes=999999-' } })
  assert.equal(unsat.status, 416)
  assert.equal(unsat.headers.get('content-range'), `bytes */${gif.length}`)
  // path games → 404, never a read outside the media dir
  for (const p of ['../db.json', '%2e%2e%2fdb.json', `${'a'.repeat(63)}.gif`, `${h}.txt`, `${h}`]) {
    assert.equal((await get(`/api/media/${p}`, { token: a.token })).status, 404, p)
  }
  // unknown but well-formed hash → 404
  assert.equal((await get(`/api/media/${'b'.repeat(64)}.gif`, { token: a.token })).status, 404)
  // no session → 401
  assert.equal((await get(`/api/media/${h}.gif`)).status, 401)
  // a disabled user cannot read either
  const at = await admin()
  await call('POST', '/api/admin/user/disable', { token: at, body: { id: a.id, disabled: true } })
  assert.equal((await get(`/api/media/${h}.gif`, { token: a.token })).status, 401)
  await call('POST', '/api/admin/user/disable', { token: at, body: { id: a.id, disabled: false } })
  // cross-site POST refused by the shared origin guard
  assert.equal((await raw('POST', '/api/media', { headers: { origin: 'https://evil.example' }, token: a.token, body: {} })).status, 403)
})

/* ---------- operator tooling: scripts/reset-password.mjs ---------- */
test('reset-password script: rehashes, bumps sv, old password dies, new one works', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-api-reset-'))
  const u = { id: 'u-reset', name: 'Locked Out', phone: '+989130000777', password: pwRecord('oldpassword1'), created: new Date().toISOString() }
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
    users: [u, { id: 'u-admin', name: 'Owner', phone: '+989120000001', password: pwRecord('adminpass123'), created: new Date().toISOString() }],
    creds: [], subs: [], invites: [], coachLinks: [], coachAssignments: []
  }))
  const script = path.join(HERE, '..', 'scripts', 'reset-password.mjs')
  const r = spawnSync(process.execPath, [script, '--data', dir, '--phone', '09130000777'], {
    cwd: HERE, encoding: 'utf8', input: 'fresh-password2\n', timeout: 15000,
    env: { ...process.env, DATA_DIR: dir }
  })
  assert.equal(r.status, 0, `script failed: ${r.stderr || r.stdout}`)
  assert.match(r.stdout, /Password replaced/)
  const dbAfter = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'))
  const edited = dbAfter.users.find(x => x.id === 'u-reset')
  assert.notEqual(edited.password.hash, u.password.hash)
  assert.equal(edited.sv, 1)
  // a fresh server against the same dir: old password rejected, new one accepted
  const s = await spawnWith({ DATA_DIR: dir })
  try {
    assert.equal((await s.c('POST', '/api/login', { body: { phone: '+989130000777', password: 'oldpassword1' } })).status, 401)
    assert.equal((await s.c('POST', '/api/login', { body: { phone: '+989130000777', password: 'fresh-password2' } })).status, 200)
  } finally { s.cleanup() }
})

/* ---------- media tooling: gc-media.mjs and inline-media.mjs ---------- */
test('media.gc coverage: coach-only refs, disabled-user state, orphans and missing files', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-api-gc-'))
  const mediaDir = path.join(dir, 'media')
  fs.mkdirSync(mediaDir)
  const H = p => p.repeat(64)
  const blob = b => Buffer.from(`GIF89a${b}`)
  // four blobs: coach-assignment-only · disabled-user-only · stale unreferenced (control) · orphan (no index entry)
  const hCoach = H('a'), hDis = H('b'), hOld = H('c'), hOrphan = H('d'), hMissing = H('e')
  for (const [h, b] of [[hCoach, '1'], [hDis, '2'], [hOld, '3']]) {
    const f = path.join(mediaDir, `${h}.gif`)
    fs.writeFileSync(f, blob(b), { mode: 0o600 })
    fs.utimesSync(f, new Date('2020-01-01'), new Date('2020-01-01')) // well past the grace period
  }
  const orphanFile = path.join(mediaDir, `${hOrphan}.gif`)
  fs.writeFileSync(orphanFile, blob('4'), { mode: 0o600 })
  fs.utimesSync(orphanFile, new Date('2020-01-01'), new Date('2020-01-01'))
  const index = {
    [hCoach]: { ext: 'gif', size: 7, owners: ['coach1'], created: '2020-01-01T00:00:00.000Z' },
    [hDis]: { ext: 'gif', size: 7, owners: ['u-dis'], created: '2020-01-01T00:00:00.000Z' },
    [hOld]: { ext: 'gif', size: 7, owners: ['u1'], created: '2020-01-01T00:00:00.000Z' },
    [hMissing]: { ext: 'gif', size: 7, owners: ['u1'], created: '2020-01-01T00:00:00.000Z' } // no file on disk
  }
  fs.writeFileSync(path.join(mediaDir, 'index.json'), JSON.stringify(index))
  // a disabled member's state still references their media — the file must survive
  fs.writeFileSync(path.join(dir, 'state-u-dis.json'), JSON.stringify({
    routines: [{ id: 'r1', ex: [{ id: '0025', mediaRef: { h: hDis, e: 'gif' } }] }]
  }))
  // the coach's assignment references theirs (the member renders it through the shared GET)
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
    users: [{ id: 'u-dis', name: 'Off', phone: '+989130000555', password: { salt: 'x', hash: 'y' }, disabled: true, created: '2020-01-01T00:00:00.000Z' }],
    creds: [], subs: [], invites: [], coachLinks: [], coachAssignments: [
      { coachId: 'coach1', memberId: 'u1', routines: [{ id: 'r1', ex: [{ id: '0025', mediaRef: { h: hCoach, e: 'gif' } }] }] }
    ]
  }))

  const run = extra => spawnSync(process.execPath, [path.join(HERE, '..', 'scripts', 'gc-media.mjs'), '--data', dir, ...extra], {
    cwd: HERE, encoding: 'utf8', timeout: 20000, env: { ...process.env, DATA_DIR: dir }
  })

  // dry run: only the stale unreferenced blob is a candidate; coach/disabled refs survive
  const dry = run([])
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, new RegExp(`garbage .*: 1`))
  assert.doesNotMatch(dry.stdout, new RegExp(hCoach))
  assert.doesNotMatch(dry.stdout, new RegExp(hDis))
  assert.match(dry.stdout, new RegExp(hOld))
  assert.match(dry.stdout, /MISSING ON DISK/)
  assert.match(dry.stdout, new RegExp(`orphan .not in index.: ${hOrphan}`))
  // --apply: the control blob and the orphan go, everything referenced and the missing entry stay listed-safe
  const apply = run(['--apply'])
  assert.equal(apply.status, 0, apply.stderr)
  assert.equal(fs.existsSync(path.join(mediaDir, `${hOld}.gif`)), false)
  assert.equal(fs.existsSync(orphanFile), false)
  assert.equal(fs.existsSync(path.join(mediaDir, `${hCoach}.gif`)), true)
  assert.equal(fs.existsSync(path.join(mediaDir, `${hDis}.gif`)), true)
  const indexAfter = JSON.parse(fs.readFileSync(path.join(mediaDir, 'index.json'), 'utf8'))
  assert.deepEqual(Object.keys(indexAfter).sort(), [hCoach, hDis].sort())
  fs.rmSync(dir, { recursive: true, force: true })
})

/* ---------- operator tooling: scripts/reset-password.mjs ---------- */
test('media tools: inline round-trip is byte-exact, gc removes only unreferenced stale files', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-api-mediatools-'))
  const mediaDir = path.join(dir, 'media')
  fs.mkdirSync(mediaDir)
  // two media blobs and their exact data-URLs (what the pre-migration state carried)
  const gifRaw = gifBytes(32)
  const mp4Raw = mp4Bytes(24)
  const hashOf = b => crypto.createHash('sha256').update(b).digest('hex')
  const hGif = hashOf(gifRaw), hMp4 = hashOf(mp4Raw)
  fs.writeFileSync(path.join(mediaDir, `${hGif}.gif`), gifRaw, { mode: 0o600 })
  fs.writeFileSync(path.join(mediaDir, `${hMp4}.mp4`), mp4Raw, { mode: 0o600 })
  const index = {
    [hGif]: { ext: 'gif', size: gifRaw.length, owners: ['u1'], created: new Date().toISOString() },
    [hMp4]: { ext: 'mp4', size: mp4Raw.length, owners: ['u1'], created: new Date().toISOString() },
    [`${'c'.repeat(64)}`]: { ext: 'gif', size: 10, owners: ['u1'], created: '2020-01-01T00:00:00.000Z' } // stale, unreferenced
  }
  fs.writeFileSync(path.join(mediaDir, 'index.json'), JSON.stringify(index))
  // the stale blob's file mtime must be old too — gc conservatively trusts max(created, mtime)
  const staleFile = path.join(mediaDir, `${'c'.repeat(64)}.gif`)
  fs.writeFileSync(staleFile, Buffer.from('GIF89astale'), { mode: 0o600 })
  fs.utimesSync(staleFile, new Date('2020-01-01'), new Date('2020-01-01'))
  const gifUrl = `data:image/gif;base64,${gifRaw.toString('base64')}`
  const mp4Url = `data:video/mp4;base64,${mp4Raw.toString('base64')}`
  const state = {
    rev: 5, unit: 'kg',
    routines: [{ id: 'r1', name: 'R', ex: [{ id: '0025', sets: 3, mediaRef: { h: hGif, e: 'gif' } }] }],
    customEx: [{ id: 'c1', n: 'Mine', bp: 'chest', mediaRef: { h: hMp4, e: 'mp4' } }]
  }
  const stateFile = path.join(dir, 'state-u1.json')
  fs.writeFileSync(stateFile, JSON.stringify(state))
  // db.json with a coach assignment also referencing the gif
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ users: [], creds: [], subs: [], invites: [], coachAssignments: [{ coachId: 'x', memberId: 'u1', routines: [{ id: 'r1', name: 'Plan', ex: [{ id: '0025', sets: 2, mediaRef: { h: hGif, e: 'gif' } }] }] }] }))

  const run = (script, extra = []) => spawnSync(process.execPath, [path.join(HERE, '..', 'scripts', script), '--data', dir, ...extra], {
    cwd: HERE, encoding: 'utf8', timeout: 20000, env: { ...process.env, DATA_DIR: dir }
  })

  // gc dry run: only the stale unreferenced blob is a candidate; both referenced blobs stay
  const dry = run('gc-media.mjs')
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /garbage .*: 1\b/)
  assert.equal(fs.existsSync(path.join(mediaDir, `${'c'.repeat(64)}.gif`)), true)
  // gc --apply: removes it, keeps referenced media, rewrites the index
  const apply = run('gc-media.mjs', ['--apply'])
  assert.equal(apply.status, 0, apply.stderr)
  assert.equal(fs.existsSync(path.join(mediaDir, `${'c'.repeat(64)}.gif`)), false)
  assert.equal(fs.existsSync(path.join(mediaDir, `${hGif}.gif`)), true)
  const indexAfter = JSON.parse(fs.readFileSync(path.join(mediaDir, 'index.json'), 'utf8'))
  assert.deepEqual(Object.keys(indexAfter).sort(), [hGif, hMp4].sort())
  // inline dry run: nothing written yet
  const dryInline = run('inline-media.mjs')
  assert.equal(dryInline.status, 0, dryInline.stderr)
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).routines[0].ex[0].mediaRef.h, hGif)
  // inline --apply: byte-exact data-URLs back, rev bumped, mediaRef gone
  const inl = run('inline-media.mjs', ['--apply'])
  assert.equal(inl.status, 0, inl.stderr)
  const st2 = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.equal(st2.routines[0].ex[0].gifData, gifUrl)
  assert.equal(st2.routines[0].ex[0].mediaRef, undefined)
  assert.equal(st2.customEx[0].gif, mp4Url)
  assert.equal(st2.rev, 6)
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600)
  // coach assignment in db.json: also inlined (the gif reference reads back the same bytes)
  const dbAfter = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'))
  assert.equal(dbAfter.coachAssignments[0].routines[0].ex[0].gifData, gifUrl)
  fs.rmSync(dir, { recursive: true, force: true })
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
