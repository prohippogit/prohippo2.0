# Client document delivery — design & setup

How a notice becomes a list of documents that actually reaches the client, and
how ProHippo knows whether it arrived.

**Status: phases 0 and 1 are implemented.** Phases 2–3 are the plan, not code.

---

## The idea

A document request is **not a message**. It is a tracked checklist that *emits*
messages.

That distinction is the whole design. If a request were just text in the
communications log, then "ask for six documents, four arrive, chase the other
two before the hearing" would have nowhere to live. Modelling it as an object
with a lifecycle — drafted → sent → items arriving → complete — means reminders,
multi-channel sending and per-item progress all fall out of the same record
instead of each needing its own mechanism.

So there are two collections, with different jobs:

| Collection | Job | Lifecycle |
|---|---|---|
| `users/{uid}/docRequests` | the checklist and its state | long-lived, edited as documents arrive |
| `users/{uid}/communications` | the delivery log | append-only, one row per send attempt |

One request can produce several communications (an email, then a WhatsApp
hand-off, then a reminder). Each carries `requestId` back to its parent.

---

## Data model

### `docRequests`

```js
{
  assesseeId, assessee, pan,       // hard id + denormalised copies for display
  noticeId, ay, section, authority, din, dueDate,
  title: "Documents required — Scrutiny u/s 143(2) · AY 2021-22",
  items: [{ id, label, note, required, status: "pending|received|waived", receivedAt }],
  channels: ["email", "whatsapp"],
  message: { subject, emailHtml, emailText, whatsappText },
  status: "draft|sent|partial|complete|failed",
  createdAt, updatedAt, sentAt, lastSentAt, lastEmailId, lastError,
}
```

Item ids are stable (`newItemId()` in `store.jsx`), so an item can be renamed or
reordered without losing whether it has been received.

### `communications`

Unchanged in shape, plus `assesseeId`, `requestId`, `providerId`, and real
delivery statuses. Every existing row keeps working.

### What the message tells the client

Every request ends with a **"How to send them"** block asking for **PDF, under
5 MB**, plus a hint that the phone's Scan option makes one.

That is not a style preference. The Income-tax portal accepts PDF only, capped
at 5 MB per file — a client who WhatsApps twelve photos has produced nothing
filable, and someone in the firm then spends an evening converting them. Asking
for the right format once, inside the request, is the whole saving.

The email carries a **ProHippo logo in the footer**, under "Sent via", not in the
header. The header belongs to the practitioner's firm: the client's relationship
is with their CA, and leading with a third party's logo would both confuse the
recipient about who is writing and make a solicited email look like marketing.
Footer attribution is the standard pattern, and the brand still gets seen on
every request.

`LOGO_URL` in `messageTemplates.js` points at Firebase Hosting's default domain,
which is always live. Point it at `prohippo.in` once that domain serves the app —
a broken image in every client email is worse than a plainer URL.

### Why the message is stored, not re-rendered

`src/messageTemplates.js` renders on the **client**, at draft time, and the
result is saved onto the request. `sendClientMessage` then delivers that stored
copy verbatim.

This is deliberate. The alternative — rendering server-side at send time — means
two copies of the template that can drift, and a preview that is only *probably*
what the client receives. Here the preview is byte-for-byte the sent message.

---

## Why `assesseeId` had to happen first

Communications used to be linked to a client by string match:

```js
data.communications.filter(c => c.to === a.name || c.to === a.email || c.to === a.mobile)
```

Rename an assessee and their entire message history silently detached. The same
match drove cascade-delete, so deleting an assessee left orphaned rows behind.

Every record now carries `assesseeId`. The string match survives only as a
fallback for rows written before the change, and
`backfillCommunicationLinks()` (in `store.jsx`, idempotent, called on the
Assessees page) stamps the id onto old rows as they're encountered.

---

## Sending

### Email — real, server-side

`sendClientMessage({ requestId, channel: "email" })` → Resend.

Two things are deliberately **not** taken from the caller:

- **The recipient.** Resolved server-side from the assessee record. A stolen
  session can't use this as an open relay to arbitrary addresses without also
  writing to the practitioner's own assessee list.
- **The From address.** Fixed to `CLIENT_EMAIL_FROM`.

**Reply-To** is set to the practitioner's own account email, so client replies
land in their inbox rather than vanishing.

Rate limit: 50 sends per rolling hour per user (`clientMailQuota/{uid}`,
transactional so parallel sends can't both slip past the cap). Far above normal
firm usage — it exists so a bug or a stolen session can't turn the account into
a mail cannon.

### Delivery status — the actual payoff

`resendWebhook` receives Resend's `email.*` events and walks the communication
row forward:

```
Queued → Sent → Delivered → Opened
                      ↘ Bounced / Complained / Failed
```

Events are ranked (`STATUS_RANK`), so a late-arriving `delivered` can never
downgrade a row that has already been marked `opened`.

This is the difference between "we opened your mail client" and "their server
accepted it at 14:32 and someone opened it" — which is exactly the conversation
you have with a client three days before a hearing.

Signature verification implements the Svix scheme directly with `node:crypto`
(HMAC-SHA256 over `${id}.${timestamp}.${body}`, 5-minute tolerance), so
`functions/` needs no new dependency.

### WhatsApp — a hand-off, honestly labelled

WhatsApp opens `wa.me` with the message pre-filled; the practitioner presses
send there. The log records **"Opened in WhatsApp"**, not "Sent".

That wording matters. The previous code logged `status: "Sent"` for a tab it had
merely opened — so the log could confidently claim a message was delivered that
the user never actually sent. A delivery log that lies is worse than no log,
because it is the thing you show a client who says they never received the list.

Real WhatsApp delivery is phase 3.

---

## Where it plugs into the existing app

### "Ask for documents" — the one action

`<AskDocsButton notice={n}/>` (`src/askForDocuments.jsx`) is self-contained:
drop it beside a notice anywhere and it handles the whole flow, composer
included. It **never dead-ends** — whatever state the notice is in, pressing it
gets you to a composer:

| Notice state | What happens |
|---|---|
| A request already exists | Opens it, showing `received/total` — never a silent duplicate |
| Lists documents | Composer, pre-filled |
| Has a PDF but no list | Reads the PDF (`extractNoticeDocuments`), then composer |
| Neither | Composer with the section's presets ready to click |

It appears on notice tiles in proceedings, the Assessee → Notices tab, the
Notices page, and the Dashboard's awaiting-review list. Orders are excluded —
an order is decided, there is nothing left to ask the client for.

The button turns **primary** and grows a deadline chip ("Due tomorrow",
"3 days left") when the notice's hearing or compliance date is within a week.
Same control everywhere, visually shouting only when it matters — rather than
disappearing on notices you might still want it for.

### Other entry points

| Entry point | File | What happens |
|---|---|---|
| Notice review → "Save & ask client for documents" | `src/Notices.jsx` | Saves the notice and opens the composer over it — parse to sent with no stop in Communications |
| Notice review → "Draft client document request" toggle | `src/Notices.jsx` | Creates a `docRequest` seeded from `notice.documents[]`, message pre-rendered so it is immediately sendable |
| Communications → "Document request" | `src/Other.jsx` | Composer with an assessee picker |
| Assessee → Communications tab | `src/Assessees.jsx` | Per-client requests with progress, plus the message log |

### Two Gemini paths, two jobs

Do not confuse these — they answer different questions about the same PDF:

| Callable | Prompt | Returns | Used by |
|---|---|---|---|
| `summarizePortalNotice` | `summaryPrompt` | additions/disallowances, order metadata | "Parse with AI" on a proceeding tile |
| `extractNoticeDocuments` | `DOCUMENTS_PROMPT` | `documents[]` + due dates only | "Ask for documents" |

`extractNoticeDocuments` is deliberately narrow. A portal notice already has its
PAN, AY, section, DIN and dates **from the source system** — those are
authoritative, and re-reading them with an AI can only make them worse. It
extracts the one thing genuinely missing, and fills a date only where nothing is
on file.

> **Why it was needed at all:** `ingestPortalNotice` writes every portal-synced
> notice with `documents: []`, because the portal's JSON carries no such list —
> it exists only in the PDF's prose. Without this, the document request had
> nothing to work from on exactly the notices that arrive automatically.

`src/docRequestPresets.js` adds the items a notice never spells out but a
practitioner always needs — ordered by the notice's section, and de-duplicated
against what's already on the list.

---

## Setup (one-time)

**There is no DNS step.** Client mail goes out from `notices@prohippo.in`, the
domain already verified in Resend for the login OTPs, so nothing new needs
verifying and nothing new costs money.

The remaining work is the webhook, which has a chicken-and-egg — you need the
deployed URL to create the webhook, but you need its signing secret in order to
deploy — that step 1 breaks with a placeholder.

Everything below assumes the Firebase CLI is installed and signed in:

```
npm install -g firebase-tools
firebase login
firebase use prohippo2
```

### On the sending domain

Best practice is a dedicated subdomain (`send.prohippo.in`) so a spam complaint
on a client email can't dent sign-in deliverability. **Resend's free plan allows
one verified domain**, and `prohippo.in` is already it — a second is a paid
upgrade.

That upgrade isn't worth it yet. These are solicited emails to the firm's own
clients who are expecting them, a few per day; the complaint risk that the
separation protects against is a bulk/cold-outreach risk. Revisit when volume
grows — switching is one line (`CLIENT_EMAIL_FROM` in `functions/index.js`) plus
a DNS verification.

> **Shared quota:** document requests and login OTPs now draw on the same Resend
> allowance (free plan: 3,000/month, 100/day). Fine for a small practice, but
> it's a shared budget — a burst of client emails eats into the headroom your
> sign-in emails need.

### Step 1 — Create a placeholder webhook secret, then deploy

The deploy fails (or stops to prompt) if a secret the code references doesn't
exist yet, so create it before deploying:

```
printf 'placeholder' | firebase functions:secrets:set RESEND_WEBHOOK_SECRET --data-file=-
```

Then deploy from a checkout of the branch carrying this feature:

```
cd ~/prohippo2.0 && git fetch origin && git checkout -f claude/communications-document-delivery-1cdv0l && git reset --hard origin/claude/communications-document-delivery-1cdv0l
cd functions && npm install && cd .. && firebase deploy --only functions
```

Wait for **`✔ Deploy complete!`**, then copy the URL the CLI prints for
`resendWebhook`. It looks like:

```
https://asia-south1-prohippo2.cloudfunctions.net/resendWebhook
```

If it scrolls past, get it back with `firebase functions:list`.

`resendWebhook` deploys to `asia-south1` only — Resend calls one fixed URL, and
unlike the callables there is no older client pinned to `us-central1`.

### Step 2 — Create the webhook, then set the real secret

1. https://resend.com/webhooks → **Add Webhook**
2. Paste the URL from step 1.
3. Subscribe to: `email.sent`, `email.delivered`, `email.delivery_delayed`,
   `email.opened`, `email.bounced`, `email.complained`.
4. **Add**, then open the webhook and copy its **Signing Secret** (`whsec_…`).

Store the real secret and redeploy just that function:

```
printf '%s' 'whsec_PASTE_YOURS_HERE' | firebase functions:secrets:set RESEND_WEBHOOK_SECRET --data-file=-
firebase deploy --only functions:resendWebhook
```

> A secret's value is read at cold start, so the redeploy is what makes the new
> value take effect. Until it does, the webhook rejects everything with 401 —
> sending still works, statuses just stay at `Queued`.

### Step 3 — Get the UI live

Hosting auto-deploys only from the default branch
(`claude/keen-ride-FlIY1`, see `.github/workflows/firebase-deploy.yml`). Merge
the pull request for this branch and the site rebuilds itself — no manual
hosting deploy.

### Checking it worked

1. Open an assessee whose **email is one you can read** (your own is ideal).
2. **Communications → Document request** → pick them, add an item, **Send email**.
3. The mail arrives from `notices@prohippo.in`; replying to it should
   address your own account email.
4. Back in **Communications → Message log**, the row starts at `Queued` and
   should reach `Delivered` within seconds, then `Opened` once you open it. If
   it stays at `Queued`, the webhook is the problem, not the send — see below.

### If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| Send fails, "couldn't send the email right now" | `RESEND_API_KEY` missing, or the monthly/daily Resend allowance is spent | Check Functions logs for the Resend status code; check usage at resend.com |
| Status stuck at `Queued` | Webhook not reaching the function, or still on the placeholder secret | Resend → the webhook → its delivery attempts. `401` = secret mismatch, redo step 2's redeploy |
| Resend shows `403` on the webhook | Function not publicly invokable | Cloud Run → `resendwebhook` → Security → allow unauthenticated invocations |
| "No valid email address on file" | The assessee record has no email | Add one on their profile — the recipient is read server-side from that record, never from the browser |

---

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| **0** | `docRequests` collection, `assesseeId` links, store CRUD, backfill | **done** |
| **1** | Composer, drafts list, `sendClientMessage`, delivery webhook | **done** |
| **A** | `extractNoticeDocuments`, universal "Ask for documents" button, save-&-ask from notice review | **done** |
| **B** | Dashboard "needs documents" strip; auto-extract on portal sync; request progress on the notice tile | planned |
| **2** | Checklist PDF via jsPDF, attached to the email; notice PDF attachment | planned |
| **3** | WhatsApp Cloud API, client upload link, scheduled reminders | planned |

### Phase B notes

- **Auto-extract on sync** means extending `onPortalOrderWritten` (orders only
  today) to pull the document list for notices as they land, so the checklist is
  ready before anyone opens the proceeding.

  > ⚠️ This needs a hard gate on `responseDueDate >= today`. Adding a new
  > assessee pulls in years of notice history — see the comment on
  > `awaitingNotices` in `store.jsx` — and parsing all of it would fire hundreds
  > of Gemini calls per new client. Only parse what is still live.

- **Dashboard "needs documents" strip**: notices with a deadline inside N days
  and no request raised. Pure UI over data that already exists, and it flips the
  app from "you remember to check" to "the app tells you what to chase".

### Phase 2 notes

`ledgerPdf.js` and `invoicePdf.js` already generate vector PDFs with the house
fonts — a checklist PDF is the same pattern. Attach via Resend's
`attachments: [{ filename, content }]` (base64), pulling the notice PDF from
Storage with the Admin SDK. Keep the total under ~10 MB.

### Phase 3 notes

- **WhatsApp Cloud API** (Meta direct, or an Indian BSP — AiSensy / Interakt /
  Gupshup / WATI). Business-initiated messages need a **pre-approved template**,
  so a 12-item checklist cannot go in the body. Send a template with variables
  (name, proceeding, due date, item count, link) plus the checklist PDF as a
  document attachment. Once the client replies, the 24-hour customer-service
  window allows free-form messages — reminders after a reply are unconstrained.
  Meta business verification plus template approval is the long pole; start it
  in parallel with other work.
- **Client upload link** — `prohippo.in/r/{token}` showing the checklist with
  tick boxes and an upload button. It **must** be served by a Function using the
  Admin SDK: Firestore and Storage rules deny all public access by design, and
  that should not change.
- **Reminders** — a daily `onSchedule` in `asia-south1` over requests with
  pending items and a `dueDate` inside N days, respecting `lastRemindedAt` and a
  max count.

---

## Known limits

- **Shared sending domain and quota.** Client mail and login OTPs both go out
  from `prohippo.in` and draw on the same Resend allowance. A deliberate
  cost trade-off, not an oversight — see "On the sending domain" above.
- **Escape closes both modals.** The composer opened from a proceeding card or
  the awaiting-notices dialog is a modal inside a modal, and `Modal` puts its
  Escape handler on `window` — so one press closes both. Harmless, but fixing it
  properly needs a modal stack, which is more than this change warranted.
- **wa.me URL length.** A long checklist produces a long URL. WhatsApp handles
  it, but some browsers truncate around 2 000 characters. Phase 3's link + PDF
  approach removes this.
- **The composer is a trusted surface.** The practitioner authors the message
  that goes to their own client, so the stored HTML is delivered as written. The
  rate limit, the server-resolved recipient and the fixed From address are the
  abuse controls, not content sanitisation.
- **`store.jsx` lint.** The new derived helpers add
  `react-refresh/only-export-components` errors, the same rule that already
  fires on every helper that file exports alongside `DataProvider`. Consistent
  with the file; not newly broken.
- **Consent.** These messages carry a client's PAN, assessment year and notice
  section over WhatsApp and email. Worth stamping a `consentAt` on the assessee
  under the DPDP Act — the portal-credential consent checkbox in
  `AssesseeModal.jsx` is the existing pattern to copy.
