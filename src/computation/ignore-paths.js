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
