/*
 * The ITR-B computation — Chapter XIV-B of the Income-tax Act, 1961.
 *
 * Pure arithmetic over the draft the practitioner has filled in. Same draft in,
 * same numbers out, no network and no AI: the form, the summarised computation
 * and the PDF all read the object this returns, so the figure on the screen and
 * the figure in the document cannot drift apart.
 *
 * THE SHAPE OF THE LIABILITY, and where each line comes from.
 *
 *   s.158BB(1)   For each previous year in the block period, the total income is
 *                computed on the evidence found in the search, and REDUCED by
 *                the income already disclosed in the return filed for that year
 *                (or determined in an assessment already completed). What is
 *                left is that year's undisclosed income. The practitioner enters
 *                the undisclosed figures head by head; the declared side is read
 *                out of the year's own ITR JSON (declared.js), never recomputed.
 *
 *   s.158BB(4)   No brought-forward loss and no unabsorbed depreciation is set
 *                off against the undisclosed income of the block period. So a
 *                year cannot go negative here: a head entered as a loss reduces
 *                that year, but the YEAR floors at nil and never eats into
 *                another year. `floored` records where that happened, because a
 *                silent floor is a number the practitioner cannot reconcile.
 *
 *   s.113        Tax on the total undisclosed income of the block period is
 *                charged at 60 per cent, plus the surcharge levied by the
 *                Finance Act of the year in which the search was initiated, plus
 *                health and education cess. The surcharge is an INPUT rather
 *                than a table: it is set by the Finance Act of the search year,
 *                and hard-coding this year's rate into a tool that will be used
 *                for searches in later years is how a document goes quietly
 *                wrong.
 *
 *   s.158BFA(1)  Where the return is furnished after the date allowed by the
 *                s.158BC notice, simple interest at 1.5% for every month or part
 *                of a month of delay, on the tax on the undisclosed income.
 *
 *   s.158BFA(2)  Penalty of 50% of the tax. NOT part of the return and never
 *                added into anything here — it is surfaced separately as an
 *                exposure figure, because a practitioner deciding what to
 *                declare wants it in front of them.
 *
 * Nothing here rounds to the rupee until the end: s.288B rounding is applied to
 * the total income and to the net payable, which is where the Act applies it.
 */
import { HEADS } from "./declared.js";
import { DII_ITEMS } from "./form.js";
import { PART_C_COLUMNS, appliesTo, partBColumns } from "./partC.js";
import { monthsOfDelay } from "./blockPeriod.js";

/** Tax on undisclosed income of the block period — s.113. */
export const RATE_113 = 60;
/** Health & education cess, presently 4%. */
export const RATE_CESS = 4;
/** Simple interest for late furnishing of the block return — s.158BFA(1). */
export const RATE_158BFA = 1.5;
/** Penalty on undisclosed income — s.158BFA(2), 50% of the tax. */
export const RATE_PENALTY = 50;

/* Undisclosed income heads. The five heads of income, plus the deemed-income
   head that carries the additions a search actually produces — unexplained cash
   credits, investments, money, expenditure — which do not sit under any of the
   five and are charged under s.115BBE when assessed in the ordinary course. */
export const UNDISCLOSED_HEADS = [
  ...HEADS,
  {
    key: "deemed",
    label: "Deemed income u/s 68, 69 to 69D",
    short: "Deemed income",
    abbr: "DEEMED",
  },
];

const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** s.288B — round to the nearest ten rupees, halves upward. */
export const round288B = (amount) => {
  const sign = amount < 0 ? -1 : 1;
  const abs = Math.abs(amount);
  return sign * Math.round(abs / 10) * 10;
};

/**
 * Compute one draft.
 *
 * @param draft  see draft.js for the shape
 * @returns a result object the form, the summary and the PDF all read
 */
export function computeItrB(draft) {
  const d = draft || {};
  const rows = Array.isArray(d.years) ? d.years : [];
  // Which of Part C's two mutually exclusive tables applies.
  const spansYears = Boolean(d.blockSpansYears);

  const years = rows.map((row) => {
    const undisclosed = {};
    let gross = 0;
    for (const h of UNDISCLOSED_HEADS) {
      const v = n(row.undisclosed && row.undisclosed[h.key]);
      undisclosed[h.key] = v;
      gross += v;
    }
    // s.158BB(4): the year floors at nil. Keep the pre-floor figure so the UI
    // can say a loss was disregarded rather than leaving the practitioner to
    // work out why the total does not add up.
    const total = Math.max(0, gross);
    const floored = gross < 0;

    /* Part D-II — the same undisclosed income, item-wise. Totalled here so the
       two break-ups can be compared; never used to derive the liability, which
       comes from Part D-I's heads. */
    const items = {};
    let itemTotal = 0;
    for (const it of DII_ITEMS) {
      const v = n(row.items && row.items[it.key]);
      items[it.key] = v;
      itemTotal += v;
    }

    /* Part C's context columns. Normalised to numbers for totalling, and each
       one marked with whether it may be filled against this row at all — a
       period column belongs to one row, and a figure keyed against any other
       is an error in the return rather than something to add up. */
    const partC = {};
    for (const c of PART_C_COLUMNS) {
      const ok = appliesTo(c, row, spansYears);
      partC[c.key] = ok ? n(row.partC && row.partC[c.key]) : 0;
      partC[`${c.key}Applies`] = ok;
      if (c.hasSection) partC[`${c.key}Section`] = (row.partC && row.partC[`${c.key}Section`]) || "";
      // Keyed where it cannot go: reported, never quietly dropped.
      if (!ok && n(row.partC && row.partC[c.key]) !== 0) partC[`${c.key}Misplaced`] = true;
    }

    const declaredTotal = n(row.declaredTotal);
    /* Credits, split as Parts G and H split them. `total` stays for the
       arithmetic, but nothing prints it without saying which part it came
       from — the "not claimed earlier" condition is on H alone. */
    const credits = {
      tds: n(row.credits && row.credits.tds),
      tcs: n(row.credits && row.credits.tcs),
      advance: n(row.credits && row.credits.advance),
      selfAssessment: n(row.credits && row.credits.selfAssessment),
    };
    credits.partG = credits.advance + credits.selfAssessment;
    credits.partH = credits.tds + credits.tcs;
    credits.total = credits.partG + credits.partH;

    return {
      ...row,
      undisclosed,
      items,
      itemTotal,
        /* s.158BB(3), and Note 4 to the form: undisclosed income in respect of an
         international transaction or a specified domestic transaction
         PERTAINING TO A PART PREVIOUS YEAR in the block period is assessed
         under the ordinary provisions, and "is not required to be submitted as
         part of the block return". Part D-II says the same thing structurally —
         rows 11 and 12 are marked fillable only where Y0 is a complete year.

         So this is not a deduction to be netted off. Income on that account
         does not belong in the block return at all, and an amount keyed against
         those two rows of a PART period is an error in the return rather than a
         figure to adjust. It is flagged, and readiness() names it. */
      excluded158BB3: row.part ? n(items.internationalTxn) + n(items.sdt) : 0,
      /* Part D-I and Part D-II describe one figure two ways, and the form says
         so out loud: the total of Part D-II "should be equal to row 6 of Part
         D I". When they disagree the form does not cast, and only the
         practitioner can say which side is wrong — so this is reported, never
         reconciled. */
      itemMismatch: itemTotal !== 0 && itemTotal !== total,
      /* A32/A34 (ii) and (iii) — the aggregate VALUE of such transactions in a
         part period. A disclosure the form asks for, not income. */
      intlTxnValue: n(row.intlTxnValue),
      sdtValue: n(row.sdtValue),
      grossUndisclosed: gross,
      totalUndisclosed: total,
      floored,
      partC,
      declaredTotal,
      // The year's total income for the block assessment: what was declared,
      // plus what the search brought out. Stated in Part B of the form.
      assessedTotal: declaredTotal + total,
      credits,
    };
  });

  /* Head-wise totals across the block period, for Part C's summary line.
   *
   * A floored year contributes NOTHING to any head, rather than contributing
   * its heads while its total is disregarded. Otherwise the head row and the
   * grand total disagree by the size of the floor — a document that does not
   * cast is worse than one that shows a nil. */
  const byHead = {};
  for (const h of UNDISCLOSED_HEADS) {
    byHead[h.key] = years.reduce((sum, y) => sum + (y.floored ? 0 : n(y.undisclosed[h.key])), 0);
  }

  const byItem = {};
  for (const it of DII_ITEMS) {
    byItem[it.key] = years.reduce((sum, y) => sum + (y.floored ? 0 : n(y.items[it.key])), 0);
  }
  const totalByItem = DII_ITEMS.reduce((sum, it) => sum + byItem[it.key], 0);

  /* Part C's column totals, and the one cross-check the form spells out: the
     part-period columns ([F]+[G], or [H] once the search runs into a later
     previous year) "should be equal to value from row 6 of PART-B". Part B is
     not modelled here, so the figure is carried out for the practitioner to
     take to it rather than checked against something we do not hold. */
  const byPartCColumn = {};
  for (const c of PART_C_COLUMNS) {
    byPartCColumn[c.key] = years.reduce((sum, y) => sum + n(y.partC[c.key]), 0);
  }
  const partBTotal = partBColumns(spansYears).reduce((sum, k) => sum + byPartCColumn[k], 0);
  const misplacedPartC = years.flatMap((y) => PART_C_COLUMNS
    .filter((c) => y.partC[`${c.key}Misplaced`])
    .map((c) => ({ ay: y.ay, slot: y.slot, letter: c.letter })));

  const totalUndisclosed = years.reduce((sum, y) => sum + y.totalUndisclosed, 0);
  const totalDeclared = years.reduce((sum, y) => sum + y.declaredTotal, 0);
  const roundedUndisclosed = round288B(totalUndisclosed);

  const surchargeRate = n(d.surchargeRate);
  const cessRate = d.cessRate === undefined || d.cessRate === "" ? RATE_CESS : n(d.cessRate);
  const rate = d.taxRate === undefined || d.taxRate === "" ? RATE_113 : n(d.taxRate);

  const tax = (roundedUndisclosed * rate) / 100;
  const surcharge = (tax * surchargeRate) / 100;
  const cess = ((tax + surcharge) * cessRate) / 100;
  const grossLiability = tax + surcharge + cess;

  /* Interest runs on the TAX, not on the tax-plus-cess: s.158BFA(1) charges it
     on "the tax on undisclosed income". Months are derived from the dates when
     both are known, and can be overridden — a notice sometimes allows a period
     other than the statutory sixty days, and the practitioner is the one who
     read it. */
  const derivedMonths = monthsOfDelay(d.dueDate, d.filedOn);
  const months = d.interestMonths === "" || d.interestMonths === undefined || d.interestMonths === null
    ? derivedMonths
    : Math.max(0, Math.trunc(n(d.interestMonths)));
  const interestRate = d.interestRate === undefined || d.interestRate === "" ? RATE_158BFA : n(d.interestRate);
  const interest = (tax * interestRate * months) / 100;

  const aggregate = grossLiability + interest;

  const credits = years.reduce(
    (acc, y) => ({
      tds: acc.tds + y.credits.tds,
      tcs: acc.tcs + y.credits.tcs,
      advance: acc.advance + y.credits.advance,
      selfAssessment: acc.selfAssessment + y.credits.selfAssessment,
    }),
    { tds: 0, tcs: 0, advance: 0, selfAssessment: 0 }
  );
  credits.partG = credits.advance + credits.selfAssessment;
  credits.partH = credits.tds + credits.tcs;
  credits.total = credits.partG + credits.partH;

  /* Part F — tax actually paid against THIS block return, by challan. Not a
     credit for an earlier year: money paid now, on this liability. */
  const blockTaxPaid = (Array.isArray(d.blockTaxPaid) ? d.blockTaxPaid : [])
    .map((c) => ({ ...c, amount: n(c && c.amount) }));
  const blockTaxPaidTotal = blockTaxPaid.reduce((sum, c) => sum + c.amount, 0);

  const balance = round288B(aggregate - credits.total - blockTaxPaidTotal);

  return {
    years,
    byHead,
    totalDeclared,
    totalUndisclosed,
    roundedUndisclosed,
    tax: {
      rate, amount: tax,
      surchargeRate, surcharge,
      cessRate, cess,
      grossLiability,
      interestRate, interestMonths: months, derivedMonths, interest,
      aggregate,
    },
    credits,
    blockTaxPaid,
    blockTaxPaidTotal,
    spansYears,
    byPartCColumn,
    /* What Part B's row 6 must come to. Named for what it is FOR, because that
       is the only reason the figure exists. */
    partBTotal,
    misplacedPartC,
    byItem,
    totalByItem,
    /* Whether Part D-II was filled at all, and whether it ties to Part D-I.
       Untouched is not a mismatch — plenty of drafts never reach it. */
    itemsEntered: totalByItem !== 0,
    itemsTie: totalByItem === 0 || totalByItem === totalUndisclosed,
    // Years where income has been put against Part D-II rows 11 or 12 of a part
    // period, which s.158BB(3) keeps out of the block return altogether.
    misplaced158BB3: years.filter((y) => y.excluded158BB3 > 0).map((y) => y.ay),
    // Positive is tax still payable; negative is a refund, which on a block
    // return means the credits already on record exceed the whole liability.
    netPayable: balance > 0 ? balance : 0,
    refundDue: balance < 0 ? -balance : 0,
    // s.158BFA(2). Reported, never added in — see the header.
    penaltyExposure: (tax * RATE_PENALTY) / 100,
    /* A block period with nothing in it is a valid draft (somebody has just
       opened the tool), not an error. This says whether there is a return to
       file yet, so the UI can hold the download buttons back. */
    hasContent: totalUndisclosed > 0,
  };
}
