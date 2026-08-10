# ITAT email ingest — setup

Each practice gets one inbound address. Anything sent to it that came from the
Tribunal is read, and offered as a matter or a hearing for one click of
confirmation. Why it is an address rather than a mailbox read — and the routes
for appeals registered under a client's address — is in `ITAT_EMAIL_INGEST.md`.

Four one-time steps: a subdomain, an inbound provider, one secret, deploy.

**No OAuth and no verification review.** Nothing here reads anybody's mailbox,
so there is no Google scope to be assessed and no annual security review. That
is the main reason this shape was chosen over `gmail.readonly`.

---

## Step 1 — A subdomain to receive on

Use a **subdomain**, not `prohippo.in` itself:

```
itat.prohippo.in
```

Its MX record points at the inbound provider. The MX for `prohippo.in` — which
is what Resend and the website's own mail depend on — is untouched, and a
mistake here cannot cost you the ability to send login emails.

The domain is a constant, `MAIL_DOMAIN`, at the top of
`functions/itatEmailParse.js`. Change it there if you use a different name;
addresses already issued keep their old domain until each practice resets.

## Step 2 — An inbound provider

Any provider that receives mail and POSTs it to a URL. The webhook reads all
three common shapes, so this is a free choice:

| Provider | Posts as | Notes |
| --- | --- | --- |
| **Postmark inbound** | JSON | The least to go wrong — no multipart, and `OriginalRecipient` carries the envelope address the alias is found in. Recommended. |
| **SendGrid Inbound Parse** | multipart/form-data | Free tier is ample. Needs the `busboy` dependency, which `functions/package.json` already lists. |
| **Mailgun Routes** | form fields | Equivalent; its webhook signing is a little better out of the box. |
| **Cloudflare Email Worker** | whatever you write | Free. Have the Worker POST `{from, to, subject, text, html, headers, messageId}` as JSON. |

Point the subdomain's MX at the provider as it instructs, then give it this
webhook URL — with the secret from step 3 on the end:

```
https://asia-south1-prohippo2.cloudfunctions.net/itatInboundEmail?key=YOUR_SECRET
```

> The endpoint refuses anything that does not present the key, so configure the
> secret first or the first test message is silently rejected.

## Step 3 — The secret, and deploy

In **Cloud Shell** (https://shell.cloud.google.com):

```
firebase functions:secrets:set ITAT_INBOUND_SECRET
```

Paste a long random value when prompted — `openssl rand -hex 24` is fine. It is
the shared secret in the webhook URL above and nothing else uses it.

```
cd ~/prohippo2.0/functions && npm install && cd .. && firebase deploy --only functions
```

## Step 4 — One forwarding rule, on the mailbox ITAT writes to

The practice address does nothing until mail is sent to it. For most appeals
that means a single rule on the practitioner's own mailbox — the address entered
on the ITAT portal at registration is ordinarily theirs.

**Settings → Integrations → ITAT email** shows the address, a Copy button, and
the four steps. In Gmail, in short:

1. On a **computer** — Gmail's phone apps do not offer forwarding at all.
2. **Forwarding and POP/IMAP → Add a forwarding address**, paste the address.
3. Gmail emails a confirmation code *to the practice address*, so it appears on
   that Settings card. Copy it back into Gmail.
4. Leave forwarding itself **disabled**, and instead create a filter with
   `From: no-reply@itat.nic.in` → **Forward it to** the address.

Step 4 is not optional pedantry. Gmail's plain "forward a copy of incoming mail"
switch would send the practice address the entire mailbox. Everything that is
not from the Tribunal is discarded on arrival without being stored, but the
right instruction is the one that never sends it.

---

## How it works

| Piece | What it does |
| --- | --- |
| `getItatEmailAddress` | Callable. Mints the practice's address on first ask, and returns it thereafter. Idempotent, so the Settings screen calls it on mount. |
| `resetItatEmailAddress` | Callable. New address; the old one stops resolving at once. For an address that reached the wrong person. |
| `itatInboundEmail` | The webhook. Checks the secret, finds the practice from the alias, parses, and stores. **Never writes a matter or a hearing.** |
| `applyItatMail` | Callable. Turns one reviewed email into a matter, and for a notice of hearing a hearing, marking any superseded hearing adjourned. |
| `dismissItatMail` | Callable. Files an email as handled without creating anything. |
| `functions/itatEmailParse.js` | All the reading. Pure — no firebase imports — so `npm test` runs it against the real emails. |

### Where things are stored

| Path | Holds | Client access |
| --- | --- | --- |
| `users/{uid}/integrations/itatEmail` | address, token, counts, last received, Gmail's pending code | read — drives the Settings card live |
| `users/{uid}/itatMail/{id}` | one received email: what was parsed, what was matched, and its status | read — backs the review queue |
| `inboundAliases/{token}` | the address → practice lookup | **denied by rules** — Cloud Functions only |

`inboundAliases` is top-level, so the existing catch-all `allow read, write: if
false` already denies clients, exactly as it does for `googleTokens` and
`portalCreds`. No rules change was needed.

### Why nothing is applied automatically

An address that receives mail from the internet can be sent a convincing
forgery, and a hearing date in somebody's diary on the wrong day is the one
mistake this application exists to prevent. So the webhook only ever parses and
stores; every matter and hearing is written by `applyItatMail`, called by a
signed-in practitioner with the parsed fields on screen in front of them.

Automatic application for messages that prove they came from the Tribunal is
phase 2, and wants a look at real `Authentication-Results` headers first — see
the open questions in `ITAT_EMAIL_INGEST.md`.

### Why a duplicate never creates a second matter

Document IDs are derived, not allocated: a matter's is
`itat_<sha1(canonical appeal number)>` and a hearing's is
`itath_<sha1(appeal number + date)>`. The same email arriving twice — a provider
retry, or the practitioner *and* their client both forwarding it — resolves to
the document it already wrote. The message itself is also deduplicated on its
`Message-ID` before that, so the second copy never even reaches the queue.

An **adjournment** is a new date for the same appeal, so it writes a new hearing
and marks the earlier one `Adjourned` rather than editing it. A matter put off
four times still reads as four dates.

### What is dropped

Mail whose sender is not `itat.nic.in` is counted and discarded — not stored,
not logged beyond a counter. This is what makes the line on the Settings card
("anything else is discarded unread") true rather than aspirational, and it is
the containment for a forwarding rule someone has scoped too widely.

The one exception is Gmail's own forwarding-confirmation mail from
`google.com`, which is recognised for its code and nothing else. It never
becomes a matter, and the code is hidden again after thirty minutes because a
dead code left on screen reads as a broken feature.

---

## Testing it without waiting for the Tribunal

```
curl -X POST "https://asia-south1-prohippo2.cloudfunctions.net/itatInboundEmail?key=YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "ITAT Online <no-reply@itat.nic.in>",
    "to": "YOUR_PRACTICE_ADDRESS@itat.prohippo.in",
    "subject": "Notice of Hearing in ITA 2530/AHD/2026 (Date of Hearing: 2026-Sep-15)",
    "text": "In Appeal No. ITA 2530/AHD/2026 Assessment Year: 2016-17 Permanent Account Number: BLGPG1814C Hearing Bench: D , Case Type: DBC. Take notice that the above appeal has been fixed for hearing at 3rd & 4th Floor, Abhinav Arcade, Ellis Bridge, Ahmedabad - 380006, Gujarat at 10.30 a.m on 15-Sep-2026 (Tue).",
    "messageId": "<smoke-test-1@itat.nic.in>"
  }'
```

Expect `ok`, and the hearing waiting under **From the Tribunal** on the Hearings
page. The other replies are all deliberate and all `200`: `no-alias` (the
address did not match a practice), `dropped` (sender not the Tribunal),
`duplicate` (that `Message-ID` has been seen), `code` (a Gmail confirmation).
A `401` means the key is wrong.

Change `messageId` between runs, or the second call is correctly ignored.

---

## Troubleshooting

**Nothing arrives at all** — check the provider's own delivery log first. If it
shows a 401, the key in the URL does not match the secret. If it shows 200 and
`no-alias`, the practice address is not in any recipient field the provider
sent; with SendGrid confirm that **POST the raw, full MIME message** is *off*,
so `envelope` is included.

**Everything says `dropped`** — the forwarding rule is sending mail that is not
from `itat.nic.in`. That is the sender allowlist doing its job.

**A hearing was confirmed but is not in Google Calendar** — that is the calendar
sync, not this. See `GOOGLE_CALENDAR_SETUP.md`; the hearing itself is on the
Hearings page either way.

**An email is in the queue as "Not recognised"** — the Tribunal changed a
template. The message is kept rather than discarded precisely so this is
visible; the fixtures to update live in `test/itatEmail.test.mjs`.
