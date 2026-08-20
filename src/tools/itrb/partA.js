/*
 * Part A of Form ITR-B — what the form asks about each year of the block.
 *
 * Source: Notification No. 30/2025, G.S.R. 221(E), fields A25 to A34.
 *
 * THREE SHAPES, NOT ONE. The form does not ask the same questions of every
 * year, and the difference is not cosmetic:
 *
 *   A26-A30   Y6 to Y2. Four questions only — when the last return was filed,
 *             under what section, its acknowledgement, and whether an
 *             assessment was PENDING as at the date of initiation.
 *   A31/A33   Y1, and Y0 once Y0 is a complete year. The full set: the same
 *             four, plus the income declared, the income after processing under
 *             s.143(1), the aggregate value of international and specified
 *             domestic transactions, and — where no return was filed — whether
 *             the due date has expired and which ITR form will be used.
 *   A32/A34   A part period. No return exists for a part of a year, so the form
 *             asks only for the income of the period and the transaction
 *             values, and sends the break-up to Part B.
 *
 * Asking a year the wrong set is how a transcription sheet stops matching the
 * screen it is being keyed into, so the variant is derived rather than guessed.
 */

/** Which set of questions the form asks of a row. */
export function variantFor(year, spansYears) {
  if (!year) return "brief";
  // A part period is asked almost nothing: there is no return to describe.
  if (year.part) return "partYear";
  // Y1 always gets the full set; Y0 gets it too once it is a complete year.
  if (year.slot === "Y1") return "full";
  if (year.slot === "Y0") return spansYears ? "full" : "partYear";
  return "brief";
}

/** The form's own field numbers, so the sheet and the screen agree. */
export const FIELD_NUMBERS = {
  brief: { filedOn: "(i)", filedSection: "(ii)", ackNum: "(iii)", pending: "(iv)" },
  full: {
    returnFiled: "(i)", filedSection: "(ii)", itrForm: "(iii)", ackNum: "(iv)",
    declaredTotal: "(v)", determined: "(vi)", intlTxnValue: "(vii)", sdtValue: "(viii)",
    dueDateExpired: "(ix)", itrFormChosen: "(x)",
  },
  partYear: { partYearIncome: "(i)", intlTxnValue: "(ii)", sdtValue: "(iii)" },
};

/* A31/A33(ii) offers a narrower list than A26-A30(ii): a return for the year
   immediately before the search cannot have been filed under s.148 or s.153A,
   and the form drops those. It also spells out which side of the due date
   s.139(1) and s.139(4) fall. */
export const FILED_UNDER_RECENT = [
  "139(1) — on or before the due date",
  "139(4) — after the due date",
  "139(5)",
  "139(8A) filed prior to the date of initiation of search or requisition",
];

/* ITD's numeric code for the section a return was filed under, as it appears in
 * the ITR JSON at FilingStatus.ReturnFileSec.
 *
 * DELIBERATELY SHORT. 11 and 12 are the two that appear across every return in
 * the repository's fixtures, and 12 is carried by the one fixture named for
 * being belated — so both are evidenced rather than recalled. The rest of the
 * code list is not, and a wrong section against a year is a wrong answer on the
 * form, so an unrecognised code maps to nothing and the practitioner picks. */
const FILED_SECTION_CODES = {
  11: "139(1)",
  12: "139(4)",
  13: "139(5)",
};

/** The section a filed return was furnished under, or "" if the code is not one we know. */
export function filedSectionFrom(itrJson) {
  const root = itrJson && itrJson.ITR;
  if (!root || typeof root !== "object") return "";
  const body = root[Object.keys(root)[0]];
  const status = (body && (body.FilingStatus || (body.PartA_GEN1 && body.PartA_GEN1.FilingStatus))) || {};
  const raw = status.ReturnFileSec;
  // ITR-5 and ITR-6 nest it a level deeper under IncomeTaxSec.
  const code = Number(raw && typeof raw === "object" ? raw.IncomeTaxSec : raw);
  return FILED_SECTION_CODES[code] || "";
}

/**
 * A32(i) / A34(i) — the income of a part period.
 *
 * NOT a field of its own. The form sends the break-up of this income to Part B,
 * and Part C states the same figure in its part-period columns with the note
 * that the two "should be equal". Three places for one number is two places for
 * it to disagree, so it is derived from Part C here and shown rather than
 * asked for.
 */
export function partYearIncome(year, result) {
  if (!year || !year.part || !result) return 0;
  return result.spansYears
    ? Number(year.partC?.nextYearPart) || 0
    : (Number(year.partC?.preInitiation) || 0) + (Number(year.partC?.postInitiation) || 0);
}

/**
 * What Part A still wants for a year, given what is on the row.
 *
 * Advisory, like readiness(): the sheet prints either way. It exists so a
 * practitioner working through seven years can see which ones are done without
 * opening each in turn.
 */
export function missingFor(year, spansYears) {
  const v = variantFor(year, spansYears);
  const a = year.partA || {};
  const gaps = [];
  if (v === "partYear") return gaps;

  if (v === "brief") {
    if (!year.filedOn) gaps.push("date of filing");
    if (!a.filedSection) gaps.push("section filed under");
    if (!year.ackNum) gaps.push("acknowledgement number");
    // The one question the form asks that nothing else on the row answers.
    if (!a.pending) gaps.push("whether an assessment was pending at the date of initiation");
    return gaps;
  }

  if (year.returnFiled === false) {
    if (!a.dueDateExpired) gaps.push("whether the s.139(1) due date had expired");
    if (a.dueDateExpired === "No" && !a.itrFormChosen) gaps.push("the ITR form the income will be furnished in");
    return gaps;
  }
  if (!year.filedOn) gaps.push("date of filing");
  if (!a.filedSection) gaps.push("section filed under");
  if (!year.declaredForm) gaps.push("the ITR form filed");
  if (!year.ackNum) gaps.push("acknowledgement number");
  if (year.declaredTotal === "" || year.declaredTotal === null || year.declaredTotal === undefined) {
    gaps.push("total income declared");
  }
  return gaps;
}
