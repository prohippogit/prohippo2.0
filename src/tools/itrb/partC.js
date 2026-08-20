/*
 * Part C of Form ITR-B — the computation of undisclosed income.
 *
 * Source: Notification No. 30/2025, G.S.R. 221(E). Column letters, labels and
 * the section each one refers to are the form's, not ours.
 *
 * WHAT PART C ACTUALLY IS. Column [A] is the undisclosed income declared for the
 * year, and it is the only column the tax is computed on — row 8 (or row 9)
 * says so: "Income chargeable to tax for the block period as declared {Refer
 * s.158BB(5)} (Figure in Column [A])". Everything from [B] rightwards is the
 * DISCLOSED income already on record, stated so the Assessing Officer can see
 * what the block income sits on top of. None of it is added to [A] and none of
 * it is subtracted from it.
 *
 * That is worth saying plainly because the pre-Finance-Act-2025 version of
 * s.158BB worked the other way round — total income first, disclosed income
 * deducted from it — and a reader who learnt the old scheme will expect these
 * columns to feed an arithmetic they do not feed.
 *
 * TWO TABLES. The form prints Part C twice and the practitioner fills exactly
 * one: the first where the search was concluded in the year it began, the
 * second where the last authorisation was executed in a later previous year.
 * They differ in the tail — see columnsFor() — and blockPeriod().spansYears
 * chooses between them.
 */

/* Which rows a column can be filled against. All of them, or one of the three
   period rows. The form does not print this as a rule; it follows from what
   each column is a period OF, and stating it here is what lets the UI grey out
   a cell that cannot hold a figure rather than inviting one. */
const ALL = "all";
const Y0 = "y0";               // the previous year in which the search began
const Y_PLUS_1 = "yPlus1";     // the year the last authorisation was executed in
const DUE_OPEN = "dueOpen";    // a year ended, whose return was not yet due

export const PART_C_COLUMNS = [
  {
    key: "determined", letter: "B", rows: ALL, hasSection: true,
    label: "Total income determined u/s 143(1) or assessed u/s 143/144/147/153A/153C/158BC(1)(c)/245D prior to the date of search or requisition",
    short: "Determined or assessed",
    ref: "158BB(1A)(a)",
  },
  {
    key: "returned", letter: "C", rows: ALL, hasSection: true,
    label: "Total income declared in the return filed u/s 139(1) or in response to notice u/s 142(1) prior to the date of initiation, and not covered in [B]",
    short: "Declared in the return",
    ref: "158BB(1A)(b)",
  },
  {
    key: "tdsOnly", letter: "D", rows: ALL,
    label: "Total income referred to in s.115A(5), s.115G or s.194P(1) for any year comprised in the block period",
    short: "115A(5) / 115G / 194P(1)",
    ref: "158BB(1A)(d)",
  },
  {
    key: "booksDueOpen", letter: "E", rows: DUE_OPEN,
    label: "Income of a previous year which has ended and whose return was not yet due at the date of initiation, on the entries in the books maintained in the normal course",
    short: "Year ended, return not due",
    ref: "158BB(1A)(c)(i)",
  },
  {
    key: "preInitiation", letter: "F", rows: Y0,
    label: "Income from 1 April of the previous year in which the search was initiated to the day immediately preceding the date of initiation",
    short: "1 April to the day before initiation",
    ref: "158BB(1A)(c)(ii)",
  },
  {
    key: "postInitiation", letter: "G", rows: Y0,
    // The one label that differs between the two tables — see labelFor().
    label: "Income from the date of initiation of the search to the date of execution of the last of the authorisations",
    labelWhenSpanning: "Income from the day the search was initiated to 31 March of the previous year in which it was initiated",
    short: "From initiation",
    ref: "158BB(1A)(c)(iii)",
  },
  {
    key: "nextYearPart", letter: "H", rows: Y_PLUS_1, table2Only: true,
    label: "Income from 1 April of the previous year in which the last of the authorisations was executed to the date of that execution",
    short: "The Y+1 part period",
    ref: "158BB(1A)(c)(iii)",
  },
];

/** The columns the applicable Part C table has. [H] exists in the second only. */
export const columnsFor = (spansYears) =>
  PART_C_COLUMNS.filter((c) => !c.table2Only || spansYears);

/** A column's heading, which for [G] depends on which table is in play. */
export const labelFor = (col, spansYears) =>
  (spansYears && col.labelWhenSpanning) || col.label;

/**
 * Can this column carry a figure against this row?
 *
 * [B], [C] and [D] are about the year and apply throughout. The rest are about
 * a PERIOD, and a period belongs to one row only:
 *
 *   [E]  a previous year that had ended by the date of initiation but whose
 *        return was not yet due — Y1, and Y0 as well once Y0 is a complete year
 *        (Notes 2 and 3 to the form).
 *   [F]  and [G] carve up Y0.
 *   [H]  is the Y+1 part period, and only exists in the second table.
 */
export function appliesTo(col, year, spansYears) {
  if (!col || !year) return false;
  switch (col.rows) {
    case ALL: return true;
    case DUE_OPEN: return year.slot === "Y1" || (spansYears && year.slot === "Y0");
    case Y0: return year.slot === "Y0";
    case Y_PLUS_1: return Boolean(spansYears) && year.slot === "Y+1";
    default: return false;
  }
}

/* Which rows carry the part-period income the form ties back to Part B.
 *
 * Table 1: "Total of Column [F] and [G] ... should be equal to value from row 6
 * of PART-B". Table 2 puts the same note against [H]. Both are saying the same
 * thing — Part B breaks up whichever period is the PART year, and Part C states
 * its total. */
export const partBColumns = (spansYears) => (spansYears ? ["nextYearPart"] : ["preInitiation", "postInitiation"]);

/* ------------------------------------------------------------------------- *
 * Reading column [B] off a return the practice already holds.
 * ------------------------------------------------------------------------- */

/* A line of a s.143(1) intimation whose head is the TOTAL INCOME.
 *
 * "Gross total income" is a different figure and is excluded deliberately: the
 * two sit adjacent in every intimation, they differ by the Chapter VI-A
 * deductions, and taking the wrong one overstates column [B] by exactly the
 * amount of those deductions. "Tax on total income" contains the words too. */
const isTotalIncomeLine = (head) => {
  const h = String(head || "").toLowerCase();
  return /total\s+income/.test(h) && !/gross/.test(h) && !/tax\s+on/.test(h) && !/deemed/.test(h);
};

/**
 * Suggest column [B] from the CPC intimation this practice has already read.
 *
 * @param ret  a record from the app's `returns` collection
 * @returns { amount, section, orderDate, commRefNo } or null
 *
 * DELIBERATELY A SUGGESTION. The figure comes from a language model's reading of
 * a PDF (functions/intimationReading.js), which is good enough to put in front
 * of somebody and not good enough to put in a return behind their back. The
 * caller shows it, names where it came from, and waits to be told to use it —
 * everything else this tool auto-fills is read from a JSON the department
 * itself produced, and that difference should be visible.
 *
 * The LATEST order wins. A s.154 rectification supersedes the s.143(1) it
 * rectifies, and column [B] wants the income as it stands at the date of the
 * search, not as it first stood.
 */
export function determinedFromReturn(ret) {
  const orders = Array.isArray(ret?.orders) ? ret.orders : [];
  const dated = orders
    .filter((o) => o && o.reading && Array.isArray(o.reading.lines))
    .slice()
    .sort((a, b) => String(b.orderDate || "").localeCompare(String(a.orderDate || "")));

  for (const order of dated) {
    const line = order.reading.lines.find((l) => isTotalIncomeLine(l && l.head));
    // asComputed is CPC's column. asReturned is the taxpayer's, which is [C].
    const amount = line && typeof line.asComputed === "number" ? line.asComputed : null;
    if (amount === null) continue;
    return {
      amount,
      /* Always 143(1), even where the figure comes from a s.154 order. Column
         [B]'s own list of sections has no entry for s.154: a rectification does
         not make a fresh determination, it corrects the s.143(1) one, and the
         income as rectified is still the income determined under s.143(1). */
      section: "143(1)",
      orderDate: order.orderDate || "",
      commRefNo: order.commRefNo || "",
      head: line.head,
    };
  }
  return null;
}

/* The intimation whose PDF should be read to answer column [B], or null.
 *
 * Column [B] is "total income determined or assessed" — the figure CPC arrived
 * at, which is printed in the s.143(1) intimation and in no record the portal
 * hands over as data. determinedFromReturn above can only find it once that PDF
 * has been read; on a practice that has never opened the Intimations screen for
 * a year, nothing has.
 *
 * ONE ORDER, THE NEWEST. Each read costs money, so this returns a single
 * candidate rather than a list: the most recent order with a readable PDF and
 * no reading yet. A s.154 rectification supersedes the s.143(1) it corrects, so
 * the newest is the one that states the income as it now stands — and if it
 * turns out to carry no total-income line, determinedFromReturn falls through
 * to whatever older order has already been read, and the practitioner can press
 * again for the next one.
 */
export function intimationToRead(ret) {
  const orders = Array.isArray(ret?.orders) ? ret.orders : [];
  return orders
    .filter((o) => o && o.storagePath && !o.locked && !(o.reading && Array.isArray(o.reading.lines)))
    .slice()
    .sort((a, b) => String(b.orderDate || "").localeCompare(String(a.orderDate || "")))[0] || null;
}

/** The same return with one order's freshly-read `reading` merged in. */
export function withOrderReading(ret, commRefNo, reading) {
  if (!ret || !reading) return ret;
  return {
    ...ret,
    orders: (ret.orders || []).map((o) => (o && String(o.commRefNo) === String(commRefNo) ? { ...o, reading } : o)),
  };
}

/* What the record actually holds about this year's orders, in one line.
 *
 * "It isn't filling" is not a diagnosis, and four different states of the
 * record produce the same empty column. This prints the state itself — how many
 * orders, how many with a PDF here, how many locked, how many already read —
 * so the practitioner can see which of the four they are in without anybody
 * having to guess on their behalf.
 */
export function describeOrders(ret) {
  const orders = Array.isArray(ret?.orders) ? ret.orders : [];
  if (!ret) return "No return on file for this year.";
  if (!orders.length) return "No order or intimation on this year's return record.";
  const withPdf = orders.filter((o) => o && o.storagePath).length;
  const locked = orders.filter((o) => o && o.locked).length;
  const readAlready = orders.filter((o) => o && o.reading && Array.isArray(o.reading.lines)).length;
  return [
    `${orders.length} order${orders.length === 1 ? "" : "s"} on file`,
    `${withPdf} with a PDF here`,
    locked ? `${locked} still locked` : "",
    readAlready ? `${readAlready} already read` : "",
  ].filter(Boolean).join(" · ");
}
