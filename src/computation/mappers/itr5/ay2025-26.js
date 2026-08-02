/*
 * ITR-5, A.Y. 2025-26 → ComputationDocument.
 *
 * Read docs/computation-spec.md before changing anything here. §4 fixes the
 * section order, §5 the labels, §6 the treatment of nil and losses, §10 the
 * schema traps this mapper is written around.
 *
 * The one rule that governs every line below: this is a presentation layer. Every
 * figure printed is a figure the return states. Where the return and arithmetic
 * disagree — and they do, routinely, by a rupee or two around depreciation and
 * s.244A interest — the return wins and the difference is carried, not tidied.
 */
import { head, sub, subtotal, total, columnHeader, section, document } from "../../model.js";
import { reader, findUnmapped } from "../../unmapped.js";
import { ayLabel, pyLabel, longDate } from "../../format.js";
import {
  tdsSection, tdsNature, capacityName, statusFromPan, constitutionTitle,
  joinAddress, filingSection, isNonOrdinaryFiling,
} from "./shared.js";

/* A head-of-income row for the TI section. The five heads always appear, even
   at nil (§4) — a computation that silently omits a head reads as incomplete to
   an assessing officer. */
const headRow = (label, ref, amount) =>
  head(label, amount, { ref, isLoss: amount < 0 ? true : undefined, amount: amount < 0 ? -amount : amount });

export function mapItr5Ay2025(body, ctx) {
  const src = reader(body);
  const notes = [];

  /* ---- who the assessee is ------------------------------------------------ */
  const gen1 = body.PartA_GEN1 || {};
  const org = gen1.OrgFirmInfo || {};
  const filing = gen1.FilingStatus || {};
  const pan = String(org.PAN || org.AssesseeName?.PAN || "").toUpperCase();
  const rawName = String(org.AssesseeName?.SurNameOrOrgName || "").trim();
  // §12: do not double-prefix a name the return already prefixed.
  const name = /^m\/s\.?\s/i.test(rawName) ? rawName : `M/s. ${rawName}`;

  src.claim("PartA_GEN1");
  src.claim("PartA_GEN2");
  src.claim("Verification");
  src.claim("Form_ITR5");

  const filingSectionCode = filing.ReturnFileSec?.IncomeTaxSec;
  const gen2 = body.PartA_GEN2 || {};
  const audit = gen2.AuditInfo || {};
  const verification = (body.Verification || {}).Declaration || {};

  const facts = [
    { label: "Residential status", value: filing.ResidentialStatus === "RES" ? "Resident" : (filing.ResidentialStatus || "") },
    { label: "Date of formation", value: longDate(org.DateOFFormOrIncorp) },
    { label: "Return filed under", value: filingSection(filingSectionCode) },
  ];

  const business = gen1.NatOfBus?.NatureOfBusiness?.[0];
  if (business) {
    facts.push({ label: "Nature of business", value: [business.TradeName1, business.Code && `Code ${business.Code}`].filter(Boolean).join(" · ") });
  }

  // GST turnover (§12: list every GSTIN, sum the turnover).
  const gstRows = src.claim("ScheduleGST.TurnoverGrsRcptForGSTIN") || [];
  if (gstRows.length) {
    const totalTurnover = gstRows.reduce((s, g) => s + Number(g.AmtTurnGrossRcptGSTIN || 0), 0);
    facts.push({
      label: gstRows.length > 1 ? "GSTINs & turnover" : "GSTIN & turnover",
      value: gstRows.map((g) => g.GSTINNo).filter(Boolean).join(", "),
      value2: totalTurnover,
    });
  }

  facts.push({
    label: "Books u/s 44AA / audit u/s 44AB",
    value: [gen2.LiableSec44AAflg === "Y" ? "Maintained" : "", gen2.LiableSec44ABflg === "Y" ? "Audited" : "Not audited"]
      .filter(Boolean).join(" · "),
  });

  if (audit.AuditorName) {
    facts.push({
      label: "Tax audit particulars",
      value: [
        [audit.AuditorName, audit.AudFrmName].filter(Boolean).join(", "),
        [audit.AudFrmRegNo && `FRN ${audit.AudFrmRegNo}`, audit.AuditorMemNo && `M. No. ${audit.AuditorMemNo}`].filter(Boolean).join(" · "),
        [audit.AuditDate && `Report dated ${longDate(audit.AuditDate)}`, audit.UDIN && `UDIN ${audit.UDIN}`, audit.AckNum44AB && `Ack. ${audit.AckNum44AB}`].filter(Boolean).join(" · "),
      ].filter(Boolean).join("\n"),
    });
  }

  const contact = org.Address || {};
  facts.push({ label: "E-mail / mobile", value: [contact.EmailAddress, contact.MobileNo && `+91 ${contact.MobileNo}`].filter(Boolean).join("\n") });

  const partners = (gen2.PartnerOrMemberInfo || []).map((p) => ({
    name: p.PartnerOrMemberName || "",
    pan: p.PAN || "",
    share: p.SharePercentage != null ? `${p.SharePercentage}%` : "",
    remuneration: p.RemunerationPaid != null ? Number(p.RemunerationPaid) : null,
    interestRate: p.RateOfInterest != null ? Number(p.RateOfInterest) : null,
  }));

  const assessee = {
    name,
    pan,
    status: statusFromPan(pan) || "",
    address: joinAddress(contact),
    email: contact.EmailAddress || "",
    mobile: contact.MobileNo ? String(contact.MobileNo) : "",
    residentialStatus: filing.ResidentialStatus === "RES" ? "Resident" : (filing.ResidentialStatus || ""),
    dateOfFormation: org.DateOFFormOrIncorp || "",
    facts,
    partners,
    constitutionTitle: constitutionTitle(pan),
  };

  if (isNonOrdinaryFiling(filingSectionCode)) {
    notes.push({ severity: "attention", text: `This computation is prepared from a return filed under ${filingSection(filingSectionCode)}.` });
  }

  /* ---- A. Income from house property --------------------------------------
   *
   * Statutory order, per property: annual letable value, less anything not
   * realised and the municipal taxes actually paid, giving the annual value;
   * then the two deductions s.24 allows — 30% of the annual value under
   * s.24(a), and interest on borrowed capital under s.24(b).
   *
   * The interest is very often larger than the annual value, so this head
   * closes at a LOSS in a great many real returns. That is not an error state:
   * it sets off against other heads under s.71 and what remains is carried
   * forward. A computation that omitted the head because its result was
   * negative would be hiding the very thing the assessee needs to see.
   */
  const hpRows = [];
  // peek, not claim. Claiming the whole subtree would consume every field in it
  // and so hide a genuinely new one — which is the opposite of what §8 is for.
  // Each figure below is read through src.num, which marks exactly that path.
  const properties = src.peek("ScheduleHP.PropertyDetails") || [];
  const many = properties.length > 1;
  properties.forEach((prop, i) => {
    const at = (field) => `ScheduleHP.PropertyDetails[${i}].Rentdetails.${field}`;
    const rent = prop.Rentdetails || {};
    const address = [prop.AddressDetailWithZipCode?.AddrDetail, prop.AddressDetailWithZipCode?.CityOrTownOrDistrict]
      .map((x) => String(x || "").trim()).filter(Boolean).join(", ");
    const letOut = String(prop.ifLetOut || "").toUpperCase() === "Y";
    const tenants = (prop.TenantDetails || []).map((t) => t.NameofTenant).filter(Boolean).join(", ");
    // A part-owned property is worth stating: the return has already restricted
    // the figures to the assessee's share, and a reader comparing this to the
    // rent agreement needs to know why they differ.
    const shareOfProperty = Number(prop.AssessePercentShareProp);
    const share = Number.isFinite(shareOfProperty) && shareOfProperty !== 100
      ? `${shareOfProperty}% share`
      : "";

    if (many) hpRows.push(columnHeader(`Property ${i + 1}${address ? ` — ${address}` : ""}`, { ref: "" }));

    hpRows.push(sub(
      letOut ? "Annual letable value of the property" : "Annual value of the property",
      src.num(at("AnnualLetableValue")),
      {
        ref: i === 0 && !many ? "Sch. HP" : "",
        note: [many ? "" : address, tenants && `let to ${tenants}`, share].filter(Boolean).join(" · "),
      }
    ));

    const unrealised = src.num(at("RentNotRealized"));
    if (unrealised) hpRows.push(sub("Less: Rent not realised", unrealised));
    const localTaxes = src.num(at("LocalTaxes"));
    if (localTaxes) hpRows.push(sub("Less: Municipal taxes paid", localTaxes));
    if (src.num(at("TotalUnrealizedAndTax"))) hpRows.push(subtotal("Annual Value", src.num(at("AnnualOfPropOwned"))));

    hpRows.push(sub("Less: Standard deduction u/s 24(a) @ 30% of the annual value",
      src.num(at("ThirtyPercentOfBalance")), { ref: "Sec. 24(a)" }));

    const interest = src.num(at("Section24B.TotalInterestUs24B")) || src.num(at("IntOnBorwCap"));
    if (interest) {
      const lenders = (rent.Section24B?.Section24BDtls || []).map((l) => l.BankOrInstnName).filter(Boolean);
      hpRows.push(sub("Less: Interest on borrowed capital u/s 24(b)", interest, {
        ref: "Sec. 24(b)",
        note: lenders.length ? `Borrowed from ${lenders.join(", ")}` : undefined,
      }));
    }
    const arrears = src.num(at("ArrearsUnrealizedRentRcvd"));
    if (arrears) hpRows.push(sub("Add: Arrears / unrealised rent received u/s 25A (less 30%)", arrears, { ref: "Sec. 25A" }));

    const own = src.num(at("IncomeOfHP"));
    if (many) hpRows.push(subtotal(own < 0 ? `Loss from property ${i + 1}` : `Income from property ${i + 1}`, Math.abs(own), { isLoss: own < 0 }));

    // Figures this property restates on the way to its own result, plus the
    // per-lender interest that the schedule already totals for us.
    src.restate([
      at("BalanceALV"), at("AnnualOfPropOwned"), at("TotalDeduct"), at("IntOnBorwCap"),
      ...(rent.Section24B?.Section24BDtls || []).map((_, li) => at(`Section24B.Section24BDtls[${li}].InterestUs24B`)),
    ]);
  });
  src.num("ScheduleHP.PassThroghIncome");

  const hpTotal = src.num("ScheduleHP.TotalIncomeChargeableUnHP");
  if (hpRows.length) {
    hpRows.push(total(
      hpTotal < 0 ? "Loss from House Property" : "Income from House Property",
      Math.abs(hpTotal),
      { isLoss: hpTotal < 0 }
    ));
  }

  /* ---- B. Profits and gains of business or profession --------------------- */
  //
  // The depreciation swap (§10): the P&L figure carries depreciation as per the
  // Companies Act, which is added back, and the s.32 allowance is deducted in
  // its place. The two differ by a rupee or two routinely — in this fixture by
  // ₹185, which IS the loss for the year. Carrying that difference is the whole
  // point; "correcting" it would erase the result.
  const netProfitPL = src.num("CorpScheduleBP.BusinessIncOthThanSpec.ProfBfrTaxPL");
  const depDebitedPL = src.num("CorpScheduleBP.BusinessIncOthThanSpec.DepreciationDebPLCosAct");
  const depAllowable = src.num("CorpScheduleBP.BusinessIncOthThanSpec.DepreciationAllowITAct32.TotDeprAllowITAct");
  const bpIncome = src.num("CorpScheduleBP.IncChrgUnHdProftGain");

  // Income credited to the P&L but taxable under another head (§10). The return
  // itemises it head by head with no total of its own, so we sum the heads and
  // name them — a reader needs to know income left business for Other Sources,
  // not merely that some figure was removed.
  const OTHER_HEAD_LABELS = {
    HouseProperty: "House Property", CapitalGains: "Capital Gains", OtherSources: "Other Sources",
    Dividend: "dividend", OtherThanDividend: "Other Sources", UnderSec115BBF: "s.115BBF",
    UnderSec115BBG: "s.115BBG", UnderSec115BBH: "s.115BBH",
  };
  const incOtherHead = src.claim("CorpScheduleBP.BusinessIncOthThanSpec.IncRecCredPLOthHeadDtls") || {};
  const otherHeadTotal = Object.values(incOtherHead).reduce((s, v) => s + Number(v || 0), 0);
  const otherHeadNames = [...new Set(Object.entries(incOtherHead)
    .filter(([, v]) => Number(v) !== 0)
    .map(([k]) => OTHER_HEAD_LABELS[k] || k))];

  // The mirror of the above: expenditure debited to the P&L that relates to that
  // income and therefore has to come back out of business income too.
  const expOtherHead = src.claim("CorpScheduleBP.BusinessIncOthThanSpec.ExpDebToPLOthHeadDtls") || {};
  const expOtherHeadTotal = Object.values(expOtherHead).reduce((s, v) => s + Number(v || 0), 0);

  const bpRows = [
    netProfitPL !== 0 && sub("Net Profit before tax as per Profit & Loss Account", netProfitPL, { ref: "Part A-P&L" }),
    otherHeadTotal !== 0 && sub(
      `Less: Income credited to P&L considered separately under ${otherHeadNames.join(" / ") || "other heads"}`,
      otherHeadTotal, { ref: "Sch. BP" }
    ),
    expOtherHeadTotal !== 0 && sub("Add: Expenditure debited to P&L relatable to income under other heads", expOtherHeadTotal, { ref: "Sch. BP" }),
    (otherHeadTotal !== 0 || expOtherHeadTotal !== 0) && subtotal(
      "Balance Profit / (Loss) of Business",
      Math.abs(netProfitPL - otherHeadTotal + expOtherHeadTotal),
      { isLoss: netProfitPL - otherHeadTotal + expOtherHeadTotal < 0 }
    ),
    depDebitedPL !== 0 && sub("Add: Depreciation debited to P&L as per the Companies Act", depDebitedPL),
    depAllowable !== 0 && sub("Less: Depreciation allowable u/s 32 of the Act", depAllowable, { ref: "Sch. DEP" }),
    total(
      bpIncome < 0 ? "Loss from Business or Profession" : "Income from Business or Profession",
      bpIncome < 0 ? -bpIncome : bpIncome,
      { isLoss: bpIncome < 0 }
    ),
  ];

  /* ---- C. Income from other sources --------------------------------------- */
  //
  // §10: split interest into its sub-fields rather than printing InterestGross
  // as one line. A reader needs to see savings-bank interest separately from a
  // term deposit, because they attract different deductions.
  const osPath = "ScheduleOS.IncOthThanOwnRaceHorse";
  const osRows = [];
  const osLine = (label, path, opts) => {
    const v = src.num(`${osPath}.${path}`);
    if (v !== 0) osRows.push(sub(label, v, opts));
    return v;
  };

  osLine("Dividend income", "DividendGross", { ref: "Sch. OS" });
  osLine("Interest from savings bank accounts", "IntrstFrmSavingBank");
  osLine("Interest on term / fixed deposits", "IntrstFrmTermDeposit");
  osLine("Interest on income-tax refund", "IntrstFrmIncmTaxRefund");
  osLine("Interest received from others", "IntrstFrmOthers");
  osLine("Rent from machinery, plant or buildings", "RentFromMachPlantBldgs");

  // §10: AnyOtherIncome is itemised with a user-entered nature string; use it.
  const otherInc = src.claim(`${osPath}.OthersInc.OthersIncDtls`) || [];
  for (const o of otherInc) {
    const amt = Number(o.OthAmount || o.Amount || 0);
    if (amt !== 0) osRows.push(sub(o.OthNatOfInc || o.NatureOfIncome || "Other income", amt));
  }
  const anyOther = src.num(`${osPath}.AnyOtherIncome`);
  if (anyOther !== 0 && !otherInc.length) osRows.push(sub("Any other income", anyOther));

  const osGross = src.num(`${osPath}.GrossIncChrgblTaxAtAppRate`);
  const osDeductions = src.num(`${osPath}.Deductions.TotDeductions`);
  const osNet = src.num("ScheduleOS.IncChargeableFrmOthSrc");

  if (osRows.length > 1 || osDeductions !== 0) osRows.push(subtotal("Gross Income chargeable under Other Sources", osGross));
  if (osDeductions !== 0) osRows.push(sub("Less: Expenditure allowable u/s 57", osDeductions, { ref: "Sec. 57" }));
  osRows.push(total("Income from Other Sources", osNet));

  /* ---- D. Computation of total income ------------------------------------- */
  const tiSalary = 0; // ITR-5 has no salary head; stated at nil for completeness (§4)
  const tiHP = src.num("PartB-TI.IncomeFromHP");
  const tiBP = src.num("PartB-TI.ProfBusGain.TotProfBusGain");
  const tiCG = src.num("PartB-TI.CapGain.TotalCapGains");
  const tiOS = src.num("PartB-TI.IncFromOS.TotIncFromOS");
  const totalOfHeads = src.num("PartB-TI.TotalTI");
  const cyla = src.num("PartB-TI.CurrentYearLoss");
  const balanceAfterCyla = src.num("PartB-TI.BalanceAfterSetoffLosses");
  const bfla = src.num("PartB-TI.BroughtFwdLossesSetoff");
  const gti = src.num("PartB-TI.GrossTotalIncome");
  const chapterVIA = src.num("PartB-TI.DeductionsUndSchVIADtl.TotDeductUndSchVIA");
  const ded10AA = src.num("PartB-TI.DeductionsUnder10Aor10AA");
  const totalIncome = src.num("PartB-TI.TotalIncome");

  /* Which head's loss was set off this year. Schedule CYLA totals each head
     separately, so the return says outright whether the s.71 set-off is a house
     property loss, a business loss or both — calling a house property loss a
     "business loss", as this did while only business income was mapped, is a
     substantive error on the face of a signed document. */
  const cylaTotals = [
    ["house property loss", src.num("ScheduleCYLA.TotalCurYr.TotHPlossCurYr")],
    ["business loss", src.num("ScheduleCYLA.TotalCurYr.TotBusLoss")],
    ["loss from other sources", src.num("ScheduleCYLA.TotalCurYr.TotOthSrcLoss")],
  ].filter(([, v]) => v !== 0).map(([label]) => label);
  const cylaLossHeads = cylaTotals.length ? cylaTotals.join(" and ") : "loss";

  // The unabsorbed-depreciation trap (§10). Brought-forward business loss sets
  // off under s.72; unabsorbed depreciation under s.32(2), from Schedule UD, and
  // they are NOT the same thing. Labelling one as the other is a substantive
  // error, so the label is chosen from where the figure actually came from.
  const udBroughtForward = src.num("ITRScheduleUD.TotDepritBalCFNY");
  const bflaFromUd = bfla !== 0 && udBroughtForward !== 0 && src.num("ScheduleBFLA.IncomeOfCurrYrAftCYLABFLA.TotalBFLASetoff") === 0;

  const tiRows = [
    headRow("Income from Salaries", "Sch. S", tiSalary),
    headRow("Income from House Property", "Sch. HP", tiHP),
    headRow("Profits and Gains of Business or Profession", "Sch. BP", tiBP),
    headRow("Capital Gains", "Sch. CG", tiCG),
    headRow("Income from Other Sources", "Sch. OS", tiOS),
    subtotal("Total of Heads of Income", totalOfHeads),
    cyla !== 0 && sub(`Less: Set-off of current year ${cylaLossHeads} u/s 71`, cyla, { ref: "Sch. CYLA" }),
    cyla !== 0 && sub("Balance after set-off of current year loss", balanceAfterCyla),
    bfla !== 0 && sub(
      bflaFromUd
        ? "Less: Set-off of brought forward unabsorbed depreciation u/s 32(2)"
        : "Less: Set-off of brought forward business loss u/s 72",
      bfla,
      { ref: bflaFromUd ? "Sch. BFLA / UD" : "Sch. BFLA" }
    ),
    subtotal("Gross Total Income", gti),
    sub("Less: Deductions under Chapter VI-A", chapterVIA, { ref: "Sch. VI-A" }),
    ded10AA !== 0 && sub("Less: Deduction u/s 10AA", ded10AA, { ref: "Sch. 10AA" }),
    total("Total Income (rounded off u/s 288A)", totalIncome),
  ];

  /* ---- E. Computation of tax liability ------------------------------------ */
  const taxNormal = src.num("PartB_TTI.ComputationOfTaxLiability.TaxPayableOnTI.TaxAtNormalRates");
  const taxSpecial = src.num("PartB_TTI.ComputationOfTaxLiability.TaxPayableOnTI.TaxAtSpecialRates");
  const surcharge = src.num("PartB_TTI.ComputationOfTaxLiability.TaxPayableOnTI.TotalSurcharge");
  const cess = src.num("PartB_TTI.ComputationOfTaxLiability.TaxPayableOnTI.EducationCess");
  const grossTax = src.num("PartB_TTI.ComputationOfTaxLiability.GrossTaxPayable");
  const relief = src.num("PartB_TTI.ComputationOfTaxLiability.TaxRelief.TotTaxRelief");
  const interest = src.num("PartB_TTI.ComputationOfTaxLiability.IntrstPay.TotalIntrstPay");
  const aggregate = src.num("PartB_TTI.ComputationOfTaxLiability.AggregateTaxInterestLiability");
  const deemedTI = src.num("PartB-TI.DeemedTotIncSec115JC");

  // A firm is taxed at a flat 30% (Para C of Schedule I to the Finance Act).
  // §5: cite the rate schedule, not a charging section we have not verified.
  const rateLabel = statusFromPan(pan) === "Partnership Firm" ? "Tax on Total Income @ 30% (firm)" : "Tax on Total Income at normal rates";

  const taxRows = [
    sub(rateLabel, taxNormal, { ref: "Para C, Sch. I" }),
    taxSpecial !== 0 && sub("Tax at special rates", taxSpecial, { ref: "Sch. SI" }),
    sub("Add: Surcharge", surcharge, { note: totalIncome <= 10000000 ? "Total income does not exceed ₹ 1 crore" : undefined }),
    sub("Add: Health & Education Cess @ 4%", cess),
    subtotal("Gross Tax Liability", grossTax),
    sub("Less: Relief u/s 90 / 90A / 91", relief),
    sub("Add: Interest u/s 234A / 234B / 234C and fee u/s 234F", interest),
    total("Total Tax and Interest Payable", aggregate),
  ];

  // §12: state why AMT is nil rather than omitting the line.
  const AMT_THRESHOLD = 2000000;
  const amtFootnote = deemedTI === 0 && totalIncome <= AMT_THRESHOLD
    ? `Adjusted total income u/s 115JC is ${totalIncome.toLocaleString("en-IN")}, which does not exceed the threshold of ₹ 20,00,000 prescribed under section 115JEE; Alternate Minimum Tax is accordingly Nil and no AMT credit arises.`
    : "";
  src.claim("ScheduleAMT");

  /* ---- F. Taxes paid ------------------------------------------------------ */
  const tdsRows = [];
  const tdsList = src.claim("ScheduleTDS2.TDSOthThanSalaryDtls") || [];
  if (tdsList.length) tdsRows.push(columnHeader("Tax Deducted at Source — TAN of Deductor", { ref: "Gross Receipt" }));

  // §12: multiple rows against the same TAN stay separate — merging them hides
  // which receipt a credit belongs to, which is exactly what a CPC mismatch
  // query asks about. But a deductor who paid ten times in the year produces ten
  // near-identical rows, so rows sharing a TAN *and* a section are shown as one
  // line carrying the count, with the gross and the credit summed.
  const byTanSection = new Map();
  for (const t of tdsList) {
    const secCode = tdsSection(t.TDSSection);
    const key = `${t.TANOfDeductor}|${secCode}`;
    const prev = byTanSection.get(key) || { tan: t.TANOfDeductor, section: secCode, gross: 0, credit: 0, count: 0, heads: new Set() };
    prev.gross += Number(t.GrossAmount || 0);
    prev.credit += Number(t.TaxDeductCreditDtls?.TaxClaimedOwnHands || 0);
    prev.count += 1;
    if (t.HeadOfIncome) prev.heads.add(t.HeadOfIncome);
    byTanSection.set(key, prev);
  }
  for (const g of byTanSection.values()) {
    const nature = tdsNature(g.section);
    tdsRows.push(sub(g.tan, g.credit, {
      note: [nature, `Sec. ${g.section}`, g.count > 1 ? `${g.count} entries` : ""].filter(Boolean).join(" · "),
      cols: { ref: g.gross ? g.gross.toLocaleString("en-IN") : "" },
    }));
  }

  const totalTds = src.num("PartB_TTI.TaxPaid.TaxesPaid.TDS");
  const totalTcs = src.num("PartB_TTI.TaxPaid.TaxesPaid.TCS");
  const advanceTax = src.num("PartB_TTI.TaxPaid.TaxesPaid.AdvanceTax");
  const selfAssessment = src.num("PartB_TTI.TaxPaid.TaxesPaid.SelfAssessmentTax");
  const totalPaid = src.num("PartB_TTI.TaxPaid.TaxesPaid.TotalTaxesPaid");
  src.claim("ScheduleTCS");
  src.claim("ScheduleIT");
  src.claim("ScheduleTDS3");
  src.num("ScheduleTDS2.TotalTDSonOthThanSals");

  const paidRows = [
    ...tdsRows,
    tdsRows.length ? subtotal("Total Tax Deducted at Source", totalTds, { ref: "Sch. TDS 2" }) : sub("Tax Deducted at Source", totalTds, { ref: "Sch. TDS 2" }),
    sub("Advance Tax Paid", advanceTax, { ref: "Sch. IT" }),
    sub("Self-Assessment Tax Paid", selfAssessment, { ref: "Sch. IT" }),
    sub("Tax Collected at Source", totalTcs, { ref: "Sch. TCS" }),
    subtotal("Total Taxes Paid", totalPaid),
    sub("Less: Total Tax and Interest Payable", aggregate),
  ];

  const netRefund = src.num("PartB_TTI.TaxPaid.NetRefundAdjust");
  const balPayable = src.num("PartB_TTI.TaxPaid.BalTaxPayable");
  paidRows.push(total(netRefund > 0 ? "Refund Due" : "Tax Payable", netRefund > 0 ? netRefund : balPayable));

  // The ₹1 that appears between "taxes paid" and "refund due" in real returns is
  // interest u/s 244A, which CPC computes and the return does not itemise. Say
  // so rather than leaving a reader to hunt for an arithmetic error.
  if (netRefund > 0 && totalPaid - aggregate !== netRefund) {
    notes.push({
      severity: "info",
      text: `The refund of ${netRefund.toLocaleString("en-IN")} exceeds the taxes paid less the liability by ${(netRefund - (totalPaid - aggregate)).toLocaleString("en-IN")}; the difference is interest u/s 244A as determined in the return.`,
    });
  }

  /* ---- G. Losses carried forward ------------------------------------------ */
  const cflRows = [];
  src.claim("ScheduleCFL");
  const cfl = body.ScheduleCFL || {};

  /* Schedule CFL's per-year buckets are named for how the form was laid out
     years ago, not for the assessment year they hold — "LossCFCurrentAssmntYear"
     is A.Y. 2019-20 on an A.Y. 2025-26 return, and the suffixed keys run on from
     there. The mapping is fixed for this assessment year, which is precisely why
     mappers are keyed by year (§9). Each bucket's own DateOfFiling corroborates
     it, and is shown so a reader can check. */
  const BROUGHT_FORWARD_YEARS = [
    ["LossCFFromPrev2ndYearFromAY", "2017-18"],
    ["LossCFFromPrevYrToAY", "2018-19"],
    ["LossCFCurrentAssmntYear", "2019-20"],
    ["LossCFCurrentAssmntYear2021", "2020-21"],
    ["LossCFCurrentAssmntYear2022", "2021-22"],
    ["LossCFCurrentAssmntYear2023", "2022-23"],
    ["LossCFCurrentAssmntYear2024", "2023-24"],
    ["LossCFCurrentAssmntYear2025", "2024-25"],
  ];

  const NATURES = [
    ["BusLossOthThanSpecLossCF", "Business Loss"],
    ["TotalHPPTILossCF", "House Property Loss"],
    ["LossFrmSpecBusCF", "Speculation Loss"],
    ["STCGLossCF", "Short-term Capital Loss"],
    ["LTCGLossCF", "Long-term Capital Loss"],
    ["OthSrcLossRaceHorseCF", "Loss from Owning Race Horses"],
  ];

  const cflTotals = cfl.TotalLossCFSummary?.LossSummaryDetail || {};
  const cflTotal = NATURES.reduce((sum, [key]) => sum + Number(cflTotals[key] || 0), 0);

  const brought = [];
  for (const [key, ay] of BROUGHT_FORWARD_YEARS) {
    const d = cfl[key]?.CarryFwdLossDetail;
    if (!d) continue;
    for (const [field, nature] of NATURES) {
      const amt = Number(d[field] || 0);
      if (amt !== 0) brought.push({ ay, nature, amt, filedOn: d.DateOfFiling || "" });
    }
  }

  const current = [];
  const currentDetail = cfl.CurrentAYloss?.LossSummaryDetail || {};
  for (const [field, nature] of NATURES) {
    const amt = Number(currentDetail[field] || 0);
    if (amt !== 0) current.push({ nature, amt });
  }

  if (brought.length || current.length) {
    cflRows.push(columnHeader("Assessment Year / Date of filing of return", { ref: "Nature", amt: "Amount (₹)" }));
  }
  for (const b of brought) {
    cflRows.push(sub(
      `A.Y. ${b.ay}${b.filedOn ? ` · Return filed on ${longDate(b.filedOn)}` : ""}`,
      b.amt,
      { cols: { ref: b.nature } }
    ));
  }
  for (const c of current) {
    cflRows.push(sub(`A.Y. ${ctx.ay} · loss of the current year`, c.amt, { cols: { ref: c.nature } }));
  }
  const udCarried = src.num("ITRScheduleUD.CurBalCFNY");
  src.claim("ITRScheduleUD");
  if (udCarried !== 0) {
    cflRows.push(sub("Unabsorbed depreciation carried forward", udCarried, {
      note: "Carried forward under s.32(2), without any time limit",
      cols: { ref: "u/s 32(2)" },
    }));
  }
  if (cflRows.length) cflRows.push(total("Total Loss Carried Forward", cflTotal));

  /* Where the year's loss arises purely from the depreciation differential, the
     return reports the SAME figure twice — once in Schedule CFL as a business
     loss and again in Schedule UD as unabsorbed depreciation. Printed as two
     rows above one total they read as though they ought to sum, which in a
     document that gets signed is worse than ugly. We print both, because the
     return states both and §1 forbids us from suppressing either, and say what
     the relationship is. */
  const cflFootnote = udCarried !== 0 && udCarried === cflTotal
    ? "The unabsorbed depreciation shown is the same amount as the business loss above, carried in Schedule UD of the return, and not a further loss. The loss for the year arises from the difference between depreciation charged in the accounts and the allowance u/s 32."
    : "";

  /* ---- exempt income, mentioned but not computed --------------------------- */
  const exempt = src.num("ScheduleEI.TotalExemptInc");
  src.claim("ScheduleEI");

  /* ---- the banner ---------------------------------------------------------- */
  let refund = null;
  let payable = null;
  if (netRefund > 0) {
    const banks = src.claim("PartB_TTI.Refund.BankAccountDtls.AddtnlBankDetails") || [];
    // §12: the UseForRefund flag can be absent; fall back to the first account
    // and say we did, rather than presenting a guess as a fact.
    let bank = banks.find((b) => String(b.UseForRefund).toLowerCase() === "true");
    if (!bank && banks.length) {
      bank = banks[0];
      notes.push({ severity: "attention", text: "No bank account is flagged for the refund in the return; the first account listed is shown." });
    }
    refund = {
      amount: netRefund,
      bank: bank
        ? { name: bank.BankName || "", accountNo: bank.BankAccountNo || "", type: bank.AccountType || "", ifsc: bank.IFSCCode || "" }
        : null,
    };
  } else if (balPayable > 0) {
    payable = { amount: balPayable };
  }

  /* ---- notes --------------------------------------------------------------- */
  notes.unshift({
    severity: "info",
    text: `This computation has been prepared from the ITR-5 return data (JSON) for A.Y. ${ctx.ay} and the figures correspond to Part A-P&L, Schedule BP, Schedule OS, Schedule CYLA/BFLA and Part B-TI / Part B-TTI of the return.`,
  });

  if (otherHeadTotal !== 0) {
    notes.push({
      severity: "info",
      text: `Receipts of ${otherHeadTotal.toLocaleString("en-IN")} credited to the Profit & Loss Account have been excluded from business income and offered under other heads, as shown in Schedule BP.`,
    });
  }

  // §10: HeadOfIncome in the TDS schedule is what the deductor/assessee tagged
  // and can legitimately disagree with where the income is offered. We never use
  // it to place income — but a mismatch is worth surfacing, because it is what a
  // CPC credit mismatch is usually about.
  const osTaggedTds = [...byTanSection.values()].filter((g) => g.heads.has("OS"));
  const bpTaggedTds = [...byTanSection.values()].filter((g) => g.heads.has("BP"));
  if (tiOS !== 0 && bpTaggedTds.length && !osTaggedTds.length && tiBP === 0) {
    notes.push({
      severity: "attention",
      text: "TDS in Schedule TDS-2 is tagged to the head \"Business or Profession\" whereas the corresponding receipts have been offered under Other Sources — the head of income tagged in the TDS schedule may be aligned to avoid a mismatch in credit at CPC.",
    });
  }

  if (exempt !== 0) {
    notes.push({ severity: "info", text: `Exempt income reported under Schedule EI: ${exempt.toLocaleString("en-IN")}.` });
  }

  /* ---- assemble ------------------------------------------------------------ */
  const sections = [
    section("HP", "Income from House Property", hpRows, { tone: "navy" }),
    section("BP", "Profits and Gains of Business or Profession", bpRows, { tone: "navy" }),
    section("OS", "Income from Other Sources", osRows, { tone: "navy" }),
    section("TI", "Computation of Total Income", tiRows, {
      tone: "navy",
      omitIfAllNil: false,
      footnote: `Total income in words: ${""}`, // filled by the renderer from the total row
    }),
    section("TAX", "Computation of Tax Liability", taxRows, { tone: "gold", omitIfAllNil: false, footnote: amtFootnote }),
    section("TAXES_PAID", "Taxes Paid & Prepaid Taxes", paidRows, { tone: "navy", omitIfAllNil: false }),
    cflRows.length ? section("CFL", "Losses Carried Forward to Subsequent Years", cflRows, { tone: "navy", layout: "table", footnote: cflFootnote }) : null,
  ];

  const doc = document({
    meta: {
      form: "ITR5",
      assessmentYear: ctx.ay,
      previousYear: pyLabel(ctx.ay),
      schemaVersion: ctx.schemaVersion,
      generatedAt: ctx.generatedAt,
    },
    assessee,
    sections,
    refund,
    payable,
    notes,
    signatory: {
      name: verification.AssesseeVerName || "",
      capacity: capacityName(verification.Capacity),
      pan: verification.AssesseeVerPAN || "",
      place: verification.Place || "",
      date: verification.Date || "",
    },
    unmapped: [],
  });

  /* Figures the return states more than once on its way to a total this mapper
     has already taken. Each line below is the SAME rupee figure as something
     above, reported again at another step of the return's own chain — Schedule
     BP arrives at its result over five successive fields, and Part B-TI restates
     Schedule OS's total. Listing them explicitly keeps §8 meaningful: a new
     field in any of these schedules still surfaces as unmapped, whereas ignoring
     the schedules wholesale would hide it. */
  src.restate([
    // Schedule BP works down to IncChrgUnHdProftGain, which we take.
    "CorpScheduleBP.BusinessIncOthThanSpec.AdjustPLAfterDeprOthSpecInc",
    "CorpScheduleBP.BusinessIncOthThanSpec.PLAftAdjDedBusOthThanSpec",
    "CorpScheduleBP.BusinessIncOthThanSpec.NetPLAftAdjBusOthThanSpec",
    "CorpScheduleBP.BusinessIncOthThanSpec.NetPLBusOthThanSpec7A7B7C",
    "CorpScheduleBP.BusinessIncOthThanSpec.IncomeOtherThanRule",
    // The s.32 allowance again, split by sub-clause.
    "CorpScheduleBP.BusinessIncOthThanSpec.DepreciationAllowITAct32.DepreciationAllowUs32_1_ii",
    "CorpScheduleBP.BusinessIncOthThanSpec.DepreciationAllowITAct32.DepreciationAllowUs32_1_iia",
    // The same current-year loss, handed from Schedule BP to Schedule CYLA.
    "CorpScheduleBP.BusSetoffCurrYr.LossSetOffOnBusLoss",
    "CorpScheduleBP.BusSetoffCurrYr.LossRemainSetOffOnBus",
    "ScheduleCYLA.TotalCurYr.TotBusLoss",
    "ScheduleCYLA.TotalLossSetOff.TotBusLossSetoff",
    "ScheduleCYLA.LossRemAftSetOff.BalBusLossAftSetoff",
    "ScheduleCYLA.OthSrcExclRaceHorseLottery.IncCYLA.IncOfCurYrUnderThatHead",
    "ScheduleCYLA.OthSrcExclRaceHorseLottery.IncCYLA.BusLossSetoff",
    "PartB-TI.LossesOfCurrentYearCarriedFwd",
    // The same, for a house property loss. Schedule CYLA states each head's
    // set-off three times over — as the head's own total, as the amount set off,
    // and as what remains — and the remainder is what Schedule CFL then carries.
    "ScheduleCYLA.TotalCurYr.TotHPlossCurYr",
    "ScheduleCYLA.TotalLossSetOff.TotHPlossCurYrSetoff",
    "ScheduleCYLA.LossRemAftSetOff.BalHPlossCurYrAftSetoff",
    "ScheduleCYLA.OthSrcExclRaceHorseLottery.IncCYLA.HPlossCurYrSetoff",
    // §10: interest is itemised into its sub-fields, so the schedule's own
    // total of them is the same money said once more.
    "ScheduleOS.IncOthThanOwnRaceHorse.InterestGross",
    // Schedule OS restates its own total, and Part B-TI restates it again.
    "ScheduleOS.IncOthThanOwnRaceHorse.DividendOthThan22e",
    "ScheduleOS.IncOthThanOwnRaceHorse.BalanceNoRaceHorse",
    "ScheduleOS.TotOthSrcNoRaceHorse",
    "ScheduleOS.DividendIncUs115BBDA.DateRange.Up16Of3To31Of3",
    "PartB-TI.IncFromOS.OtherSrcThanOwnRaceHorse",
    // Part B-TTI states the refund twice.
    "PartB_TTI.Refund.RefundDue",
    // The surcharge components that make up TotalSurcharge, which we do show.
    // Listed one by one rather than claiming the whole TaxPayableOnTI subtree,
    // so a rate or levy ITD adds in a future year still surfaces.
    "PartB_TTI.ComputationOfTaxLiability.TaxPayableOnTI.TaxPayableOnTotInc",
    "PartB_TTI.ComputationOfTaxLiability.TaxPayableOnTI.RebateOnAgriInc",
    "PartB_TTI.ComputationOfTaxLiability.TaxPayableOnTI.Surcharge25ofSI",
    "PartB_TTI.ComputationOfTaxLiability.TaxPayableOnTI.SurchargeOnTaxPayable",
    "PartB_TTI.ComputationOfTaxLiability.TaxPayableOnTI.Surcharge25ofSIBeforeMarginal",
    "PartB_TTI.ComputationOfTaxLiability.TaxPayableOnTI.SurchargeOnTaxPayableBeforeMarginal",
    "PartB_TTI.ComputationOfTaxLiability.TaxPayableOnTI.GrossTaxLiability",
    "PartB_TTI.ComputationOfTaxLiability.NetTaxLiability",
    "PartB_TTI.ComputationOfTaxLiability.TaxRelief.Section90",
    "PartB_TTI.ComputationOfTaxLiability.TaxRelief.Section91",
    // Interest and fee, itemised in the return, shown as one line here because
    // the computation states the aggregate the return carries forward.
    "PartB_TTI.ComputationOfTaxLiability.IntrstPay.IntrstPayUs234A",
    "PartB_TTI.ComputationOfTaxLiability.IntrstPay.IntrstPayUs234B",
    "PartB_TTI.ComputationOfTaxLiability.IntrstPay.IntrstPayUs234C",
    "PartB_TTI.ComputationOfTaxLiability.IntrstPay.LateFilingFee234F",
  ]);

  doc.unmapped = findUnmapped(body, src.consumed);
  return doc;
}

export { ayLabel };
