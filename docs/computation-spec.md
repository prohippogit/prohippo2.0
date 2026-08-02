# Computation of Income — Generator Specification

**Status:** authoritative. Any change to the model, the section ordering, or the
formatting rules below must be made in this file *first*, and only then in code.

If this spec and the code disagree, the spec wins and the code is wrong.

---

## 0. How this differs from the original draft

This spec began life describing a React + **TypeScript** + Tailwind repo with a
browser-side HTML→PDF renderer. ProHippo 2.0 is not that repo, so the following
were translated. Everything else — the model, section ordering, label
conventions, validation, the unmapped rule — is unchanged and binding.

| Original draft | This repo |
|---|---|
| TypeScript, `src/computation/*.ts` | JavaScript, `src/computation/*.js` (`jsconfig.json`, no TS toolchain) |
| Tailwind | Hand-written CSS; the generator ships its own scoped stylesheet |
| `npm run test` / `typecheck` / `test:golden` / `preview:pdf` | `npm test` → `node --test` (no runner dependency) |
| Montserrat woff2 embedded in the browser bundle | Montserrat embedded **server-side**, in the render function only |
| HTML → PDF in the browser | HTML built in the browser, rendered by headless Chromium in a Cloud Function (§13) |

The types in §3 are written as TypeScript interfaces because they document
shape precisely and read well. They are documentation, not code — `model.js`
carries the same shape as constructors and JSDoc.

---

## 1. What this module does

Takes an ITR JSON as filed on the income-tax portal and produces a client-ready
**Computation of Total Income and Tax Liability** as a PDF.

It is a **presentation layer, not a tax engine**. The return already contains the
assessee's own computed figures in Part B-TI and Part B-TTI. Our job is to
restate them in a readable, statutorily-labelled form — never to recompute and
substitute our own answer.

Recomputation happens in **exactly one place**: the test suite, where we
recompute totals and assert they match the return. See §7.

### Non-goals

- No tax advice, no optimisation suggestions, no regime comparison.
- No AI/LLM call at runtime. Ever. The mapping is deterministic: same JSON in,
  same document out, every time.
- No editing of the ITR JSON.

### On determinism and the render call

The pipeline up to and including the HTML string is pure and offline. The only
network call is the final HTML→PDF render, which runs headless Chromium
server-side (§13). Chromium is a renderer, not a decision-maker: it sees
finished HTML and returns pixels. Nothing about *what the document says* is
decided off the user's machine.

---

## 2. Architecture

```
ITR JSON
   │
   ├─ detect(json)          → { form: 'ITR5', ay: '2025-26', schemaVer: 'Ver1.0' }
   │
   ├─ mappers/itr5/         → ComputationDocument      ← one directory per form
   │
   ├─ validate(doc, json)   → throws / warns
   │
   └─ render(doc)           → HTML → (Cloud Function) → PDF   ← ONE renderer, shared
```

```
src/computation/
  index.js             public API: buildComputation(json, ctx) → { doc, html }
  detect.js            form + assessment year detection
  model.js             ComputationDocument shape + row constructors  (§3)
  format.js            Indian digit grouping, amount-in-words, dates  (§6)
  validate.js          ties output back to Part B-TI / Part B-TTI     (§7)
  unmapped.js          the non-zero-leaf walker                       (§8)
  ignore-paths.js      deliberate allow-list of unmapped fields       (§8)
  mappers/
    individual/        shared by ITR-2 and ITR-3 — see below
      labels.js        section, capacity, TDS and VI-A caption tables
      heads.js         salary, house property, capital gains, other sources,
                       Chapter VI-A, tax liability, taxes paid
    itr2/
      index.js         detects AY, delegates
      ay2026-27.js     registration + a home for that year's divergences
      ay2025-26.js     ditto
      build.js         the workings, shared by both years
    itr3/
      index.js
      ay2025-26.js     registration + a home for that year's divergences
      ay2024-25.js     ditto
      build.js         the workings, shared by both years
      businessHead.js  Schedule BP — the head ITR-2 has no schedule for
    itr5/
      index.js
      ay2025-26.js
      shared.js        helpers stable across years
  render/
    styles.js          design tokens (§6)
    template.js        HTML string builder
functions/
  computation.js       headless Chromium → PDF (§13)
```

**The renderer is written once and never forked per form.** If a form needs a
new kind of row, add a row *type* to the model — do not add a branch to the
renderer for "ITR-3 style".

Adding support for a new ITR form = writing one mapper + one fixture + one
golden test. Nothing else.

**Sharing between mappers is by family, not by convenience.** ITR-2 and ITR-3
are the same return with one difference — ITR-3 carries a business head — and
their Schedule S, HP, CG, OS, VIA, SI, TDS and Part B-TTI blocks are the same
schema field for field. Those workings therefore live once, in
`mappers/individual/`, and both call them. ITR-5 does not: a firm has no salary,
no regime choice and no s.16 deductions, and a table serving both would be
serving neither.

The test that a shared builder is safe to extract is the golden model: if
ITR-2's stored model does not change to the byte after the refactor, the
refactor did not change behaviour. Do it that way round.

**No head is assumed absent.** An assessee is not a template — one has salary
and a house, the next has capital gains and a partner's interest from a firm.
Every head builder walks all the sub-blocks its schedule can carry and emits
rows for whichever ones carry a figure. What a builder does not recognise it
leaves unconsumed, so §8 surfaces it rather than dropping it.

### Commands

```bash
npm test                        # all tests (node --test)
node --test test/computation    # just this module
npm run preview:computation <fixture>   # writes .tmp/<fixture>.html for eyeballing
```

---

## 3. The normalised model

```ts
export interface ComputationDocument {
  meta:      DocumentMeta;
  assessee:  Assessee;
  sections:  Section[];
  refund?:   RefundBlock;      // green banner; omit when tax is payable
  payable?:  PayableBlock;     // amber banner; omit when refund is due
  notes:     Note[];
  signatory: Signatory;
  unmapped:  UnmappedItem[];   // see §8 — MUST be surfaced, never dropped
}

export interface DocumentMeta {
  form:            'ITR1'|'ITR2'|'ITR3'|'ITR4'|'ITR5'|'ITR6'|'ITR7';
  assessmentYear:  string;     // '2025-26'
  previousYear:    string;     // '2024-25'
  schemaVersion:   string;     // as stated in the JSON
  generatedAt:     string;     // ISO
}

export interface Assessee {
  name:              string;
  pan:               string;
  status:            string;   // 'Partnership Firm', 'Trust (AOP)', 'Individual', …
  address:           string;
  email?:            string;
  mobile?:           string;
  residentialStatus: string;
  dateOfFormation?:  string;
  facts:             Fact[];   // free-form key/value pairs for the particulars card
  partners?:         Partner[];// the constitution card, where the form carries one
}

export interface Fact { label: string; value: string; }
export interface Partner {
  name: string; pan: string; share: string;
  remuneration: number|null; interest: number|null;
  // Pre-composed particulars, used where the default composition cannot express
  // them: the card serves both a firm listing its partners (ITR-5) and an
  // individual listing the firms they are a partner in (ITR-3, Schedule IF),
  // and a firm's capital balance is not a partner's remuneration.
  detail?: string;
}

export interface Section {
  id:       string;            // 'BP', 'OS', 'TI', 'TAX', 'TAXES_PAID', 'CFL'
  letter:   string;            // 'A', 'B', 'C' … assigned at build time, not hardcoded
  title:    string;            // 'Computation of Total Income'
  tone:     'navy' | 'gold' | 'slate';
  rows:     Row[];
  footnote?: string;
  omitIfAllNil?: boolean;      // default true for head-specific sections
}

export interface Row {
  kind:    'head' | 'sub' | 'subtotal' | 'total' | 'columnHeader';
  label:   string;             // statutory language — see §5
  note?:   string;             // small grey second line
  ref?:    string;             // 'Sch. BP', 'Sec. 57', 'Part A-P&L'
  amount:  number | null;      // null renders as blank, 0 renders as an em dash
  isLoss?: boolean;            // renders in red, wrapped in parentheses
  cols?:   { ref: string };    // for tables where the middle column is data, not a ref
}

export interface RefundBlock {
  amount: number;
  bank:   { name: string; accountNo: string; type: string; ifsc: string };
}
export interface PayableBlock { amount: number; }

export interface Note { text: string; severity: 'info' | 'attention'; }

export interface Signatory {
  name: string; capacity: string; pan: string; place: string; date: string;
}

export interface UnmappedItem { path: string; value: number | string; }
```

### Why `amount: number | null`

`0` and "not applicable" are different things in a tax document. `0` prints an
em dash in a greyed row (the head exists, income is nil). `null` prints nothing
(the cell is structural, e.g. a subtotal label row). Do not collapse these.

---

## 4. Section ordering

Sections are emitted in this order; letters (A, B, C…) are assigned
sequentially **after** empty sections are dropped, so there are never gaps.

| id           | Title                                          | Include when |
|--------------|------------------------------------------------|--------------|
| `SALARY`     | Income from Salaries                            | non-nil |
| `HP`         | Income from House Property                      | non-nil, **or a loss** |
| `BP`         | Profits and Gains of Business or Profession     | non-nil, or a loss |
| `CG`         | Capital Gains                                   | non-nil |
| `OS`         | Income from Other Sources                       | non-nil |
| `VIA`        | Deductions under Chapter VI-A                   | any deduction claimed |
| `TI`         | Computation of Total Income                     | **always** |
| `TAX`        | Computation of Tax Liability                    | **always** |
| `TAXES_PAID` | Taxes Paid and Prepaid Taxes                    | **always** |
| `CFL`        | Losses Carried Forward to Subsequent Years      | any non-nil c/f |

The head-specific sections (SALARY…OS) are **workings** — they show how the
figure in the `TI` section was arrived at. `VIA` is a working too: it explains
the single "Less: Deductions under Chapter VI-A" line in `TI`, and it sits
before `TI` for the same reason the heads do — a reader arrives at the total
having already seen everything that produced it. The `TI` section always lists all
five heads, including nil ones, because a computation that silently omits a head
looks incomplete to an assessing officer.

### Row skeleton for `TI` (invariant across all forms)

```
Income from Salaries                                  Sch. S
Income from House Property                            Sch. HP
Profits and Gains of Business or Profession           Sch. BP
Capital Gains                                         Sch. CG
Income from Other Sources                             Sch. OS
─ Total of Heads of Income ──────────────── subtotal
Less: Set-off of current year loss u/s 71             Sch. CYLA   [if any]
Balance after set-off of current year loss                        [if above]
Less: Set-off of brought forward loss u/s 72 / 32(2)  Sch. BFLA   [if any]
─ Gross Total Income ────────────────────── subtotal
Less: Deductions under Chapter VI-A                   Sch. VI-A
Less: Deduction u/s 10AA                              Sch. 10AA   [if any]
─ Total Income (rounded off u/s 288A) ───── total
```

---

## 5. Label conventions

Labels are the part a Chartered Accountant's eye lands on. They must read like a
computation prepared by a professional, not like a JSON key.

- Use statutory language: *"Less: Set-off of brought forward unabsorbed
  depreciation u/s 32(2)"*, not *"BF depreciation adjustment"*.
- Prefix reductions with **"Less:"** and additions with **"Add:"**. Always.
- Cite the section in the label where the section *is* the point
  (`u/s 57`, `u/s 71`, `u/s 288A`); use the `ref` column for the *source*
  (`Sch. BP`, `Part A-P&L`).
- Totals name the concept, not the arithmetic: *"Gross Total Income"*, not
  *"Sum of above"*.
- Never abbreviate a head of income.

Reference strings for the tax-rate row must not overstate authority. Use
`Para C, Sch. I` (the Finance Act rate schedule) rather than citing a charging
section unless you have verified it applies.

---

## 6. Formatting rules

| Rule | Detail |
|------|--------|
| Digit grouping | Indian system: `48,14,564` — not `4,814,564` |
| Nil | Em dash `—`, row greyed (`#9AA3B2`), amount weight 500 |
| Losses | Parentheses **and** red `#B23B3B`: `(4,64,191)` |
| Rounding | **Take rounded figures from the return.** Do not apply 288A/288B yourself |
| Currency symbol | Only in the banner and in slab labels; omitted in table columns |
| Amount in words | Indian scale — Crore / Lakh / Thousand. Suffix `Only.` |
| Alignment | Amounts right-aligned, tabular numerals |

**On rounding — this matters.** In real returns, total income is rounded to the
nearest ₹10 but the tax figure often is *not* (one of our fixtures carries a tax
of ₹703, not ₹700). If you re-derive rounding, your PDF will disagree with the
acknowledgement. Print what the return says.

### House style tokens

```
--navy-900   #0B2545      --gold-500   #C9A227      --loss     #B23B3B
--navy-700   #13315C      --gold-300   #E4C05C      --green-1  #0E4C3A
--navy-500   #1B4079      --gold-bg    #FFF6DC      --green-2  #13795C
--ink        #1B2537      --muted      #8A93A3      --hairline #E2E7F0
--row-bg     #F4F6FA      --nil-bg     #FAFBFC      --card-bg  #FFFFFF

font: Montserrat 400/500/600/700/800, embedded as woff2 (subset latin)
radii: card 18px · header 26px · row 11px · total row 12px · pill 999px
page:  A4, margins 12/11/16/11 mm
foot:  left  "Generated from <ProHippo logo>", logo 6.5 mm tall
       right name · A.Y. · Page n of m
```

The footer appears on **every** page, attribution included. The logo is the full
lockup, not the hippo alone; below about 6 mm its two lines of wordmark stop
being legible, so if the footer ever needs to be shorter, switch to the mark
plus a typeset "ProHippo" rather than shrinking the lockup.

Header band: 120° gradient navy-900 → navy-700 → navy-500, with two decorative
circles (gold at 22% opacity, white at 7%) bleeding off the right edge.

Cards must carry `break-inside: avoid` so a section never splits across pages.

---

## 7. Validation — the return is its own test oracle

Every ITR JSON already states the answer. So for each fixture we recompute and
assert. This is what stops a mis-mapped set-off from reaching a client.

```js
validate(doc, json) → { ok, failures: [{ check, expected, actual }] }
```

Assertions, all exact-match on integers:

1. Sum of head-of-income rows in `TI` === `PartB-TI.TotalTI`
2. `TI` gross total income row === `PartB-TI.GrossTotalIncome`
3. `TI` total income row === `PartB-TI.TotalIncome`
4. `TAX` gross tax row === `PartB_TTI…GrossTaxPayable`
5. `TAX` final row === `…AggregateTaxInterestLiability`
6. Sum of TDS/TCS/advance/self-assessment rows === `…TaxesPaid.TotalTaxesPaid`
7. `refund.amount` === `…NetRefundAdjust` (or payable === `BalTaxPayable`)
8. Each head-working section's closing total ties to the corresponding head row
   in `TI` — but see below, because a loss does not tie the way income does.

A failure is a **build failure**, not a warning. A computation that does not tie
to the return is worse than no computation. In production a failure raises, and
the Returns tab reports it rather than issuing a document that does not
reconcile.

### Check 8 and loss-making heads

Part B-TI **floors a negative head at nil**. A firm whose business closes at a
loss of ₹185 has `ProfBusGain.TotProfBusGain: 0` in Part B-TI, not `-185`; the
loss itself travels through Schedule CYLA and, to the extent unabsorbed, into
Schedule CFL. That is ITD's design, not an error in the return.

So check 8 is conditional on the sign of the working's closing figure:

- **Closes at income (≥ 0):** the `TI` head row must equal it exactly.
- **Closes at a loss (< 0):** the `TI` head row must be **0** — anything else
  means we have mis-read which head the figure belongs to. The loss is then
  verified against the return's own statement of it: for business, `|closing|`
  must equal `ScheduleCYLA.TotalCurYr.TotBusLoss`.

The second half matters as much as the first. Asserting only "TI says nil"
would pass for a computation that lost the loss entirely — which is precisely
the silent-omission failure §8 exists to prevent.

---

## 8. Unmapped fields — fail loud

After a mapper runs, walk the source JSON. Any **numeric leaf with a non-zero
value** whose path was not consumed by the mapper goes into `doc.unmapped`.

- `unmapped.length > 0` in tests → **test fails**.
- `unmapped.length > 0` in production → the PDF still generates, but an amber
  "Items requiring review" block is appended listing each path and value, and
  the practitioner is told on screen.

Rationale: the catastrophic failure for this product is a head of income
silently vanishing from a document the client signs. Loud and slightly ugly
beats quiet and wrong.

Maintain `ignore-paths.js` — an explicit allow-list of paths known to be
irrelevant to the computation (bank IFSC, audit acknowledgement numbers, the
zero-filled Schedule SI rate table, and so on). Adding a path there is a
deliberate act that shows up in code review.

---

## 9. Assessment-year versioning

ITD renames and re-shapes fields between years. Mappers are therefore keyed by
form **and** year-range:

```
mappers/
  itr5/
    index.js        // detects AY, delegates
    ay2025-26.js
    shared.js       // helpers stable across years
```

Never branch on `schemaVer` alone — it is `Ver1.0` in both of our current
fixtures despite the schemas differing.

A year with no mapper raises `UnsupportedFormError`, which the UI shows as a
plain sentence. It never falls back to "the nearest year" — a computation built
from the wrong year's schema is exactly the silent-wrong-answer failure §8
exists to prevent.

Two years MAY share a builder (ITR-3's `build.js` serves 2024-25 and 2025-26),
but each year keeps its own module, its own registration and its own golden
test. The rule is that no year runs against code nobody checked it against — not
that identical code must be typed twice. When a year diverges, its module is
where the divergence goes, and the other year's golden is what proves the change
did not reach it.

---

## 10. Schema notes observed in real returns

Recorded so nobody has to rediscover them.

**Status / filing**
- `FilingStatus.ReturnFileSec.IncomeTaxSec` — `11` = section 139(1).
- `OptOldRegimeCurrAY: 'N'` = default (new) regime under s.115BAC. Absent
  entirely for firms, where the concept does not apply.
- PAN 4th character carries the status: `F` = firm, `T` = trust/AOP,
  `P` = individual, `C` = company, `H` = HUF. Use it to sanity-check
  `StatusOrCompanyType` rather than decoding that code table.

**TDS (`ScheduleTDS2.TDSOthThanSalaryDtls`)**
- `TDSSection` codes are not section numbers: `94A` = s.194A,
  `4H` = s.194H, `94C` = s.194C, `94J` = s.194J. Keep a lookup map.
- `HeadOfIncome` is what the *deductor/assessee tagged*, and can legitimately
  disagree with where the income is actually offered. Do not use it to place
  income; do surface the mismatch as a note.

**Business income (`CorpScheduleBP.BusinessIncOthThanSpec`)**
- Income credited to P&L but taxable under another head appears in
  `IncRecCredPLOthHeadDtls` and must be *deducted* from net profit.
- Depreciation is a swap: add back `DepreciationDebPLCosAct`, deduct
  `DepreciationAllowITAct32.TotDeprAllowITAct`. Off-by-one rupee differences
  between the two are normal and must be carried, not "corrected".

**House property (`ScheduleHP`)**
- The head closes at a **loss** in a great many real returns, because the
  interest allowed under s.24(b) commonly exceeds the annual value. That is not
  an error state and the section must still be emitted — see `omitIfAllNil` and
  §7's note on loss-making heads.
- Statutory order is fixed: annual letable value, less rent not realised and
  municipal taxes paid, then the two s.24 deductions — 30% under s.24(a) and
  interest under s.24(b). Do not merge the two deductions into one line.
- `Section24BDtls[].TotalLoanAmt` and `LoanOutstndngAmt` are the loan's
  principal. They substantiate the interest; they are not figures in the
  computation, and printing a crore-scale principal beside a lakh-scale
  deduction reads as though it entered the total. Ignore-listed.
- `AssessePercentShareProp` is a percentage. The return has already restricted
  every figure to the assessee's share, so it is shown as a note when it is
  anything other than 100%, not as an amount.

**Set-offs**
- Current-year set-off lives in `ScheduleCYLA`, brought-forward in
  `ScheduleBFLA`. Unabsorbed depreciation is *separate* from business loss —
  it sits in `ITRScheduleUD` and sets off under s.32(2), not s.72. Labelling it
  as "brought forward business loss" is a substantive error.
- `ScheduleCFL.TotalLossCFSummary` gives closing carry-forward. A loss can
  remain fully carried forward even where other set-offs occurred in the year.
- Schedule CFL's per-year buckets are named for a layout ITD used years ago, not
  for the assessment year they hold: on an A.Y. 2025-26 return
  `LossCFCurrentAssmntYear` is A.Y. 2019-20, and the suffixed keys run on from
  there. The mapping is therefore fixed per assessment year — which is what §9's
  year-keyed mappers are for — and each bucket's own `DateOfFiling` corroborates
  it and is printed so a reader can check.
- The carry-forward total must cover **every** nature of loss the schedule
  holds (business, house property, speculation, short- and long-term capital,
  race horses), not merely the one the first fixture happened to contain.
- The s.71 set-off line must name the head whose loss it is. Schedule CYLA
  totals each head separately and so says outright which it was; describing a
  house property loss as a "business loss" is a substantive error.

**Other sources (`ScheduleOS.IncOthThanOwnRaceHorse`)**
- Split interest into its sub-fields (`IntrstFrmSavingBank`,
  `IntrstFrmTermDeposit`, `IntrstFrmIncmTaxRefund`, `IntrstFrmOthers`) rather
  than printing `InterestGross` as a single line.
- `AnyOtherIncome` is itemised in `OthersInc.OthersIncDtls[]` with a
  user-entered nature string. Use that string as the row label.

**Salary (`ScheduleS`, ITR-2/3)**
- `Salarys.NatureOfSalary.OthersIncDtls[].NatureDesc` is a numeric code table
  ("1", "4", "7") that we do **not** decode. The statutory captions —
  salary u/s 17(1), perquisites u/s 17(2), profits in lieu u/s 17(3) — are
  carried in their own fields and are what a computation states. Guessing that
  "4" means House Rent Allowance would put an unverified label on a signed
  document; the exempt allowances carry readable codes (`10(13A)`) and those
  are printed as given.
- `DeductionUS16` is the total; `DeductionUnderSection16ia` (standard deduction)
  and `ProfessionalTaxUs16iii` are its parts and are shown separately.
- `Section10_13A` carries the HRA working — actual HRA, rent paid, and the
  eligible exemption. Shown as a note, because a reader checking an HRA claim
  should not have to open the return.

**Regime (`FilingStatus`)**
- ITR-2 uses `OptOutNewTaxRegime`. `"Y"` means the assessee has opted **out**
  of the new regime and is taxed under the **old** one — the negative reads
  backwards at a glance and must be stated on the face of the computation,
  because every Chapter VI-A deduction below depends on it.
- ITR-3 asks the same question as `No_OptOutNewTaxReg`, alongside
  `OptOutNewTaxRegime_Method` (how the option was exercised — `BY10IEA` means by
  filing Form 10-IEA). `"N"` is the new regime. This reading is **verified, not
  inferred**: in the ITR-3 fixture the return's own tax at normal rates,
  3,53,432 on an aggregate of 22,11,440, reconciles to the rupee against the
  s.115BAC(1A) slabs and to nothing else, and the agricultural-income rebate of
  5,500 confirms a basic exemption of 3,00,000. If a future return disagrees,
  re-derive it the same way rather than trusting the field name.
- ITR-5 uses `OptOldRegimeCurrAY` with the opposite sense, and firms have no
  such choice at all. Do not share one helper across the two.

**Part B-TTI is not laid out the same way in ITR-2 and ITR-3**
- ITR-2 carries `Rebate87A`, `TaxPayableOnRebate`, `TotalSurcharge` and
  `EducationCess` directly under `ComputationOfTaxLiability`. ITR-3 nests all
  four inside `TaxPayableOnTI`. Read the nested one where it exists and the
  outer one otherwise — getting this wrong prints a cess of nil on a document
  somebody signs, and every total below it still ties, so nothing catches it
  except reading the page.

**Business head (`ITR3ScheduleBP`)**
- Note the key: ITR-3 calls it `ITR3ScheduleBP`, not `ScheduleBP`.
- A partner's **interest, salary, bonus and commission from a firm** are
  business income and are carried in `AnyOthIncNotInclInSalary` / `…Bonus` /
  `…Commission` / `…Interest` — "income not credited to the profit & loss
  account". Schedule BP's own item text names the case, so the captions are the
  form's, not ours. The partner's **share of the firm's profit** is exempt
  u/s 10(2A) and comes out again through `IncCredPL.FirmShareInc`.
- An assessee with no books has no P&L row to add to. Do not print a nil "net
  profit before tax" line and hang the working off it.
- `IncChrgUnHdProftGain` is item 43 — the head total, already including the
  speculative and specified-business workings. Use it rather than adding the
  three, which would be a recomputation (§1).
- Presumptive businesses appear twice and in opposite directions: the P&L
  figure in `ProfitLossInclRefrdSec.ProfitLossUs44AD…` comes out, the deemed
  profit in `DeemedProfitBusUs.Section44AD…` goes in.

**Agricultural income**
- Exempt u/s 10(1), but aggregated with total income to fix the **rate**, and
  then removed through `TaxPayableOnTI.RebateOnAgriInc`. Both movements are
  printed. Showing only the aggregate makes an exempt receipt look charged;
  showing neither makes the tax look computed on the wrong figure.

**Schedule IF**
- The firms an individual is a partner in: name, PAN, profit share and capital
  balance. The same firms are named again in
  `FilingStatus.PartnerInFirm.PartnerInFirmDtls`.

**Chapter VI-A (`ScheduleVIA`)**
- Two parallel blocks: `UsrDeductUndChapVIA` is what the assessee **claimed**,
  `DeductUndChapVIA` is what is **allowed** after the statutory caps. The
  computation states the allowed figure and notes the claim where the two
  differ — a s.80C claim of 2,28,513 restricted to 1,50,000 is exactly what a
  reader wants to see, and showing only one of the two hides it.

**Special rates (`ScheduleSI`)**
- Drives the tax section's special-rate rows: each entry gives the section code,
  the rate, the income and the tax. Read the rate from the return rather than
  hardcoding it — the rates for s.111A and s.112A changed mid-year for
  A.Y. 2025-26, and the return already says which applied.
- `SecCode` values seen: `1A` = s.111A, `2A` = s.112A, `2A_BE` = s.112A at the
  pre-change rate. An unrecognised code prints as itself.

**Capital gains (`ScheduleCGFor23`, ITR-2/3)**
- A head's subtotal is captioned by **rate, never by section**. "Short-term
  Capital Gain u/s 111A" was correct for the first return we saw, where every
  rupee of short-term gain was STT-paid equity — and wrong for the next, where
  7,51,835 of it was a land sale taxable at slab rates under the same caption.
  The split comes from `PartB-TI.CapGain.ShortTerm.*` / `.LongTerm.*`, whose
  buckets differ by year (2024-25 has no 20% short-term or 12.5% long-term;
  2025-26 added both), and the section attribution lives in the tax section
  where Schedule SI states it against each figure.
- **Land and building** does not share the s.48 shape the other classes use:
  `SaleofLandBuild.SaleofLandBuildDtls[]` carries `PropertyValuation` and
  `FullConsideration50C` alongside the consideration, because s.50C substitutes
  the higher; `AquisitCostIndex` rather than a plain cost for long-term gains;
  and `TrnsfImmblPrprty` — the buyers, their shares and their PANs, which are a
  disclosure rather than a step in the working. A computation showing only "full
  value of consideration" would hide a s.50C substitution, which is the single
  most contested figure in a property sale.
- `BalanceCGTransferBE` / `…AE` split a s.112A gain across the mid-year rate
  change in A.Y. 2025-26. They are restated rather than shown: the same split
  appears in Part B-TI's rate buckets, which cover every class of asset and
  every year.

**What differs between A.Y. 2025-26 and 2026-27 (ITR-2)**
- Capital gains: 2025-26 straddles the mid-year rate change and carries both a
  10% and a 12.5% long-term bucket; 2026-27 is the first full year on the
  amended rates and carries one of each. Nothing branches on the year — the
  workings emit a rate split only where the return puts a figure in more than
  one bucket.
- `PartB_TTI` drops the `TaxPayableOnDeemedTI` block; the deemed-income figures
  sit directly under `PartB_TTI`. Nil in the return we hold, so they would
  surface for review rather than being read wrongly.
- `IntrstPay` gains `FeeFurnish234I` alongside the s.234 interest.
- `PersonalInfo` gains a `SecondaryAdd` flag and an `AlternateAddress` block.

**What differs between A.Y. 2024-25 and 2025-26 (ITR-3)**
- The schedules are the same fields. What changes is the data, and all of it is
  read from the return: capital-gains rate buckets, the standard deduction under
  the new regime (50,000 → 75,000), and the slab table (never recomputed — Part
  B-TTI states the tax).
- The regime field differs: 2024-25 asks `OptOutNewTaxRegime`, 2025-26 asks
  `No_OptOutNewTaxReg`. `regimeLabel()` reads whichever is present.
- `ScheduleTDS2.TDSOthThanSalaryDtls[].TDSSection` is **absent** in the 2024-25
  return — all 42 rows. Print nothing rather than a bare "Sec.".

**Capacity codes (`Verification.Declaration.Capacity`)**
- `TR` = Trustee, `MP` = Managing Partner, `P` = Partner, `D` = Director,
  `KA` = Karta, `S` = Self.

---

## 11. Fixtures and tests

```
test/fixtures/
  itr5-firm-business-loss-ay2025-26.json        // set-offs, unabsorbed dep, tax audit
  itr5-firm-house-property-loss-ay2025-26.json  // s.24(b) loss, b/f losses, 22 partners
  itr2-salary-hp-capgains-ay2025-26.json        // salary, s.24(b) loss, s.111A/112A, VI-A caps
  itr2-salary-112a-refund-ay2026-27.json        // one 112A rate, TDS over the liability → refund
  itr3-partner-salary-agri-ay2025-26.json       // partner in 4 firms, agri income, 38 TDS rows
  itr3-partner-capgains-44ad-ay2024-25.json     // 44AD, land & building ST + LT, 4 rate buckets
  itr4-…  itr1-…                                 // add as forms are supported
test/golden/
  <fixture-name>.model.json                   // expected ComputationDocument
```

All fixtures **anonymised**: PAN, name, address, bank account, mobile, email,
UDIN and audit acknowledgement replaced with syntactically valid dummies.
Real client data never enters the repo.

### Preparing a fixture from a real return

```bash
node scripts/prepare-itr-fixture.mjs --list                    # what's synced
node scripts/prepare-itr-fixture.mjs --form=ITR3 --ay=2025-26  # describe + anonymise
node scripts/prepare-itr-fixture.mjs --form=ITR3 --ay=2025-26 --summary-only
```

It picks the richest return of that form and year — a fixture exercising one
head teaches a mapper less than one exercising five — prints the schedules and
every non-zero figure largest-first, then writes an anonymised copy to
`test/fixtures/`. It refuses to write if any original identifier survives, and
reports any remaining name-shaped value so an uncatalogued field is added to its
lists deliberately rather than discovered by a reader of the repository.

`--summary-only` prints the schema without writing anything, which is the right
first step: **state the mapping plan from that output before writing a mapper.**

Anonymise **by field name, never by a list of values.** A hand-written list is
exactly the sort of thing that covers seven of a firm's twenty-two partners and
leaves the rest in the repo — which happened on the first pass at the second
fixture. Verify by walking the result's string *values* (not the serialised
JSON, whose key names produce false positives) and asserting that no original
identifier survives.

Each fixture gets three tests: mapper produces the golden model; `validate()`
passes against the source JSON; `unmapped` is empty.

Minimum coverage before a form is marked supported: one profit case, one loss
case, one refund case, one tax-payable case.

Where each form stands against that, so nobody reads a green test run as more
than it is:

| Form  | A.Y.    | profit | loss | refund | tax payable |
|-------|---------|--------|------|--------|-------------|
| ITR-5 | 2025-26 | ✓      | ✓    | ✓      | ✓           |
| ITR-2 | 2026-27 | ✓      | —    | ✓      | — not yet   |
| ITR-2 | 2025-26 | ✓      | ✓    | ✓      | — not yet   |
| ITR-3 | 2025-26 | ✓      | —    | — (level) | — not yet |
| ITR-3 | 2024-25 | ✓      | —    | — (level) | — not yet |

The tax-payable path is written and rendered for both individual forms (the
banner and the "Tax Payable" closing row), but no real return exercising it has
come through the sync yet, and a fabricated one would test our own assumption
rather than the schema. The ITR-3 fixture closes level — taxes paid exceed the
liability by four rupees, which CPC neither refunds nor demands — which is worth
having as a case in its own right but is not a refund case. Add the missing
fixtures when returns arrive that carry them.

---

## 12. Edge cases to handle explicitly

- Tax **payable** rather than refundable → amber banner, no bank block.
- Neither payable nor refundable — the return closes within the few rupees CPC
  writes off, and states nil against both fields → no banner at all, and the
  closing row says so rather than reading "Refund Due — nil", which looks like a
  rejected claim.
- Nil / negative total income → tax section still renders, all rows nil.
- Multiple GSTINs in `ScheduleGST` → list all, sum turnover.
- Multiple TDS rows against the same TAN → separate rows, unless they also share
  a section, in which case they are one row carrying the count with the gross
  and the credit summed. Merging across *sections* hides which receipt a credit
  belongs to, which is exactly what a CPC mismatch query asks about; not merging
  within one turns a deductor who paid quarterly into four near-identical lines.
- Refund bank flagged `UseForRefund: 'true'` may be absent → fall back to the
  first account and add a note.
- Assessee name already prefixed `M/s.` in the JSON → do not double-prefix.
- Section 115JC / AMT: print the adjusted total income and state why AMT is nil
  rather than omitting the line.
- Revised returns (`IncomeTaxSec` = 12/13) → state so in the particulars card.

---

## 13. The render step

`render/template.js` produces one self-contained HTML string: inline CSS, the
Montserrat subset as a base64 `@font-face`, no external references of any kind.

`functions/computation.js` exposes `renderComputationPdf({ assesseeId, ay, html })`:

1. Launches headless Chromium (`puppeteer-core` + `@sparticuz/chromium`).
2. `setContent(html, { waitUntil: 'load' })` — nothing to fetch, so this is fast.
3. `page.pdf({ format: 'A4', printBackground: true })` with the §6 margins and
   the §6 footer.

   Chromium renders header/footer templates in an isolated document: no page
   styles, no network, and font-size defaults to zero. Everything in the footer
   is therefore inline and self-contained, and the ProHippo mark travels as a
   base64 data URI (`functions/assets/prohippoLogo.js`). The footer uses the
   system sans rather than the embedded Montserrat, because `@font-face` inside
   a footer template is not reliably honoured across Chromium versions and a
   footer that silently falls back mid-print is worse than one that never
   claimed the face.
4. Uploads to `users/{uid}/assessees/{id}/returns/{ay}/computation.pdf` and
   records the path on the return document.

**The HTML is built client-side and passed in.** The function does not see the
ITR JSON, does not map anything, and makes no decisions about content — so the
"no tax engine on the server" boundary holds, and the function stays a renderer
that any future form benefits from without redeployment.

Chromium is the reason this is a server call at all: the design in §6 is
gradients, rounded cards and print-safe page breaks, and reproducing it in a
drawing API would be a second renderer to keep in step with the first. §2's "one
renderer, never forked" applies to output targets as much as to forms.
