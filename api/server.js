/* opengym-api — phone/password auth + per-user state storage for openGym
   No framework, JSON-file storage, signed session cookies.               */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
// One corrupt-file snapshot per file: the reminder loop re-reads every state file each 10s,
// and a copy-per-read would pile up snapshots for a file that stays broken.
function copyCorrupt(file) {
  try {
    const dir = path.dirname(file), base = path.basename(file);
    if (fs.readdirSync(dir).some(f => f.startsWith(base + '.corrupt-'))) return;
    fs.writeFileSync(file + '.corrupt-' + Date.now(), fs.readFileSync(file), { mode: 0o600 });
  } catch (e) { console.error('corrupt snapshot failed:', file, e.message); }
}
// Single-process assumption: every read-modify-write of `db` below runs synchronously with no
// await between the read and the write, so Node's single thread serializes them. Running this
// API as multiple processes (cluster) breaks that assumption — lost updates and double-spent
// invites would follow.
let db = { users: [], creds: [], subs: [], invites: [] };
if (fs.existsSync(dbFile)) {
  try { db = JSON.parse(fs.readFileSync(dbFile, 'utf8')); }
  catch (e) {
    // An unreadable db is data, not garbage: never boot over it with an empty user table.
    copyCorrupt(dbFile);
    console.error(`FATAL: ${dbFile} is not valid JSON (${e.message}). A snapshot was saved next to it (db.json.corrupt-*). Fix or remove the file and restart — refusing to start empty.`);
    process.exit(1);
  }
}
db.subs = db.subs || [];
// Passkey credentials are no longer accepted or retained by this version.
const hadPasskeys = (db.creds || []).length > 0;
db.creds = [];
db.invites = db.invites || [];
// Coach self-serve invites are gone: the gym owner wires athletes to coaches from the panel,
// so old db.json files carrying coach-owned invite codes get them scrubbed once on boot.
const hadCoachInvites = db.invites.some(i => i.coachId);
db.invites = db.invites.filter(i => !i.coachId);
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
// Reverse lookup for the admin dashboard: which coach (if any) is this member wired to.
const coachOf = memberId => {
  const link = db.coachLinks.find(x => x.memberId === memberId && x.active !== false);
  const coach = link && db.users.find(u => u.id === link.coachId);
  return coach ? { id: coach.id, name: coach.name } : null;
};
// The client-facing view of a member's state: the stored file plus the coach-owned
// assignment injected (coachManaged routines, coach week days, coachProgram). GET /api/data
// and the 409 conflict body both go through this, so clients always compare like-for-like.
function stateView(uid, state) {
  const assignment = assignmentFor(uid);
  if (!state) return assignment ? { routines: (assignment.routines || []).map(r => ({ ...r, coachManaged: true })), week: assignment.week || {}, coachProgram: { coach: assignment.coach, week: assignment.week || {}, version: assignment.version || 0 } } : null;
  if (assignment) {
    const assigned = (assignment.routines || []).map(r => ({ ...r, coachManaged: true }));
    state.routines = [...(state.routines || []).filter(r => !assigned.some(a => a.id === r.id)), ...assigned];
    state.week = { ...(state.week || {}), ...(assignment.week || {}) };
    state.coachProgram = { coach: assignment.coach, week: assignment.week || {}, version: assignment.version || 0 };
  }
  return state;
}
function saveDb() { atomicWrite(dbFile, JSON.stringify(db, null, 2)); }
function atomicWrite(file, content) {
  // Temp file written at 0600 and fsynced, then renamed — atomic on the same filesystem,
  // and every rewritten file (db.json, state-*.json) ends up owner-only like secret/vapid.
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
if (hadPasskeys || hadCoachInvites) saveDb();
const stateFile = uid => path.join(DATA, 'state-' + uid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
// Strict on purpose: a missing file is "no data yet" (null), but a file that exists and does
// not parse is data we refuse to pretend is absent — callers surface a 500 and the file is
// never silently overwritten. Returns null only for ENOENT.
function readState(uid) {
  const file = stateFile(uid);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try { return JSON.parse(raw); }
  catch (e) {
    copyCorrupt(file);
    const err = new Error(`state file corrupt: ${file} (${e.message})`);
    err.corrupt = true;
    throw err;
  }
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
// The per-user gate for the workout-day reminder, in the user's own timezone (`now` =
// { date, hhmm }). Disabled accounts never fire — a push subscription can outlive a disable.
export function reminderDue(user, S, now) {
  if (!S || user.disabled) return false;
  if (!S.reminder?.on || S.reminder.time !== now.hhmm) return false;
  if (user.lastReminder === now.date) return false;
  if ((S.workouts || []).some(w => w.d === now.date)) return false; // already trained today
  return !!effectiveRoutineId(S, now.date); // rest day → nothing planned
}
setInterval(() => {
  for (const user of db.users) {
    if (!db.subs.some(s => s.userId === user.id)) continue;
    let S;
    try { S = readState(user.id); }
    catch (e) { console.error('reminder: unreadable state, skipping user', user.id, e.message); continue; }
    const now = userNow(S?.reminder?.tz || 'UTC');
    if (!now || !reminderDue(user, S, now)) continue;
    const rid = effectiveRoutineId(S, now.date);
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

/* ---------- personal media store ---------- */
// Personal GIF/MP4 files live here, content-addressed by sha256, OUTSIDE the per-user state
// so a workout history never carries megabytes of base64 again. MEDIA_MIGRATE only signals
// the client that it may start moving existing media; upload/serve work regardless.
const MEDIA_DIR = path.join(DATA, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });
const isMediaMigrate = () => /^(1|true|yes|on)$/i.test(process.env.MEDIA_MIGRATE || '');
const mediaEnvMax = (name, fallback) => Math.max(1, Math.trunc(+(process.env[name] || fallback)) || fallback);
const MEDIA_MAX_BYTES_PER_FILE = 1 * 1024 * 1024;   // 1 MiB hard cap per file, mirrors the client hint
const mediaIndexFile = path.join(MEDIA_DIR, 'index.json');
let mediaIndex = {};                                 // hash -> { ext, size, owners: [uid], created }
try { mediaIndex = JSON.parse(fs.readFileSync(mediaIndexFile, 'utf8')); }
catch (e) { if (fs.existsSync(mediaIndexFile)) console.error('media index unreadable — starting empty:', e.message); }
function saveMediaIndex() { atomicWrite(mediaIndexFile, JSON.stringify(mediaIndex, null, 2)); }
function mediaUsage(uid) {
  let files = 0, bytes = 0;
  for (const m of Object.values(mediaIndex)) if ((m.owners || []).includes(uid)) { files++; bytes += m.size || 0; }
  return { files, bytes };
}
function readRawBody(req, max) {
  return new Promise((resolve, reject) => {
    let failed = false;
    const tooLarge = () => {
      if (failed) return;
      failed = true;
      const err = new Error('too large');
      err.tooLarge = true;
      reject(err);
      req.resume();   // drain whatever is still coming so the 413 can actually be delivered
    };
    if (+(req.headers['content-length'] || 0) > max) return tooLarge();
    let size = 0; const chunks = [];
    req.on('data', d => { size += d.length; if (size > max) return tooLarge(); chunks.push(d); });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}
// Declared Content-Type is not trusted on its own: the bytes must carry the real signature.
function mediaKind(buf) {
  const head = buf.subarray(0, 8).toString('latin1');
  if (buf.length >= 6 && (head.startsWith('GIF87a') || head.startsWith('GIF89a'))) return 'gif';
  if (buf.length >= 8 && head.slice(4, 8) === 'ftyp') return 'mp4';
  return null;
}
const MEDIA_NAME_RE = /^[a-f0-9]{64}\.(gif|mp4)$/;
// Served to ANY signed-in, non-disabled account: coach-assigned routines reference the
// coach's uploads, and a 256-bit hash is not guessable — see docs/SECURITY.md.
function serveMedia(req, res, pathname) {
  const user = readSession(req);
  if (!user) return json(res, 401, { error: 'not signed in' });
  const name = pathname.slice('/api/media/'.length);
  if (!MEDIA_NAME_RE.test(name)) return json(res, 404, { error: 'not found' });
  const file = path.join(MEDIA_DIR, name);
  let stat;
  try { stat = fs.statSync(file); } catch { return json(res, 404, { error: 'not found' }); }
  const ext = name.split('.')[1];
  const base = {
    'Content-Type': ext === 'gif' ? 'image/gif' : 'video/mp4',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=31536000, immutable',
    ETag: `"${name.split('.')[0]}"`,
    'Accept-Ranges': 'bytes'
  };
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (m && (m[1] !== '' || m[2] !== '')) {
    let start, end;
    if (m[1] === '') {                       // suffix range: last N bytes
      const n = Math.trunc(+m[2]);
      if (!n || n > stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
      start = stat.size - n; end = stat.size - 1;
    } else {
      start = Math.trunc(+m[1]);
      end = m[2] === '' ? stat.size - 1 : Math.min(Math.trunc(+m[2]), stat.size - 1);
      if (start >= stat.size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
    }
    const len = end - start + 1;
    const chunk = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, chunk, 0, len, start); } finally { fs.closeSync(fd); }
    res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': len });
    return res.end(chunk);
  }
  res.writeHead(200, { ...base, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

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
export { normalizePhone, passwordRecord, passwordMatches, atomicWrite };
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
// A precomputed record so a login for an unknown phone runs the same scrypt work as a wrong
// password — response time must not reveal which numbers have accounts.
const DUMMY_PASSWORD = passwordRecord(crypto.randomBytes(32).toString('hex'));
// Swappable only so tests can count verifications instead of timing clocks; production always
// calls the real one unless a test replaces it (and restores it).
let verifyPassword = passwordMatches;
export function _setPasswordVerifier(fn = passwordMatches) { verifyPassword = fn }

// Cross-site request guard: state-changing verbs must come from this app's own origin. An
// absent Origin (curl, server-to-server) passes; a matching ORIGIN or a same-Host origin
// passes (dev servers and direct LAN access never know ORIGIN). GET/HEAD are never refused.
function originAllowed(req) {
  const o = req.headers.origin;
  if (!o) return true;
  if (ORIGIN && String(o).replace(/\/$/, '') === ORIGIN.replace(/\/$/, '')) return true;
  try { return new URL(o).host === req.headers.host; }
  catch { return false; }
}
/* ---------- throttles ---------- */
// TRUST_PROXY: how many trusted proxies sit in front of this API. With 0 (default) the
// socket address IS the client IP and any X-Forwarded-For is ignored — a spoofed header can
// neither dodge a bucket nor frame another client. With N, the client IP is the N-th address
// from the RIGHT of XFF (the one your own proxy appended); anything further left is
// client-controlled and never trusted.
function clientIp(req) {
  const n = Math.max(0, Math.trunc(+(process.env.TRUST_PROXY || 0)) || 0);
  if (n > 0) {
    const ips = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    const pick = ips[ips.length - n];
    if (pick) return pick;
  }
  return req.socket.remoteAddress || 'unknown';
}

// Attempt buckets: { start, count, windowMs }. Pruned every 5 minutes and hard-capped, so an
// attacker spraying random keys cannot grow the map without bound.
const buckets = new Map();          // key -> { start, count, windowMs }
const BUCKET_CAP = Math.max(1000, Math.trunc(+(process.env.BUCKET_CAP || 10000)) || 10000);
function bucketBlocked(key, max, windowMs) {
  const b = buckets.get(key);
  return !!b && Date.now() - b.start <= windowMs && b.count >= max;
}
function bucketHit(key, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now - b.start > windowMs) buckets.set(key, { start: now, count: 1, windowMs });
  else b.count++;
  if (buckets.size > BUCKET_CAP) {
    let drop = buckets.size - BUCKET_CAP;   // Map iterates in insertion order — oldest first
    for (const k of buckets.keys()) { if (drop-- <= 0) break; buckets.delete(k); }
  }
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now - b.start > b.windowMs) buckets.delete(k);
}, 5 * 60_000).unref();
export const _buckets = buckets;                                       // tests only
export function _pruneBuckets(now = Date.now()) {                      // tests only
  for (const [k, b] of buckets) if (now - b.start > b.windowMs) buckets.delete(k);
  return buckets.size;
}
export function _bucketHit(key, windowMs) { bucketHit(key, windowMs) } // tests only

// Once per boot: the first per-IP rejection logs the resolved client IP (never a phone
// number) so the operator can sanity-check their proxy chain.
let throttleWarned = false;
function warnThrottle(ip) {
  if (throttleWarned) return;
  throttleWarned = true;
  console.log(`throttle: per-IP limit reached for client ${ip} — if every member shares one IP, TRUST_PROXY is set wrong`);
}

// Limits. Everyone at one gym may sit behind one IP, so the per-IP register cap is modest
// and every value is env-tunable; windows are the ones the UI messages quote.
const LOGIN_WINDOW = 15 * 60_000, LOGIN_PHONE_MAX = 10;
const LOGIN_IP_MAX = Math.max(1, Math.trunc(+(process.env.LOGIN_IP_MAX || 30)) || 30);
const REGISTER_IP_MAX = Math.max(1, Math.trunc(+(process.env.REGISTER_IP_MAX || 10)) || 10);
const CREDENTIALS_IP_MAX = Math.max(1, Math.trunc(+(process.env.CREDENTIALS_IP_MAX || 10)) || 10);
const REGISTER_WINDOW = 60 * 60_000;

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
  'GET /api/config': async (req, res) => json(res, 200, { invite_only: INVITE_ONLY, club_name: CLUB_NAME, media_migrate: isMediaMigrate() }),

  'GET /api/me': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    json(res, 200, { user: publicUser(user) });
  },

  'POST /api/register': async (req, res) => {
    const body = await readBody(req);
    const regKey = `reg:${clientIp(req)}`;
    if (bucketBlocked(regKey, REGISTER_IP_MAX, REGISTER_WINDOW)) return json(res, 429, { error: 'too many sign-up attempts — try again later' });
    bucketHit(regKey, REGISTER_WINDOW);   // every attempt counts, so bulk sign-ups burn the budget
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
    if (invite) { user.invitedBy = invite.code; invite.usedBy = user.id; invite.usedAt = user.created; }
    db.users.push(user);
    saveDb();
    json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user) });
  },

  'POST /api/login': async (req, res) => {
    const body = await readBody(req);
    const phone = normalizePhone(body.phone);
    const ip = clientIp(req);
    const phoneKey = `login:${ip}:${phone || String(body.phone || '').slice(0, 40)}`;
    const ipKey = `lip:${ip}`;
    if (bucketBlocked(phoneKey, LOGIN_PHONE_MAX, LOGIN_WINDOW) || bucketBlocked(ipKey, LOGIN_IP_MAX, LOGIN_WINDOW)) {
      if (bucketBlocked(ipKey, LOGIN_IP_MAX, LOGIN_WINDOW)) warnThrottle(ip);
      return json(res, 429, { error: 'too many sign-in attempts — try again in 15 minutes' });
    }
    const user = db.users.find(u => u.phone === phone);
    // one scrypt run either way — an unknown number burns the same time as a wrong password
    // (the verify deliberately runs even when the user is missing — no short-circuit)
    const record = (user && user.password) ? user.password : DUMMY_PASSWORD;
    const ok = verifyPassword(String(body.password || ''), record);
    if (!user || !ok) {
      bucketHit(phoneKey, LOGIN_WINDOW);   // only failures count against the caps
      bucketHit(ipKey, LOGIN_WINDOW);
      return json(res, 401, { error: 'mobile number or password is incorrect' });
    }
    if (user.disabled) return json(res, 403, { error: 'this account has been disabled' });
    buckets.delete(phoneKey);
    json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user) });
  },

  // Existing signed-in profiles can attach credentials to the same id, preserving their data.
  'POST /api/account/credentials': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const credKey = `cred:${clientIp(req)}`;
    if (bucketBlocked(credKey, CREDENTIALS_IP_MAX, REGISTER_WINDOW)) return json(res, 429, { error: 'too many attempts — try again later' });
    bucketHit(credKey, REGISTER_WINDOW);
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
    let stored;
    try { stored = readState(user.id); }
    catch (e) {
      console.error('GET /api/data', e.message);
      return json(res, 500, { error: 'state file corrupt — not overwriting; ask the server operator to restore it' });
    }
    json(res, 200, { state: stateView(user.id, stored) });
  },

  'PUT /api/data': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (!body.state || typeof body.state !== 'object') return json(res, 400, { error: 'state required' });
    // A corrupt existing file is data we cannot read — never overwrite it with whatever the
    // client has (that would look like a healthy sync while history is destroyed).
    let current;
    try { current = readState(user.id); }
    catch (e) {
      console.error('PUT /api/data', e.message);
      return json(res, 500, { error: 'state file corrupt — not overwriting; ask the server operator to restore it' });
    }
    delete body.state.active;              // in-progress workouts stay device-local
    delete body.state.coachProgram;        // coach-owned assignment is never accepted from a member client
    delete body.state.rev;                 // rev is server-owned; a client-sent value is ignored
    const assignment = assignmentFor(user.id);
    const assignedIds = new Set((assignment?.routines || []).map(r => r.id));
    body.state.routines = (body.state.routines || []).filter(r => r && !r.coachManaged && !assignedIds.has(r.id));
    if (assignment) {
      const savedWeek = (current && current.week) || {};
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
    // rev gate — compare and write with no await in between (single-process assumption,
    // documented above the db definition), so two racing PUTs serialize cleanly.
    const currentRev = current && typeof current.rev === 'number' ? current.rev : 0;
    if (body.baseRev != null && body.baseRev !== currentRev) {
      // stale client: hand back the server's current view so it can merge — nothing is written
      return json(res, 409, { error: 'conflict', rev: currentRev, state: stateView(user.id, current) });
    }
    body.state.rev = currentRev + 1;
    atomicWrite(stateFile(user.id), JSON.stringify(body.state));
    json(res, 200, { ok: true, rev: body.state.rev, ts: body.state._ts || null });
  },

  // Personal media upload — raw bytes, not JSON/base64. Same-origin guard and the media
  // upload throttle apply; the 1 MB cap rejects before the body is fully read.
  'POST /api/media': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const ip = clientIp(req);
    const upKey = `media:${ip}`;
    if (bucketBlocked(upKey, mediaEnvMax('MEDIA_UPLOAD_IP_MAX', 60), REGISTER_WINDOW)) {
      warnThrottle(ip);
      return json(res, 429, { error: 'too many uploads — try again later' });
    }
    const ctype = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ctype !== 'image/gif' && ctype !== 'video/mp4') return json(res, 415, { error: 'send the raw file with Content-Type image/gif or video/mp4' });
    let buf;
    try { buf = await readRawBody(req, MEDIA_MAX_BYTES_PER_FILE); }
    catch { return json(res, 413, { error: 'media must be 1 MB or smaller' }); }
    if (!buf.length) return json(res, 415, { error: 'empty body' });
    const kind = mediaKind(buf);
    if (!kind || (kind === 'gif' && ctype !== 'image/gif') || (kind === 'mp4' && ctype !== 'video/mp4'))
      return json(res, 415, { error: 'content does not match the declared type — GIF must start with GIF87a/89a, MP4 with ftyp' });
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    // quota, file write and index update share one sync block (no await in between)
    let entry = mediaIndex[hash];
    if (!entry) {
      const maxFiles = mediaEnvMax('MEDIA_MAX_FILES', 40);
      const maxBytes = mediaEnvMax('MEDIA_MAX_BYTES', 30 * 1048576);
      const usage = mediaUsage(user.id);
      if (usage.files + 1 > maxFiles || usage.bytes + buf.length > maxBytes) {
        warnThrottle(ip);
        return json(res, 413, { error: `media quota reached — ${maxFiles} files / ${Math.round(maxBytes / 1048576)} MB per profile` });
      }
      const file = path.join(MEDIA_DIR, `${hash}.${kind}`);
      const tmp = file + '.tmp';
      const fd = fs.openSync(tmp, 'w', 0o600);
      try { fs.writeFileSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file);
      mediaIndex[hash] = { ext: kind, size: buf.length, owners: [user.id], created: new Date().toISOString() };
    } else {
      // dedupe: same bytes → same file, the caller just joins the owners list
      if (!entry.owners.includes(user.id)) entry.owners.push(user.id);
      const file = path.join(MEDIA_DIR, `${hash}.${entry.ext}`);
      if (!fs.existsSync(file)) {
        const tmp = file + '.tmp';
        const fd = fs.openSync(tmp, 'w', 0o600);
        try { fs.writeFileSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(tmp, file);
      }
    }
    saveMediaIndex();
    json(res, 200, { h: hash, e: kind, size: buf.length });
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
      let S;
      try { S = readState(u.id) || {}; }
      catch (e) { S = { corrupt: true }; }   // additive flag — one broken file must not take the list down
      const workouts = S.workouts || [];
      const last = workouts[workouts.length - 1];
      return {
        id: u.id, name: u.name, phone: u.phone || null, created: u.created || null,
        disabled: !!u.disabled, admin: isAdmin(u), envAdmin: ADMIN_UIDS.includes(u.id), role: isCoach(u) ? 'coach' : 'member', invitedBy: u.invitedBy || null,
        coach: isCoach(u) || isAdmin(u) ? null : coachOf(u.id),
        corrupt: !!S.corrupt,
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
    let S;
    try { S = readState(u.id) || {}; }
    catch (e) { console.error('GET /api/admin/user', e.message); return json(res, 500, { error: 'state file corrupt' }); }
    json(res, 200, {
      user: { id: u.id, name: u.name, phone: u.phone || null, created: u.created || null, disabled: !!u.disabled, admin: isAdmin(u), envAdmin: ADMIN_UIDS.includes(u.id), role: isCoach(u) ? 'coach' : 'member', invitedBy: u.invitedBy || null, coach: coachOf(u.id) },
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

  // The gym owner wires a member to a coach from the panel (coachId null to unlink). One coach
  // per member: linking replaces any previous link and drops whatever the previous coach had
  // assigned, so the member starts their new coach's program from a clean slate.
  'POST /api/admin/user/coach': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (isAdmin(u)) return json(res, 400, { error: 'an admin cannot be assigned to a coach' });
    if (u.role === 'coach') return json(res, 400, { error: 'a coach cannot be assigned to a coach' });
    const coachId = body.coachId ? String(body.coachId) : null;
    if (coachId) {
      if (coachId === u.id) return json(res, 400, { error: 'a member cannot be their own coach' });
      const coach = db.users.find(x => x.id === coachId);
      if (!coach || !isCoach(coach)) return json(res, 404, { error: 'no such coach' });
    }
    db.coachLinks = db.coachLinks.filter(x => x.memberId !== u.id);
    db.coachAssignments = db.coachAssignments.filter(x => x.memberId !== u.id);
    if (coachId) {
      db.coachLinks.push({ coachId, memberId: u.id, active: true, created: new Date().toISOString() });
      u.coachId = coachId;
    } else {
      delete u.coachId;
    }
    saveDb();
    json(res, 200, { ok: true, coach: coachOf(u.id) });
  },

  // Promote/demote an admin. Self-change is refused so the last admin can't lock themselves out
  // in one tap, and ADMIN_UIDS entries can't be demoted because the env var would re-admin them
  // on the next boot anyway — the UI hides the button for both cases.
  'POST /api/admin/user/admin': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (u.id === admin.id) return json(res, 400, { error: 'you cannot change your own admin status' });
    if (!body.admin && ADMIN_UIDS.includes(u.id)) return json(res, 400, { error: 'this admin is managed by server configuration (ADMIN_UIDS)' });
    if (body.admin) u.admin = true; else delete u.admin;
    saveDb();
    json(res, 200, { user: publicUser(u) });
  },

  // Admin sets a member's password. Passwords are one-way hashed (scrypt), so there is
  // nothing to "recover" — this writes a replacement. Admins are refused outright, same as
  // disable/role: an ordinary admin must not be able to take over the owner account, and
  // the env var would re-admin ADMIN_UIDS entries anyway. The sv bump kills the member's
  // live sessions (same mechanism as logout/all), so they re-sign-in with the new password.
  'POST /api/admin/user/password': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (isAdmin(u)) return json(res, 400, { error: 'cannot reset an admin password' });
    if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 200)
      return json(res, 400, { error: 'password must be at least 8 characters' });
    u.password = passwordRecord(body.password);
    u.sv = (u.sv || 0) + 1;
    saveDb();
    json(res, 200, { ok: true, id: u.id });
  },

  'GET /api/coach/clients': async (req, res) => {
    const coach = requireCoach(req, res); if (!coach) return;
    const links = db.coachLinks.filter(x => x.coachId === coach.id && x.active !== false);
    const clients = links.map(link => {
      const u = db.users.find(x => x.id === link.memberId);
      if (!u || u.disabled) return null;
      let state;
      try { state = readState(u.id) || {}; }
      catch (e) { state = { corrupt: true }; }   // additive flag — see GET /api/admin/users
      const workouts = state.workouts || [];
      return { id: u.id, name: u.name, disabled: !!u.disabled, created: u.created || null,
        corrupt: !!state.corrupt,
        workouts: workouts.length, lastWorkout: workouts.at(-1)?.d || null,
        assignment: db.coachAssignments.find(x => x.coachId === coach.id && x.memberId === u.id) || null };
    }).filter(Boolean);
    json(res, 200, { clients });
  },

  'GET /api/coach/client': async (req, res) => {
    const coach = requireCoach(req, res); if (!coach) return;
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    if (!coachLink(coach.id, id)) return json(res, 404, { error: 'client is not linked to this coach' });
    const u = db.users.find(x => x.id === id);
    if (!u) return json(res, 404, { error: 'no such user' });
    let S;
    try { S = readState(id) || {}; }
    catch (e) { console.error('GET /api/coach/client', e.message); return json(res, 500, { error: 'state file corrupt' }); }
    json(res, 200, { user: { id: u.id, name: u.name, disabled: !!u.disabled, created: u.created || null },
      // the client's own body preference drives which anatomy the muscle map draws
      body: S.body || 'male',
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

// Exported for tests (api/server.test.js): importing this module starts nothing, so a test
// can create its own server on port 0 with a temp DATA_DIR. Direct runs behave exactly as before.
export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    // media GET/HEAD are handled before everything else (own session check inside)
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/api/media/')) {
      return serveMedia(req, res, url.pathname);
    }
    // cross-site state-changing requests are refused before anything else runs
    if (req.method !== 'GET' && req.method !== 'HEAD' && !originAllowed(req)) {
      return json(res, 403, { error: 'cross-origin request refused' });
    }
    const key = req.method + ' ' + url.pathname;
    const handler = routes[key];
    if (!handler) return json(res, 404, { error: 'not found' });
    try { await handler(req, res); }
    catch (e) {
      console.error(key, e);
      if (!res.headersSent) json(res, 500, { error: 'server error' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const server = createServer();
  server.listen(PORT, () => console.log(`gym-api on :${server.address().port} (TRUST_PROXY=${Math.max(0, Math.trunc(+(process.env.TRUST_PROXY || 0)) || 0)})`));
}
