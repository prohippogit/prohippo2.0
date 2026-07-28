/* ProHippo — standard document checklists, keyed by the section a notice is
 * issued under.
 *
 * The AI parser reads whatever the notice itself lists (functions/index.js,
 * EXTRACTION_PROMPT). These presets cover what a practitioner asks for on top
 * of that — the papers you always end up needing but the notice never spells
 * out. They are suggestions only: every item lands in the checklist editable
 * and deletable.
 */

export const PRESETS = [
  {
    key: "143(2)",
    label: "Scrutiny u/s 143(2)",
    match: /^143\(2\)/,
    items: [
      "Computation of income and ITR acknowledgement for the year",
      "Audited financial statements — balance sheet, P&L and schedules",
      "Tax audit report in Form 3CD (if applicable)",
      "Bank statements for all accounts for the full financial year",
      "Party-wise ledger of major purchases and sales",
      "Copies of Form 26AS and AIS/TIS for the year",
    ],
  },
  {
    key: "142(1)",
    label: "Enquiry u/s 142(1)",
    match: /^142\(1\)/,
    items: [
      "Computation of income and ITR acknowledgement for the year",
      "Bank statements for all accounts for the full financial year",
      "Details and supporting bills for the expenses queried",
      "Copies of Form 26AS and AIS/TIS for the year",
    ],
  },
  {
    key: "148",
    label: "Reassessment u/s 147/148",
    match: /^14[78]/,
    items: [
      "Copy of the return filed for the year (or confirmation that none was filed)",
      "Bank statements covering the transaction referred to in the notice",
      "Documentary evidence for the source of the transaction",
      "Purchase/sale deed or contract note for the transaction, if any",
      "Copies of Form 26AS and AIS/TIS for the year",
    ],
  },
  {
    key: "68",
    label: "Cash credits / unexplained money",
    match: /^6[89]|^115BBE/,
    items: [
      "Confirmations from each lender/creditor with PAN and ITR acknowledgement",
      "Bank statements of the lenders showing the source of funds",
      "Loan agreements, and evidence of interest paid and TDS deducted",
      "Cash book and day-to-day cash summary for the period",
      "Explanation for the source of each cash deposit above ₹2 lakh",
    ],
  },
  {
    key: "250",
    label: "First appeal — CIT(A)",
    match: /^250|^246/,
    items: [
      "Copy of the assessment order under appeal",
      "Copy of Form 35 and the grounds of appeal as filed",
      "Proof of payment of the appeal fee and of any admitted demand",
      "All submissions and evidence filed before the Assessing Officer",
      "Documents to be filed as additional evidence under Rule 46A, if any",
    ],
  },
  {
    key: "ITAT",
    label: "Second appeal — ITAT",
    match: null,
    items: [
      "Copy of the CIT(A) order under appeal",
      "Copy of Form 36 and the grounds of appeal as filed",
      "Complete paper book — assessment order, submissions and evidence",
      "Proof of payment of the tribunal fee",
      "Case laws relied upon, if already identified",
    ],
  },
  {
    key: "penalty",
    label: "Penalty — 270A / 271 series",
    match: /^27[01]/,
    items: [
      "Copy of the assessment order that gave rise to the penalty",
      "Copy of the show-cause notice received",
      "Evidence supporting a bona fide explanation for the addition",
      "Proof of taxes paid on the assessed income",
    ],
  },
  {
    key: "common",
    label: "Always useful",
    match: null,
    items: [
      "PAN card and Aadhaar copy",
      "Current mobile number and email registered on the e-filing portal",
      "Copies of Form 26AS and AIS/TIS for the year",
      "Signed authority letter / vakalatnama",
    ],
  },
];

/* Presets ordered for a given notice: the ones matching its section (or
   authority, for appeal matters) first, then everything else. */
export function presetsFor({ section, authority } = {}) {
  const s = (section || "").replace(/\s+/g, "");
  const relevant = new Set();
  PRESETS.forEach((p) => { if (p.match && s && p.match.test(s)) relevant.add(p.key); });
  if (authority === "ITAT") relevant.add("ITAT");
  if (authority === "CIT(A)") relevant.add("250");
  if (authority === "Penalty") relevant.add("penalty");
  return [...PRESETS].sort((a, b) => (relevant.has(b.key) ? 1 : 0) - (relevant.has(a.key) ? 1 : 0));
}
