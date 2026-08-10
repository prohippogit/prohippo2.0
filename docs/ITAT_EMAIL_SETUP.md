# ITAT email ingest — setup

Each practice gets one inbound address. Anything sent to it that came from the
Tribunal is read, and offered as a matter or a hearing for one click of
confirmation. Why it is an address rather than a mailbox read — and the routes
for appeals registered under a client's address — is in `ITAT_EMAIL_INGEST.md`.

Four one-time steps: a domain, an inbound provider, one secret, deploy.

**No OAuth and no verification review.** Nothing here reads anybody's mailbox,
so there is no Google scope to be assessed and no annual security review. That
is the main reason this shape was chosen over `gmail.readonly`.

---

## Step 1 — A domain to receive on

```
prohippo.info
```

**A domain of its own, not a subdomain of `prohippo.in`.** Every address under
this domain is a firehose pointed at a public webhook, and `prohippo.in` carries
the login emails Resend sends. A fat-fingered MX record on that zone locks every
practitioner out of the app. A separate registration makes that impossible
rather than merely unlikely, and a second domain costs less than one support
call.

The whole domain is used, not a subdomain of it — addresses are
`<16 hex characters>@prohippo.info`. There is nothing else on this domain to
disturb, and it keeps the MX record at the zone apex where every inbound
provider expects it.

The domain is a constant, `MAIL_DOMAIN`, at the top of
`functions/itatEmailParse.js`. Change it there if you use a different name;
addresses already issued keep their old domain until each practice resets.

## Step 2 — An inbound provider

Any provider that **receives** mail and POSTs it to a URL. The webhook reads all
three common shapes, so this is a free choice:

| Provider | Posts as | Free allowance | Notes |
| --- | --- | --- | --- |
| **CloudMailin** | JSON | 10,000 inbound messages/month | Inbound is the whole product rather than a feature bolted to a sender, and its free tier is far beyond what a practice will ever use. **Recommended.** |
| **Mailgun Routes** | form fields | 1 inbound route on the free plan | Fine, and the free plan is permanent. Its 100-messages-a-day cap is a sending limit, but check it still suits before relying on it. |
| **SendGrid Inbound Parse** | multipart/form-data | none — the free tier became a 60-day trial | Works, but there is no longer a free plan to sit on. |
| **Postmark inbound** | JSON | none — inbound needs the Pro tier | Technically the cleanest payload; inbound is not on the free or Basic plans. |
| **Cloudflare Email Worker** | whatever you write | free within Workers' limits | No per-message cost, but the Worker must parse MIME itself and needs a build step, and the domain's DNS has to move to Cloudflare. Only worth it at volume. |

Prices move. Check the provider's own page before signing up — what matters here
is only that it does **inbound parse**, and the payload shape does not, because
all four are read.

> **Sending services cannot do this.** Resend, Zoho ZeptoMail, Amazon SES's
> sending side, Brevo and the rest are transactional *senders*. Their webhooks
> report what happened to mail you sent — delivered, bounced, opened — and none
> of them receives mail on your behalf or posts an inbound message anywhere.
> Neither will a mailbox host such as Zoho Mail or Google Workspace: they will
> happily receive at this domain, but they deliver into a mailbox, and getting it
> out again means polling IMAP, which is a different design and a different
> build. The requirement is specifically *inbound parse*, and it is worth
> checking a provider's docs for that phrase before signing up.

Point the domain's MX at the provider as it instructs, then give it this webhook
URL — with the secret from step 3 on the end:

```
https://asia-south1-prohippo2.cloudfunctions.net/itatInboundEmail?key=YOUR_SECRET
```

> The endpoint refuses anything that does not present the key, so configure the
> secret first or the first test message is silently rejected.

### With CloudMailin, specifically

Sign up, create an address, and it hands you an MX destination and a target URL
field. Paste the webhook URL above into it, set the format to **JSON**, and add
the MX record below. Its JSON is an `envelope` plus a `headers` object — a
different shape from Postmark's, and read by its own branch in `fromJson`,
matching header names case- and punctuation-insensitively so either of
CloudMailin's two JSON formats works without a setting to get wrong.

The envelope is what matters: a Gmail filter forward leaves `To:` pointing at
the practitioner's own mailbox, and `envelope.to` is the only field carrying the
practice address.

### Setting the MX record at BigRock

`prohippo.info` is registered at BigRock and still on BigRock's own nameservers
(`dns1.bigrock.in` … `dns4.bigrock.in`), so the record is added in their panel —
there is no need to move nameservers anywhere.

**Orders → prohippo.info → DNS Records → MX Records → Add MX Record.** Leave the
host name blank (or `@`) so it applies to the domain itself, and use the
destination and priority your provider gives you. Delete any MX record BigRock
created by default, or mail will be delivered to whichever has the lower
priority number and the webhook will never fire.

DNS takes anything from a few minutes to a few hours to take effect. Check it
with `dig MX prohippo.info +short` before assuming something is broken.

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
    "to": "YOUR_PRACTICE_ADDRESS@prohippo.info",
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
