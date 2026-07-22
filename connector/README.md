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
