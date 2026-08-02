/*
 * The business head, as ITR-3 states it — Schedule BP (`ITR3ScheduleBP`).
 *
 * This is the head ITR-2 has no schedule for and the reason ITR-3 exists. It is
 * also the head that varies most between assessees, so nothing here is written
 * for one kind of business:
 *
 *   - books of account kept        → net profit per the P&L, then the statutory
 *                                    add-backs and allowances
 *   - presumptive (44AD/ADA/AE…)   → the deemed profit, with the P&L figure for
 *                                    those businesses taken out first
 *   - a partner in a firm          → interest, salary, bonus and commission from
 *                                    the firm, which are business income and are
 *                                    not credited to any P&L; the share of the
 *                                    firm's profit is exempt u/s 10(2A) and comes
 *                                    out again
 *   - speculative business         → kept apart, because its losses are
 *   - specified business u/s 35AD  → kept apart for the same reason
 *
 * A row is emitted for every item the return carries a figure against, in the
 * order Schedule BP works down in. An assessee with none of a given kind simply
 * does not get those rows — that is what makes one working serve every business.
 *
 * §1: this is a restatement, never a recomputation. Each anchor figure below is
 * the return's own subtotal, not a sum we formed.
 */
import { sub, subtotal, total, columnHeader } from "../../model.js";

const BP = "ITR3ScheduleBP.BusinessIncOthThanSpec";

/* Income credited to the P&L that belongs under another head, and so comes out
   of the business working. The keys are the return's own. */
const OTHER_HEAD_CREDITS = [
  ["Salary", "salary"],
  ["HouseProperty", "house property"],
  ["CapitalGains", "capital gains"],
  ["OtherSources", "other sources"],
  ["Us115BBF", "royalty on patents u/s 115BBF"],
  ["Us115BBG", "carbon credits u/s 115BBG"],
  ["115BBH", "virtual digital assets u/s 115BBH"],
];

/* `Dividend` and `OtherThanDividend` are the two PARTS of `OtherSources`, not
   two more credits beside it — the A.Y. 2026-27 return states 3,64,035 against
   `OtherSources` and the same 3,64,035 against `OtherThanDividend`, and only one
   of them is subtracted on the way to the adjusted profit. Listing all three as
   "Less:" lines would have printed a working that does not add up. */
const OTHER_SOURCES_PARTS = [
  ["Dividend", "dividend"],
  ["OtherThanDividend", "sources other than dividend"],
];

/* Presumptive sections. The P&L figure for such a business is taken out and the
   deemed profit put in — the two lists are parallel in the schema. */
const PRESUMPTIVE = [
  ["Us44AD", "Section44AD", "44AD"],
  ["Us44ADA", "Section44ADA", "44ADA"],
  ["Us44AE", "Section44AE", "44AE"],
  ["Us44B", "Section44B", "44B"],
  ["Us44BB", "Section44BB", "44BB"],
  ["Us44BBA", "Section44BBA", "44BBA"],
  ["Us44BBC", "Section44BBC", "44BBC"],
  ["Us44DA", "Section44DA", "44DA"],
];

/* Amounts debited to the P&L that the Act does not allow. */
const DISALLOWANCES = [
  ["AmtDebPLDisallowUs36", "disallowable u/s 36"],
  ["AmtDebPLDisallowUs37", "disallowable u/s 37"],
  ["AmtDebPLDisallowUs40", "disallowable u/s 40"],
  ["AmtDebPLDisallowUs40A", "disallowable u/s 40A"],
  ["AmtDebPLDisallowUs43B", "disallowable u/s 43B — not paid within the due date"],
  ["InterestDisAllowUs23SMEAct", "interest disallowed u/s 43B(h) — payable to a micro or small enterprise"],
  ["OthItemDisallowUs28To44DA", "otherwise disallowable under ss.28 to 44DA"],
];

/* Receipts the Act deems to be business income of the year. */
const DEEMED = [
  ["DeemIncUs41", "u/s 41 — amounts recovered against earlier deductions"],
  ["DeemIncUs3380HHD80IA", "u/s 33 / 80HHD / 80-IA"],
  ["DeemIncUs32AD", "u/s 32AD"],
  ["DeemIncUs33AB", "u/s 33AB"],
  ["DeemIncUs33ABA", "u/s 33ABA"],
  ["DeemIncUs35ABA", "u/s 35ABA"],
  ["DeemIncUs35ABB", "u/s 35ABB"],
  ["DeemIncUs40A3A", "u/s 40A(3A)"],
  ["DeemIncUs72A", "u/s 72A"],
  ["DeemIncUs80HHD", "u/s 80HHD"],
  ["DeemIncUs80IA", "u/s 80-IA"],
  ["DeemIncUs43CA", "u/s 43CA"],
];

/* Income of a partner that no profit & loss account carries. Schedule BP's own
   item text names them: "including income from salary, commission, bonus and
   interest from firms in which individual/HUF/prop. concern is a partner". */
const FROM_FIRMS = [
  ["AnyOthIncNotInclInSalary", "salary from firms in which the assessee is a partner"],
  ["AnyOthIncNotInclInBonus", "bonus from firms in which the assessee is a partner"],
  ["AnyOthIncNotInclInCommission", "commission from firms in which the assessee is a partner"],
  ["AnyOthIncNotInclInInterest", "interest from firms in which the assessee is a partner"],
  ["AnyOthIncNotInclInOthers", "other income not credited to the profit & loss account"],
];

/* Amounts allowable that the P&L does not carry. */
const FURTHER_DEDUCTIONS = [
  ["DeductUs32_1_iii", "u/s 32(1)(iii) — assets discarded or sold"],
  ["DebPLUs35ExcessAmt", "u/s 35 — expenditure on scientific research"],
  ["AmtDisallUs40NowAllow", "disallowed u/s 40 in an earlier year, allowable now"],
  ["AmtDisallUs43BNowAllow", "disallowed u/s 43B in an earlier year, paid and allowable now"],
  ["AnyOthAmtAllDeduct", "any other amount allowable as a deduction"],
];

/* Composite income partly agricultural — Rules 7, 7A, 7B and 8. Only the
   non-agricultural part is chargeable, and the return states both. */
const RULES = [
  ["ChrgblIncUndrRule7", "Rule 7"],
  ["DeemedChrgblIncUndrRule7A", "Rule 7A — rubber"],
  ["DeemedChrgblIncUndrRule7B1", "Rule 7B(1) — coffee grown and cured"],
  ["DeemedChrgblIncUndrRule7B1A", "Rule 7B(1A) — coffee grown, cured, roasted and ground"],
  ["DeemedChrgblIncUndrRule8", "Rule 8 — tea"],
];

export function businessRows(src) {
  const rows = [];
  const n = (path) => src.num(`${BP}.${path}`);
  const line = (label, value, opts) => { if (value) rows.push(sub(label, value, opts)); return value; };

  /* -- the profit & loss account, where there is one -------------------------- */
  const netProfit = n("ProfBfrTaxPL");
  const specPL = n("NetPLFromSpecBus");
  const specifiedPL = n("NetPLFromSpecifiedBus");
  const hasPL = netProfit !== 0 || specPL !== 0 || specifiedPL !== 0;
  if (hasPL) {
    rows.push(sub("Net profit before tax as per the profit & loss account", netProfit, { ref: "Sch. BP" }));
    line("Less: Net profit from speculative business, carried to its own working", specPL);
    line("Less: Net profit from specified business u/s 35AD, carried to its own working", specifiedPL);
  }
  n("PLUs44sChapXIIG");

  for (const [key, what] of OTHER_HEAD_CREDITS) {
    const amt = n(`IncRecCredPLOthHeadDtls.${key}`);
    // The parts of "other sources", where the return breaks it down and the
    // breakdown says something the parent line does not.
    const parts = key !== "OtherSources" ? []
      : OTHER_SOURCES_PARTS.map(([k, w]) => [w, n(`IncRecCredPLOthHeadDtls.${k}`)]).filter(([, v]) => v);
    line(`Less: Income credited to the profit & loss account, assessable under ${what}`, amt, {
      note: parts.length === 1 && parts[0][1] === amt ? `Being income from ${parts[0][0]}` : undefined,
    });
    if (parts.length > 1) for (const [w, v] of parts) rows.push(sub(`— ${w}`, v));
  }
  for (const [suffix, , sec] of PRESUMPTIVE) {
    line(`Less: Profit of the business covered u/s ${sec}, as per the profit & loss account`, n(`ProfitLossInclRefrdSec.ProfitLoss${suffix}`));
  }
  n("TotalProfitFrmActCvrd");
  for (const [key, what] of [
    ["ProfitFrmActCvrdUndrRule7", "Rule 7"],
    ["ProfitFrmActCvrdUndrRule7A", "Rule 7A"],
    ["ProfitFrmActCvrdUndrRule7B1", "Rule 7B(1)"],
    ["ProfitFrmActCvrdUndrRule7B1A", "Rule 7B(1A)"],
    ["ProfitFrmActCvrdUndrRule8", "Rule 8"],
  ]) {
    line(`Less: Profit of the activity covered by ${what}, as per the profit & loss account`, n(`ProfitFrmActCvrd.${key}`));
  }

  // Exempt income credited to the P&L. A partner's share of the firm's profit is
  // the common one: it is exempt u/s 10(2A) and must come out of the working.
  line("Less: Share of profit from firms, exempt u/s 10(2A)", n("IncCredPL.FirmShareInc"));
  line("Less: Share of income from an AOP or BOI", n("IncCredPL.AOPBOISharInc"));
  line("Less: Dividend credited to the profit & loss account", n("IncCredPL.OtherExmptIncDtl.OperatingDividendAmt"));

  /* The exempt items the return names, one row each.
   *
   * `OtherExmptIncDtls` (note the plural — the singular spelling above is a
   * different field) is an ARRAY of { OperatingRevenueName, OperatingRevenueAmt }.
   * The A.Y. 2023-24 return states "Agriculture Income" 2,12,200 there, and
   * reading only the `OthExempInc` total printed the right figure under a
   * caption that said nothing about what it was — while the array element itself
   * surfaced in the review block. Where the items account for the whole total
   * they replace the summary line; where they do not, the balance follows them. */
  const exemptItems = (src.peek(`${BP}.IncCredPL.OtherExmptIncDtls`) || [])
    .map((_, i) => {
      const at = `${BP}.IncCredPL.OtherExmptIncDtls[${i}]`;
      return { name: String(src.peek(`${at}.OperatingRevenueName`) || "").trim(), amt: src.num(`${at}.OperatingRevenueAmt`) };
    })
    .filter((e) => e.amt);
  for (const e of exemptItems) {
    line(`Less: ${e.name || "Exempt income"} credited to the profit & loss account`, e.amt);
  }
  const otherExempt = n("IncCredPL.OthExempInc");
  const itemised = exemptItems.reduce((s, e) => s + e.amt, 0);
  line("Less: Other exempt income credited to the profit & loss account", otherExempt - itemised);
  src.restate([`${BP}.IncCredPL.TotExempIncPL`, `${BP}.BalancePLOthThanSpecBus`]);

  for (const [key, what] of OTHER_HEAD_CREDITS) {
    line(`Add: Expenditure debited to the profit & loss account, relating to ${what}`, n(`ExpDebToPLOthHeadDtls.${key}`));
  }
  line("Add: Expenditure relating to exempt income, debited to the profit & loss account", n("ExpDebToPLExemptInc"));
  line("Add: Expenditure disallowable u/s 14A", n("ExpDebToPLExemptIncDisAllwUs14A"));
  src.restate([`${BP}.TotExpDebPL`, `${BP}.AdjustedPLOthThanSpecBus`]);

  /* -- depreciation ----------------------------------------------------------- */
  const deprBooks = n("DepreciationDebPLCosAct");
  const deprAct = n("DepreciationAllowITAct32.TotDeprAllowITAct");
  if (deprBooks) rows.push(sub("Add: Depreciation debited to the profit & loss account", deprBooks));
  if (deprAct) {
    rows.push(sub("Less: Depreciation allowable u/s 32", deprAct, {
      ref: "Sec. 32",
      note: "Block-wise workings are in Schedules DPM, DOA and DEP of the return",
    }));
  }
  src.restate([
    `${BP}.DepreciationAllowITAct32.DepreciationAllowUs32_1_i`,
    `${BP}.DepreciationAllowITAct32.DepreciationAllowUs32_1_ii`,
    `${BP}.AdjustPLAfterDeprOthSpecInc`,
  ]);

  /* -- add-backs -------------------------------------------------------------- */
  for (const [key, what] of DISALLOWANCES) {
    line(`Add: Amounts debited to the profit & loss account, ${what}`, n(key));
  }
  for (const [key, what] of DEEMED) {
    line(`Add: Deemed income ${what}`, n(key));
  }
  line("Add: Adjustment on account of ICDS", n("IncProfDecLossAccICDSAdj"));

  /* -- income no profit & loss account carries -------------------------------- */
  const fromFirms = FROM_FIRMS.map(([key, what]) => [what, n(key)]).filter(([, v]) => v);
  const anyOther = n("AnyOthIncNotInclInExpDisallowPL");
  // "Add:" only makes sense once there is something to add to. A partner with no
  // business of their own has no profit & loss account at all, and their working
  // starts here — with a statement, not an adjustment.
  const add = (label) => (rows.length ? `Add: ${label}` : label[0].toUpperCase() + label.slice(1));
  if (fromFirms.length) {
    // The schedule reference belongs on whichever row opens the working, which
    // for a partner with no books of their own is this one.
    const opensTheWorking = rows.length === 0;
    fromFirms.forEach(([what, v], i) => {
      rows.push(sub(add(`income not credited to the profit & loss account — ${what}`), v, {
        ref: opensTheWorking && i === 0 ? "Sch. BP" : undefined,
      }));
    });
    // The itemised lines above add up to this; state the balance only when the
    // return carries more than what we have already named.
    const named = fromFirms.reduce((s, [, v]) => s + v, 0);
    if (anyOther !== named) rows.push(sub(add("other income not credited to the profit & loss account"), anyOther - named));
  } else if (anyOther) {
    rows.push(sub(add("income not credited to the profit & loss account"), anyOther));
  }
  // Only where the return states one. A.Y. 2026-27's ITR-3 leaves this field nil
  // on a return whose adjusted profit is 16,65,434, and a subtotal reading "nil"
  // between the depreciation lines and that total is not a nil profit — it is a
  // field the utility did not fill, and printing it says something untrue.
  const afterAdditions = n("TotAfterAddToPLDeprOthSpecInc");
  if (rows.length > 1 && afterAdditions) rows.push(subtotal("Profit after the additions above", afterAdditions));

  /* -- further deductions ----------------------------------------------------- */
  let anyDeduction = false;
  for (const [key, what] of FURTHER_DEDUCTIONS) {
    if (n(key)) anyDeduction = true;
    line(`Less: Amount allowable as a deduction — ${what}`, n(key));
  }
  line("Less: Adjustment on account of ICDS", n("DecProfIncLossAccICDSAdj"));
  const totalDeductions = n("TotDeductionAmts");
  const afterDeductions = n("PLAftAdjDedBusOthThanSpec");
  if (anyDeduction || totalDeductions) rows.push(subtotal("Profit after the deductions above", afterDeductions));

  /* -- presumptive businesses ------------------------------------------------- */
  const presumptive = PRESUMPTIVE
    .map(([, key, sec]) => [sec, n(`DeemedProfitBusUs.${key}`)])
    .filter(([, v]) => v);
  for (const [sec, v] of presumptive) {
    rows.push(sub(`Add: Profit deemed u/s ${sec}`, v, {
      ref: `Sec. ${sec}`,
      note: sec === "44AD" || sec === "44ADA" || sec === "44AE" ? "Presumptive basis — no deduction for expenses is claimed against it" : undefined,
    }));
  }
  n("DeemedProfitBusUs.TotDeemedProfitBusUs");
  src.restate([`${BP}.NetPLAftAdjBusOthThanSpec`, `${BP}.NetPLBusOthThanSpec7A7B7C`]);

  /* -- composite agricultural income ------------------------------------------ */
  for (const [key, what] of RULES) {
    line(`Chargeable income under ${what} — the non-agricultural part`, n(key));
  }
  const agriPart = n("BalIncDeemedFrmAgri");
  if (agriPart) {
    rows.push(sub("Less: Income deemed to be agricultural, and therefore exempt", agriPart, {
      note: "Reported in Schedule EI and aggregated only for rate purposes",
    }));
  }
  n("IncomeOtherThanRule");

  const nonSpeculative = src.num("ITR3ScheduleBP.IncChrgUnHdProftGain");

  /* -- speculative and specified business ------------------------------------- */
  const specAdjusted = src.num("ITR3ScheduleBP.SpecBusinessInc.AdjustedPLFrmSpecuBus");
  const specifiedAdjusted = src.num("ITR3ScheduleBP.SpecifiedBusinessInc.PLFrmSpecifiedBus");
  if (specAdjusted) {
    rows.push(columnHeader("Speculative business", { ref: "Sch. BP" }));
    rows.push(sub("Net profit or loss from speculative business", src.num("ITR3ScheduleBP.SpecBusinessInc.NetPLFrmSpecBus")));
    line("Add: Additions under ss.28 to 44DA", src.num("ITR3ScheduleBP.SpecBusinessInc.AdditionUs28to44DA"));
    line("Less: Deductions under ss.28 to 44DA", src.num("ITR3ScheduleBP.SpecBusinessInc.DeductUs28to44DA"));
    rows.push(subtotal(specAdjusted < 0 ? "Loss from speculative business" : "Income from speculative business", Math.abs(specAdjusted), {
      isLoss: specAdjusted < 0,
      note: "Set off only against speculative profit — s.73",
    }));
  }
  if (specifiedAdjusted) {
    rows.push(columnHeader("Specified business u/s 35AD", { ref: "Sch. BP" }));
    rows.push(sub("Profit or loss from specified business", src.num("ITR3ScheduleBP.SpecifiedBusinessInc.ProfitLossSpecifiedBusiness")));
    line("Less: Deduction u/s 35AD", src.num("ITR3ScheduleBP.SpecifiedBusinessInc.DeductionUs35AD"), { ref: "Sec. 35AD" });
    rows.push(subtotal(specifiedAdjusted < 0 ? "Loss from specified business" : "Income from specified business", Math.abs(specifiedAdjusted), {
      isLoss: specifiedAdjusted < 0,
      note: "Set off only against another specified business — s.73A",
    }));
  }
  src.claim("ITR3ScheduleBP.SpecBusinessInc");
  src.claim("ITR3ScheduleBP.SpecifiedBusinessInc");
  src.claim("ITR3ScheduleBP.BusSetoffCurrYr");

  // The return's own item 43 — "income chargeable under the head", which already
  // includes the speculative and specified workings above it. Taking it from the
  // return rather than adding the three ourselves keeps this a restatement (§1),
  // and leaves validate() a genuine cross-check against Part B-TI's own figure.
  const headTotal = nonSpeculative;
  if (rows.length) {
    rows.push(total(
      headTotal < 0 ? "Loss under the head Profits and Gains of Business or Profession" : "Income chargeable under the head Profits and Gains of Business or Profession",
      Math.abs(headTotal),
      { isLoss: headTotal < 0 }
    ));
  }
  return rows;
}
