// Break-glass password reset for openGym operators — the out-of-app way back in when nobody
// can sign in (including the admin).
//
// ⚠  STOP THE API FIRST:  docker compose stop api
// The running server holds db.json in memory and rewrites the whole file on its next save —
// an edit made underneath it would be silently lost. Restart the API after this script exits.
//
// Usage:
//   node scripts/reset-password.mjs --uid <user-id> [--data /path/to/data]
//   node scripts/reset-password.mjs --phone 0912...      [--data /path/to/data]
// The new password is read from the terminal with input hidden (TTY) or from stdin:
//   printf '%s' 'new-password' | node scripts/reset-password.mjs --phone 0912...
// The password NEVER travels as a command-line argument (it would land in shell history).
// The hash function and the atomic 0600 write are imported from api/server.js — no copy.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined };

const DATA = arg('--data') || process.env.DATA_DIR || '/data';
const uid = arg('--uid');
const phoneArg = arg('--phone');
if (!uid === !phoneArg) {   // exactly one of the two
  console.error('Usage: node scripts/reset-password.mjs --uid <user-id> | --phone <number> [--data <dir>]');
  console.error('Give exactly one of --uid or --phone. The API must be stopped (docker compose stop api).');
  process.exit(1);
}
if (!fs.existsSync(path.join(DATA, 'db.json'))) {
  console.error(`FATAL: no db.json under ${DATA} — pass --data /path/to/data (the folder the API uses).`);
  process.exit(1);
}

// Point the server module at the same data dir before it loads (it validates db.json on the
// way in and fails fast if the file is corrupt — a useful side effect here too).
process.env.DATA_DIR = DATA;
const { passwordRecord, atomicWrite, normalizePhone } = await import(new URL('../api/server.js', import.meta.url).href);

function askPassword() {
  return new Promise(resolve => {
    if (!process.stdin.isTTY) {          // piped: printf '%s' 'pw' | node reset-password.mjs …
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', d => { buf += d });
      process.stdin.on('end', () => resolve(buf.trim()));
      return;
    }
    process.stdout.write('New password (min 8 characters, input hidden): ');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    let buf = '';
    const onData = ch => {
      if (ch === '\r' || ch === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(buf);
      } else if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130) }   // Ctrl-C
      else if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
      else if (ch >= ' ' && ch <= '~') buf += ch;   // printable ASCII only, like the API accepts
    };
    process.stdin.on('data', onData);
  });
}

const password = await askPassword();
if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
  console.error('FATAL: the password must be 8–200 characters.');
  process.exit(1);
}

const dbFile = path.join(DATA, 'db.json');
const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
const phone = phoneArg ? normalizePhone(phoneArg) : null;
if (phoneArg && !phone) { console.error(`FATAL: "${phoneArg}" is not a usable mobile number (try the international form, e.g. +98912…).`); process.exit(1); }
const user = uid ? db.users.find(u => u.id === uid) : db.users.find(u => u.phone === phone);
if (!user) { console.error('FATAL: no such user in db.json.'); process.exit(1); }

const oldHash = user.password?.hash;
user.password = passwordRecord(password);
user.sv = (user.sv || 0) + 1;   // bumps the session version — every signed-in device must re-login
atomicWrite(dbFile, JSON.stringify(db, null, 2));

console.log(`✓ Password replaced for ${user.name} (${user.phone || user.id}).`);
console.log('✓ Session version bumped — all their devices are signed out.');
console.log(oldHash === user.password.hash ? '⚠ The stored hash did not change — the new password equals the old one.' : '✓ db.json written atomically with owner-only permissions.');
console.log(`⚠ Start the API again now:  docker compose start api   (or docker compose up -d)`);
