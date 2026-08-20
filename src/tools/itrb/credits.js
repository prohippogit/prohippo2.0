/*
 * Parts G and H — credit for tax paid in the years of the block period.
 *
 * WHAT THE FORM ACTUALLY ASKS, which is narrower than "the tax you paid":
 *
 *   PART G  "Details of payments of tax (advance tax/self-assessment tax) FOR
 *            WHICH NO CREDIT HAS BEEN CLAIMED IN THE RETURNS FILED EARLIER"
 *
 *   PART H  six columns, of which three are the arithmetic:
 *            (4) Total TDS/TCS credit available
 *            (5) Credit for TDS/TCS claimed in all the return(s) filed u/s 139
 *            (6) Amount of TDS/TCS credit claimed in the current return
 *
 * THERE IS NO REFUND COLUMN, AND THE FORM DOES NOT NEED ONE. A refund already
 * received is proof that the credit was CLAIMED, and a claimed credit is what
 * both parts exclude — Part G by its heading, Part H by column (5). Refund is
 * the consequence; the claim is the test. So nothing here asks whether money
 * came back, and everything here asks whether credit was taken.
 *
 * WHY THIS MATTERS TO THE BOTTOM LINE. Part E takes the total of these off the
 * tax on the undisclosed income. A credit that was already allowed in the
 * earlier year and is claimed again here understates the block liability, in a
 * return the Assessing Officer verifies under rule 12AE(4). The safe direction
 * is to start empty and make somebody assert the credit, not to fill from the
 * return and make somebody remember to take it out.
 *
 * Pure, so `node --test` can prove the arithmetic without a browser.
 */

const n = (v) => {
  if (v === "" || v === null || v === undefined) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

/**
 * Part H for one year, in the form's own columns.
 *
 * @returns { tan, available, claimedEarlier, claimedNow, entered, over }
 *          `claimedNow` is column (6) and is DERIVED — (4) less (5), floored at
 *          nil. It is not a field: two boxes that can disagree with their own
 *          difference is a return that contradicts itself on its face.
 *          `over` marks a row claiming more earlier than was ever available,
 *          which is a transcription error rather than a negative credit.
 *
 * READS AN OLDER DRAFT TOO. Drafts written before Part H had its three columns
 * carry a single `credits.tds`/`credits.tcs` filled from the return, with what
 * the return claimed alongside in `claimed`. Those are exactly columns (4) and
 * (5), so an old draft answers the new question without a migration step — and
 * answers it correctly, because on the ordinary year the two are equal and the
 * credit claimed now comes out at nil.
 */
export function partHRow(year) {
  const h = (year && year.partH) || {};
  const legacyAvailable = (n(year?.credits?.tds) ?? 0) + (n(year?.credits?.tcs) ?? 0);
  const legacyClaimed = (n(year?.claimed?.tds) ?? 0) + (n(year?.claimed?.tcs) ?? 0);
  const hasLegacy = n(year?.credits?.tds) !== null || n(year?.credits?.tcs) !== null;

  const available = n(h.available) ?? (hasLegacy ? legacyAvailable : null);
  const claimedEarlier = n(h.claimedEarlier) ?? (hasLegacy ? legacyClaimed : null);
  const a = available ?? 0;
  const c = claimedEarlier ?? 0;

  return {
    tan: String(h.tan || ""),
    available,
    claimedEarlier,
    claimedNow: Math.max(0, a - c),
    entered: available !== null || claimedEarlier !== null,
    over: c > a,
  };
}

/**
 * Part G for one year.
 *
 * No arithmetic to do — the form asks for challans, and a challan either
 * qualifies or does not. What this adds is the QUALIFIER, kept beside the
 * figure: `claimedInReturn` is what the return for that year already took
 * credit for, and a challan covered by it does not belong in Part G at all.
 */
export function partGRow(year) {
  const advance = n(year?.credits?.advance);
  const selfAssessment = n(year?.credits?.selfAssessment);
  return {
    advance,
    selfAssessment,
    total: (advance ?? 0) + (selfAssessment ?? 0),
    entered: advance !== null || selfAssessment !== null,
    /* What the return for this year claimed. Not a figure to copy into Part G —
       the opposite: the test the heading applies. */
    claimedInReturn: {
      advance: n(year?.claimed?.advance),
      selfAssessment: n(year?.claimed?.selfAssessment),
    },
  };
}

/** Both parts for one year, and their total — what Part E line 7 takes off. */
export function creditsFor(year) {
  const g = partGRow(year);
  const h = partHRow(year);
  return { partG: g.total, partH: h.claimedNow, total: g.total + h.claimedNow, g, h };
}
