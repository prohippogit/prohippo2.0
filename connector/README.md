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
    portalWorker.js  ONE PAN in one isolated context (scaffold + porting plan)
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

## Which build am I running?

The version is in the header, next to "Parallel, human-paced portal sync" —
`v1.2.0` — with a **Check for updates** link beside it. Press it and the bar
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
- PAN pick-list — `assessees:list` reads `users/{uid}/assessees` (where
  `portalCredSet == true`) directly from Firestore under the existing security
  rules, so the board shows real PANs.
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
