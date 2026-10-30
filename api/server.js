/* opengym-api — phone/password auth + per-user state storage for openGym
   No framework, JSON-file storage, signed session cookies.               */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';

const PORT = +(process.env.PORT || 3000);
const DATA = process.env.DATA_DIR || '/data';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const CLUB_NAME = process.env.CLUB_NAME || 'openGym';
// Admin dashboard (issue): admins are matched by uid; INVITE_ONLY gates new signups behind a
// code the admin generates. Both default off so a fresh self-hosted instance stays open.
const ADMIN_UIDS = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
const INVITE_ONLY = /^(1|true|yes|on)$/i.test(process.env.INVITE_ONLY || '');
// 90 days keeps someone who trains a few times a week permanently signed in without a stolen
// cookie staying good for a year. Overridable because a family instance and one on the open
// internet don't want the same number. Only affects cookies minted from now on — the expiry is
// baked into each cookie when it's issued, so lowering this never cuts an existing session short.
const SESSION_DAYS = Math.max(1, +(process.env.SESSION_DAYS || 90) || 90);
const MAX_BODY = 5 * 1024 * 1024;
// Secure cookies require HTTPS; over plain http://localhost the flag would drop the cookie
const SECURE = /^https:/i.test(ORIGIN) ? ' Secure;' : '';

fs.mkdirSync(DATA, { recursive: true });

/* ---------- secret + db ---------- */
const secretFile = path.join(DATA, 'secret');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(secretFile, 'utf8').trim();

const dbFile = path.join(DATA, 'db.json');
let db = { users: [], creds: [], subs: [], invites: [] };
try { db = JSON.parse(fs.readFileSync(dbFile, 'utf8')); } catch {}
db.subs = db.subs || [];
// Passkey credentials are no longer accepted or retained by this version.
const hadPasskeys = (db.creds || []).length > 0;
db.creds = [];
db.invites = db.invites || [];
db.coachLinks = db.coachLinks || [];
db.coachAssignments = db.coachAssignments || [];
const isAdmin = user => !!user && (user.admin === true || ADMIN_UIDS.includes(user.id));
const isCoach = user => !!user && (user.role === 'coach' || isAdmin(user));
const publicUser = user => ({ id: user.id, name: user.name, phone: user.phone || null, admin: isAdmin(user), role: isCoach(user) ? 'coach' : 'member' });
const coachLink = (coachId, memberId) => {
  const link = db.coachLinks.find(x => x.coachId === coachId && x.memberId === memberId && x.active !== false);
  const member = db.users.find(u => u.id === memberId);
  return link && member && !member.disabled ? link : null;
};
function assignmentFor(memberId) {
  const link = db.coachLinks.find(x => x.memberId === memberId && x.active !== false);
  if (!link) return null;
  const coach = db.users.find(u => u.id === link.coachId);
  const plan = db.coachAssignments.find(x => x.memberId === memberId && x.coachId === link.coachId);
  if (!plan) return null;
  return { coach: coach ? { id: coach.id, name: coach.name } : null, ...plan };
}
function saveDb() { atomicWrite(dbFile, JSON.stringify(db, null, 2)); }
function atomicWrite(file, content) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}
if (hadPasskeys) saveDb();
const stateFile = uid => path.join(DATA, 'state-' + uid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
function readState(uid) {
  try { return JSON.parse(fs.readFileSync(stateFile(uid), 'utf8')); } catch { return null; }
}

/* ---------- push notifications (Web Push / VAPID) ---------- */
const vapidFile = path.join(DATA, 'vapid.json');
let vapid;
try { vapid = JSON.parse(fs.readFileSync(vapidFile, 'utf8')); }
catch { vapid = webpush.generateVAPIDKeys(); fs.writeFileSync(vapidFile, JSON.stringify(vapid), { mode: 0o600 }); }
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || (SECURE ? ORIGIN : 'mailto:admin@localhost');
webpush.setVapidDetails(VAPID_SUBJECT, vapid.publicKey, vapid.privateKey);

async function sendPush(userId, payload) {
  const subs = db.subs.filter(s => s.userId === userId);
  if (!subs.length) return;
  const body = JSON.stringify(payload);
  let dirty = false;
  await Promise.all(subs.map(async sub => {
    // urgency 'high' is the one lever we have over delivery speed — iOS/Android throttle
    // low-urgency background push more aggressively under battery-saving modes. TTL is left
    // at the library default (long) so a briefly-offline device still gets it once reconnected,
    // rather than risking it being dropped for the sake of shaving off latency that TTL doesn't
    // actually control anyway.
    try { await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, { urgency: 'high' }); }
    catch (e) {
      console.error('push send failed', userId, e.statusCode, e.body || e.message);
      if (e.statusCode === 404 || e.statusCode === 410) {
        db.subs = db.subs.filter(s => s.endpoint !== sub.endpoint); dirty = true;
      }
    }
  }));
  if (dirty) saveDb();
}

// Rest-timer alerts: client schedules on start/extend, cancels on skip or on-screen completion —
// this only fires when the tab was backgrounded/suspended and never got to cancel it itself.
const restTimers = new Map(); // userId -> Timeout
function scheduleRestTimer(userId, sec) {
  const t = restTimers.get(userId);
  if (t) clearTimeout(t);
  restTimers.set(userId, setTimeout(() => {
    restTimers.delete(userId);
    sendPush(userId, { title: 'Rest over 💪', body: 'Time for your next set.', tag: 'rest-timer' });
  }, sec * 1000));
}
function cancelRestTimer(userId) {
  const t = restTimers.get(userId);
  if (t) { clearTimeout(t); restTimers.delete(userId); }
}

// "Workout planned today" reminder — one per user per day, at their chosen time.
// Duplicated (not imported) from frontend/src/lib/history.js effectiveRoutineId — tiny pure helper, not worth sharing across the two runtimes.
function effectiveRoutineId(S, iso) {
  const ov = S.dayPlan?.[iso];
  if (ov === 'rest') return null;
  if (ov && S.routines?.some(r => r.id === ov)) return ov;
  const wd = new Date(iso + 'T12:00:00').getDay();
  return S.week?.[wd] || null;
}
// Computes "now" in an arbitrary IANA zone (e.g. "Europe/Lisbon") instead of the server's own —
// each user's reminder fires by their own clock, wherever they and their phone actually are.
function userNow(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date());
    const g = t => parts.find(p => p.type === t)?.value;
    return { date: `${g('year')}-${g('month')}-${g('day')}`, hhmm: `${g('hour')}:${g('minute')}` };
  } catch { return null; } // unknown/invalid tz string — skip this user rather than guess
}
setInterval(() => {
  for (const user of db.users) {
    if (!db.subs.some(s => s.userId === user.id)) continue;
    const S = readState(user.id);
    if (!S?.reminder?.on) continue;
    const now = userNow(S.reminder.tz || 'UTC');
    if (!now || S.reminder.time !== now.hhmm) continue;
    if (user.lastReminder === now.date) continue;
    if ((S.workouts || []).some(w => w.d === now.date)) continue;
    const rid = effectiveRoutineId(S, now.date);
    if (!rid) continue; // rest day — nothing planned
    const routine = (S.routines || []).find(r => r.id === rid);
    console.log('reminder firing', user.id, rid);
    user.lastReminder = now.date;
    saveDb();
    sendPush(user.id, {
      title: routine ? `${routine.emoji || '🏋️'} ${routine.name} today` : 'Workout planned today',
      body: "It's on your plan — let's go 💪",
      tag: 'day-reminder'
    });
  }
// Checked every 10s (not 60s) — ticks aren't aligned to the top of the minute, so a 60s
// interval could sit on your target minute for up to 59s before noticing. 10s caps that at ~9s.
}, 10000).unref();

/* ---------- sessions (signed cookie) ---------- */
function sign(payload) {
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + mac;
}
function verifySig(token) {
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i), mac = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  } catch { return null; }
  return payload;
}
// Session payload is `<uid>:<expiry>:<version>`, where the version is the user's `sv` counter.
// Bumping `sv` (POST /api/logout/all) makes every cookie ever handed out for that account stop
// verifying, which is the only revocation there was before short of deleting ./data/secret and
// signing out the whole instance. Cookies minted before `sv` existed have no third field and are
// read as version 0, matching a user who has never bumped — they stay valid until they expire.
const sessionVersion = user => user.sv || 0;
function makeSession(user) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  return sign(user.id + ':' + exp + ':' + sessionVersion(user));
}
function readSession(req) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => {
    const i = c.indexOf('='); return i < 0 ? ['', ''] : [c.slice(0, i).trim(), c.slice(i + 1).trim()];
  }));
  const tok = cookies.gymsid;
  if (!tok) return null;
  const payload = verifySig(tok);
  if (!payload) return null;
  const [uid, exp, ver] = payload.split(':');
  if (!uid || +exp < Date.now()) return null;
  const user = db.users.find(u => u.id === uid) || null;
  if (!user) return null;
  if (user.disabled) return null;           // disabled accounts are locked out everywhere
  // Missing third field = pre-versioning cookie = version 0. Anything non-numeric is a malformed
  // payload (it still had to pass the HMAC, so this is belt-and-braces) and is refused outright.
  const claimed = ver === undefined ? 0 : Number(ver);
  if (!Number.isInteger(claimed) || claimed !== sessionVersion(user)) return null;
  return user;
}
// Guard for /api/admin/* — resolves the caller and 401/403s if they aren't an admin.
function requireAdmin(req, res) {
  const user = readSession(req);
  if (!user) { json(res, 401, { error: 'not signed in' }); return null; }
  if (!isAdmin(user)) { json(res, 403, { error: 'forbidden' }); return null; }
  return user;
}
function requireCoach(req, res) {
  const user = readSession(req);
  if (!user) { json(res, 401, { error: 'not signed in' }); return null; }
  if (!isCoach(user)) { json(res, 403, { error: 'coach access required' }); return null; }
  return user;
}
function sessionCookie(user) {
  return `gymsid=${makeSession(user)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly;${SECURE} SameSite=Lax`;
}
const clearCookie = `gymsid=; Path=/; Max-Age=0; HttpOnly;${SECURE} SameSite=Lax`;

/* ---------- helpers ---------- */
function json(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(extraHeaders || {}) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', d => {
      size += d.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}
function normalizePhone(input) {
  let phone = String(input || '').trim().replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[\s()-]/g, '');
  if (phone.startsWith('00')) phone = '+' + phone.slice(2);
  if (phone.startsWith('09') && /^09\d{9}$/.test(phone)) phone = '+98' + phone.slice(1);
  if (/^9\d{9}$/.test(phone)) phone = '+98' + phone;
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
}
function passwordRecord(password) {
  const salt = crypto.randomBytes(16);
  return { salt: salt.toString('base64url'), hash: crypto.scryptSync(password, salt, 64).toString('base64url') };
}
function passwordMatches(password, record) {
  try {
    const actual = crypto.scryptSync(password, Buffer.from(record.salt, 'base64url'), 64);
    const expected = Buffer.from(record.hash, 'base64url');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}
const authAttempts = new Map();
function blockedAuth(key) {
  const now = Date.now(), old = authAttempts.get(key);
  if (!old || now - old.start > 15 * 60_000) { authAttempts.set(key, { start: now, count: 0 }); return false; }
  return old.count >= 10;
}
function failAuth(key) { const a = authAttempts.get(key) || { start: Date.now(), count: 0 }; a.count++; authAttempts.set(key, a); }

/* ---------- live presence (in-memory) ---------- */
// Clients heartbeat /api/activity while a workout is on screen; the admin dashboard reads who's
// live. Purely ephemeral — never persisted. Expires shortly after the last ping.
const presence = new Map();               // uid -> { name, exIdx, exTotal, setsDone, setsTotal, startedAt, updatedAt }
const PRESENCE_TTL = 70000;               // ~3.5× the 20s client heartbeat
function livePresence(uid) {
  const p = presence.get(uid);
  if (!p) return null;
  if (Date.now() - p.updatedAt > PRESENCE_TTL) { presence.delete(uid); return null; }
  return p;
}
setInterval(() => { for (const [k, v] of presence) if (Date.now() - v.updatedAt > PRESENCE_TTL) presence.delete(k); }, 30000).unref();

/* ---------- routes ---------- */
const routes = {
  'GET /api/health': async (req, res) => json(res, 200, { ok: true, users: db.users.length }),

  // Public config the login screen needs before anyone is signed in.
  'GET /api/config': async (req, res) => json(res, 200, { invite_only: INVITE_ONLY, club_name: CLUB_NAME }),

  'GET /api/me': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    json(res, 200, { user: publicUser(user) });
  },

  'POST /api/register': async (req, res) => {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 40);
    if (!name) return json(res, 400, { error: 'name required' });
    const phone = normalizePhone(body.phone), password = String(body.password || '');
    if (!phone) return json(res, 400, { error: 'enter a valid mobile number, including country code' });
    if (password.length < 8 || password.length > 200) return json(res, 400, { error: 'password must be at least 8 characters' });
    if (db.users.some(u => u.phone === phone)) return json(res, 409, { error: 'this mobile number already has an account' });
    const code = String(body.code || '').trim().toUpperCase();
    if (INVITE_ONLY && !db.invites.some(i => i.code === code && !i.usedBy && !i.revoked))
      return json(res, 403, { error: 'a valid invite code is required' });
    // Re-check the invite at the last moment, then burn it.
    let invite = code ? db.invites.find(i => i.code === code && !i.usedBy && !i.revoked) : null;
    if (INVITE_ONLY && !invite) return json(res, 403, { error: 'invite code is no longer valid — ask for a new one' });
    const user = { id: crypto.randomBytes(12).toString('base64url'), name, phone, password: passwordRecord(password), created: new Date().toISOString() };
    if (invite) {
      user.invitedBy = invite.code; invite.usedBy = user.id; invite.usedAt = user.created;
      if (invite.coachId && db.users.some(u => u.id === invite.coachId && isCoach(u))) {
        user.coachId = invite.coachId;
        db.coachLinks.push({ coachId: invite.coachId, memberId: user.id, active: true, created: user.created });
      }
    }
    db.users.push(user);
    saveDb();
    json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user) });
  },

  'POST /api/login': async (req, res) => {
    const body = await readBody(req);
    const phone = normalizePhone(body.phone), key = `${req.socket.remoteAddress || 'unknown'}:${phone || String(body.phone || '').slice(0, 40)}`;
    if (blockedAuth(key)) return json(res, 429, { error: 'too many sign-in attempts — try again in 15 minutes' });
    const user = db.users.find(u => u.phone === phone);
    if (!user || !user.password || !passwordMatches(String(body.password || ''), user.password)) {
      failAuth(key); return json(res, 401, { error: 'mobile number or password is incorrect' });
    }
    if (user.disabled) return json(res, 403, { error: 'this account has been disabled' });
    authAttempts.delete(key);
    json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user) });
  },

  // Existing signed-in profiles can attach credentials to the same id, preserving their data.
  'POST /api/account/credentials': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req), phone = normalizePhone(body.phone), password = String(body.password || '');
    if (!phone) return json(res, 400, { error: 'enter a valid mobile number, including country code' });
    if (password.length < 8 || password.length > 200) return json(res, 400, { error: 'password must be at least 8 characters' });
    if (db.users.some(u => u.id !== user.id && u.phone === phone)) return json(res, 409, { error: 'this mobile number already has an account' });
    user.phone = phone; user.password = passwordRecord(password); saveDb();
    json(res, 200, { user: publicUser(user) });
  },

  'POST /api/logout': async (req, res) => json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie }),

  // "Sign out everywhere" — bumps this user's session version, invalidating all existing cookies.
  'POST /api/logout/all': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    user.sv = sessionVersion(user) + 1;
    saveDb();
    json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
  },

  'GET /api/data': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    try {
      const state = JSON.parse(fs.readFileSync(stateFile(user.id), 'utf8'));
      const assignment = assignmentFor(user.id);
      if (assignment) {
        const assigned = (assignment.routines || []).map(r => ({ ...r, coachManaged: true }));
        state.routines = [...(state.routines || []).filter(r => !assigned.some(a => a.id === r.id)), ...assigned];
        state.week = { ...(state.week || {}), ...(assignment.week || {}) };
        state.coachProgram = { coach: assignment.coach, week: assignment.week || {}, version: assignment.version || 0 };
      }
      json(res, 200, { state });
    } catch {
      const assignment = assignmentFor(user.id);
      json(res, 200, { state: assignment ? { routines: (assignment.routines || []).map(r => ({ ...r, coachManaged: true })), week: assignment.week || {}, coachProgram: { coach: assignment.coach, week: assignment.week || {}, version: assignment.version || 0 } } : null });
    }
  },

  'PUT /api/data': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (!body.state || typeof body.state !== 'object') return json(res, 400, { error: 'state required' });
    delete body.state.active;              // in-progress workouts stay device-local
    delete body.state.coachProgram;        // coach-owned assignment is never accepted from a member client
    const assignment = assignmentFor(user.id);
    const assignedIds = new Set((assignment?.routines || []).map(r => r.id));
    body.state.routines = (body.state.routines || []).filter(r => r && !r.coachManaged && !assignedIds.has(r.id));
    if (assignment) {
      const saved = readState(user.id) || {};
      const savedWeek = saved.week || {};
      body.state.week = body.state.week || {};
      for (const day of Object.keys(assignment.week || {})) {
        if (Object.prototype.hasOwnProperty.call(savedWeek, day)) body.state.week[day] = savedWeek[day];
        else delete body.state.week[day];
      }
      for (const [day, id] of Object.entries(body.state.week)) {
        if (assignedIds.has(id)) {
          if (Object.prototype.hasOwnProperty.call(savedWeek, day)) body.state.week[day] = savedWeek[day];
          else delete body.state.week[day];
        }
      }
    }
    atomicWrite(stateFile(user.id), JSON.stringify(body.state));
    json(res, 200, { ok: true, ts: body.state._ts || null });
  },

  'GET /api/push/public-key': async (req, res) => json(res, 200, { key: vapid.publicKey }),

  'POST /api/push/subscribe': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const sub = body.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return json(res, 400, { error: 'invalid subscription' });
    db.subs = db.subs.filter(s => s.endpoint !== sub.endpoint);
    db.subs.push({ userId: user.id, endpoint: sub.endpoint, keys: sub.keys, created: new Date().toISOString() });
    saveDb();
    json(res, 200, { ok: true });
  },

  'POST /api/push/unsubscribe': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    db.subs = db.subs.filter(s => !(s.userId === user.id && s.endpoint === body.endpoint));
    saveDb();
    json(res, 200, { ok: true });
  },

  'POST /api/push/test': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    await sendPush(user.id, { title: 'openGym', body: 'Test notification ✅ — this is what alerts look like.', tag: 'test' });
    json(res, 200, { ok: true });
  },

  'POST /api/push/rest-timer': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const sec = Math.max(1, Math.min(3600, Math.round(+body.seconds || 0)));
    if (!sec) return json(res, 400, { error: 'seconds required' });
    scheduleRestTimer(user.id, sec);
    json(res, 200, { ok: true });
  },

  'POST /api/push/rest-timer/cancel': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    cancelRestTimer(user.id);
    json(res, 200, { ok: true });
  },

  // Live-workout heartbeat: client pings while a workout is on screen; { active:false } drops it.
  'POST /api/activity': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (body.active) {
      presence.set(user.id, {
        name: String(body.name || '').slice(0, 60),
        exIdx: +body.exIdx || 0, exTotal: +body.exTotal || 0,
        setsDone: +body.setsDone || 0, setsTotal: +body.setsTotal || 0,
        startedAt: +body.startedAt || Date.now(),
        updatedAt: Date.now()
      });
    } else presence.delete(user.id);
    json(res, 200, { ok: true });
  },

  /* ---------- admin dashboard ---------- */
  // One row per user, cheap enough for a personal instance (reads each state file once).
  'GET /api/admin/users': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const users = db.users.map(u => {
      const S = readState(u.id) || {};
      const workouts = S.workouts || [];
      const last = workouts[workouts.length - 1];
      return {
        id: u.id, name: u.name, created: u.created || null,
        disabled: !!u.disabled, admin: isAdmin(u), role: isCoach(u) ? 'coach' : 'member', invitedBy: u.invitedBy || null,
        workouts: workouts.length,
        lastWorkout: last ? last.d : null,
        lastSync: S._ts || null,
        hasPush: db.subs.some(s => s.userId === u.id),
        live: livePresence(u.id)
      };
    });
    json(res, 200, { users, invite_only: INVITE_ONLY, now: Date.now() });
  },

  // Drill-down: full workout history + body-weight log for one user.
  'GET /api/admin/user': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const u = db.users.find(x => x.id === id);
    if (!u) return json(res, 404, { error: 'no such user' });
    const S = readState(u.id) || {};
    json(res, 200, {
      user: { id: u.id, name: u.name, created: u.created || null, disabled: !!u.disabled, admin: isAdmin(u), role: isCoach(u) ? 'coach' : 'member', invitedBy: u.invitedBy || null },
      unit: S.unit || 'kg',
      lastSync: S._ts || null,
      routines: (S.routines || []).map(r => ({ id: r.id, name: r.name, emoji: r.emoji, count: (r.ex || []).length })),
      bodyweight: S.bodyweight || [],
      workouts: (S.workouts || []).slice().reverse()   // newest first for display
    });
  },

  'POST /api/admin/user/disable': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (isAdmin(u)) return json(res, 400, { error: 'cannot disable an admin' });
    u.disabled = !!body.disabled;
    if (u.disabled) presence.delete(u.id);   // drop them off "training now" at once
    saveDb();
    json(res, 200, { ok: true, id: u.id, disabled: u.disabled });
  },

  'POST /api/admin/user/role': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (isAdmin(u)) return json(res, 400, { error: 'admin role is managed by server configuration' });
    if (body.role !== 'coach' && body.role !== 'member') return json(res, 400, { error: 'role must be coach or member' });
    u.role = body.role;
    if (body.role !== 'coach') {
      const removed = db.coachLinks.filter(x => x.coachId === u.id).map(x => x.memberId);
      db.coachLinks = db.coachLinks.filter(x => x.coachId !== u.id);
      db.coachAssignments = db.coachAssignments.filter(x => x.coachId !== u.id);
      db.invites = db.invites.filter(x => x.coachId !== u.id);
      for (const memberId of removed) {
        const member = db.users.find(x => x.id === memberId);
        if (member?.coachId === u.id) delete member.coachId;
      }
    }
    saveDb();
    json(res, 200, { user: publicUser(u) });
  },

  'GET /api/coach/clients': async (req, res) => {
    const coach = requireCoach(req, res); if (!coach) return;
    const links = db.coachLinks.filter(x => x.coachId === coach.id && x.active !== false);
    const clients = links.map(link => {
      const u = db.users.find(x => x.id === link.memberId);
      if (!u || u.disabled) return null;
      const state = readState(u.id) || {};
      const workouts = state.workouts || [];
      return { id: u.id, name: u.name, disabled: !!u.disabled, created: u.created || null,
        workouts: workouts.length, lastWorkout: workouts.at(-1)?.d || null,
        assignment: db.coachAssignments.find(x => x.coachId === coach.id && x.memberId === u.id) || null };
    }).filter(Boolean);
    json(res, 200, { clients });
  },

  'POST /api/coach/invites/new': async (req, res) => {
    const coach = requireCoach(req, res); if (!coach) return;
    const body = await readBody(req);
    let code;
    do { code = crypto.randomBytes(8).toString('hex').toUpperCase(); } while (db.invites.some(i => i.code === code));
    const invite = { code, note: String(body.note || '').slice(0, 60), coachId: coach.id, createdBy: coach.id, created: new Date().toISOString() };
    db.invites.push(invite); saveDb();
    json(res, 200, { invite });
  },

  'GET /api/coach/client': async (req, res) => {
    const coach = requireCoach(req, res); if (!coach) return;
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    if (!coachLink(coach.id, id)) return json(res, 404, { error: 'client is not linked to this coach' });
    const u = db.users.find(x => x.id === id);
    if (!u) return json(res, 404, { error: 'no such user' });
    const S = readState(id) || {};
    json(res, 200, { user: { id: u.id, name: u.name, disabled: !!u.disabled, created: u.created || null },
      workouts: (S.workouts || []).slice().reverse(), assignment: db.coachAssignments.find(x => x.coachId === coach.id && x.memberId === id) || null });
  },

  'PUT /api/coach/assignment': async (req, res) => {
    const coach = requireCoach(req, res); if (!coach) return;
    const body = await readBody(req);
    const memberId = String(body.memberId || '');
    if (!coachLink(coach.id, memberId)) return json(res, 404, { error: 'client is not linked to this coach' });
    if (!Array.isArray(body.routines) || body.routines.length > 40 || !body.week || typeof body.week !== 'object' || Array.isArray(body.week))
      return json(res, 400, { error: 'routines and weekly schedule required' });
    const ids = new Set();
    const routines = [];
    for (const r of body.routines) {
      if (!r || typeof r.id !== 'string' || !r.id || typeof r.name !== 'string' || !Array.isArray(r.ex) || r.ex.length > 100)
        return json(res, 400, { error: 'invalid routine' });
      if (ids.has(r.id)) return json(res, 400, { error: 'routine ids must be unique' });
      if (r.ex.some(e => !e || typeof e.id !== 'string')) return json(res, 400, { error: 'invalid exercise in routine' });
      ids.add(r.id);
      routines.push({ id: r.id, name: r.name.slice(0, 80), emoji: String(r.emoji || '🏋️').slice(0, 12),
        prog: r.prog || 'linear', ex: r.ex.map(e => ({ ...e })) });
    }
    const week = {};
    for (const [day, routineId] of Object.entries(body.week)) {
      if (!/^[0-6]$/.test(day) || (routineId !== 'rest' && !ids.has(routineId))) return json(res, 400, { error: 'invalid weekly schedule' });
      week[day] = routineId;
    }
    const idx = db.coachAssignments.findIndex(x => x.coachId === coach.id && x.memberId === memberId);
    const previous = idx >= 0 ? db.coachAssignments[idx] : null;
    if (!routines.length) {
      if (idx >= 0) db.coachAssignments.splice(idx, 1);
      saveDb(); json(res, 200, { assignment: null }); return;
    }
    const assignment = { coachId: coach.id, memberId, routines, week, version: (previous?.version || 0) + 1, updatedAt: new Date().toISOString() };
    if (idx >= 0) db.coachAssignments[idx] = assignment; else db.coachAssignments.push(assignment);
    saveDb(); json(res, 200, { assignment });
  },

  'GET /api/admin/invites': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    // resolve usedBy uid → name for display
    const invites = db.invites.map(i => ({
      ...i, usedByName: i.usedBy ? (db.users.find(u => u.id === i.usedBy) || {}).name || null : null
    }));
    json(res, 200, { invites, invite_only: INVITE_ONLY });
  },

  'POST /api/admin/invites/new': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    let code;
    // 16 hex chars = 64 bits, up from 8 chars / 32 bits. The app has no rate limiting by design
    // (that's the reverse proxy's job), so the code itself has to be the thing that isn't worth guessing. Codes already in
    // db.json keep working — validation is an exact string compare, never a length or format check.
    do { code = crypto.randomBytes(8).toString('hex').toUpperCase(); } while (db.invites.some(i => i.code === code));
    const invite = { code, note: String(body.note || '').slice(0, 60), createdBy: admin.id, created: new Date().toISOString() };
    db.invites.push(invite);
    saveDb();
    json(res, 200, { invite });
  },

  'POST /api/admin/invites/revoke': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const inv = db.invites.find(i => i.code === String(body.code || '').toUpperCase());
    if (!inv) return json(res, 404, { error: 'no such code' });
    if (inv.usedBy) return json(res, 400, { error: 'already used — cannot revoke' });
    db.invites = db.invites.filter(i => i.code !== inv.code);
    saveDb();
    json(res, 200, { ok: true });
  }
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const key = req.method + ' ' + url.pathname;
  const handler = routes[key];
  if (!handler) return json(res, 404, { error: 'not found' });
  try { await handler(req, res); }
  catch (e) {
    console.error(key, e);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
  }
}).listen(PORT, () => console.log(`gym-api on :${PORT}`));
