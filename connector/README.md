# ProHippo Connector

A local desktop app (Electron + Playwright) that syncs many PANs from the
income-tax e-filing portal **in parallel**, from the practitioner's own
residential connection, at a **human, randomised pace**.

It is the interim "parallel-sync tier": faster than the one-tab-at-a-time
Chrome extension, without the IP-blocking risk of cloud scraping. The strategic
endpoint remains official ERI / Authorised-Representative access; this app is
built so the fetch source can later move to ERI/AR by changing only
`portalWorker.js`.

> Full design rationale: the engineering spec (goals/non-goals, IP-safety model,
> concurrency, packaging, sunset path).

## Why this is IP-safe

- **Residential IP** — traffic comes from the practitioner's home/office
  connection, the same network they already log in from. This is the safe lane.
- **Concurrency cap** — at most **5** PAN sessions at once (`config.js › POOL`).
- **Randomised everything** — launch stagger and every inter-request delay are
  drawn from ranges (`pacing.js`); there are no fixed cadences to fingerprint.
- **Isolated sessions** — one Playwright `BrowserContext` per PAN (own cookies),
  so sessions never collide — the desktop analogue of the portal's Dual Login.

## What it reuses (does not reinvent)

| Concern                | Source of truth (unchanged contract)                     |
|------------------------|----------------------------------------------------------|
| Login + Dual Login     | ported → `portalLogin.js` (from `portal-login.js`)       |
| PAN master data        | ported → `portalMaster.js` (from `syncMaster()`)         |
| Portal JSON API        | ported → `portalApi.js` (from `portal-net.js`)           |
| Scoped/incremental diff | ported → `portalFetch.js` (scope + knowns model)        |
| Credential decryption  | `getPortalCredential` Cloud Function (in-memory only)    |
| Ingest + Storage upload | ported → `ingest.js` (1:1 with `src/portalIngest.js`)   |

The **"sn" header is just the serviceName echoed verbatim** — the real auth is
the session cookie (per `portal-net.js`). So once a context is logged in, the
API calls go direct with the page's own `fetch`; no token capture is needed.

## Layout

```
connector/
  src/main/          Electron main process (Node)
    main.js          window + IPC + owns Firebase session and pool
    preload.js       locked-down bridge exposed to the UI
    config.js        Firebase config, portal URLs, POOL cap + stagger
    firebaseClient.js  auth + httpsCallable wrappers
    credentials.js   getPortalCredential — in-memory only, never on disk
    deviceSession.js "remember this device" key, in the OS keychain
    updater.js       version + auto-update (full on Windows, notify-only on macOS)
    timing.js        per-phase stopwatch reported per PAN
    pacing.js        rand / jsleep / PACE / POLL (ported timings)
    pool.js          worker pool: cap 5, randomised staggered launch
    settings.js      the switches, remembered between launches
    autoStart.js     "start when I sign in" — the OS's own login item
    scheduler.js     unattended syncing: once at launch, then every N hours
    schedulePlan.js  when the next run is due (pure, tested)
    portalWorker.js  ONE PAN in one isolated context (scaffold + porting plan)
    portalMaster.js  one PAN's profile / jurisdiction / contact, mapped
    assessees.js     add an assessee: fetch from the portal, then create it
    ingest.js        pushes results to the Cloud Functions
  src/renderer/      thin UI (index.html / styles.css / renderer.js)
  electron-builder.yml  packaging + signing + auto-update config
```

## Develop

```bash
cd connector
npm install          # also runs `playwright install chromium`
npm run dev          # launches Electron with devtools
```

Sign in with a ProHippo practitioner account (same as the web app) — Google or
email/password. The board shows one card per PAN with live progress.

## Google sign-in setup (one-time)

If your ProHippo account signs in **with Google**, the connector needs a Google
OAuth "Desktop app" client so it can sign you in through your real browser
(Google blocks sign-in inside embedded app windows). This is a one-time setup
for your firm.

1. Open the Google Cloud credentials page for the project:
   **https://console.cloud.google.com/apis/credentials?project=prohippo2**
   (sign in as the account that owns the ProHippo Firebase project).
2. Click **+ CREATE CREDENTIALS → OAuth client ID**.
3. **Application type: Desktop app**. Name it `ProHippo Connector`. Click **Create**.
4. A box shows a **Client ID** and **Client secret** — keep it open.
5. In the `connector` folder, copy `google-oauth.example.json` to
   **`google-oauth.json`** and paste the two values in. (This file is
   git-ignored — it never leaves your machine.)
6. Restart the connector (`npm run dev`) and click **Sign in with Google**.

The Google token is accepted by Firebase as the *same account* your web-app
Google sign-in uses — same uid, same data.

## Adding an assessee

**+ Add assessee**, next to Reload. This exists because the web app can only
create an assessee through the Chrome extension: it hands the PAN and password
to the extension, which signs in and reads the master data. Somebody who has
just installed the connector and has no extension therefore had an empty list
and no way to fill it — the one thing a new user needs to do first was the one
thing they could not do here.

The connector already drives a real portal login for the sync, so the form
borrows it for a single PAN:

1. Enter the **PAN** and its **e-filing password**, and tick the authorisation
   box. Consent gates the *fetch*, not just the storage — fetching signs in to
   the client's portal account, which is the act needing authorisation.
2. **Fetch from portal** logs in (respecting Dual Login and the session-expiry
   bounce, same as a sync) and reads three services: `myPanDetailsService`,
   `jurisdictionDetailsService` and `userProfileService`. Name, date of birth /
   incorporation, address, mobile, email and the Assessing Officer come back and
   fill the form; each fetched field is tagged **from portal ✓**. Nothing is
   saved at this point, so a wrong password costs a failed login and nothing
   else. Un-tick **Run hidden** first if you want to watch it happen.
3. Review — every field stays editable, and a PAN the portal says nothing about
   still leaves a form you can complete by hand.
4. **Add assessee** writes the record, then stores the login against it
   (`savePortalCredential`, encrypted server-side). It appears in the list
   already selected, ready to sync.

A PAN can only appear once in a practice — every notice, matter and invoice
hangs off it — so a PAN already on the list is refused, naming the assessee it
clashes with. If the record is created but the login cannot be stored, the form
says so and stays open: this list only shows assessees *with* a stored login, so
"added" followed by an unchanged list would look like a bug rather than a
half-finished save.

The password is in memory for the length of the login and is never written to
disk here — the same rule the sync follows.

## Syncing without being asked

Everything below is **off until it is switched on**, in the *Automatic sync*
panel above the list. An app that installs itself into startup and begins
signing in to clients' income-tax portals unattended, because it was installed
once, is not something to assume anybody wants.

| Switch | What it does |
|--------|--------------|
| **Start when I sign in to this computer** | Registers the OS's own login item — a Launch Agent on macOS, a Run key on Windows. Nothing is hand-written into either. The switch reads its state back FROM the OS, so removing the app from Login Items or Task Manager's Startup tab is reflected here rather than contradicted. |
| **Sync as soon as it starts** | One sync after the session is restored. Hung off the silent sign-in and not off launch: with nobody signed in there is nothing to sync, and on a machine that has just booted the device key is still being redeemed over a network that may not be up. |
| **Keep syncing about every N hours** | 3, 6, 12 or 24; six by default, and *about* is meant literally — see "Why it does not look robotic" below. For the machine nobody restarts — the firm's server in the corner, where "sync at launch" would fire once in June and never again. |

An unattended run takes **every PAN with a stored portal login** and is always
hidden, whatever "Run hidden" is set to: a browser window taking the screen on a
machine somebody else is using is not acceptable.

**One sync at a time, whoever asked for it.** The button and the scheduler share
a single lock. Two pools at once would put twice the capped number of portal
sessions on one residential IP — the single thing the pacing everywhere else
exists to prevent — and both runs would fetch the same PANs over each other.
While the schedule is running, the window's own controls disable themselves and
say so.

### Why it does not look robotic

A fixed schedule is a fingerprint. Everything *inside* a run has always been
drawn from a range — `pacing.js` opens with "there are no fixed intervals
anywhere in the sync path" — but the gap *between* runs was exact, and
06:00:04 / 12:00:11 / 18:00:07 every day from one residential address is the
easiest pattern in the world to read as automation. A human's own portal use is
ragged, clustered in office hours, and never lands on the same second twice.

So the schedule is deliberately imprecise, in four places:

| | |
|---|---|
| **The interval is a range** | Drawn fresh every cycle: ±15% of the interval, or about a 1h48m window at six hours. Two consecutive gaps are never the same length. The floor is a quarter of the interval, so no draw can put two runs on top of each other, and the ceiling is 40% — configurable to widen, not to switch off. |
| **Drawn once, then stored** | `nextAutoRunAt` is persisted. Re-drawing on every timer tick would be a target that never arrives and a countdown that jumps about. |
| **The launch sync waits first** | 1–7 minutes, randomised. A machine switched on at 09:00 every weekday would otherwise reach the portal at 09:00 every weekday — the same fingerprint by another route. |
| **The PANs are shuffled** | An unattended run deals them in a different order each time. The same list worked top to bottom is a pattern in itself: one PAN always first, one always last, every day. A manual run keeps the order you chose. |
| **Nothing runs overnight** | A pause from **midnight to 6am** by default, both ends configurable. Randomised timing makes the rhythm human; it cannot make 03:41 a plausible hour for the practitioner whose account it is to be signing in. A firm works days. |

The overnight pause **defers, it does not skip** — a run that came due at 3am
happens as soon as the window lifts, so a machine left on overnight still starts
the day up to date. And the release is itself randomised across the first
three-quarters of an hour: letting everything go the moment the window ends
would put a burst at exactly 06:00 every morning, which is the fingerprint this
was meant to remove, moved six hours down the clock.

A month of a six-hour schedule with the pause on, printed as clock times:

```
Wed, 12 Aug   06:00   12:33   18:55
Thu, 13 Aug   06:31   12:29   19:21
Fri, 14 Aug   06:32   13:24   20:07
Sat, 15 Aug   06:18   12:52   18:06
Sun, 16 Aug   06:22   11:42   16:58   23:34
Mon, 17 Aug   06:22   12:25   18:13   23:19
```

None of this changes what the portal sees *within* a run, which was already
safe: at most five sessions at once, each in its own browser context, launched
1.5–4.2s apart, with every request paced from a range.

`connector-v1.10.0` is the first build with any of it — before that the connector
only ever synced when somebody pressed a button.

### How the timing behaves

`schedulePlan.js` owns the arithmetic and is the one part of this with tests,
because both failure modes are silent: a schedule that never fires looks exactly
like one with nothing to do, and one that fires constantly is noticed only by
the income-tax portal.

- **Counted from the last run, not from launch.** A server rebooted hourly still
  syncs about every six hours.
- **Never run → due now.** Switching it on at 9am on a machine that was off all
  week syncs at 9am, not at 3pm.
- **Asleep through four intervals → one run, not four.** The next moment is
  computed from the wall clock on every wake-up, rather than counted off a
  ticking interval.
- **A last-run stamp in the future is ignored.** A server whose clock is wrong at
  boot and corrects a minute later would otherwise park the schedule days out and
  never run again.
- **The timer never waits more than half an hour** before re-reading the clock.
  That ceiling is what lets a clock correction, a VM restore or a timezone change
  recover on their own.
- **The stamp is written whether the run succeeded or failed.** A portal that is
  down at 6am must not become a retry every minute for the rest of the day.

### Keep the window open

On Windows and Linux the window IS the app: closing it quits, and a quit app
keeps no schedule. The panel says so while the interval switch is on. macOS
keeps running with the window closed, as it always has.

### Last sync, per assessee

Every row says when that PAN last came back clean — "today, 04:30 am", "Sun, 10
Aug, 10:15 pm", or **Never synced** in amber. The day is named because on a list
that syncs by itself the question is usually "did it run overnight?".

This is stamped by the connector on every successful run (`markSynced`), not
inferred from what arrived. The list previously read `portalNoticeSyncedAt`,
which only moves when a NEW notice is stored — so a PAN with a clean compliance
record, which is most of them, synced every six hours and still read "never
synced". The web app's own "Last synced" line reads the same field and gets the
same correction.

## Which build am I running?

The version is in the header, next to "Parallel, human-paced portal sync" —
`v1.10.0` — with a **Check for updates** link beside it. Press it and the bar
below the header answers either way: a newer build, or "you're on the latest
version". Silence would be indistinguishable from a broken button, so there
isn't any.

The app also checks by itself a few seconds after launch. That check says
nothing when there is nothing to say — an unprompted "you're up to date" is
noise nobody asked for.

Windows downloads a new build in the background and installs it when the app
quits. macOS cannot: Squirrel.Mac refuses to apply an update to an unsigned app,
and these builds are deliberately unsigned until there is an Apple Developer ID.
There the button opens the .dmg instead. See `src/main/updater.js`.

The version shown is whatever `connector/package.json` carried at build time,
and CI overwrites that from the release tag (`connector-vX.Y.Z`) — so the tag is
the source of truth, and a release that doesn't bump it is never offered to
anyone.

## Build installers

```bash
npm run dist:win     # NSIS installer (needs Authenticode EV cert to sign)
npm run dist:mac     # DMG (needs Apple Developer ID + notarization)
```

## Staying signed in

Firebase Auth's persistence options are all browser-backed, and this app runs
Firebase in Electron's **main (Node) process** — so the session used to die with
the process and the practitioner was asked for an emailed code on *every* launch.

Fixed with a "remember this device" key rather than a cached Firebase refresh
token (the JS SDK has no public way to restore a session from one in Node, and an
app-scoped key is revocable by us):

1. The first sign-in is unchanged — an emailed code.
2. The backend issues a random device key and stores only a **peppered, salted
   hash** of it, the same way the OTP codes are stored. The plaintext never
   reaches Firestore.
3. The connector keeps the key in the **OS keychain** via Electron
   `safeStorage` — macOS Keychain, Windows DPAPI, Linux keyring. That binds it to
   the logged-in OS account; copied elsewhere it's unopenable ciphertext.
4. Each launch redeems it silently for a Firebase custom token.
5. **Sign out** revokes it server-side *and* deletes it locally, so a surviving
   copy is dead.

Two deliberate choices:

- **Idle expiry of 90 days**, rolling — refreshed on every launch, so an active
  user is never asked again. "Signed in forever" is a liability for a tool that
  can reach clients' income-tax portals, and there's no upside.
- **No rotation on each use.** Rotating would mean a client that fails to persist
  the new key gets signed out — precisely the annoyance this removes. The key
  lives in the OS keychain, so a stolen copy already implies a compromised
  machine, where rotation buys little. Revocation plus the idle window covers it.

If the OS keychain is unavailable (mainly Linux with no keyring) the device is
simply not remembered and sign-in works as before. It never falls back to writing
the key in plaintext.

Backend: `issueDeviceKey` (authenticated), `redeemDeviceKey` and
`revokeDeviceKey` (unauthenticated — they *are* a sign-in mechanism, exactly like
`verifyOtp`). The `deviceSessions` collection needs no security rule:
`firestore.rules` denies everything outside `users/{uid}`, so only the Admin SDK
reaches it.

## Security

- Portal passwords are decrypted (AES-256-GCM, server-side) and held **in
  memory only** for the duration of one login. Never written to disk, never
  logged, never persisted in connector state.
- The device key is the one credential kept on disk, and only ever encrypted by
  the OS keychain — see "Staying signed in" above.
- `contextIsolation` on, `nodeIntegration` off, `sandbox` on — the renderer can
  only reach the small `connector` bridge in `preload.js`.
- `.state/`, logs, and any session data are git-ignored.

## Status

**Working now:**

- Practitioner sign-in.
- **Automatic syncing** — start with the computer, sync on launch, and keep
  syncing every N hours (see "Syncing without being asked" above).
- PAN pick-list — `assessees:list` reads `users/{uid}/assessees` (where
  `portalCredSet == true`) directly from Firestore under the existing security
  rules, so the board shows real PANs.
- **Add assessee** — `portalMaster.js` + `assessees.js` sign in as one PAN, read
  its master data, and create the assessee with its portal login. No Chrome
  extension anywhere in that path (see "Adding an assessee" above).
- **Login (pass 1)** — `portalLogin.js` drives a real Playwright login through
  User ID → [secure-access confirm] → Password → Dashboard, handling the
  Dual Login and session-expiry dialogs, on a randomised poll cadence.
- **Scoped fetch + ingest (pass 2)** — `portalFetch.js` pulls the e-Proceedings
  list (FYA, plus FYI for `all`, plus synthetic closed rows for `eproc`),
  applies the same scope + `knowns` incremental diff as the extension, downloads
  only NEW notice/order PDFs and filed responses, uploads them to Storage, and
  records everything through the existing `ingestPortal*` callables (`ingest.js`
  is a 1:1 port of `src/portalIngest.js`). Order PDFs auto-parse on fetch.

**Still `TODO(port)`** (pass 3): filed **Form 35 appeals** — the `appeals` scope
and the Form 35 leg of a full `all` sync. This needs `viewFiledForms` +
`pdfweb` render (the `deepMergeShape`/template logic in `portal-login.js`);
until it lands, those two paths log a "coming in pass 3" notice and skip.
