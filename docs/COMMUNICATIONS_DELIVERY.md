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

| Entry point | File | What happens |
|---|---|---|
| Notice review → "Draft client document request" toggle | `src/Notices.jsx` | Creates a `docRequest` seeded from `notice.documents[]`, message pre-rendered so it is immediately sendable |
| Notice review → "Prepare request" button | `src/Notices.jsx` | Opens the composer directly (saved notices only) |
| Communications → "Document request" | `src/Other.jsx` | Composer with an assessee picker |
| Assessee → Communications tab | `src/Assessees.jsx` | Per-client requests with progress, plus the message log |

The AI parser already extracts `documents[]` from the notice PDF
(`EXTRACTION_PROMPT` in `functions/index.js`), so in the common path the
checklist arrives pre-filled and the practitioner only edits.

`src/docRequestPresets.js` adds the items a notice never spells out but a
practitioner always needs — ordered by the notice's section, and de-duplicated
against what's already on the list.

---

## Setup (one-time)

### 1. Verify a sending subdomain in Resend

Client mail goes out from **`send.prohippo.in`**, not the bare domain.

> ⚠️ `login@prohippo.in` carries the sign-in OTPs. If a client marks a document
> request as spam, that reputation hit must not land on the emails people need
> in order to get into the product. Keep the two domains separate.

In the Resend dashboard → **Domains** → add `send.prohippo.in`, then add the
DKIM/SPF records it gives you to DNS and wait for verification. The From address
is `CLIENT_EMAIL_FROM` in `functions/index.js` — change it there if you use a
different subdomain.

### 2. Set the webhook signing secret

Resend dashboard → **Webhooks** → add an endpoint pointing at the deployed
`resendWebhook` URL, subscribed to the `email.*` events. Copy its signing secret
(a `whsec_…` value) and store it:

```
printf '%s' 'whsec_YOUR_SECRET' | firebase functions:secrets:set RESEND_WEBHOOK_SECRET --data-file=-
```

### 3. Deploy

```
cd ~/prohippo2.0/functions && npm install && cd .. && firebase deploy --only functions
```

`resendWebhook` deploys to `asia-south1` only — Resend calls one fixed URL, and
unlike the callables there is no older client pinned to `us-central1`.

Deploy the functions first, then paste the resulting URL into the Resend
dashboard, then set the secret and redeploy. Until the secret is set the webhook
rejects everything with 401 — sending still works, statuses just stay at
`Queued`.

---

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| **0** | `docRequests` collection, `assesseeId` links, store CRUD, backfill | **done** |
| **1** | Composer, drafts list, `sendClientMessage`, delivery webhook | **done** |
| **2** | Checklist PDF via jsPDF, attached to the email; notice PDF attachment | planned |
| **3** | WhatsApp Cloud API, client upload link, scheduled reminders | planned |

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
