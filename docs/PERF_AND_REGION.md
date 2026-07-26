# Portal sync performance — what changed, and how to deploy it

This covers the first batch of sync performance work on the connector plus the
Cloud Functions region migration that goes with it.

---

## 1. What was wrong

### The incremental diff was never connected (the big one)

The sync has a "what do we already hold?" mechanism — `knownDins`,
`knownByProc`, `knownResponseIds`, `knownActiveProcs`. It works, and the browser
extension path builds it properly via `buildSyncKnowns()` in
`src/Assessees.jsx`.

The desktop connector never did. `listPortalAssessees()` returned no `knowns`,
and the renderer passed `knowns: a.knowns || {}` — i.e. **always an empty
object**. Consequences, all in `connector/src/main/portalFetch.js`:

| Empty set | Effect |
| --- | --- |
| `knownDins` | every notice PDF re-downloaded, re-uploaded to Storage, re-ingested, **every sync** |
| `knownByProc` | no proceeding ever skipped; a detail call for all of them |
| `knownResponseIds` | every filed reply and reply attachment re-downloaded |
| `knownActiveProcs` | `eproc` closure detection was a no-op |
| `knownDins` (Form 35) | every filed Form 35 re-rendered through `pdfweb`, 3 attempts each |

So the "incremental" sync was a **full sync every time**. This is why a re-sync
of an unchanged client cost roughly as much as the first one.

### Functions were in Iowa; the database is in Mumbai

Firestore for this project is `asia-south1` (Mumbai). The functions were pinned
to `us-central1` (Iowa) — Google's default, never revisited. Every Firestore
operation crossed the planet at ~250 ms, and these functions make dozens to
hundreds of them **sequentially**:

| Function | Sequential Firestore ops | Time lost to the split |
| --- | --- | --- |
| `ingestPortalProceedings` (40 proceedings) | ~160 | **~40 s** |
| `ingestPortalNotice` (per notice) | up to 6 | ~1.5 s × every notice |

`ingestPortalProceedings` is called on **every** sync with **every** proceeding —
the knowns don't skip it — so that ~40 s was paid even when nothing had changed.

### AI parsing sat on the critical path

`connector/src/main/ingest.js` awaited `summarizePortalNotice` for every order:
a 5-25 s Gemini read of the PDF, capped at 5 concurrent instances **shared
across all workers**, blocking the sync each time.

### Smaller costs

- A fixed `jsleep(900, 1500)` after every login, on every PAN.
- A `page.evaluate` **every 400 ms for the whole sync** watching for a logout
  dialog that essentially cannot appear (we never navigate after login) —
  ~150 CDP round trips a minute per context, competing with the real API calls.
- The login page fetched all its artwork and webfonts.
- `itbaResponseService` called for every notice on every sync, including notices
  in closed proceedings that cannot receive new replies.
- `ingestPortalNotice` ran a `where("din","==")` collection query, then computed
  the deterministic document id (`din_<sha1>`) that it could have read directly.

---

## 2. What changed

**Connector**

- `firebaseClient.getSyncKnowns(pan)` — new; reads notices + matters for the PAN
  and builds the four known-sets. A faithful port of `buildSyncKnowns()`.
- `portalWorker.js` — starts that read **before** the login and awaits it after,
  so it costs no wall time. If it fails, the sync falls back to fetching
  everything and says so in the log rather than failing.
- `portalLogin.js` — the fixed post-login sleep is replaced by watching the
  portal's cookie jar until it settles (typically ~350 ms, capped at 1.5 s); the
  400 ms logout-guard poll is replaced by a single `MutationObserver`; images,
  media and fonts are blocked during login only.
  - *Stylesheets are deliberately still loaded* — the login state machine decides
    visibility from element geometry, and this is an Angular Material app whose
    control geometry comes from CSS.
- `portalFetch.js` — the two proceedings list calls (FYA + FYI) now run
  concurrently; reply lookups are skipped for known notices in closed
  proceedings.
- `ingest.js` — no longer awaits `summarizePortalNotice`.
- `timing.js` — new; per-phase stopwatch, reported per PAN.
- Default scope is now **Everything**, in both the dropdown and the `pool.js`
  fallback. With working knowns it costs about two extra list calls on an
  already-synced PAN, and the old `eproc` default quietly left filed Form 35s
  and the FYI tab unsynced.

**Cloud Functions**

- `REGIONS = ["asia-south1", "us-central1"]` — every callable deploys to both
  regions under the same name. v2 HTTP/callable functions accept an array.
- `minInstances: 1` on `ingestPortalNotice` and `ingestPortalProceedings`.
- `ingestPortalProceedings` — one batched `getAll` + one `BulkWriter` instead of
  ~4 sequential round trips per proceeding.
- `ingestPortalNotice` — reads the deterministic doc id directly, falling back to
  the query only on a miss (a hand-uploaded, AI-parsed notice can carry a DIN
  under a random id, and skipping the fallback would duplicate it). The assessee
  read now runs concurrently with the dedup read.
- `onPortalOrderWritten` — new Firestore trigger that summarises order PDFs after
  the fact. Pinned to `asia-south1` because Firestore triggers must live in the
  database's region. Exactly one automatic attempt per document: `aiSummary`
  stops the re-fire from our own write-back, `aiSummaryError` stops a bad PDF
  retrying forever. `summarizePortalNotice` remains for manual retry.

**Repo**

- `eslint.config.js` — `connector/src/**` had no matching config, so every
  `require`/`module` in the Electron main process was reported as an undefined
  global (67 errors) and `npm run lint` was unusable there. Now the main process
  is linted as Node + browser (several of its functions are serialised into the
  page by Playwright) and the renderer as a browser script.

---

## 3. Deploy — in this order

> **Order matters.** Steps 1 and 2 must not be swapped. Flipping a client to a
> region with no deployed function takes that client offline until step 1 lands.

### Step 1 — Deploy the functions (safe; nothing breaks)

```bash
firebase deploy --only functions
```

Expect:

- **Roughly twice the usual number of functions**, one set per region. This is
  correct — both regions now serve the same names.
- A prompt to grant the new Mumbai functions access to the secrets
  (`GEMINI_API_KEY`, `CREDENTIAL_ENC_KEY`, `RESEND_API_KEY`, `OTP_PEPPER`).
  Accept.
- A new function in the list: `onPortalOrderWritten` (asia-south1 only).
- New `gcf-v2-sources-…-asia-south1` buckets appearing in Cloud Storage. Normal
  deployment plumbing; leave them alone.

Verify before continuing:

```bash
gcloud functions list --project=prohippo2 --format="table(name,region,state)"
```

Every `ingestPortal*`, `getPortalCredential`, `requestOtp` and `verifyOtp` should
appear **twice** — once per region — and be `ACTIVE`.

Nothing is using Mumbai yet. The existing web app and every installed connector
still call Iowa, exactly as before.

### Step 2 — Flip the clients to Mumbai

One line in each of two files:

- `src/firebase.js` → `getFunctions(app, "asia-south1")`
- `connector/src/main/config.js` → `const FUNCTIONS_REGION = "asia-south1";`

Then:

```bash
npm run build
firebase deploy --only hosting
```

The web app is now on Mumbai. Rebuild and re-release the connector to move
desktop users (see the caveat below).

### Step 3 — Retire Iowa (much later, or never)

Only once no old connector is in the wild. Drop `"us-central1"` from `REGIONS`
in `functions/index.js` and redeploy; the CLI will ask you to confirm deleting
the Iowa copies.

There is no rush, and one good reason to wait: it also halves the
`minInstances` bill, since a warm instance is charged **per region**.

---

## 4. Known caveat: the connector cannot update itself

`electron-updater` is listed in `connector/package.json` but is **not wired up
anywhere in the code**. There is no update check, so desktop users only get new
builds by downloading the installer again.

Two consequences:

1. Step 3 above can't be done confidently — you have no way to know when the
   last old connector is gone. Leaving both regions live is fine.
2. More importantly, **none of the improvements here reach existing desktop
   users until they manually reinstall.**

Wiring up auto-update is small (`electron-builder.yml` already publishes to
GitHub Releases) and worth doing before the next batch.

---

## 5. Measuring

Every PAN now logs its own breakdown. In the connector, open DevTools
(`npm run dev`) and look for:

```
[sync timing] ABCDE1234F: 23.4s total — pdf 9.1s, ingest 5.2s, login 4.8s, notice-list 2.1s, replies 1.4s, pacing 0.8s
```

The same line is on each row as a tooltip, so a screenshot from a real practice
is enough to diagnose a slow sync.

Buckets: `login`, `list`, `notice-list`, `pdf`, `replies`, `ingest`,
`order-list`, `f35-render`, `pacing`.

**What to watch, and what it decides:**

- **`ingest` still large after step 2** → the callables aren't the problem
  anymore; it's the PDF upload leg. The bucket
  (`prohippo2.firebasestorage.app`) is in `us-central1` while the database is in
  Mumbai, so uploads from India cross the planet. Deferred on purpose: after the
  knowns fix a repeat sync uploads *zero* PDFs, and the planned two-lane split
  will overlap uploads with portal work. If `ingest` is still material after
  both, add an `asia-south1` bucket for new files (bucket locations are
  permanent, so this needs a `bucket` field on each notice so downloads know
  where to look).
- **`pdf` dominant** → expected on first syncs; addressed next batch by
  downloading via `context.request` (raw bytes in Node, no base64 through CDP)
  with 2-3 concurrent downloads.
- **`login` > ~8 s** → the portal itself is slow; not much left to trim.
- **`pacing` material** → the deliberate 120-320 ms gaps between documents. Only
  reconsider with numbers in hand; it is an IP-safety measure.

---

## 6. Expected results

| | Before | After this batch |
| --- | --- | --- |
| Repeat sync, one client, nothing new | 10-20 min | **~20-30 s** |
| First sync, ~75 notices | 10-20 min | **~3-4 min** |
| Bulk, 50 already-synced clients, 5 at a time | hours | **~3-5 min** |

Concurrency stays at **5** deliberately. Every change above *reduces* the number
of requests made to the income-tax portal — the knowns fix alone cuts repeat-sync
volume by roughly 95% — so this batch lowers the blocking risk while making
things faster. Raise concurrency later, as its own change, so a problem can be
attributed.

---

## 7. Still open

- **Bulk sync interruptions** — remember progress and offer "Resume — N left" on
  next launch. Still manual; nothing runs on its own.
- **Freshness labels** — "synced 3 days ago" per client, highlighting anything
  over a week old. There is no background sync by design, so staleness is
  currently invisible.
- **Next batch** — bundled ingest (one call per N notices instead of one per
  notice), the two-lane fetch/upload split, `context.request` PDF downloads, and
  showing the notice list before the PDFs finish.
