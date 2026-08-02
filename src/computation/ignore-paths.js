/*
 * The deliberate allow-list of unmapped paths — docs/computation-spec.md §8.
 *
 * Everything a mapper does not read is reported as "requiring review" unless it
 * is listed here. Adding a path is a deliberate act that shows up in review;
 * that friction is the point. The question to answer before adding one is not
 * "is this noisy?" but "could this ever belong in a Computation of Total
 * Income?" If the answer is maybe, leave it out and let it surface.
 *
 * Two kinds of entry:
 *   SUBTREES  whole schedules that are financial statements or working papers,
 *             not part of the computation of income.
 *   LEAVES    identifiers and codes that happen to be numeric — a PIN code is
 *             not a figure, but a naive walker cannot tell.
 */

/* Schedules that are the accounts, not the computation.
 *
 * A Computation of Total Income restates Part B-TI and Part B-TTI and shows the
 * workings behind each head. The balance sheet, the trading and manufacturing
 * accounts and the profit & loss account are the *source* the return was
 * prepared from; they are filed alongside it and are not restated in a
 * computation. The single figure the computation does take from them — net
 * profit before tax — is read through Schedule BP, which is where the return
 * itself carries it.
 *
 * The depreciation schedules (DPM/DOA/DEP/DCG) are the same case: the
 * computation shows the s.32 allowance as one line, and the block-wise workings
 * behind it belong in the tax audit papers.
 */
const SUBTREES = [
  "PARTA_BS", // balance sheet
  "ManufacturingAccount",
  "TradingAccount",
  "PARTA_PL", // profit & loss account
  "PARTA_OI", // other information (44AA/44AB particulars, quantitative details)
  "ScheduleDPM", // depreciation on plant & machinery, block-wise
  "ScheduleDOA", // depreciation on other assets, block-wise
  "ScheduleDEP", // summary of the above two
  "ScheduleDCG", // deemed capital gains on sale of depreciable assets
  "ScheduleESR", // s.35 expenditure on scientific research — a P&L disclosure
  "ScheduleICDS", // ICDS adjustments, already inside the Schedule BP figure
  "CreationInfo", // utility version numbers
  "ScheduleAMTC", // AMT credit brought forward/set off; shown only when AMT bites
  // Assets and liabilities, disclosed once total income exceeds ₹ 50 lakh. It is
  // a statement of what the assessee owns on 31 March, and no figure in it enters
  // the computation of income — jewellery of 40 lakh in the review block would be
  // a false alarm on every large return, which is worse than useless.
  "ScheduleAL",
];

/* Numeric leaves that are identifiers, rates or dates rather than amounts. */
const LEAF_PATTERNS = [
  /\.PinCode$/,
  /\.StateCode$/,
  /\.CountryCode$/,
  /\.CountryCodeMobile$/,
  /\.MobileNo$/,
  /\.AadhaarCardNo$/,
  /\.PartnerOrMemberInfo\[\d+\]\.AadhaarCardNo$/,
  /AudFrmAadhaar$/,
  /AckNum44AB$/, // tax audit acknowledgement number
  /\.SharePercentage$/, // a percentage, surfaced in the partners card as text
  /\.RateOfInterest$/, // ditto
  /\.SchemaVer$/,
  /\.FormVer$/,
  /StatusOrCompanyType$/,
  /SubStatus$/,
  /\.IncomeTaxSec$/, // 11 = s.139(1); shown as a label, not a figure
  /NatureOfBusiness\[\d+\]\.Code$/,
  // Schedule HP identifiers and particulars that are not figures.
  //
  // HPSNo and TenantSNo are row numbers in the property and tenant tables.
  // AssessePercentShareProp is a percentage — it is surfaced in the property's
  // own note when it is anything other than 100%, because a part-owned property
  // is worth seeing, but it is not an amount.
  //
  // The loan's principal and outstanding balance are deliberately here too. A
  // Computation of Total Income deducts the INTEREST under s.24(b); the
  // principal is a balance-sheet particular that the return discloses to
  // substantiate that interest, and printing a 2.9 crore loan alongside a 5.7
  // lakh deduction would read as a figure entering the computation.
  /ScheduleHP\.PropertyDetails\[\d+\]\.HPSNo$/,
  /ScheduleHP\.PropertyDetails\[\d+\]\.TenantDetails\[\d+\]\.TenantSNo$/,
  /ScheduleHP\.PropertyDetails\[\d+\]\.AssessePercentShareProp$/,
  // ITR-2 spells the same field differently. Both are the assessee's percentage
  // share of the property, not an amount.
  /ScheduleHP\.PropertyDetails\[\d+\]\.AsseseeShareProperty$/,
  /Section24BDtls\[\d+\]\.TotalLoanAmt$/,
  /Section24BDtls\[\d+\]\.LoanOutstndngAmt$/,

  // Schedule SI's rate table. Every return carries the full list of special
  // rates whether or not any income is taxed at them, so `SplRatePercent: 1`
  // means "1% is a rate that exists", not "1 rupee of income". The income
  // itself sits in the sibling amount fields, which are NOT ignored.
  /ScheduleSI\.SplCodeRateTax\[\d+\]\.SplRatePercent$/,
];

/** True if this path is knowingly outside the computation. */
export function isIgnored(path) {
  const p = String(path || "");
  for (const t of SUBTREES) if (p === t || p.startsWith(t + ".") || p.startsWith(t + "[")) return true;
  for (const re of LEAF_PATTERNS) if (re.test(p)) return true;
  return false;
}

export const IGNORED_SUBTREES = SUBTREES;
