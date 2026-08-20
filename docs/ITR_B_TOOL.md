# Tools → ITR-B

The block assessment return for a search case, built from what the practice
already holds.

## Why it exists

A search or requisition on or after **1 September 2024** puts the assessee into
block assessment under Chapter XIV-B. The return is **Form ITR-B**, prescribed by
rule 12AE (Notification No. 30/2025 dated 7 April 2025), and s.158BC(1)(a) gives
**sixty days from the service of the notice** to furnish it.

That return covers **seven periods**, not one. Sixty days is not long to settle
seven years of figures with a client who has just been searched — and most of
what the form asks for is already in this app:

* the PAN, name, status and contact details are in the assessee register;
* the income declared in each year is in the ITR JSON the portal sync has on
  file for that year.

So the tool asks for what is genuinely the practitioner's work — the undisclosed
income, and the manner in which it was derived — and hands back a working paper.

**It does not file anything.** The document says so on its face, in a band on
page one and again in the closing note.

## The form itself

The authority for everything below is the notified form: **Notification No. 30/2025
dated 7 April 2025, G.S.R. 221(E)** — Income-tax (Tenth Amendment) Rules, 2025,
which inserts rule 12AE and Form ITR-B into Appendix-II. `itrb/form.js` holds the
form's own vocabulary (the Part D-II items, the filing sections, the verification
sentence) taken from the gazette rather than paraphrased.

### The block period comes from two dates

A19 is the date the **first** authorisation was executed; A20 the date the
**last** one was. The form derives the period from both — "Block period (Derived
by system based on A19-A20)" — and its shape changes when they fall in different
previous years:

| | Same previous year | Later previous year |
| --- | --- | --- |
| Y6 … Y1 | six preceding A.Y.s | six preceding A.Y.s |
| Y0 | the **part period**, 1 April → A20 | the **complete** year |
| Y+1 | — | the **part period**, 1 April → A20 |

Part C of the form carries two mutually exclusive tables for exactly this reason,
and `blockPeriod()` reports which applies as `spansYears`.

### Parts, and which of them this tool covers

| Part | What the form asks | Here |
| --- | --- | --- |
| A | General information, both search dates, the notice, per-year filing and assessment status | Yes — including A25–A34's three per-year variants |
| B | Break-up of Y0/Y+1 part-year income under s.158BB(1A)(c)(ii)/(iii) | Yes, on the one row it belongs to |
| C | Undisclosed income per year, column [A], with the disclosed-income context in [B]–[H] | Yes — all columns, with the applicable table chosen automatically |
| D-I | Head-wise break-up | Yes |
| D-II | Item-wise break-up, fourteen rows, tied to D-I | Yes |
| E | Tax payable | Yes |
| F | Self-assessment tax for the block period, by challan | Yes |
| G | Advance tax / self-assessment tax paid earlier | Yes, per year |
| H | TDS/TCS not claimed earlier | Yes, per year |
| Verification | The form's declaration | Yes, verbatim |

**Every part of the form is now modelled.** The Review tab reports where each one
stands — done, partly, or not started — because a hole nobody can see is the
failure mode a transcription sheet has that a computation does not: a
computation is visibly wrong when a figure is missing, and a sheet just looks
finished.

## The statutory shape

| Line | Where it comes from |
| --- | --- |
| Block period | s.158B(b) and Note 1 — six preceding A.Y.s plus Y0, and Y+1 where the last authorisation was executed in a later previous year. Seven rows, or eight. |
| Undisclosed income | s.158BB(1)(a) as substituted by the Finance Act 2025 with effect from 01-09-2024 — declared directly, per year, in column [A] of Part C. The old circuitous method (total income less disclosed income) was replaced, and the tool follows the new one. |
| Losses | s.158BB(4) — no brought-forward loss or unabsorbed depreciation is set off. A year whose heads net to a loss is carried at **nil** and never reduces another year. |
| Tax | s.113 — 60% of the total undisclosed income, plus the surcharge levied by the Finance Act **of the year the search was initiated**, plus health and education cess. |
| Interest | s.158BFA(1) — 1.5% for every month or part of a month of delay beyond the date allowed by the notice, on the tax. The notice may allow 60 days, or 90 under the fifth proviso inserted by the Finance Act 2025. |
| s.158BB(3) | Note 4 — undisclosed income from an international or specified domestic transaction **pertaining to a part previous year** is assessed under the ordinary provisions and is not part of this return. Part D-II rows 11 and 12 are therefore disabled on a part period, and the aggregate *value* of such transactions is disclosed instead (A32/A34). |
| Furnishing | Rule 12AE(2) — DSC only for a company, a political party, and anyone whose accounts are audited u/s 44AB; DSC or EVC for everyone else. |
| Credits | Rule 12AE(4) — every credit except self-assessment tax for the block period itself is allowed only on the Assessing Officer's verification and satisfaction. |
| Penalty | s.158BFA(2) — 50% of the tax. **Reported, never added in**: no penalty is leviable on undisclosed income declared in this return where the tax on it is paid and evidence of payment is furnished with it. |
| Rounding | s.288B — to the nearest ten rupees, applied to the total undisclosed income and to the net payable. |

The surcharge is a **field, not a table**. It is fixed by the Finance Act of the
search year, and hard-coding this year's rate into a tool that will be used for
searches in later years is how a document goes quietly wrong.

## What is where

Everything with arithmetic or a read in it is a pure module under
`src/tools/itrb/`, tested by `test/itrb.test.mjs` under `node --test`. The React
files are the form over them and contain no tax logic.

| File | What it owns |
| --- | --- |
| `itrb/blockPeriod.js` | The block period from a search date; the sixty-day due date; months of delay. |
| `itrb/declared.js` | Head totals read out of a filed ITR JSON, form-agnostically. |
| `itrb/compute.js` | The whole liability: aggregation, the s.158BB(4) floor, tax, interest, credits. |
| `itrb/draft.js` | The draft's shape, and how it is filled from an assessee and from a return. |
| `itrb/pdf.js` | The mock ITR-B and the summarised computation (jsPDF, house theme). |
| `Tools.jsx`, `tools/ItrB.jsx` | The catalogue page and the form. |

### Why `declared.js` is not `src/computation/`

`src/computation/` builds a full Computation of Total Income and is deliberately
per-form and per-year (see `computation-spec.md` §2), so it covers the forms and
years somebody has written a mapper for. A block period is seven years long, and
an assessee who has been searched has usually filed a *different form* in at
least two of them. Refusing to read a year because no mapper exists for its form
would leave holes in the middle of the block period.

`declared.js` therefore reads **head totals and nothing else**, the way
`functions/itrTaxPosition.js` reads four leaf figures for the s.143(1) variance.
It never adds anything up and never applies a rate, so there is no arithmetic to
get wrong against a form nobody has mapped — only a field to find or not find. A
head a form does not have (there is no capital-gains head on ITR-1) reads `null`
and prints as a dash, never as a nil.

## Part B belongs to one row

Whichever of the block period is the **part** year: Y0 where the search began
and ended in the same previous year, Y+1 where the last authorisation was
executed later. It is not a per-year schedule, and asking it of seven rows would
be asking it six times too often.

Two things it does that the other schedules do not:

* **The subtotals are computed, never typed** (3v, 4av, 4biv, 4c, 4e, 5d, 6).
  The form prints their formulae; a sheet whose totals can be keyed
  independently is a sheet that can disagree with itself.
* **"Enter nil if loss" is applied**, on the nine rows that carry it. It is not
  a rounding convention — it is what stops a head that lost money in the part
  period sheltering income in another head of the same period. Every row it
  bites on is named with the figure that was disregarded, because a number
  silently replaced by nil is a number nobody can reconcile.

Row 6 is checked against Part C's part-period columns, which is the tie the form
itself asks for.

## Part A asks three different sets of questions

A25–A34 do not ask the same things of every year, and flattening them into one
set is how a transcription sheet stops matching the screen it is keyed into.
`variantFor()` derives which applies:

| Fields | Rows | What it asks |
| --- | --- | --- |
| A26–A30 | Y6 … Y2 | date of filing, section, acknowledgement, and whether an assessment was **pending** at the date of initiation |
| A31 / A33 | Y1, and Y0 once Y0 is a complete year | the above plus the income declared, the income after s.143(1), the international and specified-domestic transaction values — or, where no return was filed, whether the due date has expired and which ITR form will be used |
| A32 / A34 | a part period | the income of the period and the transaction values only; the break-up goes to Part B |

Two figures are **derived rather than asked for twice**, because one number in
two places is one number in two states:

* **A31/A33 (vi)**, total income after processing u/s 143(1), is Part C column
  **[B]**; the Part A field mirrors it read-only.
* **A32/A34 (i)**, the income of a part period, is Part C's part-period columns
  — the same figure the form ties to Part B row 6.

The section a return was filed under (A(ii)) reads from the ITR JSON's
`FilingStatus.ReturnFileSec`, but only for codes there is evidence for: 11 and
12 appear across every fixture in the repository and 12 is carried by the one
named for being belated, which fixes 11 → 139(1) and 12 → 139(4). An
unrecognised code maps to nothing and the practitioner picks, because a wrong
section against a year is a wrong answer on the form.

## Two documents, two jobs

* **Transcription sheet** — every field in the form's order under its own
  numbering, to key the portal from.
* **Computation of income** — the working the client signs off.

Downloadable separately or together; together is the default, so what is signed
off is what was keyed.

## Part C, and what its columns are not

Column **[A]** is the undisclosed income declared for the year, and it is the
only column the tax touches — row 8 (or 9) reads *"Income chargeable to tax for
the block period as declared {Refer s.158BB(5)} (Figure in Column [A])"*.
Columns **[B]** to **[H]** state the income already determined, assessed or
declared. **None of it is added to [A] and none of it is subtracted from it.**

Worth saying plainly, because the pre-Finance-Act-2025 s.158BB worked the other
way round — total income first, disclosed income deducted — so anyone who learnt
the old scheme will expect these columns to feed an arithmetic they do not feed.
`test/itrb.test.mjs` pins this: adding context figures must not move the tax.

Each period column belongs to exactly one row, and `appliesTo()` is what stops a
figure being keyed where the form has nowhere to put it:

| Column | Belongs to | Section |
| --- | --- | --- |
| [B] [C] [D] | every row | 158BB(1A)(a), (b), (d) |
| [E] | Y1, and Y0 once Y0 is a complete year | 158BB(1A)(c)(i) |
| [F] [G] | Y0 | 158BB(1A)(c)(ii), (iii) |
| [H] | Y+1, second table only | 158BB(1A)(c)(iii) |

[G] means different periods in the two tables — to the execution of the last
authorisation in the first, to 31 March in the second — which `labelFor()`
handles.

### What fills itself, and what only suggests

**[C] fills** from the ITR JSON, because that is a document the department
produced and the figure is stated in it.

**[B] suggests.** The income determined u/s 143(1) comes from a language
model's reading of the intimation PDF (`functions/intimationReading.js`), which
is good enough to put in front of somebody and not good enough to put in a
return behind their back. The banner names the figure, the row it came from and
the order's date, and waits to be told to use it. The latest order wins — a
s.154 rectification supersedes the s.143(1) it rectifies — and it is reported
under s.143(1) regardless, because column [B]'s list of sections has no entry
for s.154. "Gross total income" is excluded explicitly: it sits next to total
income in every intimation and differs by the Chapter VI-A deductions.

## Finding the proceeding the practice already holds

A search case does not arrive here as an ITR-B draft. It arrives as a proceeding
under **Matters**, with the s.158BC notice in it and the panchnama attached to
it. **Find the s.158BC proceeding** on the Details tab searches for it and takes
what it can. Two sources, deliberately shown apart:

**Recorded fields — filled on one press.** `findProceeding.js` matches matters
and notices on the PAN and on a s.158BC/158BD section, picks the *earliest*
s.158BC notice (a reminder carries its own DIN, which is not the one Part A
wants), and takes the DIN, the notice date, the date of service, the period the
Assessing Officer allowed, and the limb of s.158BC. Where two notices **disagree**
about a date it fills nothing and says so — the sixty-day clock runs off the
date of service, and quietly picking one of two is how that clock ends up wrong
with nobody looking.

**The two search dates — read, then shown, then applied.** A19 and A20 are in
the prose of the documents and are in no record at all, so `readBlockSearchDates`
(a callable in `functions/`) reads them. Each date comes back with the sentence
it was read from, and nothing is written until the practitioner has looked at the
quote. These two dates decide seven years of assessment between them; one day
either side of 31 March moves the whole block by a year and changes which Part C
table applies.

**It reads the whole proceeding, not one notice.** The department does not send
one notice: a block proceeding accumulates the s.158BC notice, the covering
letter, reminders and the panchnama, on separate entries and often a fortnight
apart. The s.158BC notice is the document *least* likely to state when the search
concluded — it calls for a return. So `readingOrder()` gives the callable every
block notice that has a file, the notice that starts the return first (the answer
is cached against it), and all of them are read in one Gemini call.

**It opens archives.** What arrives is frequently a ZIP of scans. `collectDocuments`
in `functions/blockSearchDates.js` sniffs every file by its **first bytes** rather
than its extension, expands ZIPs (two levels deep, then it stops), and hands the
PDFs and images inside to the model. The ZIP reader is hand-rolled on `zlib`
rather than taken from a dependency, so that `node --test` exercises it —
including the guards, which are the point: entry count, per-entry size and total
size are all capped, and a declared size is checked *before* anything is
decompressed. Password-protected entries are reported as such rather than as bad
reads; RAR and 7-Zip are named and skipped.

**It says which files it read.** Every run returns a manifest — every file
considered, the notice it came off, the archive it came out of, and what became
of it (read, opened, left out, password, not opened, not a document). The card is
shown whether or not dates were found, and opens by itself when they were not.
This exists because the first live run reported that the documents "don't state
the search dates", when what had actually happened was that one notice of several
was read and its archive was never opened. "No document says X" is not checkable
unless the reader also says which documents it opened.

`functions/blockSearchDates.js` also holds the normalisation, in the same
CommonJS module so `node --test` can reach it without Firebase: a conclusion
dated before the initiation drops the conclusion (falling back to the shorter
block period, never one that invents a year), and any date before 2024 is
discarded as a misread — Chapter XIV-B runs from 01-09-2024, so a 1998 "search
date" is an assessment year read off the same page.

> **Deploy note.** `readBlockSearchDates` changed shape — it now takes a list of
> notice ids and returns a manifest. Until
> `firebase deploy --only functions:readBlockSearchDates` has run again, **Read
> the search dates** still works but reads only the first notice and cannot open
> a ZIP. The scan and its recorded-field fill are pure client code and are
> unaffected.

## Starting from the notice

A block return is furnished through the e-Proceeding for the s.158BC notice, and
that notice is usually already in the app with its DIN, its date, the date it was
served and the period the Assessing Officer allowed. `Build the ITR-B` on the
notice screen carries all four across (`fromNotice`), so the only thing left to
key on Part A is the pair of search dates — which are on the panchnama, not on
the notice.

## Storage

Drafts live in `users/{uid}/itrbDrafts`, covered by the existing
`users/{userId}/{document=**}` rule — no `firestore.rules` change was needed.
A draft is saved explicitly, and again whenever a document is downloaded, so a
paper that has been handed over always corresponds to something on file.

## Filling a year's declared income

Two routes, both landing in the same place:

* **Fill from synced returns** — reads the ITR JSON the portal sync already
  stored, per year or for the whole block period at once. Needs the bucket's
  CORS policy to allow the site (`storage.cors.json`, see
  `PORTAL_SYNC_SETUP.md`); the tool names that cause rather than passing the
  browser's bare "Failed to fetch" along.
* **Upload ITR JSONs** — as many years at once as you like.

Either way a reading is filed against **the assessment year the file states**,
not the row the button sits on. Seven JSONs downloaded from the portal in one go
are named by acknowledgement number, and a file picked out of that list by
mistake would otherwise put one year's declared income against another —
silently, and in a figure that *reduces* the undisclosed income. A file for a
different PAN, or for a year outside the block period, is refused with the reason.
