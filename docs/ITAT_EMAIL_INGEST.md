# ITAT email ingest — design

> **Phase 1 is built.** The address, the webhook, the parser, the matcher, the
> matter and hearing writers and the review queue are in
> `functions/itatEmail.js`, `functions/itatEmailParse.js`, `src/itatEmail.js`,
> `src/ItatInbox.jsx` and `src/ItatEmailCard.jsx`. To put it into service —
> domain, provider, secret, and the one forwarding rule — see
> `ITAT_EMAIL_SETUP.md`. This document is the reasoning behind it, and the plan
> for what comes next.

The Tribunal already tells us everything we want to know. It emails it.

Two templated emails come off the ITAT e-filing portal from
`no-reply@itat.nic.in`, and between them they carry the whole life of a second
appeal:

| Email | Subject | Carries |
| --- | --- | --- |
| **Registration** | `Registration & Scrutiny Summary - ITA 2635/AHD/2026 - Assessment Year: 2014-15` | the appeal number the filing was registered as, the e-filing acknowledgement, the date of filing, the bench, the appellant and respondent, PAN — plus a PDF *Registration Summary* saying the same |
| **Notice of hearing** | `Notice of Hearing in ITA 2530/AHD/2026 (Date of Hearing: 2026-Sep-15)` | appeal number, AY, PAN, hearing bench, case type, the date, the time, the venue address, and the previous date if it was adjourned |

Registration should create a **matter**. The notice of hearing should create a
**hearing** — and the hearing then reaches Google Calendar on its own, because
`onHearingWrittenSync` already watches that collection. Nothing new is needed on
the calendar side at all.

The whole problem is therefore: *how does the mail get from a mailbox we do not
control into `users/{uid}/…`, safely.*

---

## Whose mailbox — and the thing the samples actually show

ITAT mails the one address entered on the portal at registration. It does not
accept a second one: there is no field for the representative's address
alongside the appellant's, which was checked with a practitioner rather than
assumed. Whatever went on the record at filing is the only address the Tribunal
will ever write to.

An earlier draft of this document read the sample registration summary as
carrying the *client's* address and built the architecture around that. It is
worth stating plainly that this was wrong, because the correction changes what
gets built first. The **Appellant Email** on that summary —
`chavdagreen@gmail.com`, against an appellant named Ramniklal M. Makwana — is the
**consultant's own address**. The second sample, a hearing notice for a different
appellant entirely, arrived in that same consultant's inbox. Two different
clients, one mailbox: the practitioner had registered both appeals under their
own address, which is ordinary practice.

That reorders everything. The common case is not "the email is somewhere we
cannot reach" — it is **"the email is already in the practitioner's own inbox,
and nothing is reading it."** One forwarding rule, set once by the practitioner
on their own mailbox, covers every appeal registered that way: all clients, past
and future, with no client ever involved.

Client-side setup does not disappear, because appeals registered under a client's
address still exist. But it stops being the mechanism and becomes the exception
handler — which is a much easier thing to ship, and a much easier thing to sell
to someone who was never going to open Gmail's settings.

The architecture is unchanged by any of this: **a per-practice inbound address
that anything can forward to** serves both, and the practitioner's own rule is
simply its first and biggest source.

### Why not just read Gmail

Reading a mailbox needs `gmail.readonly` (or `gmail.modify`). Both are
**restricted** scopes: verification review *plus* an annual CASA security
assessment, with a real invoice attached. Compare `GOOGLE_CALENDAR_SETUP.md`,
where picking `calendar.app.created` — non-sensitive, no review, no user cap —
was the difference between shipping and waiting three weeks. Gmail has no narrow
equivalent for background polling.

And after paying that price it still only sees the consultant's mailbox. It
belongs on the roadmap as convenience for practices that file under their own
address, never as the mechanism.

---

## Recommended mechanism

```
ITAT (no-reply@itat.nic.in)
        │
        ├─► consultant's mailbox ─┐
        └─► client's mailbox ─────┤ forwarding rule (or a manual forward)
                                  ▼
              <token>@prohippo.info      ← one per practice, one per assessee
                                  │
                 inbound provider (MX → webhook)
                                  ▼
              itatInboundEmail   (onRequest, asia-south1)
                                  │
        authenticate → parse → match assessee → write
                                  ▼
     users/{uid}/matters      users/{uid}/hearings      users/{uid}/itatMail
                                          │
                                          └─► existing Google Calendar sync
```

Addresses are unguessable random tokens, and come in two kinds. Each practice
has **one of its own**, for the consultant's mailbox and for ad-hoc forwards.
Each assessee can additionally be issued **their own**, which is what gets handed
to a client — see *Handing the setup to the client* below for why that separation
earns its keep.

Four ways mail reaches them, and a practice will use several at once:

1. **One forwarding rule in the practitioner's own mailbox**, scoped to
   `from:no-reply@itat.nic.in`. Set once, in five minutes, by the one person in
   this story who is comfortable in Gmail's settings — and it covers every appeal
   registered under the firm's address, for every client, past and future. This
   is the mechanism. Everything else handles what it misses.
2. **Making that the filing habit.** Where the client is content for the firm to
   be the contact, registering future appeals under the firm's address puts them
   inside route 1 automatically. Nothing to build; worth saying out loud because
   it quietly shrinks routes 3 and 4 to nothing.
3. **A forwarding rule in the client's mailbox**, set by the client from a link
   the consultant sends them. This is the one that decides whether the feature
   covers a whole practice or half of it, and it has a section to itself below.
4. **A manual forward**, from anyone, any time. The always-there fallback and
   the thing that makes the feature usable on day one. Treated as lower trust —
   see below.

Because the alias identifies the practice and the PAN inside the mail identifies
the client, it does not matter which of the four routes a given message took.

### Getting the MX in place

Put it on a **domain of its own** — `prohippo.info` — rather than a subdomain of
`prohippo.in`. Every address under it is a firehose pointed at a public webhook,
and `prohippo.in` carries the login emails Resend sends: a fat-fingered MX record
on that zone locks every practitioner out of the app. A separate registration
makes that impossible rather than merely unlikely.

| Option | Notes |
| --- | --- |
| **Postmark inbound** | Point the domain's MX at Postmark, give it the function URL. Posts JSON, and its `OriginalRecipient` carries the envelope address the alias is found in. Least to go wrong. |
| **Mailgun Routes** | Equivalent, with a signed webhook (timestamp + token + HMAC) — slightly better authentication story out of the box. |
| **SendGrid Inbound Parse** | Equivalent; posts multipart form data, which the webhook also reads. |
| **Cloudflare Email Routing + Email Worker** | No per-message cost, but the Worker must parse MIME itself and needs a build step. Only worth it at volume. |

What none of them can be is a transactional *sender* — Resend, ZeptoMail, SES's sending side. Those report on mail you sent; they never receive any. Nor a mailbox host: Zoho Mail and Google Workspace will receive at this domain perfectly well, but they deliver into a mailbox, and getting it out again means polling IMAP.

Whichever is chosen, the Cloud Function is a public `onRequest` and must not
trust the caller: verify the provider's signature or a long secret path segment,
and reject anything that fails.

---

## Handing the setup to the client

The consultant cannot configure someone else's mailbox. What ProHippo can do is
make the client's part of it short enough that it actually gets done — and the
honest measure of that is not how elegant the flow is, but how many clients
finish it without a phone call.

### The shape of it

**Issue the client their own address.** From the assessee's profile:
*Set up ITAT email forwarding* mints `<token>@prohippo.info` bound to that one
assessee, and produces a **setup link** — an unguessable, no-login page the
consultant sends over WhatsApp or email using the delivery that already exists
(`sendClientMessage`, which will already translate the covering message into the
client's own language).

Per-assessee rather than one practice-wide address, for four reasons that all
show up in practice:

- Mail is attributable to a client *before* it is parsed, so a message whose PAN
  is mangled still lands in the right file.
- The provider's verification code (below) can be matched to the client whose
  setup is in flight, instead of guessing between three simultaneous ones.
- Ending a client relationship revokes one address; every other client's
  forwarding keeps working.
- A client who over-scopes their rule floods one alias, which is contained,
  traceable and revocable on its own.

**The setup page does the hard part.** The client opens it on their phone; it
shows the address with a copy button and step-by-step instructions for their
provider. Then it *waits with them*: the page stays open, live, and the moment
the provider's verification email arrives at the alias — which it does, because
the alias is the destination being verified — the page **displays the
confirmation code on screen**. The client types it back into Gmail without ever
leaving their own account, asking their consultant, or reading a code out over
the phone. That single trick is the difference between a two-minute job and a
support call, and it works for every provider that verifies by emailing the
destination, which is all of the common ones.

The page then waits for the real thing: when the first ITAT message actually
arrives it turns green, and the consultant sees the assessee's forwarding status
go **Connected** in ProHippo. Nobody is left wondering whether it worked.

### The instructions have to be exactly right

Two details decide whether this is safe and whether it works at all:

**Use a filter, not blanket forwarding.** Gmail's *Forwarding and POP/IMAP* tab
offers "Forward a copy of incoming mail to…", and a client who ticks that sends
ProHippo their entire personal inbox. The correct sequence is: add the address
and verify it, **leave forwarding itself disabled**, then create a filter —
`From: no-reply@itat.nic.in` → *Forward it to* the verified address. A verified
address can be used by a filter while blanket forwarding stays off; that is the
configuration the instructions must produce, and the page should say why in one
line, because a client who understands the reason will not "simplify" it.

**Gmail forwarding cannot be set up from the mobile app.** Neither Android nor
iOS Gmail exposes it — it is desktop web only. This is the single biggest reason
a client will fail, so the page must open by saying so, and offer to send the
link to a desktop rather than letting someone discover it three screens in.
Outlook.com, Yahoo and Zoho all allow it in their mobile web settings, so the
instructions branch on the address's domain and show only the relevant provider.

### Consent, and the client's ability to stop

The client is pointing part of their personal mailbox at their consultant's
software. That deserves to be handled properly, not buried:

- The setup page states plainly, before anything is copied, that **only mail
  from the Tribunal is kept, and everything else is discarded without being
  read or stored**. The sender allowlist at the webhook is what makes that true
  rather than a promise — an off-target message is dropped before any write, and
  all that survives is a counter.
- The same page carries a **Stop forwarding** control that revokes the alias
  from the client's side, without going through the consultant. A control the
  data subject can reach themselves is the right posture generally, and under
  the DPDP Act it is worth having on the record.
- Consent is recorded on the assessee: address, timestamp, and the text the
  client was shown.

### Guarding against a stranger pointing mail at us

The setup link is unguessable, but a link can be forwarded. So the alias pins
itself: the mailbox that sends the first accepted ITAT message is remembered,
and later mail arriving from a *different* forwarder goes to the review queue
instead of applying automatically. Combined with the ITAT-only sender allowlist,
the exposure of a leaked setup link is that someone can put ITAT mail in front
of the consultant for confirmation — not that they can move a hearing date.

### When forwarding quietly stops

A forwarding rule that has been deleted, or a mailbox that has hit its quota,
looks exactly like a client with no ITAT activity. Silence is the failure mode,
and silence is invisible.

Three things catch it, cheapest first: the alias records `lastReceivedAt`; a
matter that is Active while its assessee's alias has been silent for months is
worth a nudge; and — decisively — the **cause list** cross-check. If the
Tribunal lists a hearing for an appeal number on file and no email ever arrived
for it, the forwarding is broken, and ProHippo knows that without the client
noticing anything.

### If the client will not do it

The ladder, in order of how much the client has to do:

| | Client does | Result |
| --- | --- | --- |
| 1 | Nothing — the consultant enters the alias as the representative's address on the ITAT portal at filing | Fully automatic, no forwarding anywhere |
| 2 | One-time setup from the link | Fully automatic thereafter |
| 3 | Forwards each ITAT email by hand | Works; lands in the review queue for one click |
| 4 | Nothing at all | Cause-list scraping still recovers hearing dates for appeals on file |

Row 1 is the quiet winner for appeals filed from here on, and it needs no client
cooperation whatsoever. Row 4 is why the cause-list companion in the phasing
table below is worth more than it first looks: it is the floor under every case
where the email route fails.

---

## Trust: what we accept

An address that receives mail from the internet is an injection surface. A
forged "Notice of Hearing" that moves a real hearing date is a serious harm, so
acceptance is layered, and nothing lands in the practice's data silently.

**Dropped without being stored:**

- anything whose original sender is not on the allowlist (`no-reply@itat.nic.in`
  to start; the allowlist is the extension point for
  `donotreply@incometax.gov.in` later);
- anything with no recognisable appeal number in it.

This matters more than it looks. If a client sets an over-broad forwarding rule,
their *entire* inbox arrives at our door. The allowlist is what stops a
misconfigured rule turning into a data-retention problem.

**Auto-applied** — written straight to matters/hearings:

- the message arrived with its original headers intact (a rule-based forward
  preserves them, so `From:` is still ITAT), **and**
- authentication passed: `Authentication-Results` shows DKIM verifying for the
  ITAT sending domain. *Check the samples for a `DKIM-Signature` first — if
  `itat.nic.in` does not sign its mail, this gate cannot exist, and the fallback
  is alias secrecy plus the allowlist plus the review queue.* SPF is expected to
  fail on forwarded mail and must not be required.

**Queued for one click of confirmation** — everything else, which includes every
manual forward, because an inline forward rewrites `From:` and breaks the
signature. The parsed fields are shown filled in; the user presses Confirm and
the same writer runs. This is also where a message that parsed cleanly but
matched no assessee waits.

Two more guards, both cheap:

- **Idempotency.** `sha1(Message-ID)` is written to
  `users/{uid}/itatMail/{id}`; a repeat delivery — provider retry, a forwarding
  loop, the consultant *and* the client both forwarding — is recognised and
  discarded.
- **Rotation.** The alias can be reset from Settings, exactly as the ICS
  subscription link already can, for when it has been forwarded to the wrong
  person.

---

## Parsing

These are machine-generated templates, so this is deterministic string work
first and AI only where the template runs out. That is the same line
`functions/index.js` already draws: the portal's own structured data wins, and
Gemini is asked only about things a PDF is the sole source of.

Fields, and where each comes from in the two samples:

| Field | Registration email | Notice of hearing |
| --- | --- | --- |
| Appeal number | subject + body + PDF — `ITA 2635/AHD/2026` | subject + body — `ITA 2530/AHD/2026` |
| Assessment year | subject, `2014-15` | body, `2016-17` |
| PAN | body — "filed by you in **AAWPM8125C**" | body — `PAN: BLGPG1814C` |
| Filed on | body / PDF — `23-Jul-2026` | — |
| E-filing ack no. | PDF — `1800112095` | — |
| Bench | PDF — `Bench: A` | body — `Hearing Bench: D` |
| Case type | — | body — `DBC` |
| Appellant, address | PDF | body |
| Respondent | PDF — `ITO, WARD 2(1)(2), AHMEDABAD` | body — `Ward 1, International Taxation, Ahmedabad` |
| Hearing date | — | subject `2026-Sep-15`, body `15-Sep-2026 (Tue)` |
| Hearing time | — | body — `10.30 a.m` |
| Venue | — | body — `3rd & 4th Floor, Abhinav Arcade, … Ahmedabad - 380006` |
| Previously fixed on | — | body — `Last fixed for hearing on:` (empty when first fixed) |

The building blocks:

```js
APPEAL_NO = /\b(ITA|C\.?O\.?|SA|MA|WTA)\s*(?:No\.?\s*)?(\d{1,6})\s*\/\s*([A-Z]{2,5})\s*\/\s*(\d{4})\b/i
PAN       = /\b[A-Z]{5}\d{4}[A-Z]\b/
AY        = /Assessment\s*Year[:\s]*((?:19|20)\d{2}\s*-\s*\d{2,4})/i
DMY       = /\b(\d{1,2})-([A-Za-z]{3})-(\d{4})\b/          // 15-Sep-2026
TIME      = /\bat\s*(\d{1,2})[.:](\d{2})\s*(a\.?m|p\.?m)/i  // 10.30 a.m → "10:30"
```

The appeal number is canonicalised for keying — uppercased, `No.` and spaces
removed — so `ITA No. 1244/Ahd/2024` and `ITA 1244/AHD/2024` are one thing. The
bench code (`AHD`, `MUM`, `DEL`, …) maps to a city for the display bench name,
`Ahmedabad 'D' Bench`, which is the shape `Hearings.jsx` already renders.

The registration **PDF** goes to Storage and, where the body did not carry a
field, through the existing `summarizePortalNotice`-style Gemini read with a
strict JSON schema — the pattern `intimationReading.js` already uses. AI never
overrides a value the email itself stated.

Parsing runs against a fixture set of real messages. When a template changes —
and NIC templates do change — the parse fails closed: the message is kept, the
user sees it in the review queue with whatever was extracted, and nothing wrong
is written.

---

## Matching the assessee

In order, stopping at the first hit:

0. **The alias it arrived at**, when that alias belongs to one assessee. Settled
   before a single field is parsed, and still right when the PAN is mangled.
1. **PAN** against `users/{uid}/assessees` — both emails carry it, and it is
   exact. This is the normal path for the practice-wide alias, and the
   confirmation for a per-assessee one. A PAN that contradicts the alias is not
   overridden by either: it goes to review.
2. **Appeal number** against an existing matter's `ref`, canonicalised. Catches
   the case where the matter was entered by hand before any email arrived.
3. **Appellant name**, normalised (case, punctuation, `&`/`AND`, honorifics),
   plus AY. Suggestion only — never auto-applied.

No match means the review queue, showing the parsed appellant and PAN. If the
email carried **both a name and a PAN**, Confirm reads *Confirm & add client*
and opens the file from the email itself: name, address, and entity type from
the PAN's fourth character (the same rule as `entityFromPan` in
`src/AssesseeModal.jsx`). Nothing is created without that press — the ban is on
creating an assessee *silently*, not on creating one at all, and the distinction
is the PAN. A name match is a resemblance and would quietly fork a client's file
in two; a PAN either is on file or it is not.

The PAN lookup runs again at Confirm rather than trusting what the webhook
recorded, so a client added by hand in the minutes between the email arriving
and somebody pressing the button is found rather than duplicated.

**Where the name comes from.** The notice of hearing lays the parties out in a
two-column table — appellant left, respondent right, with the words *Appellant*
and *Respondent* as the last row under them. Flattened to text they interleave
beyond recovery, which is why an earlier version of this file said the name
could not be read; parsed as a table it is simply "find the label row, read the
same column above it". The respondent column is the Department, and filing an
appeal under the Assessing Officer's name is the failure that shape guards
against.

**Matching an existing assessee enriches it, but only into blanks.** An address
on the notice fills an empty `address` field and never overwrites one somebody
typed. What a practitioner entered is theirs; the Tribunal's copy is only better
than nothing.

---

## What gets written

**Registration → `users/{uid}/matters/itat_<sha1(canonicalItaNo)>`**

```
{ type: "ITAT", assessee, pan, ay, ref: "ITA 2635/AHD/2026",
  bench: "Ahmedabad 'A' Bench", status: "Active", priority: "medium",
  filedOn: "2026-07-23", ackNo: "1800112095", respondent,
  source: "itat-email", sourceMessageId, registrationPdfPath }
```

The derived document ID is the same trick `ingestPortalProceedings` uses for
`pcdng_…`: a redelivery merges into the document it already wrote instead of
adding a second matter. Duplicates are prevented by construction, not by
cleanup.

One deliberate side effect worth stating plainly: `isAppealed()` in
`src/appeals.js` treats an ITAT matter for the same PAN + AY as proof the appeal
was filed, so creating this matter **removes the underlying CIT(A) order from
the Appeals to-do list**. That is correct — the appeal has demonstrably been
filed, the Tribunal just said so — but it means a mismatched AY would drop a live
deadline off the board. AY must match exactly, and the review queue is where an
uncertain match is settled.

**Notice of hearing → `users/{uid}/hearings/itath_<sha1(itaNo + "|" + date)>`**

```
{ assessee, pan, ay, authority: "ITAT", bench: "Ahmedabad 'D' Bench",
  date: "2026-09-15", time: "10:30", mode: "Physical",
  ita: "ITA 2530/AHD/2026", caseType: "DBC", venue, status: "Upcoming",
  source: "itat-email", sourceMessageId }
```

Keying on appeal number **plus date** is what makes adjournments behave. A
re-fixed hearing is a new date for the same appeal: it writes a new document,
and the earlier one for that appeal is marked `Adjourned` rather than deleted, so
the history of a matter that has been adjourned four times is still readable.
The `Last fixed for hearing on:` line corroborates which earlier date was
displaced.

If a hearing notice arrives for an appeal with no matter on file — likely,
because the registration email may predate the integration — the matter is
created from the hearing notice too. Both emails carry enough.

Then `onHearingWrittenSync` fires and the hearing appears in the practitioner's
Google Calendar. No new calendar code.

**Every message → `users/{uid}/itatMail/{sha1(messageId)}`**: subject, sender,
received time, the parse result, what was written, and the status
(`applied` / `needs-review` / `dropped`). This is the audit trail, the dedupe
key and the review queue's backing collection, all one document.

Storage rules need nothing new — everything is under `users/{uid}`, already
covered. The alias→uid lookup lives in a top-level `inboundAliases/{token}`
collection, which the existing catch-all `allow read, write: if false` already
denies to clients, same as `googleTokens` and `portalCreds`.

---

## What the practitioner sees

**Settings → Integrations → ITAT email.** The practice's own alias with a copy
button, a live "last received" line, **Reset address**, and the forwarding
instructions for the consultant's own mailbox.

**On each assessee's profile**, a forwarding status — *Not set up* / *Waiting for
the client* / *Connected, last received 3 days ago* — with **Send setup link**
beside it. That is where the consultant spends ten seconds per client and then
stops thinking about it. A practice-level view of the same column answers "which
of my clients are not covered", which is the question that actually gets asked.

**A review queue**, as a tab on Hearings or a badge in the existing shell, holding
everything awaiting one click. Empty most days; that is the point.

---

## Suggested phasing

| Phase | Ships | Depends on |
| --- | --- | --- |
| **1** | Alias, inbound webhook, parser, matcher, matter/hearing writers, review queue — plus the practitioner's own forwarding rule and the three-screen guide for setting it. | A domain with an MX record, and an inbound provider account. Nothing else. |
| **2** | Client-facing setup: per-assessee links, the live code-catching page, forwarding status on the assessee, auto-apply for authenticated messages. | Phase 1 in the field, and knowing how many appeals actually sit outside route 1. |
| **3** | Extend the allowlist and parsers to CIT(A)/NFAC and departmental mail — much higher volume, same pipeline. | Sample emails. |
| **4** | Optional client-side "Connect Gmail", if enough appeals are registered under client addresses to justify Google's review and the annual assessment. Optional IMAP polling in the desktop connector for non-Google mailboxes, where credentials are already vaulted. | A commercial decision, not a technical one. |

Phase 1 is now most of the value on its own, which was not true of the earlier
draft. One rule, set by the practitioner on their own mailbox, and every appeal
registered under the firm's address starts filing itself — no client asked to do
anything. Phase 2 exists for the appeals registered under a client's address, and
its size should be measured before it is built: a practice that files everything
under its own address may never need it.

A worthwhile companion, independent of email: the Tribunal publishes daily
**cause lists**. Scraping them for appeal numbers already on file corroborates
every hearing date and catches adjournments that never generate a message at
all. Two independent sources agreeing is a much stronger promise than one.

---

## Open questions

- **Does `itat.nic.in` sign with DKIM?** Check `Authentication-Results` on a raw
  copy of either sample. It decides whether auto-apply can be authenticated or
  whether everything routes through the review queue at first.
- **Which inbound provider?** It must do *inbound parse* — a transactional sender (Resend, ZeptoMail, SES's sending side) reports on mail you sent and cannot receive any, and a mailbox host delivers into a mailbox rather than to a webhook.
- **Of the appeals a practice is running, how many were registered under a
  client's address rather than the firm's?** This is the size of Phase 2 and the
  only thing that decides whether it is worth building at all. Answered by
  counting, not by guessing — and once Phase 1 is live the answer arrives on its
  own, as the appeals that never produce an email.

**Answered:** the ITAT portal does **not** accept a representative's email
alongside the appellant's. There is one address per appeal, fixed at
registration, which is why route 1 is a forwarding rule rather than a change on
the portal.
