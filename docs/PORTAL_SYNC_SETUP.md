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

1. Chrome → `chrome://extensions` → turn on **Developer mode**.
2. Click **Load unpacked** and select the `extension/` folder from the repo.
   (In Cloud Shell you can't load it; do this on your own computer — either
   clone the repo locally, or download the `extension/` folder.)
3. **ProHippo Sync** appears in the list.

See `extension/README.md` for details.

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

The rendered return is much the largest of these — 10-12 MB a year against a few
hundred KB for everything else — and was first left to an on-demand button for
that reason. It is now synced: a practitioner opening a client's file expects the
return to be there, and waiting on a portal round trip to read a return you
already filed is not a saving anyone asked for. Budget roughly **100 MB per
assessee** across ten assessment years.

Each document is fetched exactly once, when its acknowledgement number is first
seen; a filed return never changes. Years synced before this change keep a
**Fetch form** button on the Returns tab, and a fresh sync picks them up.

Metadata goes to `users/{uid}/returns`, one document per PAN + assessment year,
via `ingestPortalReturn`. These are **not** filed under `notices` — they are not
e-Proceedings, have no DIN, carry no reply thread, and no appeal deadline is
derived from them.

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
in `src/computation/`. Supported today: **ITR-5, A.Y. 2025-26**. Other forms and
years show a plain "not yet supported" message rather than a wrong document.

```
npm test                        # golden model, validate(), unmapped
npm run preview:computation     # writes .tmp/<fixture>.html to eyeball
```

Deploy adds two dependencies to `functions/` (`puppeteer-core`,
`@sparticuz/chromium`) and the function needs 1 GiB:

```
firebase deploy --only functions
```
