/*
 * Form ITR-B's own vocabulary, taken from the notified form.
 *
 * Source: Notification No. 30/2025 dated 7 April 2025, G.S.R. 221(E) —
 * Income-tax (Tenth Amendment) Rules, 2025, which inserts rule 12AE and
 * Form ITR-B into Appendix-II. Where a list here looks arbitrary, it is the
 * form's list, in the form's order, with the form's wording.
 *
 * WHY THIS IS ITS OWN FILE. draft.js needs these to build a blank draft and
 * compute.js needs them to total the columns. Putting them in either one makes
 * the other import it, and the two already point at each other — a cycle that
 * happens to work today because nothing is read at module-evaluation time, and
 * that would break the first time somebody added a top-level constant derived
 * from the other module. A leaf both can import costs nothing and cannot cycle.
 */

/* Part D-II — "Item-wise break-up of the total undisclosed income for the block
   period declared in Part D I". Fourteen rows, then a total which the form
   requires to equal row 6 of Part D-I.

   Note the shape of the list: it is NOT a list of assets. Rows 1-5 are assets,
   6-10 are wrong claims, 11-12 are transactions, and 13-14 are catch-alls. An
   earlier draft of this tool guessed at "money, bullion, jewellery, VDA, other
   assets" and got six of the fourteen wrong, which is why these now come from
   the gazette rather than from memory. */
export const DII_ITEMS = [
  { key: "money", short: "Money", no: 1, label: "Money" },
  { key: "bullion", short: "Bullion", no: 2, label: "Bullion" },
  { key: "jewellery", short: "Jewellery", no: 3, label: "Jewellery" },
  { key: "valuable", short: "Other valuable article", no: 4, label: "Other valuable article or thing" },
  { key: "vda", short: "Virtual digital asset", no: 5, label: "Virtual Digital Asset" },
  { key: "expenditure", short: "Expenditure", no: 6, label: "Expenditure" },
  { key: "claimExpense", short: "Incorrect claim — expense", no: 7, label: "Incorrect claim on account of expense" },
  { key: "claimExemption", short: "Incorrect claim — exemption", no: 8, label: "Incorrect claim on account of exemption" },
  { key: "claimDeduction", short: "Incorrect claim — deduction", no: 9, label: "Incorrect claim on account of deduction" },
  { key: "claimAllowance", short: "Incorrect claim — allowance", no: 10, label: "Incorrect claim on account of allowance" },
  /* Rows 11 and 12 carry the form's own restriction: they are filled only where
     Y0 is a COMPLETE year. For a part period, s.158BB(3) keeps this income out
     of the block return altogether — see Note 4 to the form, and
     excludedFromBlock() in compute.js. */
  { key: "internationalTxn", short: "International transactions", no: 11, label: "International Transactions", completeYearOnly: true },
  { key: "sdt", short: "Specified domestic txns", no: 12, label: "Specified Domestic Transactions", completeYearOnly: true },
  { key: "entries", short: "Entries in books or documents", no: 13, label: "Income based on any entries in books of account or other documents or transactions" },
  { key: "other", short: "Any other", no: 14, label: "Any Other" },
];

/* A15 — nature of employment. */
export const EMPLOYMENT_NATURE = [
  "Central Govt.", "State Govt.", "Public Sector Undertaking",
  "Pensioners-CG", "Pensioners-SG", "Pensioners-PSU", "Pensioners-Others",
  "Others", "Not Applicable (e.g. Family Pension etc.)",
];

/* A26-A31(ii) — the section a previously filed return was filed under. The
   139(8A) entry carries the form's qualifier, which is part of the option
   rather than a note beside it. */
export const FILED_UNDER = [
  "139(1)", "139(4)", "139(5)",
  "139(8A) filed prior to the date of initiation of search or requisition",
  "148", "153A", "153A r.w.s. 153C", "142(1)",
];

/* A26-A30(iv) — where an assessment, reassessment or recomputation was PENDING
   for the year as on the date of initiation, the section it was pending under. */
export const PENDING_UNDER = ["143(3)", "148", "153A", "153A r.w.s. 153C", "158BC", "245D"];

/* Part C column [B] — the section the income was determined or assessed under
   prior to the date of the search. */
export const ASSESSED_UNDER = ["143(1)", "143(3)", "144", "147", "153A", "153C", "158BC(1)(c)", "245D"];

/** A16 — status, as the e-filing utility offers it. */
export const STATUSES = [
  "Individual", "HUF", "Firm", "LLP", "Company", "AOP", "BOI",
  "Trust", "Local authority", "Artificial juridical person",
];

/* The verification declaration, verbatim from the form. The blanks are filled
   by the caller; nothing else about this sentence is ours to reword. */
export const VERIFICATION_TEXT = (name, father, capacity, pan) =>
  `I, ${name || "________________"} son/ daughter of ${father || "________________"} solemnly declare that to the best of my `
  + `knowledge and belief, the information given in the return is correct and complete and is in accordance with the `
  + `provisions of the Income-tax Act, 1961. I further declare that I am making this return in my capacity as `
  + `${capacity || "________________"} and I am also competent to make this return and verify it. `
  + `I am holding permanent account number ${pan || "________________"}.`;

/**
 * Rule 12AE(2) — how this assessee must furnish the return.
 *
 * A person whose accounts are required to be audited under s.44AB, a company,
 * and a political party must file under digital signature. Everyone else may
 * use a DSC or an electronic verification code.
 */
export function furnishingMode({ status, auditUs44AB, politicalParty } = {}) {
  const dscOnly = Boolean(auditUs44AB) || Boolean(politicalParty) || status === "Company";
  return {
    dscOnly,
    label: dscOnly ? "Digital signature (DSC) only" : "Digital signature (DSC) or electronic verification code (EVC)",
    // For the PDF, where this shares a half-width cell with its own caption.
    short: dscOnly ? "DSC only" : "DSC or EVC",
    reason: dscOnly
      ? (status === "Company" ? "a company" : politicalParty ? "a political party" : "accounts required to be audited u/s 44AB")
      : "",
  };
}
