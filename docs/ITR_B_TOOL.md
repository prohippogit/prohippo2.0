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
| A | General information, both search dates, the notice, per-year filing and assessment status | Partly — the per-year filing section, acknowledgement and pending-assessment fields are not modelled yet |
| B | Break-up of Y0/Y+1 part-year income under s.158BB(1A)(c)(ii)/(iii) | Not modelled — complete it on the portal |
| C | Undisclosed income per year, column [A], with the disclosed-income context in [B]–[H] | Column [A] and a declared total; [B]–[H] not modelled |
| D-I | Head-wise break-up | Yes |
| D-II | Item-wise break-up, fourteen rows, tied to D-I | Yes |
| E | Tax payable | Yes |
| F | Self-assessment tax for the block period, by challan | Yes |
| G | Advance tax / self-assessment tax paid earlier | Yes, per year |
| H | TDS/TCS not claimed earlier | Yes, per year |
| Verification | The form's declaration | Yes, verbatim |

What is not modelled is stated on the working paper itself, so nobody assumes a
blank part means a nil.

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
