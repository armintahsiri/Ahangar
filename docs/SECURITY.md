# Security notes for operators

Practical notes for running an openGym instance. Nothing here changes the app's behavior —
these are the things you need to know when something goes wrong.

## 1. Recovering a locked-out account (including the admin)

Passwords are stored as one-way scrypt hashes — there is nothing to "look up". The way back in
is a controlled rewrite with the bundled script:

```bash
docker compose stop api          # the API holds db.json in memory and rewrites it on save
node scripts/reset-password.mjs --phone 09121234567 --data ./data
# …type the new password (input is hidden), or pipe it:
printf '%s' 'new-password' | node scripts/reset-password.mjs --uid <user-id> --data ./data
docker compose start api
```

- Works for any account, admins included — it is the operator's break-glass tool. Use it on
  your own instance, for your own members.
- The script bumps the account's session version, so every signed-in device is signed out and
  must log in with the new password.
- `db.json` is rewritten atomically with owner-only file permissions.

## 2. The `./data` folder is a credential store

A backup of `./data` contains everything an attacker needs to impersonate your instance:

| File | What it is | Sensitivity |
|---|---|---|
| `db.json` | accounts, scrypt password hashes, invite codes | personal data + password hashes |
| `state-<user>.json` | each member's plan, workouts, body weight | personal data |
| `secret` | the HMAC key that signs session cookies | **whoever holds it can mint valid sessions for any user id** |
| `vapid.json` | web-push private key | lets the holder send push as your server |

Back it up, yes — but store the backup the way you would store a password: encrypted, off the
web server, never committed to git. If `secret` ever leaks, delete it and restart the API
(a fresh key is generated; every cookie is invalidated and everyone signs in again).

## 3. Rest-timer notifications live in memory

The "rest over" push is scheduled in the API's memory (`POST /api/push/rest-timer`) and
cancelled by the client when you're back on screen. If the API restarts while a rest timer is
running, that one alert is silently gone — everything else (workout-day reminders, subscriptions)
is persisted in `db.json` and survives restarts.

## 4. Environment knobs that matter

| Variable | Effect |
|---|---|
| `ORIGIN` | must be the exact public URL — also the anchor of the cross-origin guard on POST/PUT |
| `INVITE_ONLY` | require an invite code per signup (recommended for anything internet-facing) |
| `TRUST_PROXY` | how many proxy hops are trusted for client-IP throttling (compose sets 1) |
| `LOGIN_IP_MAX` / `REGISTER_IP_MAX` / `CREDENTIALS_IP_MAX` | per-IP throttle ceilings |

## 5. Reporting

Please report vulnerabilities privately via the repository's security advisory feature rather
than a public issue — see SECURITY policy at the repository root.
