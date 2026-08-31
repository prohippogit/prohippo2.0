# Income-tax Portal Sync — setup (Phase 0 + 1)

This adds the ability to store each assessee's e-filing portal login (encrypted)
and open the portal already logged in, via the **ProHippo Sync** Chrome extension.

There are three one-time steps: set an encryption key, deploy the functions, and
load the extension.

---

## Step 1 — Create the encryption key secret

The portal passwords are encrypted at rest with a key ProHippo holds. Generate a
random key and store it as a Firebase secret. In **Cloud Shell**
(https://shell.cloud.google.com), run:

```
cd ~/prohippo2.0 && git fetch origin && git checkout -f claude/keen-ride-FlIY1 && git reset --hard origin/claude/keen-ride-FlIY1
```

Then generate + set the key (copy this whole block):

```
KEY=$(openssl rand -base64 32) && printf '%s' "$KEY" | firebase functions:secrets:set CREDENTIAL_ENC_KEY --data-file=-
```

> ⚠️ This key protects every stored portal password. If you ever change or lose
> it, previously saved passwords can't be decrypted and must be re-entered. You
> don't need to remember the key yourself — it stays in Firebase — just don't
> rotate it casually.

## Step 2 — Deploy the functions

```
cd ~/prohippo2.0/functions && npm install && cd .. && firebase deploy --only functions
```

Wait for **`✔ Deploy complete!`** (type `3` if it asks about container images).

The web app auto-deploys from GitHub, so no hosting step is needed.

## Step 3 — Load the ProHippo Sync extension (desktop Chrome)

Users no longer need the repository for this. The app serves the extension
itself: on an assessee's **Overview**, the **Income-tax portal** card has a
**Get Chrome extension** / **Download extension** button beside **Add portal
login**, which downloads `prohippo-sync-extension.zip` and shows the five
install steps. The zip is built from this repo's `extension/` folder on every
deploy (`scripts/build-extension-zip.mjs`, run by `npm run build`), so it is
always the version the deployed app expects — there is no release to publish.

By hand, from a clone:

1. Chrome → `chrome://extensions` → turn on **Developer mode**.
2. Click **Load unpacked** and select the `extension/` folder from the repo.
   (In Cloud Shell you can't load it; do this on your own computer.)
3. **ProHippo Sync** appears in the list.

Chrome never auto-updates an unpacked extension: after pulling a new version,
press the refresh arrow on its card and check the version matches
`extension/manifest.json`. See `extension/README.md` for details.

**No Chrome, or don't want the extension at all?** The **Sync Connector**
desktop app does the same work without it, and since v1.9.0 it can also **add an
assessee** — fetch the master data from the portal and create the record — so a
new user can get going before any extension is installed.

---

## Using it

1. Open an assessee → **Edit** (or Add) → fill **Income-tax portal login**
   (user ID = usually PAN, and the password), tick the consent box, save.
2. On the assessee's **Overview**, the **Income-tax portal** card now shows
   **Open e-Proceedings (auto-login)**.
3. Click it — a portal tab opens and logs in automatically.

## First-run calibration

The portal's login field names can change; the extension's auto-fill is
best-effort. If the on-page ProHippo badge says it couldn't fill the form,
report what you see and the selectors in `extension/portal-login.js` will be
tuned once. This is normal for portal automation.

## Phase 2 — e-Proceedings + notice/order PDFs (implemented)

The extension now, after login, calls the portal's JSON API directly to pull the
e-Proceedings list, then for each proceeding pulls its notices/orders and
downloads each PDF. PDFs are uploaded to **Firebase Storage** under
`users/{uid}/assessees/{id}/notices/…` and their metadata (DIN, section, dates,
Storage path) is recorded via the `ingestPortalNotice` Cloud Function
(deduped by DIN).

Two extra one-time deploy steps for this phase:

1. **Enable Firebase Storage** for the project (Firebase console → Build →
   Storage → Get started), if it isn't already.
2. **Deploy the new rules + function:**

   ```
   firebase deploy --only functions,storage
   ```

   `storage.rules` restricts every user to their own `users/{uid}/…` files.

### What a run nobody is watching fetches

A sync can look at four things: **e-Proceedings** (notices, orders, replies),
**filed Form 35s**, **filed returns with their CPC intimations and s.154
orders**, and — on demand only — a **rendered ITR form PDF**.

Every automatic run asks for **e-Proceedings only**. That covers the schedule,
the sync-at-launch run, the connector's *Sync selected*, and the web app's bulk
"sync these twelve". Form 35s and filed returns are choices of their own, on the
same dropdown, one click away.

This is not about speed. The appeals pass asks the portal to render a PDF on
demand and the returns pass unlocks CPC documents with a password built from a
date of birth the practice may never have recorded — either can come back
empty-handed on a portal that is merely busy, and the run then reports the
assessee as *partly synced*. On a run somebody pressed, that is a fair answer to
a question they asked. On one nobody asked for, it is a screenful of failures
about data the practitioner never wanted, and the reported response was to run
the whole sync again. Four and five times, over notices that were already in.

**The exception is an assessee's first sync.** A PAN with no last-sync time has
no baseline to be incremental against, so it is fetched in full exactly once —
whatever the dropdown says — and every run after it is the fast one. The rule
lives in `src/syncScope.js` and `connector/src/main/syncScope.js` (two copies,
ESM and CommonJS, because neither side can import the other), and
`test/syncScope.test.mjs` runs both over the same cases and fails if they
disagree.

Two settings, both remembered:

| Where | Control | Default |
|---|---|---|
| Connector, toolbar | **Scope** — what *Sync selected* fetches | e-Proceedings |
| Connector, automatic panel | **Unattended syncs fetch** — schedule + launch | e-Proceedings |
| Web app, bulk bar | the scope dropdown beside *Sync N from portal* | e-Proceedings |
| Web app, assessee card | the scope dropdown beside *Sync* | e-Proceedings, or **Full sync** if that assessee has never been synced |

The connector's stored setting carries an `autoScopeChosen` flag. The default
moved from *Everything* to *e-Proceedings*, and `settings.write()` stores the
whole object — so every install that had ever toggled any switch had
`autoScope: "all"` on disk. Until somebody picks a scope themselves, that stored
value is ignored and the current default applies; the moment they do, their
choice wins for good.

### What a re-sync decides NOT to fetch — and why that is the dangerous half

A sync that re-read everything every run would be unusable, so it re-reads only
what has changed. Every one of those decisions is a decision **not to ask the
portal a question**, and a wrong one is invisible: no error, no empty result,
just data that never arrives while the app reports a clean sync.

They are therefore all in one place — `connector/src/main/syncDecisions.js` —
and they follow one rule:

> **Ask what the portal says has changed. Never infer it from something else.**

That rule is written against a real failure. A closed A.Y. 2024-25 scrutiny
carried four notices, three replies with 22 attachments, and a closure order set
(assessment order, computation sheet, demand notice u/s 156). The app showed the
four notices and nothing else, through four syncs, each reported as successful.
Nothing had failed — the sync had decided not to look, on two pieces of
reasoning that are true and are not evidence:

| The old reasoning | Why it is wrong |
|---|---|
| "the notice count is unchanged, and the proceeding is closed — skip it" | Filing a reply does not change a notice count, and neither does issuing a closure order. A closed proceeding is exactly where both live. |
| "a closed proceeding cannot receive new replies — don't ask" | True going forward, and beside the point: the replies were filed while it was open. If they were not already on file when it closed, they never would be. |
| "the fast scope reads the *For your Action* tab only" | Once any sync records a proceeding as closed it is in neither the action tab nor the just-closed list, so on the scope the app defaults to after the first sync — and the one every bulk sync uses — it does not exist. |

What the portal actually states, and what is now read:

| Portal field | Where | What it settles |
|---|---|---|
| `viewNoticeCount` | list row | is there a notice we do not hold |
| `lastResponseSubmittedOn` | list row **and** each notice | has a reply been filed since we last looked |
| `respStatus: "S"` / `isSubmitted` / `respId` | each notice | does a reply exist at all |
| `proceedingClosureOrder` | list row | is there a closure order we do not hold |

A proceeding is skipped only when **all** of those are already on file, and the
number skipped is reported to the practitioner rather than folded into a silent
"up to date". Both tabs are listed in every scope; "fast" now means less work
per proceeding, not less of the portal.

**Both syncs decide the same way.** The rules live in two files —
`connector/src/main/syncDecisions.js` (CommonJS, Electron) and
`extension/sync-decisions.js` (a content script in an isolated world, with no
module system to import through) — and `test/syncDecisions.test.mjs` runs every
case through both and fails if they return anything different. That guard is the
point of the pair: two copies of a rule that decides *not* to ask the portal can
drift apart without producing a single error anywhere.

The extension ran on the old, cruder rule for months — notice count on file +
closed, or notice count on file in `eproc` — so a reply filed against a
proceeding whose notice count had not moved was invisible to it, in every scope.
It also read *For your Action* only in `eproc` and inferred closures from what
had left it, which cannot see a proceeding that closed before the app ever
recorded it as active. Both are fixed; both paths now list both tabs and skip
only what the portal says has not moved.

**Carrying a hint is not the same as reading one.** `noticeReplies`,
`procNeedsMeta` and `appealFormsPending` were computed by `syncKnowns`, passed
through `openPortalLogin`, relayed by `background.js` — and never mentioned in
`portal-login.js`. Every one of them makes the sync skip *more* when it is
missing, silently. `test/syncKnowns.test.mjs` now reads `portal-login.js` as the
last hop and requires it to mention every field the builder produces, so the
next one fails a test instead of a client.

A list call that did not **succeed** is never read as "no proceedings", on
either path: a 500, a WAF 403 or a 401 from a session that is not ready yet
produces no rows, and no rows looks exactly like a clean compliance record. The
connector raises it (nothing is stamped); the extension hands the run back to
its navigate-and-retry path. Only a call that returned 200 with a body we cannot
parse is forgiven, because the portal has changed its own payloads before.

Three tests hold this: `test/syncDecisions.test.mjs` (the rules),
`test/portalFetchReplies.test.mjs` (the reported case replayed through the real
fetch loop against the portal's own payloads), and `test/syncKnowns.test.mjs`
(the two copies of the "what do we already hold" rules agree, and every field
survives the hops to the connector — `procNeedsMeta` was being dropped by two of
them, which is how the repair path meant to reach into a closed proceeding came
to do nothing at all).

**No migration is needed for data already missing.** These decisions are made
fresh on every run from what the portal states, so the next sync of an affected
assessee fetches the replies and orders that earlier runs skipped.

### One notice is a SET of files, not a file

The portal's "Notice/Letter pdf" screen routinely lists several Download
buttons against a single notice. A s.148 reassessment arrives as four: the
notice, the approval to the JAO, the set note, and the print of the approval
search.

`noticeletterpdf` reports this in a way that is easy to get wrong. It names ONE
document at the top level and lists the whole set separately:

```jsonc
{
  "noticeSection": "148",
  "satDocId": 442426058,                                  // ← ONE of them
  "docNam":  "…_AST_APPROVAL TO JAO.pdf.gz",
  "docMap": {                                             // ← ALL of them
    "442426058": "…_AST_APPROVAL TO JAO.pdf.gz",
    "442426042": "…_AST_SET NOTE APPROVAL.pdf.gz",
    "442426059": "…_AST_AXIPP8954H_Notice us 148_….pdf.gz",
    "442426040": "…_AST_AXIPP8954H_Print Approval Search_….pdf.gz"
  }
}
```

The sync read `satDocId` and stopped, so three of the four never left the
portal — and on this notice the one it did take was the internal approval, not
the notice the assessee has to answer.

What happens now:

- **Every** entry in `docMap` is fetched, in ascending `satDocId` order (the
  order the portal's own screen lists them in). Bounded at 12 files / 60 MB per
  notice; `docsTotal` records how many the portal listed, so the card can say
  "4 of 6" rather than implying four was all there was.
- The **primary** — what the "PDF" button saves and what the AI summary reads —
  is chosen from the filenames (the notice's own section first, then the word
  "notice"), with the portal's `satDocId` as the tie-break.
- The rest land on the notice as `attachments: [{ storagePath, filename,
  satDocId, contentType, kind, bytes }]`. `kind` is `pdf` | `zip` | `other`, and
  the Storage object carries the real extension, because the department
  sometimes hands over a **compressed folder** instead of listing files — a ZIP
  saved as `.pdf` is a file nobody can open.
- Notices already on file are **repaired once**. A known DIN is skipped by the
  incremental diff, which is the point of it, so `noticeDocsPending` /
  `procNeedsDocs` (built from notices with no `docsSyncedAt`) let the sync go
  back for what is missing. It never re-downloads the file already held, and it
  never touches a field a practitioner may have edited — that is all
  `attachNoticeDocuments` is allowed to do. The list empties itself: every
  ingest stamps `docsSyncedAt`, whatever the portal said.

`ingestPortalNotice` gained an `attachments` argument and there is one new
callable, so this phase needs `firebase deploy --only functions`.

## Phase 3 — filed returns, intimations and s.154 orders (implemented)

A full sync now also pulls every assessment year's filed return. One call to
`itrStatusService` returns them all — acknowledgement number, form, e-verification,
demand/refund position and the whole CPC activity timeline — so this pass costs
one list call plus a few documents per year, not one call per year.

Per return we store:

| Document | Endpoint | Where it lands |
|---|---|---|
| The ITR JSON, exactly as filed | `returns/downloadfile` | `returns/{ay}/itr.json` |
| ITR-V / acknowledgement | `returns/pdf` | `returns/{ay}/acknowledgement.pdf` |
| Intimation u/s 143(1), order u/s 154 | `document/intimation` | `returns/{ay}/order-{ref}.pdf` |
| The filed return itself, fully rendered | `returns/preview/{ay}` | `returns/{ay}/form.pdf` |

The first three are small — a few hundred KB between them. The rendered return
is 10-12 MB a year, and is treated differently for that reason alone; see the
next section.

Each document is fetched exactly once, when its acknowledgement number is first
seen. A filed return never changes, so there is nothing a later sync could
usefully re-read.

### The rendered return is NOT synced — it is fetched on demand

Of the four documents above, three are small (a few hundred KB between them) and
one is 10-25 MB: `returns/preview/{ay}`, the whole filed return rendered for
printing. It is paid twice — down from the portal, up to Storage — on a
practitioner's home connection. Measured on a real practice it was **18-21
seconds per year**, more than half of every sync that had any work in it.

Against that, nothing in the app depends on it:

| What you might want | Where it comes from |
|---|---|
| Computation of Total Income | the **ITR JSON** |
| Every figure on the Returns tab | the **status service** |
| Proof of filing | the **ITR-V**, 150 KB, always synced |
| Reading or printing the return as filed | the rendered form — **on demand** |

So the sync fetches the JSON, the ITR-V and the CPC orders for every year, and
leaves the rendered form to the Returns tab's **Fetch form** button, which pulls
one named year while the practitioner waits for *that* year.

`FORM_SYNC_RECENT_YEARS` (`connector/src/main/portalReturns.js` and
`extension/portal-login.js`, which must stay in step) is **0**. Set it to N to
sync the newest N years again — roughly 20 seconds per year per client on that
client's first sync, and nothing thereafter.

Two earlier attempts are recorded here because both looked reasonable and both
were wrong. **Rationing** the backfill (three per run) made every sync slow
instead of one, and could not answer "when does this stop?". A **window** of the
two most recent years still cost 40 seconds per client — and, because the fetch
was silently failing, cost it on every single run.

### When the fetch fails

A form fetch that comes back unusable — a portal error, an HTML page, or a
document past the 80 MB ceiling — is **recorded on the return** as
`formPdfError` rather than silently dropped. The Returns tab then offers
**Retry form** with the reason on hover.

This matters more than it sounds. Before it, a failed fetch left no trace, so
every later sync tried again and failed identically: twenty seconds per year,
per client, for ever, with nothing anywhere saying why. It survived four rounds
of performance work because a silent failure is indistinguishable from work.

### Orders that are never re-fetched

Two states are terminal and count as "known", so no later sync asks again:

| State | Why |
|---|---|
| stored and readable | there is nothing left to do |
| `request-only` (before A.Y. 2017-18) | the portal will not serve it directly — it opens a request-and-email flow we cannot complete unattended |

A third state, **stored but still encrypted**, is reported separately as
`lockedOrderRefs`. Retrying it is the repair path once the assessee's date of
birth is on file — and pure waste before that, because the password is derived
from that date and nothing else. The browser path learns whether a retry could
succeed from `canUnlockOrders`, since it is the app that decrypts, not the
content script.

### Which activity codes carry a downloadable order

Read off the portal's own bundle (the statuses it marks with a `dnlIntOrdr`
action), not guessed from the status text:

- **61-65** — intimation u/s 143(1) (demand determined, refund determined,
  no demand no refund, refund fully/partly adjusted)
- **71-75, 613** — rectification order u/s 154

Anything else is recorded as "no order", so a new CPC status shows up as absent
rather than mislabelled. Code 50 (intimation u/s 245) carries a reference but the
portal serves no document for it.

### Order PDFs are password-protected

CPC encrypts every s.143(1) intimation and s.154 order. The password is the
department's published recipe:

```
PAN in lower case  +  date of birth / incorporation as DDMMYYYY
e.g.  aalfj4935c04112015
```

We decrypt on the way in — using qpdf compiled to WebAssembly — so Storage never
holds a file the practitioner has to type a password into. The date comes from
the assessee record, falling back to the filed ITR JSON, and any date found that
way is written back to the assessee so it never has to be found again.

If neither source has it, the encrypted PDF is still stored and flagged; the
Returns tab says which assessees need a date of birth, and the next sync unlocks
them. **Before A.Y. 2017-18** the portal will not serve an order directly at all —
it opens a request form and e-mails the order out — so those are recorded with
that reason rather than shown as missing.

## Phase 4 — Computation of Income (implemented)

Each year's row on the Returns tab has a **Computation** button, enabled wherever
that year's ITR JSON has been synced. It maps the return to a normalised
document, checks every figure back against Part B-TI and Part B-TTI, and renders
a formatted PDF.

The mapping, the validation and the HTML all happen in the browser and are
deterministic — no AI, no network, same JSON in, same document out. Only the
HTML→PDF step is a server call (`renderComputationPdf`, headless Chromium), and
it renders finished markup without seeing the return.

**`docs/computation-spec.md` is authoritative.** Read it before touching anything
in `src/computation/`. Supported today: **ITR-1, ITR-2 and ITR-3 for A.Y. 2022-23
to 2026-27, and ITR-5 for A.Y. 2025-26** — `src/computation/supported.js` is the
single table the Returns tab reads, and a test holds it to the mappers that
actually exist. Other forms and years show a plain "not yet supported" message
rather than a wrong document.

```
npm test                        # golden model, validate(), unmapped
npm run preview:computation     # writes .tmp/<fixture>.html to eyeball
```

Deploy adds two dependencies to `functions/` (`puppeteer-core`,
`@sparticuz/chromium`) and the function needs 1 GiB:

```
firebase deploy --only functions
```


## Storage CORS — required, once per project

The app reads its own documents back out of Storage in the browser: the Returns
tab fetches a PDF to save it under a proper filename, and the Computation
generator reads the filed ITR JSON.

A browser refuses a cross-origin read of a Storage object unless the **bucket's**
CORS policy allows the site's origin, and it reports that refusal as a bare
`Failed to fetch` with no explanation. Uploads and Cloud Functions are
unaffected, so everything else looks healthy — which makes this a genuinely
confusing failure to diagnose. Symptoms:

- **Computation** shows "Failed to fetch".
- Document buttons open a viewer tab instead of downloading, with a
  `download: falling back to opening in a tab` warning in the console.

`storage.cors.json` in the repo root is the policy. Apply it once:

```bash
gcloud storage buckets update gs://prohippo2.firebasestorage.app \
  --cors-file=storage.cors.json
```

Check it took:

```bash
gcloud storage buckets describe gs://prohippo2.firebasestorage.app \
  --format="default(cors_config)"
```

Add any new origin the app is served from to that file and re-apply. Note this
is a property of the **bucket**, not of the code — a redeploy will not set it,
and it survives every deploy once set.
