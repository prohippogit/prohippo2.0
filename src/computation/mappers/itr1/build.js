/*
 * ITR-1 (Sahaj) → ComputationDocument. Shared by every assessment year we support.
 *
 * Each year has its own module (./ay2025-26.js, ./ay2026-27.js), its own
 * registration and its own golden test — §9's rule is that no year runs against
 * code nobody checked it against, not that identical code must be typed twice.
 * Where a year diverges, its module is where that goes, and every OTHER year's
 * golden is what proves the change did not reach it.
 *
 * Read docs/computation-spec.md before changing anything here. §4 fixes the
 * section order, §5 the labels, §6 the treatment of nil and losses, §10 the
 * schema traps this mapper is written around.
 *
 * ITR-1 is the shortest return there is, and its shape is the reason it needs a
 * builder of its own rather than a call into ../individual/heads.js:
 *
 *   It has NO SCHEDULES. Salary, house property, other sources and Chapter VI-A
 *   are one flat block, `ITR1_IncomeDeductions`. Where ITR-2 itemises gross
 *   salary by component code, ITR-1 states three figures — s.17(1), s.17(2),
 *   s.17(3) — and nothing beneath them.
 *
 *   It has NO PART B-TI AND NO PART B-TTI. Total income is the closing line of
 *   the same income block; the tax is `ITR1_TaxComputation`; the taxes paid and
 *   the refund sit at the top level. validate() therefore resolves the figures it
 *   asserts against through a per-form table of paths (§7).
 *
 *   It carries no set-off. A house property loss — capped at 2,00,000 on this
 *   form — is already inside `GrossTotIncome` as a negative head, so there is no
 *   Schedule CYLA line to print and no total of heads distinct from gross total
 *   income.
 *
 * What it DOES share with ITR-2 and ITR-3 is the wording: the captions come from
 * ../individual/labels.js so that the same statutory line does not read two ways
 * across the forms one practitioner files for one client (§2).
 *
 * The rule that governs every line: this is a presentation layer. Every figure
 * printed is a figure the return states.
 */
import { head, sub, subtotal, total, columnHeader, section, document } from "../../model.js";
import { reader, findUnmapped } from "../../unmapped.js";
import { pyLabel, longDate } from "../../format.js";
import {
  regimeLabel, viaLabel, viaOrder, viaRef, personName, joinAddress,
  filingSection, isNonOrdinaryFiling, exemptAllowanceLabel,
  tdsSection, tdsNature, headOfIncome,
} from "../individual/labels.js";

const inr = (v) => Number(v || 0).toLocaleString("en-IN");

const headRow = (label, ref, amount) =>
  head(label, amount, { ref, isLoss: amount < 0 ? true : undefined, amount: amount < 0 ? -amount : amount });

/* The block that is the whole computation of income on this form. Every path
   below hangs off it, so it is named once. */
const INC = "ITR1_IncomeDeductions";
const TAXC = "ITR1_TaxComputation";

/* Capacity codes. NOT ../individual/labels.js's table: §10 requires a form's
   code list to be read from that form's own schema, and no ITR-1 schema has been
   read here. `S` is the code every return we hold carries and the only one this
   table therefore claims; anything else prints as itself (§5), which is a code a
   reader can look up rather than a meaning we invented for it. */
const CAPACITY = { S: "Self" };
const capacityName = (code) => {
  const c = String(code || "").trim().toUpperCase();
  return CAPACITY[c] || c;
};

/* ------------------------------------------------------------------ salary --
 *
 * Statutory shape, as on any return: salary u/s 17(1), the value of perquisites
 * u/s 17(2) and profits in lieu u/s 17(3) make gross salary; the allowances
 * exempt u/s 10 come off it; then the deductions s.16 allows.
 *
 * ITR-1 states the three limbs of gross salary and no breakdown beneath them, so
 * there is nothing here answering to Schedule S's component codes.
 */
function salaryRows(src) {
  /* Every field is read BEFORE anything is decided, so that a return with a
     figure this working would not print still has it consumed or surfaced
     deliberately rather than by accident of control flow (§8). */
  const salary17_1 = src.num(`${INC}.Salary`);
  const perquisites = src.num(`${INC}.PerquisitesValue`);
  const inLieu = src.num(`${INC}.ProfitsInSalary`);
  const gross = src.num(`${INC}.GrossSalary`);
  /* Income of a retirement benefit account maintained in a notified country,
     which s.89A defers to the year it is taxed there. The return states the
     total, the per-country split, and the relief taken back out below. */
  const notified89A = src.num(`${INC}.IncomeNotified89A`);
  const notifiedOther = src.num(`${INC}.IncomeNotifiedOther89A`);
  const countries = (src.peek(`${INC}.IncomeNotified89AType`) || [])
    .map((c, i) => [c.NOT89ACountrycode, src.num(`${INC}.IncomeNotified89AType[${i}].NOT89AAmount`)])
    .filter(([, v]) => v);
  const exempt = src.claim(`${INC}.AllwncExemptUs10.AllwncExemptUs10Dtls`) || [];
  const totalExempt = src.num(`${INC}.AllwncExemptUs10.TotalAllwncExemptUs10`);
  const relief89A = src.num(`${INC}.Increliefus89A`);
  const net = src.num(`${INC}.NetSalary`);
  const stdDeduction = src.num(`${INC}.DeductionUs16ia`);
  const entertainment = src.num(`${INC}.EntertainmentAlw16ii`);
  const profTax = src.num(`${INC}.ProfessionalTaxUs16iii`);
  src.num(`${INC}.DeductionUs16`); // the total of the three above
  const salaryIncome = src.num(`${INC}.IncomeFromSal`);

  const rows = [];
  if (!gross && !salary17_1 && !salaryIncome) return rows;

  rows.push(sub("Salary as per section 17(1)", salary17_1, { ref: "Part B" }));
  if (perquisites) rows.push(sub("Add: Value of perquisites u/s 17(2)", perquisites));
  if (inLieu) rows.push(sub("Add: Profits in lieu of salary u/s 17(3)", inLieu));
  if (notified89A) {
    rows.push(sub("Add: Income from a retirement benefit account in a notified country u/s 89A", notified89A, {
      ref: "Sec. 89A",
      note: countries.length ? countries.map(([c, v]) => `${c} ${inr(v)}`).join(" · ") : undefined,
    }));
  }
  if (notifiedOther) {
    rows.push(sub("Add: Income from a retirement benefit account in a country not notified u/s 89A", notifiedOther));
  }

  if (perquisites || inLieu || notified89A || notifiedOther) rows.push(subtotal("Gross Salary", gross));

  // Allowances exempt u/s 10, itemised by the code the return gives. For most of
  // these the code IS the section — "10(13A)" — so it is printed as given; the
  // two that are not are named in ../individual/labels.js.
  for (const e of exempt) {
    const amt = Number(e.SalOthAmount || 0);
    if (!amt) continue;
    const code = String(e.SalNatureDesc || "").trim();
    const named = exemptAllowanceLabel(code);
    rows.push(sub(named ? `Less: ${named}` : `Less: Allowance exempt u/s ${code}`, amt, {
      note: named ? e.SalOthNatOfInc || undefined : undefined,
    }));
  }
  if (relief89A) rows.push(sub("Less: Relief in respect of income u/s 89A charged in an earlier year", relief89A));
  if (totalExempt || relief89A) rows.push(subtotal("Net Salary", net));

  if (stdDeduction) rows.push(sub("Less: Standard deduction u/s 16(ia)", stdDeduction, { ref: "Sec. 16(ia)" }));
  if (entertainment) rows.push(sub("Less: Entertainment allowance u/s 16(ii)", entertainment, { ref: "Sec. 16(ii)" }));
  if (profTax) rows.push(sub("Less: Tax on employment u/s 16(iii)", profTax, { ref: "Sec. 16(iii)" }));

  rows.push(total("Income chargeable under the head Salaries", salaryIncome));
  return rows;
}

/* ---------------------------------------------------------- house property --
 *
 * One property, stated as figures rather than as a schedule. The statutory order
 * is fixed and the two s.24 deductions stay separate lines (§10).
 *
 * The trap is `StandardDeduction`, which here is the 30% allowed by s.24(a) and
 * NOT the s.16(ia) standard deduction it sits three fields away from.
 *
 * The head closes at a loss in a great many real returns, because the interest
 * allowed under s.24(b) exceeds the annual value. On this form the loss set off
 * is capped at 2,00,000 and the return has already applied that cap, so the
 * figure printed is the return's own.
 */
function housePropertyRows(src, hpTotal) {
  const rows = [];
  const rent = src.num(`${INC}.GrossRentReceived`);
  const localTaxes = src.num(`${INC}.TaxPaidlocalAuth`);
  const annualValue = src.num(`${INC}.AnnualValue`);
  const thirty = src.num(`${INC}.StandardDeduction`);
  const interest = src.num(`${INC}.InterestPayable`);
  const arrears = src.num(`${INC}.ArrearsUnrealizedRentRcvd`);
  if (!rent && !annualValue && !thirty && !interest && !arrears) return rows;

  /* How the property was used. The name is the utility's own caption for the
     question it asks (self-occupied / let out / deemed let out), and no return we
     hold carries a house property, so this is the one field here that could not be
     checked against one. Nothing in the working depends on it: it is a string,
     read for a note, and if a real return spells it otherwise the note is simply
     omitted rather than a figure going wrong (§5). */
  const type = String(src.val(`${INC}.TypeOfHP`) || "").trim().toUpperCase();
  const use = { S: "self-occupied", L: "let out", D: "deemed let out" }[type] || "";

  if (rent || localTaxes) {
    rows.push(sub("Gross rent received, receivable or letable value", rent, {
      ref: "Part B",
      note: use || undefined,
    }));
    if (localTaxes) rows.push(sub("Less: Municipal taxes paid to the local authority", localTaxes));
    rows.push(subtotal("Annual value", annualValue));
  } else {
    // No rent stated. Where there is no annual value either, the property is one
    // the law charges nothing on and the working is the interest alone — saying
    // that beats an "Annual value — nil" row that invites a reader to look for
    // rent. Where the return DOES state an annual value, it is stated and nothing
    // is claimed about why no rent appears beside it.
    rows.push(sub("Annual value of the property", annualValue, {
      ref: "Part B",
      note: [use, annualValue ? "" : "no annual value is charged"].filter(Boolean).join(" · ") || undefined,
    }));
  }
  if (thirty) rows.push(sub("Less: Standard deduction u/s 24(a) @ 30% of the annual value", thirty, { ref: "Sec. 24(a)" }));
  if (interest) rows.push(sub("Less: Interest payable on borrowed capital u/s 24(b)", interest, { ref: "Sec. 24(b)" }));
  if (arrears) rows.push(sub("Add: Arrears or unrealised rent received, less 30% u/s 25A", arrears, { ref: "Sec. 25A" }));

  rows.push(total(
    hpTotal < 0 ? "Loss from House Property" : "Income from House Property",
    Math.abs(hpTotal), { isLoss: hpTotal < 0 || undefined }
  ));
  return rows;
}

/* ----------------------------------------------------------- other sources --
 *
 * `OthersIncDtlsOthSrc[]` itemises the head: a code, the utility's own words for
 * it, and an amount. `SAV` is verified from the return itself — the A.Y. 2024-25
 * return states "Interest from Saving Account" against it. Every other code is
 * captioned from the return's own words where it gives them and prints as itself
 * where it does not (§5). Nothing here is decoded from what a code looks like it
 * might mean.
 */
const OS_NATURE = { SAV: "Interest from a savings bank account" };

function otherSourcesRows(src, osTotal) {
  const rows = [];
  const items = src.claim(`${INC}.OthersInc.OthersIncDtlsOthSrc`) || [];
  for (const o of items) {
    const amt = Number(o.OthSrcOthAmount || 0);
    if (!amt) continue;
    const code = String(o.OthSrcNatureDesc || "").trim();
    const label = OS_NATURE[code.toUpperCase()] || o.OthSrcOthNatOfInc
      || (code ? `Income from other sources (code ${code})` : "Income from other sources");
    rows.push(sub(label, amt, { ref: rows.length ? "" : "Part B" }));
  }

  const familyPension = src.num(`${INC}.DeductionUs57iia`);
  const relief89A = src.num(`${INC}.Increliefus89AOS`);

  // The itemised rows are stated gross; `IncomeOthSrc` is net of the s.57(iia)
  // deduction, so the deduction is printed and the total taken from the field
  // rather than added up here (§1).
  if (familyPension) {
    rows.push(sub("Less: Deduction u/s 57(iia) — one-third of family pension, up to 15,000", familyPension, { ref: "Sec. 57(iia)" }));
  }
  if (relief89A) rows.push(sub("Less: Relief in respect of income u/s 89A charged in an earlier year", relief89A));

  // Nothing to show a working for. A return that states the head as one figure
  // and itemises nothing is stated by the head row in the TI section; a section
  // whose only row is its own total would repeat that and explain nothing.
  if (!rows.length) return rows;

  rows.push(total(
    osTotal < 0 ? "Loss under the head Other Sources" : "Income chargeable under the head Other Sources",
    Math.abs(osTotal), { isLoss: osTotal < 0 || undefined }
  ));
  return rows;
}

/* --------------------------------------------------------- Chapter VI-A ----
 *
 * §10: the return carries what was CLAIMED and what is ALLOWED after the
 * statutory caps, in two parallel blocks — the same pair the individual forms
 * carry in Schedule VI-A, one level shallower. The computation states the allowed
 * figure, because that is what enters the total, and notes the claim wherever the
 * two differ — a s.80TTA claim cut down to the 10,000 the section allows is
 * exactly what a reader wants to see, and printing only one of the two hides it.
 *
 * Two of this block's keys are spelled differently here than on the other
 * individual forms: `Section80CCDEmployeeOrSE` and `AnyOthSec80CCH`. Both are
 * captioned in ../individual/labels.js so that neither prints as a field name.
 */
function chapterVIA(src) {
  const claimed = src.claim(`${INC}.UsrDeductUndChapVIA`) || {};
  const allowed = src.claim(`${INC}.DeductUndChapVIA`) || {};
  const rows = [];
  // Anything named Tot… is a subtotal of the block, not a deduction in it.
  const keys = Object.keys(allowed)
    .filter((k) => !/^Tot/.test(k) && Number(allowed[k]) > 0)
    .sort((a, b) => viaOrder(a) - viaOrder(b));
  for (const k of keys) {
    const amt = Number(allowed[k]);
    const askedFor = Number(claimed[k] || 0);
    rows.push(sub(viaLabel(k), amt, {
      ref: viaRef(k),
      note: askedFor > amt ? `Claimed ${inr(askedFor)}; restricted to the statutory limit` : undefined,
    }));
  }
  const allowedTotal = src.num(`${INC}.DeductUndChapVIA.TotalChapVIADeductions`);
  if (rows.length) rows.push(total("Total deductions under Chapter VI-A", allowedTotal));
  // Schedule 80D itemises the health-insurance premium the block above totals.
  src.claim("Schedule80D");
  return { rows, allowedTotal, claimedTotal: Number(claimed.TotalChapVIADeductions || 0) };
}

/* --------------------------------------------------------- tax liability ---
 *
 * `ITR1_TaxComputation`, restated in the order Part D of the form states it.
 * Every row is a figure the return carries; a nil row is printed as nil rather
 * than dropped, because a reader checking a computation looks for the line before
 * they look for the figure.
 *
 * There is no surcharge here and no field for one: an assessee whose total income
 * could attract it cannot file this form.
 */
function taxRows(src) {
  const rows = [];
  const onTotal = src.num(`${TAXC}.TotalTaxPayable`);
  const rebate87A = src.num(`${TAXC}.Rebate87A`);
  const afterRebate = src.num(`${TAXC}.TaxPayableOnRebate`);
  const cess = src.num(`${TAXC}.EducationCess`);
  const grossTax = src.num(`${TAXC}.GrossTaxLiability`);
  const relief89 = src.num(`${TAXC}.Section89`);
  const afterRelief = src.num(`${TAXC}.NetTaxLiability`);
  const interest = src.num(`${TAXC}.TotalIntrstPay`);
  const aggregate = src.num(`${TAXC}.TotTaxPlusIntrstPay`);

  rows.push(sub("Tax on Total Income at the rates in force", onTotal, { ref: "Para A, Sch. I" }));
  rows.push(sub("Less: Rebate u/s 87A", rebate87A, { ref: "Sec. 87A" }));
  if (rebate87A) rows.push(sub("Tax after rebate", afterRebate));
  rows.push(sub("Add: Health & Education Cess @ 4%", cess));
  rows.push(subtotal("Gross Tax Liability", grossTax));
  rows.push(sub("Less: Relief u/s 89", relief89, { ref: "Sec. 89" }));
  // Only where the relief bites. With nil relief this figure IS the gross tax
  // above it, and the same amount on two consecutive rows reads as an error.
  if (relief89) rows.push(sub("Tax payable after relief u/s 89", afterRelief));
  rows.push(sub("Add: Interest u/s 234A / 234B / 234C and fee u/s 234F", interest, { note: interestNote(src) }));
  rows.push(total("Total Tax and Interest Payable", aggregate));
  return { rows, aggregate };
}

/** "s.234B 5,049 · fee u/s 234F 1,000" — which interest, not just how much. */
function interestNote(src) {
  const at = `${TAXC}.IntrstPay`;
  const parts = [
    ["234A", src.num(`${at}.IntrstPayUs234A`)],
    ["234B", src.num(`${at}.IntrstPayUs234B`)],
    ["234C", src.num(`${at}.IntrstPayUs234C`)],
  ].filter(([, v]) => v).map(([s, v]) => `s.${s} ${inr(v)}`);
  const fee = src.num(`${at}.LateFilingFee234F`);
  if (fee) parts.push(`fee u/s 234F ${inr(fee)}`);
  // New in the A.Y. 2026-27 schema, alongside the s.234 interest.
  const furnish = src.num(`${at}.FeeFurnish234I`);
  if (furnish) parts.push(`fee u/s 234I ${inr(furnish)}`);
  return parts.length ? parts.join(" · ") : undefined;
}

/* ----------------------------------------------------------- taxes paid ----
 *
 * ITR-1 renames the credit blocks and keeps the rows inside them: the totals it
 * states — `TotalTDSonSalaries`, `TotalTDSonOthThanSals`, `TotalSchTCS`,
 * `TotalTaxPayments` — are four of ITR-2's own key names, which is the evidence
 * that what sits under them is ITD's shared row definition rather than a new one
 * (§10).
 *
 * So each block's ARRAY is discovered rather than named, and every field inside a
 * row is then read by name. A return that names them differently prints no credit
 * rows and surfaces every figure in them under §8 — loud, and never a wrong
 * figure against a right-looking caption.
 *
 * No return we hold has a rupee deducted at source, so there is no FIXTURE for
 * any of this; the rule is held instead by a mutation test in
 * test/computation/itr1.test.mjs, which builds the ITR-2 row shapes under these
 * wrappers and asserts both the rows and an empty review block. Add a fixture
 * when a return with credits arrives (§11).
 */
function blockRows(src, block) {
  const node = src.peek(block);
  if (!node || typeof node !== "object") return { path: "", list: [] };
  const key = Object.keys(node).find((k) => Array.isArray(node[k]) && node[k].length);
  return key ? { path: `${block}.${key}`, list: node[key] } : { path: "", list: [] };
}

/* One credit, stated six ways.
 *
 * `TaxDeductCreditDtls` splits the same deduction by whose hands it is claimed in
 * and against which head. The computation prints the figure claimed in the
 * assessee's own hands; the other five are that figure again, so they are restated
 * rather than left to fill the review block on every return that has any TDS at
 * all (§8).
 *
 * `BroughtFwdTDSAmt` and `AmtCarriedFwd` are deliberately NOT restated. A credit
 * carried to another year is not this year's credit stated differently — it is a
 * fact about the return, and a practitioner should see it. */
const restateCreditSiblings = (src, at) => src.restate([
  `${at}.TaxDeductCreditDtls.TaxDeductedOwnHands`,
  `${at}.TaxDeductCreditDtls.TaxDeductedIncome`,
  `${at}.TaxDeductCreditDtls.TaxDeductedTDS`,
  `${at}.TaxDeductCreditDtls.TaxClaimedIncome`,
  `${at}.TaxDeductCreditDtls.TaxClaimedTDS`,
]);

function taxesPaidRows(src, { aggregate }) {
  const rows = [];

  /* Tax deducted from salary, by employer. */
  const salary = blockRows(src, "TDSonSalaries");
  const salaryCredits = salary.list.map((t, i) => {
    const at = `${salary.path}[${i}]`;
    const d = t.EmployerOrDeductorOrCollectDetl || {};
    return {
      tan: src.val(`${at}.EmployerOrDeductorOrCollectDetl.TAN`) || "",
      name: d.EmployerOrDeductorOrCollecterName || "",
      gross: src.num(`${at}.IncChrgSal`),
      credit: src.num(`${at}.TotalTDSSal`),
    };
  }).filter((t) => t.gross || t.credit);
  if (salaryCredits.length) {
    rows.push(columnHeader("Tax Deducted at Source — TAN of Deductor", { ref: "Gross Receipt" }));
    for (const t of salaryCredits) {
      rows.push(sub(t.tan, t.credit, {
        note: [t.name, "Salary · Sec. 192"].filter(Boolean).join(" · "),
        cols: { ref: t.gross ? inr(t.gross) : "" },
      }));
    }
  }

  /* Tax deducted from everything else. §12: rows against the same TAN stay
     separate unless they also share a section, in which case one row carries the
     count — a bank that paid interest quarterly is otherwise four near-identical
     lines, and merging across sections would hide which receipt a credit belongs
     to, which is exactly what a CPC mismatch query asks about. */
  const other = blockRows(src, "TDSonOthThanSals");
  const byTanSection = new Map();
  other.list.forEach((t, i) => {
    const at = `${other.path}[${i}]`;
    const sec = tdsSection(t.TDSSection);
    const key = `${t.TANOfDeductor}|${sec}`;
    const prev = byTanSection.get(key) || { tan: t.TANOfDeductor || "", section: sec, gross: 0, credit: 0, count: 0 };
    prev.gross += src.num(`${at}.GrossAmount`);
    prev.credit += src.num(`${at}.TaxDeductCreditDtls.TaxClaimedOwnHands`);
    prev.count += 1;
    restateCreditSiblings(src, at);
    byTanSection.set(key, prev);
  });
  // A row with neither a receipt nor a credit says nothing and is dropped. One
  // with a receipt and no deduction stays: that is what a s.143(1) mismatch
  // turns on.
  const otherCredits = [...byTanSection.values()]
    .filter((g) => g.gross || g.credit)
    .sort((a, b) => b.credit - a.credit || b.gross - a.gross);
  if (otherCredits.length && !salaryCredits.length) {
    rows.push(columnHeader("Tax Deducted at Source — TAN of Deductor", { ref: "Gross Receipt" }));
  }
  for (const g of otherCredits) {
    rows.push(sub(g.tan, g.credit, {
      // Some years' returns carry no section code at all, and "Sec." with
      // nothing after it is worse than saying nothing.
      note: [tdsNature(g.section), g.section ? `Sec. ${g.section}` : "", g.count > 1 ? `${g.count} entries` : ""].filter(Boolean).join(" · "),
      cols: { ref: g.gross ? inr(g.gross) : "" },
    }));
  }

  /* Tax deducted by someone with no TAN — a buyer of immovable property under
     s.194-IA, an individual tenant under s.194-IB, or a payer under s.194M. They
     deduct against their own PAN, so these credits appear in neither block above. */
  const tds3 = blockRows(src, "ScheduleTDS3Dtls");
  const tds3Credits = tds3.list.map((t, i) => {
    const at = `${tds3.path}[${i}]`;
    restateCreditSiblings(src, at);
    return {
      pan: t.PANOfBuyerTenant || t.PANofTenant || t.PANOfOtherPerson || "",
      head: headOfIncome(t.HeadOfIncome),
      gross: src.num(`${at}.GrossAmount`),
      credit: src.num(`${at}.TaxDeductCreditDtls.TaxClaimedOwnHands`),
    };
  }).filter((g) => g.gross || g.credit).sort((a, b) => b.credit - a.credit || b.gross - a.gross);
  if (tds3Credits.length) {
    rows.push(columnHeader("Tax Deducted at Source — PAN of Buyer or Tenant", { ref: "Gross Receipt" }));
    for (const g of tds3Credits) {
      rows.push(sub(g.pan, g.credit, {
        note: ["Deducted by a person not required to hold a TAN", g.head].filter(Boolean).join(" · "),
        cols: { ref: g.gross ? inr(g.gross) : "" },
      }));
    }
  }

  const tds = src.num("TaxPaid.TaxesPaid.TDS");
  const tcs = src.num("TaxPaid.TaxesPaid.TCS");
  const advance = src.num("TaxPaid.TaxesPaid.AdvanceTax");
  const selfAssessment = src.num("TaxPaid.TaxesPaid.SelfAssessmentTax");
  const totalPaid = src.num("TaxPaid.TaxesPaid.TotalTaxesPaid");
  src.num("TDSonSalaries.TotalTDSonSalaries");
  src.num("TDSonOthThanSals.TotalTDSonOthThanSals");
  src.num("ScheduleTDS3Dtls.TotalTDS3Details");

  rows.push(subtotal("Total Tax Deducted at Source", tds, { ref: "Sch. TDS" }));

  /* Advance tax and self-assessment tax are one challan each, and listing them
     lets a reader tie the figure to a receipt without opening the return. In date
     order: the return lists them as they were keyed, which puts a March
     instalment above a June one. */
  const payments = blockRows(src, "TaxPayments");
  const challans = payments.list
    .map((c, i) => ({
      bsr: c.BSRCode || "",
      serial: c.SrlNoOfChaln || "",
      date: c.DateDep || "",
      amount: src.num(`${payments.path}[${i}].Amt`),
    }))
    .filter((c) => c.amount)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (challans.length) {
    rows.push(columnHeader("Advance Tax and Self-Assessment Tax — BSR code / challan", { ref: "Date" }));
    for (const c of challans) {
      rows.push(sub(`${c.bsr}${c.serial ? ` · ${c.serial}` : ""}`, c.amount, { cols: { ref: longDate(c.date) || "" } }));
    }
  }
  rows.push(sub("Advance Tax Paid", advance, { ref: "Sch. IT" }));
  rows.push(sub("Self-Assessment Tax Paid", selfAssessment, { ref: "Sch. IT" }));
  src.num("TaxPayments.TotalTaxPayments");

  /* Tax collected at source, by collector. Naming them costs two lines and
     answers the same need the TDS rows do: a bare total leaves a reader with
     nothing to tie to a 26AS entry. */
  const tcsBlock = blockRows(src, "ScheduleTCS");
  const collectors = tcsBlock.list.map((c, i) => {
    const at = `${tcsBlock.path}[${i}]`;
    // Both fields are read, never short-circuited: the collection of the year and
    // the part of it claimed this year are the same figure on most returns, and a
    // `||` would leave whichever came second to surface as an omission (§8).
    const claimed = src.num(`${at}.TCSClaimedThisYearDtls.TCSAmtCollOwnHand`);
    const collected = src.num(`${at}.TCSCurrFYDtls.TCSAmtCollOwnHand`);
    return { tan: c.EmployerOrDeductorOrCollectTAN || c.TAN || "", credit: claimed || collected };
  }).filter((c) => c.credit).sort((a, b) => b.credit - a.credit);
  if (collectors.length) {
    rows.push(columnHeader("Tax Collected at Source — TAN of Collector", { ref: "" }));
    for (const c of collectors) rows.push(sub(c.tan, c.credit));
  }
  src.num("ScheduleTCS.TotalSchTCS");

  rows.push(sub("Tax Collected at Source", tcs, { ref: "Sch. TCS" }));
  rows.push(subtotal("Total Taxes Paid", totalPaid));
  rows.push(sub("Less: Total Tax and Interest Payable", aggregate));
  return rows;
}

/* -------------------------------------------------------------- the banner --
 *
 * Refund or payable, never both, and neither where the return closes at nil
 * against both fields — which is every ITR-1 we hold, because the rebate u/s 87A
 * extinguishes the tax (§12).
 */
function refundOrPayable(src, notes) {
  const refundDue = src.num("Refund.RefundDue");
  const balPayable = src.num("TaxPaid.BalTaxPayable");
  if (refundDue > 0) {
    const banks = src.claim("Refund.BankAccountDtls.AddtnlBankDetails") || [];
    let bank = banks.find((b) => String(b.UseForRefund).toLowerCase() === "true");
    if (!bank && banks.length) {
      bank = banks[0];
      notes.push({ severity: "attention", text: "No bank account is flagged for the refund in the return; the first account listed is shown." });
    }
    return {
      refund: {
        amount: refundDue,
        bank: bank ? { name: bank.BankName || "", accountNo: bank.BankAccountNo || "", type: bank.AccountType || "", ifsc: bank.IFSCCode || "" } : null,
      },
      payable: null,
      refundDue,
      balPayable,
    };
  }
  src.claim("Refund");
  return { refund: null, payable: balPayable > 0 ? { amount: balPayable } : null, refundDue, balPayable };
}

/* ------------------------------------------------------------------ build --- */
export function buildItr1(body, ctx) {
  const src = reader(body);
  const notes = [];

  /* ---- who the assessee is ------------------------------------------------ */
  const personal = body.PersonalInfo || {};
  const filing = body.FilingStatus || {};
  const pan = String(personal.PAN || "").toUpperCase();
  const name = personName(personal.AssesseeName);

  src.claim("PersonalInfo");
  src.claim("FilingStatus");
  src.claim("Verification");
  src.claim("Form_ITR1");
  src.claim("CreationInfo");

  const verification = body.Verification || {};
  const declaration = verification.Declaration || {};
  const filingSectionCode = filing.ReturnFileSec;
  const regime = regimeLabel(filing);
  const contact = personal.Address || {};

  const facts = [
    // ITR-1 may be filed only by an individual, and only by one who is
    // ordinarily resident — the form has no status field and no residential
    // status field because it admits no other answer.
    { label: "Status", value: "Individual" },
    { label: "Date of birth", value: longDate(personal.DOB) },
    { label: "Return filed under", value: filingSection(filingSectionCode) },
    // §10: the regime field's sense reads backwards, and every deduction below
    // depends on which one applies. State it rather than leaving it inferred.
    { label: "Tax regime", value: regime },
    { label: "Due date", value: longDate(filing.ItrFilingDueDate) },
    { label: "E-mail / mobile", value: [contact.EmailAddress, contact.MobileNo && `+91 ${contact.MobileNo}`].filter(Boolean).join("\n") },
  ];

  const assessee = {
    name,
    pan,
    status: "Individual",
    address: joinAddress(contact),
    email: contact.EmailAddress || "",
    mobile: contact.MobileNo ? String(contact.MobileNo) : "",
    residentialStatus: "Resident",
    dateOfFormation: personal.DOB || "",
    facts,
    partners: [],
  };

  if (isNonOrdinaryFiling(filingSectionCode)) {
    notes.push({ severity: "attention", text: `This computation is prepared from a return filed under ${filingSection(filingSectionCode)}.` });
  }

  /* ---- the heads and Chapter VI-A ------------------------------------------ */
  // A.Y. 2026-27 renames the house property total. The two spellings never
  // co-occur, so reading whichever is present beats branching on the year (§10).
  const hpTotal = src.peek(`${INC}.TotalIncomeChargeableUnHP`) === undefined
    ? src.num(`${INC}.TotalIncomeOfHP`)
    : src.num(`${INC}.TotalIncomeChargeableUnHP`);
  const osTotal = src.num(`${INC}.IncomeOthSrc`);

  const salary = salaryRows(src);
  const hp = housePropertyRows(src, hpTotal);
  const os = otherSourcesRows(src, osTotal);
  const via = chapterVIA(src);

  /* ---- Computation of total income ----------------------------------------- */
  const salaryTotal = src.num(`${INC}.IncomeFromSal`);
  const gtiStated = src.num(`${INC}.GrossTotIncome`);
  // Present from A.Y. 2025-26, when ITR-1 was first allowed to carry a long-term
  // capital gain u/s 112A within the s.112A exemption. Where the two differ, the
  // difference is that gain, and the INCLUDING figure is the gross total income
  // Chapter VI-A comes off. Read on PRESENCE, not on truth: validate() resolves
  // the same pair the same way, and a nil figure means nil, not absent (§3).
  const has112A = src.peek(`${INC}.GrossTotIncomeIncLTCG112A`) !== undefined;
  const gtiWith112A = has112A ? src.num(`${INC}.GrossTotIncomeIncLTCG112A`) : 0;
  const gti = has112A ? gtiWith112A : gtiStated;
  const ltcg112A = has112A ? gtiWith112A - gtiStated : 0;
  const totalIncome = src.num(`${INC}.TotalIncome`);

  const tiRows = [
    // "Part B" rather than a schedule reference: this form has no schedules, and
    // Part B is where it computes gross total income (§10).
    headRow("Income from Salaries", "Part B", salaryTotal),
    headRow("Income from House Property", "Part B", hpTotal),
    headRow("Income from Other Sources", "Part B", osTotal),
    ltcg112A !== 0 && headRow("Long-term Capital Gains u/s 112A", "Part B", ltcg112A),
    // No "Total of Heads of Income" row: on this form that figure IS gross total
    // income — there is no set-off between the two — and printing one number
    // twice under two captions reads as an arithmetic error (§10).
    subtotal("Gross Total Income", gti),
    sub("Less: Deductions under Chapter VI-A", via.allowedTotal, { ref: "Part C" }),
    total("Total Income (rounded off u/s 288A)", totalIncome),
  ];

  /* ---- tax, taxes paid ------------------------------------------------------ */
  const tax = taxRows(src);
  const paidRows = taxesPaidRows(src, { aggregate: tax.aggregate });
  const banner = refundOrPayable(src, notes);
  // A return can close level, and every ITR-1 we hold does: the rebate u/s 87A
  // leaves nothing to pay and nothing was deducted, so the return states nil
  // against both fields. Saying so beats a "Tax Payable — nil" row that reads
  // like a demand for nothing.
  if (banner.refundDue > 0 || banner.balPayable > 0) {
    paidRows.push(total(banner.refundDue > 0 ? "Refund Due" : "Tax Payable", banner.refundDue > 0 ? banner.refundDue : banner.balPayable));
  } else {
    paidRows.push(total("Nothing further payable or refundable", 0));
  }

  /* ---- notes ---------------------------------------------------------------- */
  notes.unshift({
    severity: "info",
    text: `This computation has been prepared from the ITR-1 return data (JSON) for A.Y. ${ctx.ay} and the figures correspond to Part B, Part C and Part D of the return.`,
  });
  // Lower-case the first letter only. toLowerCase() on the whole label turns the
  // section reference into "s.115bac(1a)", which is not how a section is written
  // on a document somebody signs.
  if (regime) {
    notes.push({ severity: "info", text: `The return is filed under the ${regime[0].toLowerCase()}${regime.slice(1)}.` });
  }
  const restricted = via.claimedTotal - via.allowedTotal;
  if (restricted > 0) {
    notes.push({
      severity: "attention",
      text: `Deductions under Chapter VI-A of ${inr(via.claimedTotal)} were claimed, of which ${inr(restricted)} was restricted by the statutory limits; ${inr(via.allowedTotal)} has been allowed.`,
    });
  }
  const exemptAgri = src.num(`${INC}.ExemptIncAgriOthUs10.ExemptIncAgriOthUs10Total`);
  src.claim(`${INC}.ExemptIncAgriOthUs10`);
  if (exemptAgri) {
    notes.push({ severity: "info", text: `Exempt income reported in the return: ${inr(exemptAgri)}. It does not enter total income and is stated for information.` });
  }
  if (ltcg112A !== 0) {
    notes.push({
      severity: "info",
      text: `Gross total income includes a long-term capital gain u/s 112A of ${inr(ltcg112A)}, being the difference between the return's own gross total income with and without it.`,
    });
  }

  /* ---- assemble ------------------------------------------------------------- */
  const sections = [
    section("SALARY", "Income from Salaries", salary, { tone: "navy" }),
    section("HP", "Income from House Property", hp, { tone: "navy" }),
    section("OS", "Income from Other Sources", os, { tone: "navy" }),
    via.rows.length ? section("VIA", "Deductions under Chapter VI-A", via.rows, { tone: "navy" }) : null,
    section("TI", "Computation of Total Income", tiRows, { tone: "navy", omitIfAllNil: false }),
    section("TAX", "Computation of Tax Liability", tax.rows, { tone: "gold", omitIfAllNil: false }),
    section("TAXES_PAID", "Taxes Paid & Prepaid Taxes", paidRows, { tone: "navy", omitIfAllNil: false }),
  ];

  const doc = document({
    meta: {
      form: "ITR1",
      assessmentYear: ctx.ay,
      previousYear: pyLabel(ctx.ay),
      schemaVersion: ctx.schemaVersion,
      generatedAt: ctx.generatedAt,
    },
    assessee,
    sections,
    refund: banner.refund,
    payable: banner.payable,
    notes,
    signatory: {
      name: declaration.AssesseeVerName || name,
      capacity: capacityName(verification.Capacity),
      pan: declaration.AssesseeVerPAN || pan,
      place: verification.Place || "",
      date: verification.Date || "",
    },
    unmapped: [],
  });

  /* No src.restate() block here, and that is worth saying out loud: on this form
     every figure the return states is read by name above — there is no schedule
     restating a total that Part B has already taken. If a later schema adds one,
     it belongs in a restate list here rather than in a wholesale claim (§8). */

  doc.unmapped = findUnmapped(body, src.consumed);
  return doc;
}
