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
| Portal API capture     | `extension/portal-net.js` → Playwright `route`/`response`|
| Scoped/incremental diff | scope + knowns model from `portal-login.js`             |
| Credential decryption  | `getPortalCredential` Cloud Function (in-memory only)    |
| Ingest                 | `ingestPortal{Proceedings,Notice,Response,AppealForm}`   |

## Layout

```
connector/
  src/main/          Electron main process (Node)
    main.js          window + IPC + owns Firebase session and pool
    preload.js       locked-down bridge exposed to the UI
    config.js        Firebase config, portal URLs, POOL cap + stagger
    firebaseClient.js  auth + httpsCallable wrappers
    credentials.js   getPortalCredential — in-memory only, never on disk
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

Sign in with a ProHippo practitioner account (same as the web app). The board
shows one card per PAN with live progress.

## Build installers

```bash
npm run dist:win     # NSIS installer (needs Authenticode EV cert to sign)
npm run dist:mac     # DMG (needs Apple Developer ID + notarization)
```

## Security

- Portal passwords are decrypted (AES-256-GCM, server-side) and held **in
  memory only** for the duration of one login. Never written to disk, never
  logged, never persisted in connector state.
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
  Dual Login and session-expiry dialogs, on a randomised poll cadence. On
  success the PAN's isolated context is sitting on the portal dashboard.

**Still `TODO(port)`** in `portalWorker.js` (pass 2): scoped e-Proceedings
capture, incremental diff against the knowns, PDF download, and ingest — ports
of `portal-net.js` and the scope/knowns logic, feeding the existing
`ingestPortal*` callables via `ingest.js`.
