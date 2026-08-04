# Intimation variance — what CPC did to the assessee's position

Every s.143(1) intimation and s.154 rectification order the sync brings in is
compared against what it revised, and the difference is flagged red or green on
the dashboard. This document is about where the two figures come from, why the
comparison is arithmetic rather than an AI read of the PDF, and the decisions
that were made deliberately.

## The two sides

| | where it comes from |
|---|---|
| **CPC's position** | the activity row's own detail blob — `computedDemndAmt` / `computedRefndAmt`, stored on the order as `demand` / `refund` (`connector/src/main/portalReturns.js` → `ingestPortalReturn`); failing that, the order's own printed total (see below) |
| **The assessee's position** | the filed ITR JSON already in Storage, read by `functions/itrTaxPosition.js` |

**CPC's figure is read from the order's STATUS, never by netting the two fields
against each other.** When CPC determines a refund and sets it off u/s 245, the
portal populates both — the refund determined, *and* the outstanding demand of
**earlier years** the refund went towards. Engine 1 netted them and reported a
₹1,83,744 demand on an A.Y. 2022-23 intimation that agreed with the return line
for line and whose own words are *"There is no payment due."* The status says
which figure belongs to the order (`OUTCOME_BY_ACTIVITY`), so it is asked. An
unrecognised status carrying both figures reports "could not be compared" rather
than guessing.

### When the portal sends a status and no amount

A real A.Y. 2024-25 intimation arrived under status 61 — *processed, demand
determined* — with both amount fields empty. The status said a demand existed
and nothing said how much, so the row read "not compared" beside a document
printing **₹6,540** in bold on page one. That is a gap the practitioner can see,
which is the right failure, but it is still a gap.

So where the portal gave **nothing**, `documentNet()` takes the order's own
printed total from the AI read. Three rules keep it honest:

- **only where the portal gave nothing.** A portal figure is never overridden,
  corrected or averaged with a read one.
- **a read that failed its reconciliation is refused.** It has already been shown
  to disagree with a figure that could be checked. A read that could not be
  checked is accepted, because "unchecked" is the normal state for exactly the
  orders this is for — there was no portal figure to check against.
- **`variance.source` records which it was** (`"portal"` / `"document"` / `""`),
  all the way to the screen, so a document-sourced figure is visibly weaker
  rather than silently equal. The order card labels it *"per the order — the
  portal sent no amount"*.

And the reconciliation refuses to check a read against a figure that came from a
read: both numbers would be the same read of the same page, and "reconciles"
would dress one unverified source up as two agreeing ones.

### The portal's refund figure is one line short of the money

A refund order does not stop at the refund. It nets the tax against the taxes
paid, and **then** adds interest u/s 244A and restates the total — and it is the
restated total that reaches the bank. The portal's `computedRefndAmt` is the
first of those figures.

A real A.Y. 2024-25 order, all three figures correct:

| | |
|---|---|
| Refund claimed in the return | ₹2,29,840 |
| Refund CPC computed — **what the portal sends** | ₹2,28,838 |
| Interest u/s 244A | + ₹3,432 |
| **Total refundable — what the client received** | **₹2,32,270** |

The page showed the middle figure under the heading *"CPC determined"*, flagged
the ₹1,002 shortfall in red, and left the practitioner to work out why the client
had been paid more than either number on screen. Every figure was right and the
screen was still failing at its job.

**The flag does not move to the last line, and must not.** The return's own
column against s.244A is printed *N/A* — a return never claims interest on its
own refund — so measuring ₹2,32,270 against the ₹2,29,840 claimed would compare a
refund *with* interest against one *without*, report ₹2,430 "in the assessee's
favour", and bury a real ₹1,002 disallowance (the ₹1,000 fee u/s 234F plus ₹2 of
s.288B rounding) underneath statutory interest. Interest is compensation for
CPC's delay, not CPC agreeing with the return.

So the ladder is stated **in full**, in order, by `positionLadder()` in
`src/intimations.js`: the claim, CPC's figure carrying the flag, the interest,
and the total. The last line is the one a practitioner says out loud, so it is
what the **Demand / Refund** column and the card heading show. The interest is
only known once the order has been read — the portal never sends it — so the
ladder is two rungs before a read and four after, and `final.fromRead` says
which. The column caption reads *"refund incl. 244A"* rather than letting the
headline figure change silently under an unchanged label.

The order prints all three, so the total is **checked** against the other two
rather than computed from them (`refundLadder()` in
`functions/intimationReading.js`). A model that misreads one of them says so
instead of producing a total that adds up because we made it add up.

#### The trap: a refund order prints its refund twice

Only the **before-interest** figure is comparable to the portal's, and the
after-interest one is printed in three prominent places while the before-interest
one appears once, buried in the computation:

| where | which |
|---|---|
| `Refund amount [40=(39e-38)]` in the detailed computation | **before** interest — this is the one |
| the banner at the top: *"Refund Amount: Rs …"* | after |
| the first-page summary row *"Refund amount (including interest under section 244A)"* | after |
| `Total Income Tax Refund` / `Total amount refundable` | after |

A prompt that said *"read the banner where the table's last row is unclear"* —
correct for a demand order — produced ₹7,26,450 as the refund determined on an
A.Y. 2023-24 order where the portal said ₹6,85,332. The reconciliation caught it,
which is the system working, but the screen said only *"does not match"*.

So the prompt now names the split explicitly with a worked example, restricts the
banner fallback to demand orders, and `interestSlip()` recognises the one
signature this failure has — a read exceeding the portal's figure by exactly the
s.244A interest — and says so on the card. A wrong diagnosis being worse than
none, it stays silent when the gap is not the interest.

Both are **net of taxes paid**, and both use one sign convention, set once and
never varied:

> **Positive is money coming back to the assessee.** A refund of ₹40,000 is
> `+40000`; tax still payable of ₹40,000 is `−40000`.

So the difference is a single subtraction and its sign is the flag. Negative is
red — CPC left the assessee worse off than the baseline claimed. Positive is
green.

## Why no PDF is read

The intimation prints a full head-wise table — "as provided by taxpayer in
return of income" against "as computed under section 143(1)" — and reading it
would explain *why* a difference arose. It is not needed to know *whether* one
did, and the figures above are stated by the portal in structured form. That
means the flag:

- costs nothing per order, and no Gemini call,
- works on orders whose PDF is locked or that CPC will only send by e-mail
  (`lockReason: "request-only"`, A.Y. 2016-17 and earlier),
- works retroactively across every order already synced, and
- cannot be wrong in the way a model can be wrong.

### The head-wise breakdown (`readIntimationOrder`)

That rule held when the breakdown landed. `readIntimationOrder` reads the
order's own comparison table — the return's figures against CPC's, line by line
— and **cannot contradict the flag** (it can only supply one where the portal
gave no figure at all, under the rules above). What makes it safe to look at is the
reconciliation in `functions/intimationReading.js`: the model is also asked for
the order's own bottom line, and that has to equal the demand or refund the
portal separately recorded, to the rupee. Two independent sources for one
number; they agree only if the read was faithful.

Where they disagree the breakdown is kept but marked as not reconciling, and the
screen says so instead of showing a confident table nobody checked. A read that
cannot be checked at all is a third state, and none of the three is called
"probably right" — that would be read as "right".

It also reads the order's **outstanding-demand annexures** — the arrears of other
assessment years the refund was set off against, and what is still owed. Those
are kept strictly apart from the order's own position and can never reach the
variance; mixing the two is what produced the ₹1,83,744 bug. They earn their
place because an order can agree with the return to the rupee and still leave
the client with nothing.

### When it runs by itself (`onReturnWritten`)

Manual by default: one button, one order, one paid call. A practice can switch
on automatic reads in Settings, which applies the same read — through a
Firestore trigger, never inside the sync, because `docs/PERF_AND_REGION.md`
records what awaiting a Gemini call on that path did to sync times.

Five guards, each a number rather than a heuristic:

| guard | value | why |
|---|---|---|
| red only | — | most orders agree; there is nothing to explain |
| material only | ₹1,000 | below that nobody files a rectification |
| recent only | 14 months | an old intimation does not need an unasked explanation |
| once only | — | a stored `reading` or `readingError` blocks it; the button always overrides |
| daily cap | 50 per practice | a deploy that rewrites every return can make a whole history eligible at once |

The age window is the first line of defence and the cap is the backstop —
`functions/autoRead.test.mjs` asserts a 200-order history leaves well under a
tenth eligible. Automatic reads meter under `readIntimationAuto`, apart from
manual ones, so the Costs page answers what the automation costs on its own.

The suggested cause is stored as `suggestedCause` with `causeAccepted: false`
and does nothing until a practitioner accepts it on screen — the by-cause
grouping decides which clients are treated as sharing a legal position, which is
too consequential to happen automatically. Its vocabulary is duplicated between
`functions/intimationReading.js` and `src/intimations.js` (CommonJS and ESM),
with a test in `test/intimations.test.mjs` pinning the two together.

## A s.154 order is not compared against the return

This is the single decision most likely to be got wrong, so it is encoded in one
place (`functions/returnVariance.js`) and tested directly.

A rectification revises the intimation before it, not the return. Take a return
claiming a ₹40,000 refund, a 143(1) that wrongly raised a ₹2,00,000 demand, and
a s.154 order that put it right:

- measured against the **return**, the s.154 order reads as a ₹40,000 shortfall
  and gets flagged;
- measured against the **intimation it rectified**, it reads as +₹2,00,000 —
  green, which is what actually happened.

So the baseline for a s.154 order is the most recent *earlier* order for the same
assessment year that carries a figure, falling back to the return only when there
is none. `variance.baseline.kind` records which was used and the UI always says
so — a difference is meaningless without the thing it is a difference from.

Orders sharing a date are not used as each other's baseline: same-day orders
cannot be reliably sequenced, and a baseline picked from a tie is a coin toss
presented as a fact.

## What is not flagged

- **Differences of ₹100 or less.** s.288A/288B rounding, plus CPC and the
  return's software rounding at different points, make small differences the
  norm. Without the floor the card flags ₹8 and is ignored inside a week.
- **Anything that could not be compared.** A missing CPC figure or an unreadable
  return gives `flag: "unknown"` with the reason — never a zero baseline. Reading
  an unreadable return as a nil position would turn every intimation into a
  full-value red or green flag.

## Refunds adjusted u/s 245

Activity codes 64/65/74/75/613 mean CPC determined a refund and set it off against
an earlier demand. That does **not** change the flag — the refund determined is
still the refund determined, and comparing it to the refund claimed is still
valid. The set-off is a separate matter (recovery of a past year's demand), so it
is carried as `variance.adjusted` and labelled in the UI, because a practitioner
reading "refund ₹80,000" needs to know none of it is arriving.

## Where it runs

```
portalReturns.js ──> ingestPortalReturn ──> returns/{id}.orders[].variance
   (both sync paths)      │                  returns/{id}.returnPosition
                          └── itrTaxPosition.js reads the ITR JSON from Storage
```

The position is read from **Storage**, not from the sync message: `itrJson` is
only sent the first time a year is seen, so a re-sync bringing a newly issued
s.154 order arrives with it null. It is cached on the return document and keyed
by the path it was read from, so this costs one Storage read per assessment year
for the life of that year — not one per sync.

`refreshReturnVariances` brings the back history through the same engine. It has
to exist as its own callable because the connector *skips* an assessment year
with no new order, so a quiet year would otherwise never pass through the ingest
again. The dashboard fires it once per page load when it sees intimations with no
variance on them (`needsVarianceBackfill`), and it is idempotent — a return whose
orders already carry a variance from the current `VARIANCE_ENGINE` is skipped.
Bump that constant when the arithmetic or the baseline rule changes, then call
with `{ force: true }`.

## Where it shows

- **Dashboard card** — every intimation from the last six months, anchored on the
  CPC order date and measured from today (not from the last sync, which would
  make the same order appear and disappear depending on sync frequency). The card
  is one colour and the *rows* carry the red and the green: six months will
  normally contain movement in both directions, and a card that turns red
  whenever any client gets a demand is a card nobody reads. Additional demand and
  extra refund are shown apart and never netted.
- **Returns tab** — one line under each order, with its baseline.
- **At sync time** — the ingest returns a variance summary and the Returns tab
  raises an alert for additional demand as the year comes in.

Orders can be ticked off. The tick is a map on the return document
(`varianceReviewed: { "<commRefNo>": true }`), not a flag inside the orders
array — the sync owns that array and rewrites it wholesale, so a flag stored
inside it would be erased the next time CPC issued anything for the year.

## Who is doing it

An intimation can be allocated to a member of staff, and the allocation lives in
the same per-order map as every other decision (`intimationTracking`), for the
same reason: `assignedTo`, `assignedAt`, `workDone`, `doneAt`.

**The roster is derived, not managed.** Staff is free text everywhere else in
ProHippo — on the assessee, on a matter, on a hearing — so `staffRoster()`
collects every name already in use anywhere and offers them through a
`<datalist>`. A name not on the list is simply typed, which is what makes "add
the staff if they are not in the list" free rather than a feature. Names fold
case-insensitively (`staffKey`) with the first spelling winning, so "Priya" and
"priya" are one person's workload rather than two half-answers.

**"Done" is not the decision.** The decision is what the practice resolved to do
about the order — rectify, appeal, accept. `workDone` is whether the person given
the job has carried it out. A rectification can be decided on Monday and filed on
Friday, and a page conflating the two would show the Monday state all week. Only
allocated work can be marked done, and unassigning clears the tick with it.

The **By staff** view groups on this, leading with what is still open rather than
what has ever been done, and unallocated is a group of its own that always sorts
last — nobody has picked it up, so it is a to-do list, not a workload.

## Tests

Both engines are pure and have no dependencies, so they run without installing
anything:

```
node --test functions/itrTaxPosition.test.mjs functions/returnVariance.test.mjs
node --test functions/intimationReading.test.mjs
node --test test/intimations.test.mjs        # also covered by npm test
```
