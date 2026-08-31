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
- Default scope was briefly **Everything**, in both the dropdown and the
  `pool.js` fallback, on the reasoning that with working knowns it costs about
  two extra list calls on an already-synced PAN. Two of the three holes that
  justified it are now closed on their own terms — every scope lists both
  proceeding tabs, and the per-proceeding skip is decided from what the portal
  says has moved — and the third, filed Form 35s, was not worth what it cost:
  the appeals and returns passes fail on their own terms often enough that an
  unattended "everything" run routinely reported assessees as *partly synced*
  over data nobody had asked for. **The default is `eproc` again**, everywhere
  a run is automatic or in bulk, with one exception: an assessee that has never
  been synced is fetched in full once. See `syncScope.js` and the "What a run
  nobody is watching fetches" section of `PORTAL_SYNC_SETUP.md`.

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

### Step 1 — Deploy the functions (safe; nothing breaks) — ✅ DONE 2026-07-26

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

> **Since first writing this:** the runtime moved to Node 22 and three callables
> were added for "remember this device" (`issueDeviceKey`, `redeemDeviceKey`,
> `revokeDeviceKey`). Both need a `firebase deploy --only functions`, and the
> function count below is now **15 per region** rather than 11. Deploy the
> functions *before* releasing a connector build that expects them.

Verify before continuing:

```bash
gcloud functions list --project=prohippo2 --format="table(name,region,state)"
```

Every `ingestPortal*`, `getPortalCredential`, `requestOtp` and `verifyOtp` should
appear **twice** — once per region — and be `ACTIVE`.

Nothing is using Mumbai yet. The existing web app and every installed connector
still call Iowa, exactly as before.

#### What actually happened, for whoever adds the next region

The first deploy **partially failed** and needed two retries. Both causes were
first-time-in-a-new-region races, and neither indicated anything wrong with the
code. Expect the same if a third region is ever added.

1. **9 of 11 callables failed their Cloud Build** with an unhelpful
   `HTTP Error: 500, Could not create Cloud Run service` / *"An unexpected error
   occurred"*. The build log gave the real reason:

   ```
   NAME_UNKNOWN: Repository "gcf-artifacts" not found
   failed to ensure registry read/write access to
   asia-south1-docker.pkg.dev/prohippo2/gcf-artifacts/...
   ```

   Firebase creates the regional `gcf-artifacts` Artifact Registry repository as
   part of the first deploy into a region, but launches all the builds
   concurrently. Two won the race; nine hit a registry that did not exist yet and
   died one second in, during ANALYZING. **Fix: redeploy.** The repository exists
   after the first attempt, so the retry succeeds.

2. **`onPortalOrderWritten` failed** with `Permission denied while using the
   Eventarc Service Agent`. The Eventarc and Pub/Sub service identities are
   created *during* that same first deploy, so their permissions had not
   propagated. Firebase says so in the error. **Fix: wait ~5 minutes, redeploy.**

Neither is diagnosable from the top-level output — the build failures in
particular look alarming and generic. Go straight to the build log:

```bash
gcloud builds list --region=asia-south1 --project=prohippo2 --limit=5
gcloud builds log <BUILD_ID> --region=asia-south1 --project=prohippo2 2>&1 | tail -50
```

### Step 2 — Flip the clients to Mumbai

One line in each of two files, both now flipped:

- `src/firebase.js` → `getFunctions(app, "asia-south1")`
- `connector/src/main/config.js` → `const FUNCTIONS_REGION = "asia-south1";`

The web app deploys itself: `firebase-deploy.yml` runs on every push to the
default branch, so **merging the change is what puts the web app on Mumbai** —
there is no separate hosting command to run, and no chance to stage it. That is
precisely why step 1 has to be verified first:

```bash
gcloud functions list --project=prohippo2 --filter="name~/locations/asia-south1/" --format="value(name)" | wc -l
```

Expect 12 (11 callables + `onPortalOrderWritten`). If that number is short, do
not merge — the live web app would call functions that aren't there.

Desktop users move only when they install a rebuilt connector (see the caveat
below).

### Step 3 — Retire Iowa (much later, or never)

Only once no old connector is in the wild. Drop `"us-central1"` from `REGIONS`
in `functions/index.js` and redeploy; the CLI will ask you to confirm deleting
the Iowa copies.

There is no rush, and one good reason to wait: it also halves the
`minInstances` bill, since a warm instance is charged **per region**.

---

## 4. Releasing the connector (and auto-update)

`electron-updater` used to be a dependency that nothing imported — there was no
update check at all, so any improvement only reached a practitioner who happened
to notice and reinstall. It is now wired up in `connector/src/main/updater.js`.

### How a release works

```bash
git tag connector-v1.0.1 && git push origin connector-v1.0.1
```

**The tag must be `connector-vX.Y.Z`** — full semver, three parts. CI reads the
version out of the tag and writes it into `package.json` before building, because
auto-update works by comparing the installed version against the one recorded in
`latest*.yml`. A tag that isn't semver **fails the build on purpose**, with a
message saying so: shipping a build whose version didn't move produces installers
nobody can ever be upgraded from, which is worse than a failed build.

This replaces the older `connector-v2` / `connector-v3` style. Those tags would
now be rejected.

`build-connector.yml` then attaches the installers **plus `latest.yml`,
`latest-mac.yml` and the blockmaps** to the single `connector-latest` release,
marked `make_latest`. That is the update feed; electron-updater's GitHub provider
finds it with no extra configuration.

### Platform difference — a real constraint

| | Behaviour |
| --- | --- |
| **Windows** (NSIS) | Full auto-update. Downloads in the background, installs on quit. |
| **macOS** | **Cannot self-update.** Checks for updates and shows a banner with a download link. |

macOS is not an oversight. Squirrel.Mac refuses to apply an update to an app
without a valid code signature, and CI builds unsigned on purpose
(`CSC_IDENTITY_AUTO_DISCOVERY: "false"` — there is no Apple Developer ID yet).
*Checking* is safe unsigned; only *applying* is blocked. So macOS users are told a
new version exists and handed a one-click download, which still solves the real
problem: they find out.

Buy an Apple Developer ID and notarize, and macOS gets the same background flow —
delete the platform branch in `updater.js`. That would also remove the one-time
Gatekeeper warning on first open.

### The one-time cliff

Builds already installed (version `0.1.0`) contain **no updater code**, so they
will never check. Those users must install once more by hand to get onto the
auto-updating track. Unavoidable, and worth saying plainly when announcing the
release. From `1.0.0` onward it is automatic on Windows and one click on macOS.

Until no `0.1.0` build is left in the wild, the `us-central1` functions must stay
deployed (step 3 of §3), which also keeps the `minInstances` bill doubled.

---

## 5. Measured results (2026-07-26, real practice data)

Every PAN logs its own breakdown — as a tooltip on its row, and as a
`[sync timing]` line in the DevTools console. Buckets: `login`, `list`,
`notice-list`, `pdf`, `replies`, `ingest`, `order-list`, `f35-render`, `pacing`.

Five real PANs, the last four run concurrently:

| PAN | Proceedings | New docs | Total | login | ingest | pdf |
| --- | --- | --- | --- | --- | --- | --- |
| CUXPS9996L | 14 | 0 | **15.5 s** | 9.0 | 1.2 | – |
| ABIPP8547L | 5 | 0 | **11.7 s** | 9.4 | 0.2 | – |
| AABFI9185R | 8 | 0 | **16.3 s** | 12.9 | 0.1 | – |
| AALFJ4935C | 2 | 4 | **22.2 s** | 9.7 | 7.8 | 2.2 |
| AAWPM8125C | 12 | 3 | **23.2 s** | 9.7 | 7.0 | 1.3 |

Against 10-20 minutes per PAN before, i.e. **roughly 40-60× on the repeat case**.
Four PANs at once finished in ~25 s wall clock, which puts 50 already-synced
clients at concurrency 5 around 4 minutes.

### What the numbers say

**`login` is now the bottleneck, at 55-80% of every run.** 9.4-12.9 s, and it is
the largest bucket in all five. Everything else combined is 2-3 s on a
nothing-new sync. Some of that is the portal's own SPA load and auth response and
is not ours to fix, but the poll loop (a `page.evaluate` every 360-680 ms) means
each login step is discovered up to a tick late. Event-driven waits are the
obvious next target — worth perhaps 2-4 s.

**`ingest` is the second cost, but ONLY when documents are fetched.** 0.1-1.2 s
with nothing new; **7.0-7.8 s for 3-4 documents** — about 2 s per document. And
note the asymmetry with `pdf`: downloading 4 PDFs *from the portal* took 2.2 s,
while pushing those same 4 to our own backend took 7.8 s.

That 2 s per document is the Storage upload, and the bucket
(`prohippo2.firebasestorage.app`) is in `us-central1` while everything else is
now in Mumbai — so every PDF crosses the planet. Two possible fixes:

1. **Upload concurrently** (the two-lane split). Four uploads at once is roughly
   the cost of the slowest, so ~7.8 s becomes ~2 s. No migration, no schema
   change.
2. **An `asia-south1` bucket** for new files. Cuts each upload rather than
   overlapping them, but bucket locations are permanent, so this means a second
   bucket plus a `bucket` field on every notice so downloads know where to look.

**Do (1) first.** It is the bigger win and far cheaper. Revisit (2) only if
`ingest` is still material afterwards.

**`pdf` is cheap** — 1.3-2.2 s for 3-4 documents. The planned `context.request`
change (raw bytes in Node instead of base64 through CDP) is still worth doing for
large PDFs, but it is not where the time goes.

**`pacing` is 0.6-1.1 s** — the deliberate 120-320 ms gaps between documents.
Leave it; it is an IP-safety measure and it is not costing much.

## 6. Results vs. prediction

| | Before | Predicted | **Actual** |
| --- | --- | --- | --- |
| Repeat sync, one client, nothing new | 10-20 min | ~20-30 s | **11.7-16.3 s** |
| Sync fetching a few new documents | 10-20 min | – | **22-23 s** |
| Bulk, 50 already-synced clients, 5 at a time | hours | ~3-5 min | **~4 min** (extrapolated) |

Concurrency stays at **5** deliberately. Every change above *reduces* the number
of requests made to the income-tax portal — the knowns fix alone cuts repeat-sync
volume by roughly 95% — so this batch lowers the blocking risk while making
things faster. Raise concurrency later, as its own change, so a problem can be
attributed.

---

## 7. Still open

Re-ordered by the measurements above rather than by the original guesses — the
per-document work I had planned matters much less than login does.

**Done — the two deadline items**

- ~~**Node 20 → 22.**~~ `functions/package.json` now declares Node 22, ahead of
  Google's 2026-10-30 decommission of Node 20. **Needs a `firebase deploy --only
  functions` to take effect** — a runtime change rebuilds every function, in both
  regions. Nothing in `functions/index.js` is version-sensitive: it uses only
  `crypto`, the Firebase SDKs and global `fetch` (stable since Node 18).
- ~~**Auto-update for the connector.**~~ Wired up — see §4 for the release flow,
  the mandatory `connector-vX.Y.Z` tag format, and why macOS notifies rather than
  self-installs.

**Performance, in measured priority order**

1. **Login** — 55-80% of every sync. Replace the 360-680 ms poll with
   event-driven waits so each step isn't discovered up to a tick late. Part of
   the 9-13 s is the portal's own SPA and auth latency and is not recoverable.
2. **Concurrent uploads** — ~2 s per document today, all of it crossing to the
   `us-central1` bucket. Four at once ≈ the cost of one. Cheaper and bigger than
   the bucket migration; do it first and re-measure.
3. **`context.request` PDF downloads** — raw bytes in Node instead of base64
   through CDP. Worth doing for large PDFs, but `pdf` is only 1.3-2.2 s, so this
   is no longer urgent.
4. **Two-tier sync** — show the notice list before the PDFs finish. Less valuable
   now that a whole sync is ~20 s; keep it in mind for practices with far more
   history than the PANs measured here.
5. **Bundled ingest** — one call per N notices. Deprioritised: the callable leg is
   fast now that it is in-region; the upload leg is the cost, and (2) addresses it.
6. **`asia-south1` Storage bucket** — only if `ingest` is still material after
   (2). Needs a `bucket` field on every notice, since bucket locations are
   permanent.

**Observability gap found during verification**

- `onPortalOrderWritten` only writes to the log on failure, so a successful
  automatic summarisation is indistinguishable from an early return at the guard.
  Add a one-line success log; otherwise the only way to confirm it worked is to
  open the notice and look.

**Product**

- **Bulk sync interruptions** — remember progress and offer "Resume — N left" on
  next launch. Still manual; nothing runs on its own.
- **Freshness labels** — "synced 3 days ago" per client, highlighting anything
  over a week old. There is no background sync by design, so staleness is
  currently invisible.
