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
| **CloudMailin** | JSON | 10,000 inbound messages/month, but **custom domains need the $25/mo plan** | Inbound is the whole product rather than a feature bolted to a sender. Free, but on `cloudmailin.net` and one address per practice — fine for a single practice, see below. |
| **Mailgun Routes** | form fields | 1 inbound route **and a custom domain**, on the permanent free plan | One route can catch every address at the domain, so one free route serves every practice. The strongest free option for a multi-practice deployment. |
| **SendGrid Inbound Parse** | multipart/form-data | none — the free tier became a 60-day trial | Works, but there is no longer a free plan to sit on. |
| **Postmark inbound** | JSON | none — inbound needs the Pro tier | Technically the cleanest payload; inbound is not on the free or Basic plans. |
| **Cloudflare Email Worker** | whatever you write | free within Workers' limits | No per-message cost, but the Worker must parse MIME itself and needs a build step, and the domain's DNS has to move to Cloudflare. Only worth it at volume. |

**For more than one practice, Mailgun's free plan is the one to reach for.** Its
single inbound route takes a pattern, so `match_recipient(".*@prohippo.info")`
catches every address at the domain and forwards all of them to the one webhook
— which is exactly the catch-all the other providers charge for. Every practice
then gets a working `<token>@prohippo.info` with no per-customer setup at all.

Prices move, and the free tiers move faster. Check the provider's own page
before signing up — what matters here is only that it does **inbound parse**,
and the payload shape does not, because all of these are read.

> **Sending services cannot do this.** Resend, Zoho ZeptoMail, Amazon SES's
> sending side, Brevo and the rest are transactional *senders*. Their webhooks
> report what happened to mail you sent — delivered, bounced, opened — and none
> of them receives mail on your behalf or posts an inbound message anywhere.
> Neither will a mailbox host such as Zoho Mail or Google Workspace: they will
> happily receive at this domain, but they deliver into a mailbox, and getting it
> out again means polling IMAP, which is a different design and a different
> build. The requirement is specifically *inbound parse*, and it is worth
> checking a provider's docs for that phrase before signing up.

Point the domain's MX at the provider as it instructs, then give it the webhook
URL with the secret from step 3 on the end.

**Take the URL from what the deploy prints**, rather than assembling one. These
are 2nd-gen functions, so they run on Cloud Run and the deploy ends with the
address to use:

```
Function URL (itatInboundEmail(asia-south1)): https://itatinboundemail-XXXXXXXX-el.a.run.app
```

The provider gets that, with `?key=YOUR_SECRET` appended. The older
`https://asia-south1-<project>.cloudfunctions.net/itatInboundEmail` form still
resolves as a compatibility alias, but the printed one is the address the
function actually answers on, and it is right by construction rather than by
someone remembering the pattern.

> The endpoint refuses anything that does not present the key, so configure the
> secret first or the first test message is silently rejected.

### With Mailgun, specifically

**Receiving → Add domain** `prohippo.info`, then point its MX at the hosts
Mailgun gives (`mxa.mailgun.org` and `mxb.mailgun.org`, priority 10 and 10) —
see the BigRock steps below, and delete whatever MX records were there before.

Then **Receiving → Create Route**, one of them:

| Field | Value |
| --- | --- |
| Expression type | Match Recipient |
| Recipient | `.*@prohippo.info` |
| Action | Forward → the webhook URL with `?key=YOUR_SECRET` |
| Priority | 0 |

That single route is the catch-all. Nothing more is needed per practice: an
address minted in Settings works the moment it is minted.

Mailgun posts form fields rather than JSON, which the webhook reads — and its
`message-headers` arrive as a JSON array of pairs rather than as a header
block, which `fromForm` understands. The recipient is in `recipient`, the
envelope address, so a Gmail filter forward resolves correctly.

Two things to confirm on the free plan before relying on it: whether its
100-messages-a-day figure counts received mail as well as sent, and that log
retention of one day is enough for the delivery log to still be useful when
something needs diagnosing. Neither is likely to bite at a few emails a day.

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

**Only the MX record is needed.** CloudMailin's DNS page offers five records,
and four of them exist so you can *send* through CloudMailin: a `mta.` CNAME, a
`._domainkey` DKIM key, a `_dmarc` policy, and an SPF `include:`. ProHippo sends
nothing through this domain — the app's own mail goes out through Resend on
`prohippo.in` — so those four can be skipped entirely, and skipping the 2048-bit
DKIM key avoids the registrar TXT-length fight it usually starts. CloudMailin's
own page labels the MX row "Inbound", which is the one to trust.

**Custom domains are a paid feature.** CloudMailin's free tier — 10,000 messages
a month, and generous with everything else — issues an address on
`cloudmailin.net` and puts `prohippo.info` behind the $25/month Starter plan.
Three hundred dollars a year to change the words after the `@`, on a mailbox
receiving a few dozen messages a month, is a poor trade.

So don't. Take the address CloudMailin gives you and tell ProHippo to listen on
it: **Settings → Integrations → ITAT email → "Your mail provider gave you a
different address?"**, paste it, save. Nothing downstream cares which domain an
address is on — the webhook looks up whichever address the mail was sent to, and
the same is true of a Mailgun route or a Postmark inbound address.

What is given up is cosmetic and one operational nicety: the address is not on
your own domain, and a single CloudMailin address serves one practice, so a
multi-practice deployment eventually wants either the paid plan's catch-all or
one address per practice. Neither is worth paying for on day one.

If you *do* have custom domains, set the local part to the 16 characters
ProHippo minted, or turn on the catch-all — then every practice's address works
with no further setup.

### Setting the MX record at BigRock

`prohippo.info` is registered at BigRock and still on BigRock's own nameservers
(`dns1.bigrock.in` … `dns4.bigrock.in`), so the record is added in their panel —
there is no need to move nameservers anywhere.

**Orders → prohippo.info → DNS Records → MX.** Open that tab and **delete
anything already there first.** A registrar's default MX record, or one left by
a bundled mailbox product, wins if its priority number is lower, and mail then
goes to a mailbox nobody reads while the webhook never fires. For the same
reason, do not activate the bundled Titan Email trial on this domain — it sets
its own MX records.

Then add one record per host CloudMailin lists, leaving the host name blank (or
`@`) so it applies to the domain itself:

| Host name | Value | Priority |
| --- | --- | --- |
| *(blank)* | `client1.cloudmailin.net` | 10 |
| *(blank)* | `client2.cloudmailin.net` | 20 |
| *(blank)* | `client3.cloudmailin.net` | 30 |

Three records, not one: the second and third are the fallbacks a sending server
tries when the first does not answer, which is why they take ascending
priorities rather than the equal 10s the panel displays. Pick the shortest TTL
offered while setting up — a wrong record cached for a day is a slow afternoon.

BigRock says 4–6 hours; it is usually much faster. Check with
`dig MX prohippo.info +short` before assuming something is broken.

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
curl -X POST "PASTE_THE_FUNCTION_URL_FROM_THE_DEPLOY?key=YOUR_SECRET" \
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

**The Settings card says "No address yet", and the browser console shows a CORS
error on `getItatEmailAddress`** — this is almost never really about CORS. A
2nd-gen function runs on Cloud Run, and if that service does not allow public
invocation the request is refused by Google's infrastructure *before* it reaches
any of this code. That refusal carries no `Access-Control-Allow-Origin` header,
so the browser reports the only thing it can see: a CORS failure.

Firebase grants the permission as part of a normal deploy. A deploy that errored
partway through — over quota, or rate-limited on a large batch — can leave a
function created but unreachable. Grant it directly:

```
for s in getitatemailaddress resetitatemailaddress applyitatmail dismissitatmail itatinboundemail; do
  gcloud run services add-iam-policy-binding "$s" \
    --region=asia-south1 --member=allUsers --role=roles/run.invoker --project=prohippo2
done
```

Cloud Run lower-cases the service names; the function URL printed by the deploy
shows the form it uses. Do not skip `itatinboundemail` because it has no screen
of its own — the mail provider reaches it from the open internet and fails the
same way, silently, in its own delivery log rather than in a browser console.

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
