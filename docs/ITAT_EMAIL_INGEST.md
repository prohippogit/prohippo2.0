# ITAT email ingest — design

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

## The awkward part: whose mailbox

ITAT mails the address entered on the portal at registration. For a practice
that is sometimes the consultant's own address and sometimes the client's — the
sample registration summary in hand shows an **Appellant Email** belonging to the
assessee, not the firm. So any design that assumes "the user's inbox" covers
maybe half the appeals in a practice and silently misses the rest, which is the
worst possible failure mode for a hearing date.

That single fact rules the architecture. **A per-practice inbound address that
anything can forward to** works for both cases. Reading the user's own mailbox
works for one of them, and costs far more to ship.

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
              itat-<token>@in.prohippo.in        ← unique per practice
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

Every practice gets one unguessable address. Four ways mail reaches it, and a
practice will use several at once:

1. **Register the alias with the Tribunal.** Where the portal accepts a
   representative's address alongside the appellant's, put the alias there at
   filing time. The Tribunal then mails ProHippo directly and there is no
   forwarding at all. Best outcome; only available for appeals filed from now on.
2. **A forwarding rule in the consultant's mailbox**, scoped to
   `from:no-reply@itat.nic.in`. Two minutes, one time, covers every appeal filed
   under the firm's address, past and future.
3. **A forwarding rule in the client's mailbox.** Same rule, set by the client.
   ProHippo generates the instructions and can send them over the existing
   WhatsApp/email channel (`sendClientMessage`); the Gmail confirmation code
   Google sends to verify a new forwarding address lands *in our inbox*, so the
   handshake can be completed automatically instead of asking the client to
   read a code back.
4. **A manual forward**, from anyone, any time. The always-there fallback and
   the thing that makes the feature usable on day one. Treated as lower trust —
   see below.

Because the alias identifies the practice and the PAN inside the mail identifies
the client, it does not matter which of the four routes a given message took.

### Getting the MX in place

Put it on a **subdomain** — `in.prohippo.in` — so the MX for `prohippo.in`
itself, and everything already sending as that domain, is untouched.

| Option | Notes |
| --- | --- |
| **SendGrid Inbound Parse** | Point the subdomain's MX at SendGrid, give it the function URL. Posts multipart form data with attachments and the raw MIME. Free tier is ample. Simplest thing that works. |
| **Mailgun Routes** | Equivalent, with a signed webhook (timestamp + token + HMAC) — slightly better authentication story out of the box. |
| **Cloudflare Email Routing + Email Worker** | Free and no per-message cost; the Worker `fetch`es the raw message to our function. Confirm current subdomain support before committing to it. |

Whichever is chosen, the Cloud Function is a public `onRequest` and must not
trust the caller: verify the provider's signature or a long secret path segment,
and reject anything that fails.

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

1. **PAN** against `users/{uid}/assessees` — both emails carry it, and it is
   exact. This is the normal path.
2. **Appeal number** against an existing matter's `ref`, canonicalised. Catches
   the case where the matter was entered by hand before any email arrived.
3. **Appellant name**, normalised (case, punctuation, `&`/`AND`, honorifics),
   plus AY. Suggestion only — never auto-applied.

No match means the review queue, showing the parsed appellant and PAN with an
**Add this assessee** button. An assessee is never created silently; a
misparsed name would otherwise quietly fork a client's file in two.

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

**Settings → Integrations → ITAT email.** The alias with a copy button, a live
"last received" line, **Reset address**, and step-by-step forwarding instructions
for Gmail and Outlook. Beside it, a **Send setup instructions to client** action
that reuses the existing WhatsApp/email delivery so the consultant does not have
to explain forwarding rules over the phone.

**A review queue**, as a tab on Hearings or a badge in the existing shell, holding
everything awaiting one click. Empty most days; that is the point.

---

## Suggested phasing

| Phase | Ships | Depends on |
| --- | --- | --- |
| **1** | Alias, inbound webhook, parser, matcher, matter/hearing writers, review queue. Manual forwarding only. | An MX subdomain and an inbound provider account. Nothing else. |
| **2** | Guided forwarding-rule setup, automatic completion of the Gmail verification handshake, auto-apply for authenticated messages. | Phase 1 in the field. |
| **3** | Extend the allowlist and parsers to CIT(A)/NFAC and departmental mail — much higher volume, same pipeline. | Sample emails. |
| **4** | Optional `gmail.readonly` connect for practices filing under their own address, if the CASA cost is ever worth it. Optional IMAP polling in the desktop connector for non-Google mailboxes, where credentials are already vaulted. | A commercial decision, not a technical one. |

Phase 1 is the whole value: hearing dates stop depending on somebody noticing an
email. Everything after it is a reduction in setup friction.

A worthwhile companion, independent of email: the Tribunal publishes daily
**cause lists**. Scraping them for appeal numbers already on file corroborates
every hearing date and catches adjournments that never generate a message at
all. Two independent sources agreeing is a much stronger promise than one.

---

## Open questions

- **Does `itat.nic.in` sign with DKIM?** Check `Authentication-Results` on a raw
  copy of either sample. It decides whether auto-apply can be authenticated or
  whether everything routes through the review queue at first.
- **Which inbound provider**, and is `in.prohippo.in` free to take an MX record?
- **Does the ITAT portal accept a representative's email** alongside the
  appellant's at registration? If it does, route 1 above is the one to push in
  the product, because it removes forwarding from the picture entirely.
