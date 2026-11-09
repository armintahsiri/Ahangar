<div align="center">

<img src="assets/banner.png" alt="openGym" width="720">

<br>

**A self-hosted gym & body-weight tracker you actually own.**

Plan your week, run guided workouts, track every set and your body weight over time —
on your phone, synced across devices, with mobile-number and password sign-in.
No account on someone else's server, no subscription, no ads. Just `docker compose up`.

<br>

[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-a3e635?style=flat-square)](LICENSE)
![Self-hosted](https://img.shields.io/badge/self--hosted-%F0%9F%8F%A0-60a5fa?style=flat-square)
![PWA](https://img.shields.io/badge/PWA-installable-a78bfa?style=flat-square)
![React](https://img.shields.io/badge/React-19-38bdf8?style=flat-square&logo=react&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-compose-2496ED?style=flat-square&logo=docker&logoColor=white)
![No tracking](https://img.shields.io/badge/telemetry-none-f472b6?style=flat-square)
<br>
![GitHub last commit](https://img.shields.io/github/last-commit/Jenesyx/opengym-fa?style=flat-square)
[![GitHub stars](https://img.shields.io/github/stars/Jenesyx/opengym-fa?style=flat-square)](https://github.com/Jenesyx/opengym-fa/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/Jenesyx/opengym-fa?style=flat-square)](https://github.com/Jenesyx/opengym-fa/issues)

</div>

<br>

**English** · [فارسی](README.fa.md)

Created and maintained by **[Arta (Jenesyx)](https://github.com/Jenesyx)** · [Repository](https://github.com/Jenesyx/opengym-fa)

# If you are not a developer, read this

You do **not** need to own a server or know how to program. You need a free GitHub account,
an account with a hosting provider, and an AI coding assistant that can work with your GitHub
repository. The AI can prepare the deployment while the hosting provider keeps the website online.

> **Important:** for the complete app, choose hosting that supports **Docker and persistent
> storage**, such as Railway or Render. openGym is not only a static website: its API stores your
> profile, password hash and workout history. A normal Vercel or Netlify static deployment publishes only
> the frontend and is **not a complete installation**. Use those platforms only if an experienced
> developer or AI first adapts both the API and persistent data storage.

## 1. Put your own copy in your GitHub account

1. Sign in to [GitHub](https://github.com/).
2. Open [Jenesyx/opengym-fa](https://github.com/Jenesyx/opengym-fa).
3. Click **Fork** in the top-right corner.
4. On the next page, select your GitHub account as **Owner**, keep the repository name
   `opengym-fa`, and click **Create fork**.
5. Wait until GitHub opens `https://github.com/YOUR-NAME/opengym-fa`.

That fork is already the copy inside your account—there is no second upload step.

## 2. Ask AI to put it online

The simplest reliable route is to give an AI assistant access to your fork and ask it to deploy
the **whole Docker application** to a managed host. [Railway](https://railway.com/) and
[Render](https://render.com/) are examples; they provide the online computer, HTTPS address and
persistent disk, so you do not manage a physical server. A persistent service or disk may require
a paid plan—check the provider's current price before confirming.

Copy this prompt, replace `YOUR-NAME`, and send it to Codex, ChatGPT, Claude, or another coding
assistant that can edit your repository:

```text
I am not a developer. Please deploy my fork of openGym-fa and guide me one small step at a time:
https://github.com/YOUR-NAME/opengym-fa

I want the complete application online, including the frontend, Node API, exercise media,
phone/password login, and permanent workout data. Choose a managed Docker host such as Railway or
Render. I do not own a server. Before choosing a paid plan, tell me the current cost and ask me.

Requirements:
1. Work only in my fork. Preserve the Persian and English interface.
2. Do not make a frontend-only Vercel or Netlify deployment. If I insist on either platform,
   explain that the API and persistent storage must be migrated and verify the complete result.
3. Create or repair the deployment configuration needed by the chosen host.
4. Attach persistent storage and make the API use it for /data. My profiles and workout
   history must survive a restart and redeployment.
5. Use the final HTTPS address for ORIGIN.
6. Never commit or reveal .env files, session secrets, cookies, data/db.json, or backups.
7. Enable automatic deployment from my fork, but ask before changing billing, domains or access.
8. Verify the public homepage returns HTTP 200 and /api/health returns JSON containing ok: true.
9. Restart or redeploy once and verify that a test profile/data still exists afterward.
10. Show me the exact public URL, how to create my first profile, how to make access invite-only,
    how to install the website on my phone, how to back up /data, and how future GitHub changes
    are deployed.

Do not say it is finished until the frontend, API, HTTPS login, media and persistent data
have all been checked. If you need me to click something, give the exact button name and its
location on the current screen.
```

## 3. Open and use your website

When the AI gives you the final `https://...` address:

1. Open it and choose **Create profile**.
2. Create an account with your mobile number and a password of at least 8 characters.
3. For Persian, open **Settings → General → Language → فارسی**.
4. Open **Plan**, create a routine and assign it to weekdays.
5. Press the center **Start** button on a workout day.
6. Use **Settings → Data → Export backup** regularly.
7. Install it like an app: Android/Chrome **⋮ → Add to Home screen**; iPhone/Safari
   **Share → Add to Home Screen**.

The website URL itself is **not a password**. Unless access protection or invite-only signup is
enabled, anyone who knows the URL can open the registration screen. Ask the AI to help you create
your own profile first and then enable invite-only access if the site should be private.

## 4. Edit your copy later

- On your fork's GitHub page, press the **`.`** key to open GitHub's browser editor, or open the
  repository in your preferred AI coding tool.
- Ask the AI for the change you want, review it, and let it **commit and push to your fork**.
- If automatic deployment is connected, the hosting provider will rebuild the site after the push.
- Never upload `.env`, `data/`, exported backups or secret values to GitHub.

If you only want to try the app on one computer and do not need a public website, skip cloud
hosting and follow [Quick start (self-host)](#quick-start-self-host) below.

<div align="center">
<table>
<tr>
<td align="center"><img src="assets/screenshots/home.png" alt="Home" width="230"><br><sub><b>Home</b> — today's workout & weight</sub></td>
<td align="center"><img src="assets/screenshots/workout.png" alt="Workout" width="230"><br><sub><b>Guided workout</b> — animated demos & sets</sub></td>
<td align="center"><img src="assets/screenshots/stats.png" alt="Stats" width="230"><br><sub><b>Stats</b> — heatmap, charts & PRs</sub></td>
</tr>
</table>
</div>

<div align="center">

### [GitHub repository](https://github.com/Jenesyx/opengym-fa) · [Releases](https://github.com/Jenesyx/opengym-fa/releases)

The complete Persian/English source, setup guides, releases and issue tracker live in this repository.<br>
<sub>Created and maintained by Arta under the GitHub identity Jenesyx.</sub>

</div>

## Why

Most workout apps lock your data behind a login on their servers, nag you to upgrade, or
disappear when the startup does. openGym is the opposite: **it runs on your box, your data
stays in a folder you control, and it's yours to fork.** It still feels modern — installable
as a home-screen app, password sign-in, offline support, sync across your phone and laptop.

## Features

- ⚖️ **Body-weight tracking** — interactive chart with a goal line you set, gains/losses colored by whether they move toward it
- 🏋️ **Weekly plan** — a routine per weekday, over a library of **1,324 exercises** (searchable, with animated demos)
- 🗓️ **Reschedule any day** — sick, missed a session, or fewer gym days this week? Move a workout to another day without touching your weekly plan
- ▶️ **Guided workouts** — it knows what day it is and starts today's session; asks your body weight first, pre-fills your weights from last time, rest timer, PR detection, per-exercise weight tracking
- ☀️ **The screen stays awake while you train** — no unlocking the phone and finding your place again between every set. On for as long as a workout is running, released the moment you finish it, and switchable off in Settings
- 🔗 **Supersets** — build them, and log them back-to-back with a rest only after the pair
- ⏱️ **Timed exercises** — planks, hangs, wall sits and loaded carries are logged by time, not reps, with a work timer that counts the set itself (separate from the rest timer) and logs the time you actually held. They can carry weight too
- 📈 **Progression that follows a rule** — pick one per routine, override it per exercise: linear, **Greyskull LP** (AMRAP top set, double jumps, 10 % resets), double progression through a rep range, or adding time. Your weights are already right when the session opens, and every target says *why* it's that number. Missed reps never advance the load, stalls trigger a deload, and bodyweight exercises progress in reps instead
- 💪 **Estimated 1RM** — per exercise, from your best eligible set (it names which one), with its own progress curve and a calculator for sets you haven't done. Won't guess above 12 reps
- 🎯 **Effort per set, in your scale** — an optional third column rating how hard a set was, as **RIR** (reps left in the tank) or **RPE** (the same judgement on a 10-point scale). Off by default; each set keeps the scale it was logged with, and nothing else reads the value — your progression and 1RM are unaffected
- 💪 **Bodyweight exercises, logged as bodyweight** — push-ups, pull-ups, dips and 300-odd others arrive knowing they carry no load, so there's no weight column and no working-weight prompt: one stepper, log the reps. Add a dip belt and it reads as an addition, and progression goes back to following the weight. Without one, reps climb — and past a ceiling you set, a set is added instead of a rep, up to the point where the honest advice is load or a harder variation
- ↔️ **Reps per side** — for lunges, single-arm rows and the rest. You log the total, the app shows the split ("8 per side"), and the target steps in twos so it never lands on a number one side can't have
- 🏃 **Cardio** — log time + speed, not just weight × reps
- 📤 **Share a plan** — send someone your routines and week schedule as a small file (no workouts, no weigh-ins), or print it as a clean PDF. Importing merges, so their plan is never overwritten
- 🔧 **Filter by equipment** — narrow the library to what you actually own; the options adapt to what you've picked, so every combination on screen has results behind it
- ✨ **Your own exercises** — a name and a body part is enough; they behave like built-in ones everywhere, with an optional description instead of an animation
- 🟩 **Activity heatmap** — a GitHub-style year view, shaded by time spent training
- 💪 **Muscle map** — a front-and-back body diagram shaded by how much work each muscle got, over a week, a month or all time. It names the muscles you *haven't* trained in that period, previews what a routine hits while you build it, and shows what you just trained when you finish. Male or female figure, your pick
- 🔔 **Push notifications** — rest-timer alerts even with the app closed, plus an optional reminder on days you have a workout planned but haven't logged one. Opt in per profile; keys are generated on first run, nothing to configure
- 📱 **Mobile number and password sign-in** — each profile keeps its own data, synced across devices
- 🛠️ **Three roles** — the **gym owner** (admin, set via `ADMIN_UIDS`) runs the admin dashboard: who's training right now, per-user history, disable accounts, promote **coaches**, assign members to each coach, and invite-only signup. Each **coach** writes a separate program for every athlete under them, from their own templates; each **athlete** sees their assigned plan read-only and logs the workout they actually did. Off by default, so a fresh instance stays open with no admin
- 🎨 **Designed, not assembled** — light/dark themes and 8 accent colors saved to your profile, over a hand-drawn icon set instead of emoji, so it looks the same on every phone
- 🌍 **English & Persian** — full UI translation in both, right-to-left layout for Persian; exercise instructions localized, loaded on demand so the app stays fast
- 📥 **Bring your history with you** — import from **FitNotes** (Android and iOS), **Strong** and **Hevy**, or body weight straight out of an **Apple Health** export. Exercise names are matched against the library and anything unrecognised becomes one of your own exercises, so nothing in the file is dropped
- 📦 **Yours to keep** — one-tap JSON export/import, guest mode, **no telemetry**
- 📱 **Standalone Android app** — the whole tracker as a sideloadable APK: no account, no server, data on the phone, native workout reminders ([releases](https://github.com/Jenesyx/opengym-fa/releases))

## Quick start (self-host)

You need [Docker](https://docs.docker.com/get-docker/) with Compose.

```bash
git clone https://github.com/Jenesyx/opengym-fa.git
cd opengym-fa
cp .env.example .env
docker compose up -d --build
```

On Windows PowerShell, use `Copy-Item .env.example .env` instead of `cp`.

Open **http://localhost:8080**, tap **Create profile**, and you're in. First launch downloads
the exercise media (~140 MB) once. Docker builds this fork from source, including the Persian UI;
you don't need Node installed for this method.

> Want it reachable from your phone over the internet? You'll need an HTTPS
> domain — a two-line change in `.env`. See **[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)**.

## Local development (npm)

Use Node.js 20.19+ or 22.12+ from the repository root:

```bash
npm install
npm run dev
```

⚠ `npm run dev` uses the same default `./data` folder as the Docker deployment. Do not run the
dev stack and `docker compose` against the same checkout at the same time — both would write
`db.json` (set `DATA_DIR` for one of them if you need both).

Open **http://localhost:5173**. The root dev command starts the React frontend, API, and local
exercise-media server together. Local API data is stored in `./data`.

## How to use the website

1. Open the website and choose **Create profile** for account sync, or **Continue without account** for browser-only guest mode.
2. To use Persian, open **Settings → General → Language → فارسی**. The interface switches to RTL immediately.
3. Open **Plan**, create a routine, add exercises, and assign routines to weekdays. You can also load the starter Push/Pull/Legs plan.
4. On a training day, press the center **Start** button. Enter your body weight, complete each set, and use the rest timer between sets.
5. Open **Stats** and **History** to review workout volume, records, estimated 1RM, body weight, activity, and muscle balance.
6. Open **Settings → Data** to export a JSON backup. Administrators should also back up the server's `./data` folder.

Changing the weight unit (Settings → General) only relabels numbers — existing history is **not converted**, so switching units on a profile with history mixes charts and records.

### Install the website on a phone or desktop

openGym is a PWA. Open the deployed HTTPS website, then:

- **Android/Chrome:** menu **⋮ → Add to Home screen**.
- **iPhone/iPad/Safari:** **Share → Add to Home Screen**.
- **Desktop Chrome/Edge:** use the install icon in the address bar.

For secure sign-in over the internet, use an HTTPS domain. Plain HTTP on a trusted local network can be used for testing; guest mode stores data only in that browser.

On **iOS, Web Push needs iOS 16.4 or later** and only works once openGym has been installed to
the Home Screen (per the Safari steps above) — inside a regular Safari tab the toggle will not
appear.

## AI-assisted setup prompt

For a no-code deployment from your GitHub fork, use the beginner cloud prompt at the top of this
README. The prompt below is for local Docker setup, development, or an existing server/domain.

Copy the prompt below into ChatGPT, Codex, Claude, or another coding assistant. Give the AI access to the cloned repository or paste back every command result it requests.

```text
You are my setup assistant for the openGym Persian/English self-hosted website:
https://github.com/Jenesyx/opengym-fa

Goal: install the app, verify it end to end, and then show me how to use it. Do not claim success until the website and /api/health both respond correctly.

First ask me:
1. My operating system (Windows, macOS, or Linux).
2. Whether I want a quick local setup, local development, or a public HTTPS deployment.
3. Whether Docker with Compose is installed.
4. If public: the exact domain/subdomain I control and which reverse proxy or tunnel I use.

Recommended normal installation:
1. Clone https://github.com/Jenesyx/opengym-fa.git and enter opengym-fa.
2. Copy .env.example to .env using the correct command for my OS.
3. For localhost keep ORIGIN=http://localhost:8080.
4. Run docker compose up -d --build.
5. Check docker compose ps, inspect failing service logs, and verify:
   - the website returns HTTP 200 at http://localhost:8080
   - http://localhost:8080/api/health returns JSON with ok: true
6. If a port is busy, choose a free WEB_PORT and update ORIGIN to match.

For local code development instead, verify Node.js 20.19+ or 22.12+, then run npm install and npm run dev from the repository root. Read the printed frontend URL; the launcher selects a free API port automatically.

For a public deployment, require HTTPS. Set ORIGIN to the exact full URL (for example https://gym.example.com). Help configure my chosen Cloudflare Tunnel, Caddy, Traefik, nginx, or Nginx Proxy Manager without exposing secrets.

Safety and verification rules:
- Never print or upload .env, data/secret, data/db.json, cookies, or private keys.
- Ask before installing system software, changing DNS/firewall rules, deleting data, or replacing configuration.
- Preserve ./data; explain how to back it up before updates or risky changes.
- Diagnose the actual error output and environment instead of guessing.
- If a command fails, give me one next command at a time and explain exactly what result to return.

After setup, guide me through:
- creating a phone/password profile or using guest mode;
- selecting فارسی from Settings → General → Language;
- creating routines and assigning the weekly plan;
- starting and completing a workout;
- checking Stats and History;
- exporting a JSON backup;
- installing the PWA on my phone.
```

## Mobile app (no server at all)

The same codebase also builds a **standalone mobile app** (Capacitor): no account, no sync,
no backend — everything stays on the phone, with native workout-day reminders and share-sheet
backups. Self-hosting gets you multi-device sync and profiles for friends & family; the
mobile app is the install-and-done flavor.

- **Android:** download the APK from [**GitHub Releases**](https://github.com/Jenesyx/opengym-fa/releases) and sideload it —
  openGym is deliberately not on the Play Store. Or build it yourself: **[docs/MOBILE.md](docs/MOBILE.md)**.
- **iPhone:** Apple doesn't allow installing apps outside the App Store, so there is no iOS
  download. Self-host and add it to your home screen from Safari (it's a full PWA), or build
  the native app onto your own device from Xcode — see **[docs/MOBILE.md](docs/MOBILE.md)**.

## How it works

```
┌─────────────┐        ┌──────────────────────────────┐
│  Your phone │──HTTPS─▶│  web  (nginx)                │
│  / laptop   │        │   ├─ serves the built app    │
└─────────────┘        │   └─ proxies /api ──────────┐│
                       └──────────────────────────────┘│
                                                        ▼
                                        ┌──────────────────────────┐
                                        │  api  (Node + scrypt auth)│
                                        │   └─ ./data (JSON files) │
                                        └──────────────────────────┘
```

- **frontend/** — React + Vite (React Router + Zustand), built to static files **inside Docker**
- **api/** — Node with no framework, storing data and scrypt password hashes as JSON files under `./data`
- **web/** — a multi-stage image that builds the frontend and serves it with nginx, proxying `/api` to the backend

## Your data

Lives in `./data` on your host: `db.json` (profiles + password hashes), `state-<user>.json`
(each user's plan, workouts, body weight, settings), `secret` (the session-cookie key), and
`media/` (personal exercise GIFs/MP4s, served by hash).
**Back up `./data` and you've backed up everything.** Passwords are stored as one-way hashes.

## Configuration

All via `.env` (see `.env.example`):

| Variable      | What it is                                           | Default                 |
|---------------|------------------------------------------------------|-------------------------|
| `ORIGIN`      | Full URL the app is served from                      | `http://localhost:8080` |
| `WEB_PORT`    | Host port for the web UI                             | `8080`                  |
| `ADMIN_UIDS`  | User ids that get the admin dashboard (comma-separated) | *(none)*             |
| `INVITE_ONLY` | Require an invite code to create a profile           | *(off)*                 |

Push notification keys are generated on first run and saved to `./data/vapid.json` — nothing to set.

## Roadmap

Rough, community-driven — ideas and PRs welcome:

- [x] Standalone mobile app — Android APK to sideload ([releases](https://github.com/Jenesyx/opengym-fa/releases)); on iOS as a self-hosted PWA (no store listings planned)
- [x] Automatic progression programs (linear, Greyskull LP, double progression) with stalls and deloads
- [x] Estimated 1RM per exercise
- [ ] Percentage / training-max programming (5/3/1-style) on top of the progression engine
- [ ] More starter plans (upper/lower, full-body, 5×5)
- [x] Importers from FitNotes / Strong / Hevy (including the RPE they record), and body weight from Apple Health
- [x] Effort per set — RIR or RPE, whichever scale you think in
- [ ] Body measurements (waist, arms…) alongside weight
- [ ] Per-exercise notes & plate calculator
- [ ] Exercise instructions in German & Portuguese (UI is translated; upstream dataset doesn't ship these yet)

## Tech

React 19 + Vite (React Router, Zustand) · Node (no framework) · nginx · Docker Compose ·
Phone/password sessions · exercise data from [hasaneyldrm/exercises-dataset](https://github.com/hasaneyldrm/exercises-dataset).
No database server, no cloud dependencies — the frontend builds inside Docker, so self-hosting
stays a one-command `docker compose up`.

The training logic — progression rules, 1RM estimation, how a logged session is read back —
lives in pure functions under `frontend/src/lib/` with tests next to them: `npm test` in
`frontend/`. Vitest is a dev dependency; the app itself ships no runtime dependencies beyond
React, the router and Zustand.

## Community

- **[Q&A](https://github.com/Jenesyx/opengym-fa/discussions/categories/q-a)** — self-hosting
  help, login trouble, "how do I…". For public deployments, check the HTTPS address and `ORIGIN`.
- **[Ideas](https://github.com/Jenesyx/opengym-fa/discussions/categories/ideas)** — features
  worth talking through before anyone writes code.
- **[Show and tell](https://github.com/Jenesyx/opengym-fa/discussions/categories/show-and-tell)**
  — your setup, your plan templates, whatever you built on top.
- **[Issues](https://github.com/Jenesyx/opengym-fa/issues)** — bugs, and work that's already
  been agreed on.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Good first issues: more starter
plans, exercise-data languages, import from other trackers. **A ⭐ helps more people find it.**

openGym is free and stays free: AGPL, no subscription, no paid tier, nothing held back for
sponsors. If it replaced a paid tracker for you and you want to chip in, the Sponsor button at the
top of the page is there — a star, a bug report or a PR is worth just as much.

## License

[GNU AGPL v3.0](LICENSE) — free and open source. You can self-host, use, modify and share it;
if you run a modified version as a network service, you must offer that version's source under
the same license. Nobody can turn openGym into a closed, proprietary product.

Exercise images/GIFs are fetched from the upstream dataset and keep their own terms — see [NOTICE.md](NOTICE.md).
