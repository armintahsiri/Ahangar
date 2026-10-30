# Self-hosting openGym

openGym is two small containers (a web server and an API) plus a folder of your data.
This guide takes you from "just cloned it" to "using it from my phone over the internet".

## 1. Run it locally (5 minutes)

Requirements: [Docker](https://docs.docker.com/get-docker/) with the Compose plugin.

```bash
git clone https://github.com/Jenesyx/opengym-fa.git
cd opengym-fa
cp .env.example .env
docker compose up -d --build
```

- First start downloads the exercise images/GIFs (~140 MB) once into `media/img` and `media/gif`.
- Open **http://localhost:8080** and create a profile with your mobile number and password.
- The Compose command builds this fork from source, including the Persian UI. Node is not needed locally.

Check it's healthy:

```bash
docker compose ps
curl http://localhost:8080/api/health      # {"ok":true,...}
```

Logs: `docker compose logs -f`. Stop: `docker compose down`.

## 2. Accounts and secure connections

Accounts use a mobile number and password. Use at least 8 characters for the password. Passwords
are stored as one-way scrypt hashes. For use over the internet, put the app behind HTTPS so login
details and session cookies are protected in transit. Plain HTTP is suitable only for trusted local
testing; guest mode keeps data only in that browser.

If you already had a passkey account, open the running app while your existing session is still
signed in. In **Settings → Account**, choose **Set mobile number and password**. This attaches the
new sign-in to the same account and preserves its workout history and coach relationship. Do this
before signing out; old passkeys are no longer accepted after upgrading.

## 3. Expose it over HTTPS on your own domain

Put openGym behind something that terminates TLS for a hostname you control, then point it at
the `web` container. Pick whichever you already run:

### Option A — Cloudflare Tunnel (no open ports)

1. Create a tunnel and route `gym.example.com` → `http://<docker-host>:8080`.
2. Cloudflare gives you HTTPS automatically.

### Option B — Caddy (automatic Let's Encrypt)

```caddy
gym.example.com {
    reverse_proxy localhost:8080
}
```

### Option C — Traefik / nginx / Nginx Proxy Manager

Route `gym.example.com` (HTTPS) → `web:80` (or `<docker-host>:8080`). Any reverse proxy works —
openGym only needs the browser to reach it over `https://gym.example.com`.

Then set the public address in `.env` and restart:

```bash
# .env
ORIGIN=https://gym.example.com
WEB_PORT=8080
```

```bash
docker compose up -d
```

Visit `https://gym.example.com`, create your profile, and add it to your home screen
(iOS: Share → Add to Home Screen · Android: ⋮ → Add to Home screen).

## 4. Multiple users

Anyone who can reach the URL can create their own profile — each gets isolated data. That's the
default: open signup, no admin.

If you'd rather control who gets in, two optional settings in `.env` turn that around:

```bash
ADMIN_UIDS=youruserid      # comma-separated; these users get the admin dashboard
INVITE_ONLY=1              # new profiles need an invite code
```

Register your own profile first, then find your id in `./data/db.json` under `users[].id`
and put it in `ADMIN_UIDS`. You'll get an **Admin dashboard** link in Settings: who's training
right now, each user's workout history and body weight, the ability to disable an account (signed
out and locked out everywhere until you re-enable it), and — with `INVITE_ONLY=1` — generating and
revoking invite codes. Existing accounts keep working when you switch invite-only on. Admin access
is gated by your account session and enforced server-side, so it needs no separate login.

Prefer to keep the whole thing off the open internet? A VPN or an auth proxy (Authelia, Cloudflare
Access…) in front still works, and composes with the above.

## 5. Club and coach mode

One openGym server can be used as a club-branded member app. Set `CLUB_NAME` to the club's display
name and `INVITE_ONLY=1` so new accounts need an invitation; keep the server's `/data` volume
persistent. The club admin can promote a
member account to coach in **Admin → user → Make coach**. A coach then opens **Settings → Coach
dashboard**, creates a member invite, and shares its one-time code. When the invited member creates
their account, it is linked to that coach.

Coaches create routine templates in **Plan**, then assign a separate snapshot to each client and
choose its weekday in the coach dashboard. Later template changes do not change an already assigned
plan; assign the updated template again to publish a new version. Members can view assigned plans
and log the sets they actually complete. They cannot edit the coach-owned assignment. A workout
report is written only to the signed-in member's own account; coaches can read linked clients'
reports but cannot submit or edit those reports.

This is a club pilot workflow, not a full gym-management system: it does not handle dues, class
booking, or membership-system integrations. The admin account can still inspect all user histories,
so use it only for trusted club operators and explain that access to members. Exercise media has
separate upstream terms; review them before offering a commercial deployment.

## 6. Backups

Everything is in `./data`:

```bash
tar czf opengym-backup-$(date +%F).tar.gz data/
```

That archive contains all profiles, password hashes and workout history. Restore by unpacking it back
into the project folder. (Individual users can also export their own data as JSON from Settings.)

## 6. Notifications

openGym can push two kinds of alert to your phone/desktop, even when the app isn't open:
rest-timer-over, and a reminder on days you have a workout planned but haven't logged one yet.
Turn it on per-profile in **Settings → Notifications** (requires a signed-in account and
HTTPS — see section 3).

No setup needed server-side, and nothing to configure per timezone: VAPID keys are generated on
first run and saved to `./data/vapid.json`, and each user's browser reports its own timezone
automatically when they turn the reminder on — it fires at their local time, and follows them if
they travel, regardless of what timezone the server itself runs in.

**Keep screen awake** (Settings → *During a workout*) has the same transport requirement: the
Wake Lock API is only available over HTTPS or on `http://localhost`, so on a plain-LAN-IP
instance the switch shows as unsupported. Nothing to configure server-side either way, and iOS
refuses the lock while the phone is in Low Power Mode.

## 7. Updating

Build the current fork from source:

```bash
git pull
docker compose up -d --build
```

The app shell is versioned (`?v=N`) so clients pick up changes on next load. Your `./data` and the
downloaded media are untouched.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Login does not work securely over the internet | Set up HTTPS and set `ORIGIN` to the public HTTPS address. |
| Media didn't download | `docker compose logs media`. Re-run `docker compose up -d`, or run `./scripts/fetch-media.sh`. |
| Port 8080 already used | Set `WEB_PORT=9090` in `.env` (and update `ORIGIN` for local testing). |
| No "Notifications" option in Settings | Requires a signed-in profile and HTTPS (or `localhost`) — guest mode and plain HTTP over LAN can't subscribe. |
| Day reminder fires at the wrong time | Toggle it off and on in Settings so it re-detects your browser's timezone (also happens automatically on every app load — see section 6). |
| Want to reset a stuck login | Delete the cookie in your browser; sessions are just signed cookies. |
| Docker cannot pull a base image | Check registry/network access, then retry `docker compose up -d --build`. |
