# WhatsApp delivery (WATI) — design & setup

How a hearing, a notice or an invoice reaches somebody on WhatsApp, and how
ProHippo knows whether it arrived.

**Status: phase 0 is implemented — the pipe, and nothing that uses it.** The six
messages are phases 1–4 and are the plan, not code.

---

## The idea

WhatsApp is not email with a different transport. Two constraints shape
everything here, and neither has an equivalent in `sendClientMessage`:

**You cannot write what you like.** A business may send free text only inside a
24-hour window opened by the recipient writing first. Everything ProHippo sends
is business-initiated to somebody who has not written, so every message must be
a **template Meta approved in advance** — fixed prose with numbered slots. That
is why `TEMPLATES` in `functions/whatsapp.js` is a registry rather than a
formatting concern: it is the record of what may legally be sent, and a name
that is not in it fails locally rather than at Meta.

**One number carries every practice.** ProHippo is the sender; the practitioner's
firm is named in the body. So a client who reports a message as spam does not
damage that practice's deliverability — they damage everyone's. Consent, the
opt-out list and the burst guards are not compliance theatre; they are what
stops one careless practice taking the platform down for the rest.

---

## Who a message goes to

| Message | Recipient | Falls back to |
|---|---|---|
| Document request | Group head | The assessee's own mobile |
| New notice — practitioner | The practitioner | — |
| New notice — client | Group head | Not sent |
| Hearing reminder | The practitioner | — |
| Weekly cause list | The practitioner | — |
| Invoice | Group head | The practitioner, with a different template |

### Why the group head, and not the assessee

A group is a family or a business house — "Shah Group" — and several of its
members are companies and trusts. You do not WhatsApp Shah Textiles Pvt. Ltd.;
you WhatsApp Rajesh Shah, who answers for all of them.

So the group grew a `head`:

```js
// users/{uid}/groups/{id}
head: { name, mobile, assesseeId },
headWhatsappOptIn: { optedIn, at, by, source, revokedAt },
```

`assesseeId` links the head back to a member where they are one, which is the
usual case — the group modal offers each member as a one-click fill so the
number is copied off a profile rather than retyped. Two spellings of the same
mobile is how a client who said STOP still gets messaged.

The free-text `contact` field is untouched. It was always "name / phone / email
for group billing" and it is still exactly that — prose for a human, not an
address the machine sends to.

### The practitioner's own number

`profile.phone`, and only if `profile.phoneVerified`. That is the number they
proved they own by OTP when they linked it for sign-in — never one typed into a
form. Same rule the voice agent dials by, for the same reason: a number taken
from a request turns the account into a free outbound dialler billed to us.

---

## Consent

Meta requires the recipient's opt-in. The group head has never seen ProHippo
and cannot tick a box in it, so the practitioner — who has the relationship and
is the one being asked — attests on their behalf. What is recorded is not a
boolean:

```js
{ optedIn: true, at: "2026-08-12T…", by: "ca@mehta.co", source: "practitioner" }
```

An attestation with no author is not one. `by` is the account that ticked it and
`at` is when, so the question "who said this client agreed" has an answer.

**A STOP reply outranks the tick.** `headConsent()` treats a set `revokedAt` as
consent withdrawn whatever `optedIn` says, and the group modal shows the date
and refuses to pretend that turning the switch back on will help. It will not —
the send is refused at `waOptOut` before it reaches WATI.

### The opt-out list is global, deliberately

`waOptOut/{phone}` is keyed on the number alone, not on `(practice, number)`.
Everyone is messaged from one WhatsApp number and a client cannot tell the
practices apart, so honouring an opt-out per-practice would be honouring it in a
way the person who asked cannot observe.

`isOptedOut()` **fails closed**. If the lookup itself errors, the send is
refused. The cost of a missed reminder is one message; the cost of messaging
somebody who opted out is the number's quality rating, and at the far end the
account.

---

## The two permissions, and why they are separate

The Settings card and the group consent answer different questions, and
conflating them is the mistake `src/whatsappSettings.js` exists to prevent.

| | Question | Where |
|---|---|---|
| `profile.whatsapp.<key>` | Is this practice *willing to send* this message? | Settings |
| `group.headWhatsappOptIn` | Has *this person agreed to receive* it? | The group |

A client message needs both. `clientReachability(group)` is the single function
that asks, and it returns the **reason** rather than a bare false — because
every caller has to say something useful. The composer disables a button with a
tooltip, the invoice falls back to the practitioner, the log records why nothing
left. A boolean would make all three say "couldn't send".

`noticeAlertClient` is the one client message that defaults **off**. A
practitioner who has not yet read an order does not necessarily want their client
hearing about it first; that is a judgement about the relationship, so it is
asked rather than assumed.

---

## Sending

`deliver()` in `functions/whatsapp.js` is the one entry point. It refuses what
must not go, reserves quota, calls WATI, writes the delivery log and indexes the
provider's id.

**It never throws.** Every caller is a background job or a batch of clients, and
one unreachable group head must not abort the other nine. The result says what
happened, and a `communications` row is written either way — a delivery log that
holds only successes is worse than no log, because it is the thing you show a
client who says they never received it.

### Delivery status

`watiWebhook` walks the row forward through the same `STATUS_RANK` ladder
`resendWebhook` uses, so a late-arriving event can never downgrade what is
already known:

```
Queued → Sent → Delivered → Read
                    ↘ Failed / Undelivered
```

"Read" rather than email's "Opened" — it is WhatsApp's own word, and the two
blue ticks that mean it.

WATI does not sign its webhooks the way Resend does, so there is no signature to
verify. The protection is a shared secret only WATI and the function know, given
to WATI in the URL (`?token=…`) or as an `x-wati-token` header, compared in
constant time.

Event names differ between tenants on casing and on whether the field is `type`
or `eventType`, so they are normalised to letters-only before lookup. **An
unrecognised event is logged with its raw name** rather than dropped — a name the
map is missing then shows up as something to add, instead of as a delivery log
that quietly stopped moving.

### Rate limit

100 per rolling hour per user (`whatsappQuota/{uid}`, transactional so parallel
sends cannot both slip past). Far above normal use — it exists so a runaway
trigger cannot cost every *other* practice on the number its quality rating.

Unlike `reserveMailQuota`, this one **returns rather than throws**. That one is
only ever reached from a callable, where an `HttpsError` is the response; these
sends also come from schedulers and Firestore triggers, where a thrown
`HttpsError` is a confusing log line and nothing more.

### Cost

Metered through `spend.js` as vendor `wati`, SKU `whatsapp-utility`, and
**deliberately unpriced** — the India utility rate is unconfirmed until the first
WATI invoice, and `pricing.js` has one rule about that: a made-up rate is worse
than a visible gap. Sends show on the Costs page under "N calls had no rate".

To price it, read the per-message utility rate off the invoice, set
`WHATSAPP_INR_PER_UTILITY`, add a `wati` branch to `priceCall()`, and bump
`RATE_VERSION`.

---

## Languages

**A template is identified by (name, language).** Gujarati is a separate Meta
submission from English, separately reviewed and separately rejectable.

This is the one thing that does not carry over from the email path.
`translateClientMessage` translates the letter at draft time; that cannot work
here, because Meta must have already approved the exact Gujarati sentences
before one is sent.

What survives is the split `PHRASES` already makes:

| | Email | WhatsApp |
|---|---|---|
| Fixed sentences (`PHRASES`) | Gemini, at draft time | **Gemini once**, human-checked, submitted to Meta |
| Document names, the note | Gemini, at draft time | Unchanged — runtime, in a variable |
| Slots — name, DIN, dates, AY | Never sent to the model | Unchanged |

`TEMPLATES` records which languages each template is approved in.
`resolveLanguage()` falls back to English for anything else and returns
`substituted: true`, which is written onto the communications row as
`waLanguageSubstituted`. Silently sending English while the app shows Gujarati
is the bug that costs a client's trust rather than a message.

Start with **en, hi, gu** — nine submissions across the three client-facing
templates. Twelve languages would be 36 variants, and every copy change becomes
36 resubmissions.

---

## Setup (one-time)

### Step 1 — Meta onboarding, through WATI

WATI onboards through Meta Embedded Signup: a Facebook Business Manager with
business verification complete, and a phone number not currently registered on
any WhatsApp app.

When approval lands, check two things before going further — the **display name
reads exactly `ProHippo`**, and the number shows Connected with a Green quality
rating. Changing the display name afterwards is a fresh Meta review.

A new number starts limited, typically 250 business-initiated conversations per
24 hours, scaling automatically with quality and volume.

### Step 2 — Credentials

WATI dashboard → the API docs / developer section. Two values: a tenant-specific
endpoint and a long-lived bearer token.

```bash
export WATI_ENDPOINT="https://live-mt-server.wati.io/YOUR_TENANT_ID"
export WATI_TOKEN="Bearer YOUR_ACCESS_TOKEN"
export MY_NUMBER="919824000000"   # your own mobile, country code, no +
```

Prove the token works before it goes anywhere near a Cloud Function. An empty
list is the correct answer at this point; a `401` means the endpoint or token is
wrong.

```bash
curl -s "$WATI_ENDPOINT/api/v1/getMessageTemplates" -H "Authorization: $WATI_TOKEN" | head -c 800
```

WATI will not message a number that is not a contact, so add your own:

```bash
curl -X POST "$WATI_ENDPOINT/api/v1/addContact/$MY_NUMBER" \
  -H "Authorization: $WATI_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Test - my own number"}'
```

> **Two things to confirm against your own dashboard's API docs**, which are
> authoritative for your tenant in a way generic documentation is not:
> whether you are on `/api/v1/` or `/api/v2/` (`API_VERSION` in
> `functions/whatsapp.js`), and how a document URL reaches a media header
> (`MEDIA_MODE` in the same file). Both are one constant. Three of the six
> messages attach a PDF and will not work until the second is right.

### Step 3 — Secrets

The webhook secret goes in as a placeholder: a deploy stops on a referenced
secret that does not exist, and the real one cannot be set until the function is
deployed. Same chicken-and-egg as `RESEND_WEBHOOK_SECRET`, solved the same way.

```bash
printf '%s' "$WATI_ENDPOINT" | firebase functions:secrets:set WATI_API_ENDPOINT   --data-file=- --project prohippo2
printf '%s' "$WATI_TOKEN"    | firebase functions:secrets:set WATI_API_TOKEN      --data-file=- --project prohippo2
printf 'placeholder'         | firebase functions:secrets:set WATI_WEBHOOK_SECRET --data-file=- --project prohippo2
```

The webhook secret is **ours, not WATI's** — invent a long random string, put it
in the webhook URL you give WATI, and store the same value here.

### Step 4 — Templates

WATI → Broadcast → Templates → Add Template. Category **Utility** for every one
of them — never Marketing, which is dearer and blockable by the recipient.

Each needs a **sample value for every variable** or Meta rejects the submission
unread. Three need a **Document** header; upload any small PDF as the sample.

Submit the four English-only practitioner templates first. They are what phase 1
needs, and getting one approved teaches you what the reviewer wants before nine
client-facing variants go in.

Meta's validator rejects, in roughly this order of frequency: a body that ends on
a variable, two variables with nothing between them, a variable containing a
newline, and a missing sample.

**As each approval lands, add its language code to `TEMPLATES` in
`functions/whatsapp.js`.** Everything starts at `["en"]` because nothing has been
submitted yet — listing a language before Meta approves it turns a clear
rejection at submission time into a silent send failure later.

### Step 5 — Deploy and wire the webhook back

```bash
cd functions && npm install && cd ..
firebase deploy --only functions:watiWebhook --project prohippo2
```

Take the printed URL, add it in WATI's webhook settings with `?token=<your
secret>` appended, and subscribe to the delivered / read / replied / failed
events. Then store the real secret and redeploy — a secret is read at cold
start, so nothing takes effect until the function restarts.

```bash
printf '%s' 'YOUR_WEBHOOK_SECRET' | firebase functions:secrets:set WATI_WEBHOOK_SECRET --data-file=- --project prohippo2
firebase deploy --only functions:watiWebhook --project prohippo2
```

### Step 6 — Signed URLs, for the cause list

The weekly cause list renders a PDF server-side and hands WATI a signed Storage
URL. Signing needs one grant, and without it the Saturday job fails at the last
step with a permissions error that does not mention signing.

```bash
gcloud iam service-accounts list --project prohippo2   # confirm the name first
gcloud projects add-iam-policy-binding prohippo2 \
  --member="serviceAccount:prohippo2@appspot.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator"
```

Not needed until phase 2.

### Step 7 — Watch the quality rating

One number carries every practice. Check WATI's quality rating and messaging tier
daily for the first fortnight. A drop always traces to a specific template, and
the client-facing three are the ones to suspect — which is why they ship last and
`noticeAlertClient` defaults to off.

---

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| Every send logs `Failed`, reason `send-failed` | Endpoint or token wrong, or the tenant is on `/api/v2/` | Run the `getMessageTemplates` curl above; change `API_VERSION` |
| `WhatsApp rejected the message: …` | Template not approved, or the recipient is not a WATI contact | Check the template's state in WATI; `addContact` first |
| Sends succeed, status stays `Queued` | Webhook not reaching the function, or still on the placeholder secret | WATI's webhook delivery log. `401` = secret mismatch, redo step 5 |
| PDF messages fail, text ones work | `MEDIA_MODE` is the wrong shape for this tenant | Flip it; confirm with one live send |
| A client is never reached | No consent recorded, or they replied STOP | Assessees → Groups shows both, with the STOP date |
| Costs page shows "no rate" | Expected — WhatsApp is metered but unpriced | Set `WHATSAPP_INR_PER_UTILITY` after the first invoice |
