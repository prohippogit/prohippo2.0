# Intimation variance — what CPC did to the assessee's position

Every s.143(1) intimation and s.154 rectification order the sync brings in is
compared against what it revised, and the difference is flagged red or green on
the dashboard. This document is about where the two figures come from, why the
comparison is arithmetic rather than an AI read of the PDF, and the decisions
that were made deliberately.

## The two sides

| | where it comes from |
|---|---|
| **CPC's position** | the activity row's own detail blob — `computedDemndAmt` / `computedRefndAmt`, stored on the order as `demand` / `refund` (`connector/src/main/portalReturns.js` → `ingestPortalReturn`) |
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
— and **cannot touch the flag**. What makes it safe to look at is the
reconciliation in `functions/intimationReading.js`: the model is also asked for
the order's own bottom line, and that has to equal the demand or refund the
portal separately recorded, to the rupee. Two independent sources for one
number; they agree only if the read was faithful.

Where they disagree the breakdown is kept but marked as not reconciling, and the
screen says so instead of showing a confident table nobody checked. A read that
cannot be checked at all is a third state, and none of the three is called
"probably right" — that would be read as "right".

It runs **on demand only**: one button, one order, one paid call. There is no
sync hook, because a practice with 200 clients and five years apiece would be a
thousand reads nobody asked for.

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

## Tests

Both engines are pure and have no dependencies, so they run without installing
anything:

```
node --test functions/itrTaxPosition.test.mjs functions/returnVariance.test.mjs
node --test functions/intimationReading.test.mjs
node --test test/intimations.test.mjs        # also covered by npm test
```
