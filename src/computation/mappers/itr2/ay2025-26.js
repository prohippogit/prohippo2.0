/*
 * ITR-2, A.Y. 2025-26 → ComputationDocument.
 *
 * Read docs/computation-spec.md before changing anything here. §4 fixes the
 * section order, §5 the labels, §6 the treatment of nil and losses, §10 the
 * schema traps this mapper is written around.
 *
 * ITR-2 is filed by an individual or HUF with no business income, so it brings
 * three heads a firm's ITR-5 never exercises — salary, capital gains and the
 * regime choice under s.115BAC — and one thing that changes the whole shape of
 * the tax section: income taxed at special rates. For A.Y. 2025-26 the rates on
 * capital gains changed mid-year, so a single figure is split between the rate
 * that applied before the change and after it. The return states both, and both
 * are printed as stated: this mapper reads rates off Schedule SI rather than
 * asserting what the law was on any given date.
 *
 * The rule that governs every line: this is a presentation layer. Every figure
 * printed is a figure the return states.
 */
import { head, sub, subtotal, total, columnHeader, section, document } from "../../model.js";
import { reader, findUnmapped } from "../../unmapped.js";
import { pyLabel, longDate } from "../../format.js";
import {
  specialRateLabel, regimeLabel, viaLabel, viaOrder, capacityName, residentialStatus,
  personName, joinAddress, filingSection, isNonOrdinaryFiling, tdsSection, tdsNature,
} from "./shared.js";

const headRow = (label, ref, amount) =>
  head(label, amount, { ref, isLoss: amount < 0 ? true : undefined, amount: amount < 0 ? -amount : amount });

export function mapItr2Ay2025(body, ctx) {
  const src = reader(body);
  const notes = [];

  /* ---- who the assessee is ------------------------------------------------ */
  const gen1 = body.PartA_GEN1 || {};
  const personal = gen1.PersonalInfo || {};
  const filing = gen1.FilingStatus || {};
  const pan = String(personal.PAN || "").toUpperCase();
  const name = personName(personal.AssesseeName);

  src.claim("PartA_GEN1");
  src.claim("Verification");
  src.claim("Form_ITR2");
  src.claim("CreationInfo");

  const verification = body.Verification || {};
  const declaration = verification.Declaration || {};
  const filingSectionCode = filing.ReturnFileSec;
  const regime = regimeLabel(filing.OptOutNewTaxRegime);

  const facts = [
    { label: "Status", value: personal.Status === "H" ? "Hindu Undivided Family" : "Individual" },
    { label: "Date of birth", value: longDate(personal.DOB) },
    { label: "Residential status", value: residentialStatus(filing.ResidentialStatus) },
    { label: "Return filed under", value: filingSection(filingSectionCode) },
    // §10: the regime field's sense reads backwards, and every deduction below
    // depends on which one applies. State it rather than leaving it inferred.
    { label: "Tax regime", value: regime },
    { label: "Due date", value: longDate(filing.ItrFilingDueDate) },
  ];
  const contact = personal.Address || {};
  facts.push({ label: "E-mail / mobile", value: [contact.EmailAddress, contact.MobileNo && `+91 ${contact.MobileNo}`].filter(Boolean).join("\n") });

  const assessee = {
    name,
    pan,
    status: personal.Status === "H" ? "HUF" : "Individual",
    address: joinAddress(contact),
    email: contact.EmailAddress || "",
    mobile: contact.MobileNo ? String(contact.MobileNo) : "",
    residentialStatus: residentialStatus(filing.ResidentialStatus),
    dateOfFormation: personal.DOB || "",
    facts,
    partners: [],
  };

  if (isNonOrdinaryFiling(filingSectionCode)) {
    notes.push({ severity: "attention", text: `This computation is prepared from a return filed under ${filingSection(filingSectionCode)}.` });
  }

  /* ---- A. Salaries --------------------------------------------------------
   *
   * Statutory shape: salary u/s 17(1), the value of perquisites u/s 17(2) and
   * any profits in lieu u/s 17(3) make up gross salary; the allowances exempt
   * under s.10 come off it; then the two deductions s.16 allows.
   *
   * §10: the per-component breakdown inside NatureOfSalary uses a numeric code
   * table we deliberately do not decode. The captions above are the return's
   * own fields and are what a computation states; guessing that code "4" means
   * House Rent Allowance would put an unverified label on a signed document.
   */
  const salaryRows = [];
  const employers = src.peek("ScheduleS.Salaries") || [];
  const manyEmployers = employers.length > 1;

  employers.forEach((emp, i) => {
    const at = (f) => `ScheduleS.Salaries[${i}].Salarys.${f}`;
    const employerName = emp.NameOfEmployer || "";
    const gross = src.num(at("GrossSalary"));
    const salary17_1 = src.num(at("Salary"));
    const perquisites = src.num(at("ValueOfPerquisites"));
    const inLieu = src.num(at("ProfitsinLieuOfSalary"));

    if (manyEmployers) salaryRows.push(columnHeader(`Employer ${i + 1} — ${employerName}`, { ref: "" }));
    salaryRows.push(sub("Salary as per section 17(1)", salary17_1, {
      ref: i === 0 && !manyEmployers ? "Sch. S" : "",
      note: manyEmployers ? "" : employerName,
    }));
    if (perquisites) salaryRows.push(sub("Add: Value of perquisites u/s 17(2)", perquisites));
    if (inLieu) salaryRows.push(sub("Add: Profits in lieu of salary u/s 17(3)", inLieu));
    if (manyEmployers) salaryRows.push(subtotal(`Gross salary — employer ${i + 1}`, gross));
    // The per-component split and the individual perquisite lines are the same
    // money already stated above, itemised for the return's own schedule.
    src.claim(`ScheduleS.Salaries[${i}].Salarys.NatureOfSalary`);
    src.claim(`ScheduleS.Salaries[${i}].Salarys.NatureOfPerquisites`);
    src.claim(`ScheduleS.Salaries[${i}].AddressDetail`);
    src.num(at("IncomeNotified89A"));
    src.num(at("IncomeNotifiedOther89A"));
  });

  const grossSalary = src.num("ScheduleS.TotalGrossSalary");
  if (employers.length) salaryRows.push(subtotal("Gross Salary", grossSalary));

  // Allowances exempt under s.10, itemised by the code the return gives. These
  // codes ARE readable ("10(13A)"), unlike the salary-component ones.
  const exemptRows = src.claim("ScheduleS.AllwncExemptUs10.AllwncExemptUs10Dtls") || [];
  const hra = src.claim("ScheduleS.Section10_13A") || {};
  for (const e of exemptRows) {
    const amt = Number(e.SalOthAmount || 0);
    if (!amt) continue;
    const code = String(e.SalNatureDesc || "").trim();
    const isHra = code === "10(13A)";
    salaryRows.push(sub(
      isHra ? "Less: House rent allowance exempt u/s 10(13A)" : `Less: Allowance exempt u/s ${code === "OTH" ? "10" : code}`,
      amt,
      {
        note: isHra && hra.ActlHRARecv
          ? `HRA received ${Number(hra.ActlHRARecv).toLocaleString("en-IN")} · rent paid ${Number(hra.ActlRentPaid || 0).toLocaleString("en-IN")}`
          : (code === "OTH" ? e.SalOthNatOfInc || "" : ""),
      }
    ));
  }
  const totalExempt = src.num("ScheduleS.AllwncExtentExemptUs10");
  const netSalary = src.num("ScheduleS.NetSalary");
  if (totalExempt) salaryRows.push(subtotal("Net Salary", netSalary));

  const stdDeduction = src.num("ScheduleS.DeductionUnderSection16ia");
  const entertainment = src.num("ScheduleS.EntertainmntalwncUs16ii");
  const profTax = src.num("ScheduleS.ProfessionalTaxUs16iii");
  if (stdDeduction) salaryRows.push(sub("Less: Standard deduction u/s 16(ia)", stdDeduction, { ref: "Sec. 16(ia)" }));
  if (entertainment) salaryRows.push(sub("Less: Entertainment allowance u/s 16(ii)", entertainment, { ref: "Sec. 16(ii)" }));
  if (profTax) salaryRows.push(sub("Less: Tax on employment u/s 16(iii)", profTax, { ref: "Sec. 16(iii)" }));

  const salaryIncome = src.num("ScheduleS.TotIncUnderHeadSalaries");
  if (salaryRows.length) salaryRows.push(total("Income chargeable under the head Salaries", salaryIncome));
  src.num("ScheduleS.DeductionUS16");

  /* ---- B. Income from house property -------------------------------------- */
  const hpRows = [];
  const properties = src.peek("ScheduleHP.PropertyDetails") || [];
  const manyProps = properties.length > 1;
  properties.forEach((prop, i) => {
    const at = (f) => `ScheduleHP.PropertyDetails[${i}].Rentdetails.${f}`;
    const rent = prop.Rentdetails || {};
    const address = prop.AddressDetailWithZipCode?.AddrDetail || "";
    // "S" = self-occupied, "L" = let out, "D" = deemed let out.
    const use = String(prop.ifLetOut || "").toUpperCase();
    const selfOccupied = use === "S";

    if (manyProps) hpRows.push(columnHeader(`Property ${i + 1}${address ? ` — ${address}` : ""}`, { ref: "" }));

    if (selfOccupied) {
      // A self-occupied property has a nil annual value by law, so the working
      // is the interest alone. Saying so is clearer than an "Annual value — nil"
      // row that invites the reader to look for rent that cannot exist.
      hpRows.push(sub("Annual value of the self-occupied property", src.num(at("AnnualLetableValue")), {
        ref: i === 0 && !manyProps ? "Sch. HP" : "",
        note: [address, "self-occupied — annual value taken as nil"].filter(Boolean).join(" · "),
      }));
    } else {
      hpRows.push(sub("Annual letable value of the property", src.num(at("AnnualLetableValue")), {
        ref: i === 0 && !manyProps ? "Sch. HP" : "",
        note: address,
      }));
      const unrealised = src.num(at("RentNotRealized"));
      if (unrealised) hpRows.push(sub("Less: Rent not realised", unrealised));
      const localTaxes = src.num(at("LocalTaxes"));
      if (localTaxes) hpRows.push(sub("Less: Municipal taxes paid", localTaxes));
      const thirty = src.num(at("ThirtyPercentOfBalance"));
      if (thirty) hpRows.push(sub("Less: Standard deduction u/s 24(a) @ 30% of the annual value", thirty, { ref: "Sec. 24(a)" }));
    }

    const interest = src.num(at("Section24B.TotalInterestUs24B")) || src.num(at("IntOnBorwCap"));
    if (interest) {
      const lenders = (rent.Section24B?.Section24BDtls || []).map((l) => l.BankOrInstnName).filter(Boolean);
      hpRows.push(sub("Less: Interest on borrowed capital u/s 24(b)", interest, {
        ref: "Sec. 24(b)",
        note: lenders.length ? `Borrowed from ${lenders.join(", ")}` : undefined,
      }));
    }
    const own = src.num(at("IncomeOfHP"));
    if (manyProps) hpRows.push(subtotal(own < 0 ? `Loss from property ${i + 1}` : `Income from property ${i + 1}`, Math.abs(own), { isLoss: own < 0 }));

    src.restate([
      at("BalanceALV"), at("AnnualOfPropOwned"), at("TotalDeduct"), at("IntOnBorwCap"),
      ...(rent.Section24B?.Section24BDtls || []).map((_, li) => at(`Section24B.Section24BDtls[${li}].InterestUs24B`)),
    ]);
  });
  const hpTotal = src.num("ScheduleHP.TotalIncomeChargeableUnHP");
  if (hpRows.length) {
    hpRows.push(total(hpTotal < 0 ? "Loss from House Property" : "Income from House Property", Math.abs(hpTotal), { isLoss: hpTotal < 0 }));
  }

  /* ---- C. Capital gains ---------------------------------------------------
   *
   * The rates on both s.111A and s.112A changed part-way through the previous
   * year, so the return splits one gain between the rate that applied before
   * the change and the rate after it. We label those splits with the rates
   * Schedule SI states rather than with a date we assert.
   */
  const cgRows = [];
  const siRows = src.claim("ScheduleSI.SplCodeRateTax") || [];
  const rateFor = (code) => {
    const row = siRows.find((r) => String(r.SecCode) === code);
    return row && row.SplRatePercent ? `${row.SplRatePercent}%` : "";
  };

  const stcg = src.peek("ScheduleCGFor23.ShortTermCapGainFor23") || {};
  const stcgTotal = src.num("ScheduleCGFor23.ShortTermCapGainFor23.TotalSTCG");
  if (stcgTotal) {
    const equity = (stcg.EquityMFonSTT || [])[0]?.EquityMFonSTTDtls;
    if (equity) {
      cgRows.push(columnHeader("Short-term capital gains", { ref: "Sch. CG" }));
      cgRows.push(sub("Full value of consideration — equity shares / units (STT paid)", Number(equity.FullConsideration || 0)));
      cgRows.push(sub("Less: Cost of acquisition", Number(equity.DeductSec48?.AquisitCost || 0)));
      const improve = Number(equity.DeductSec48?.ImproveCost || 0);
      if (improve) cgRows.push(sub("Less: Cost of improvement", improve));
      const expense = Number(equity.DeductSec48?.ExpOnTrans || 0);
      if (expense) cgRows.push(sub("Less: Expenditure on transfer", expense));
    }
    cgRows.push(subtotal(`Short-term Capital Gain u/s 111A${rateFor("1A") ? ` (taxable at ${rateFor("1A")})` : ""}`, stcgTotal));
  }

  const ltcgTotal = src.num("ScheduleCGFor23.LongTermCapGain23.TotalLTCG");
  if (ltcgTotal) {
    const s112a = src.peek("Schedule112A") || {};
    cgRows.push(columnHeader("Long-term capital gains", { ref: "Sch. 112A" }));
    if (s112a.SaleValue112A) {
      cgRows.push(sub("Full value of consideration — equity shares / units u/s 112A", Number(s112a.SaleValue112A)));
      cgRows.push(sub("Less: Cost of acquisition", Number(s112a.Deductions112A || 0)));
    }
    const be = src.num("ScheduleCGFor23.LongTermCapGain23.SaleOfEquityShareUs112A.CapgainonAssetsTransferBE");
    const ae = src.num("ScheduleCGFor23.LongTermCapGain23.SaleOfEquityShareUs112A.CapgainonAssetsTransferAE");
    cgRows.push(subtotal("Long-term Capital Gain u/s 112A", ltcgTotal));
    if (be) cgRows.push(sub(`— taxable at ${rateFor("2A_BE") || "the pre-amendment rate"}`, be));
    if (ae) cgRows.push(sub(`— taxable at ${rateFor("2A") || "the amended rate"}`, ae));
  }

  const cgTotal = src.num("ScheduleCGFor23.TotScheduleCGFor23");
  if (cgRows.length) cgRows.push(total("Income chargeable under the head Capital Gains", cgTotal));
  src.num("ScheduleCGFor23.SumOfCGIncm");
  src.claim("ScheduleCGFor23.CurrYrLosses");
  src.claim("ScheduleCGFor23.AccruOrRecOfCG");
  src.claim("Schedule112A");
  src.claim("ScheduleCGFor23.LongTermCapGain23.SaleOfEquityShareUs112A");
  src.claim("ScheduleCGFor23.ShortTermCapGainFor23.EquityMFonSTT");

  /* ---- D. Income from other sources ---------------------------------------- */
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
  osLine("Family pension", "FamilyPension");
  osLine("Rent from machinery, plant or buildings", "RentFromMachPlantBldgs");
  osLine("Winnings from lotteries, crossword puzzles etc.", "LtryPzzlChrgblUs115BB");
  const otherInc = src.claim(`${osPath}.OthersInc.OthersIncDtls`) || [];
  for (const o of otherInc) {
    const amt = Number(o.OthAmount || 0);
    if (amt) osRows.push(sub(o.OthNatOfInc || "Other income", amt));
  }
  if (!otherInc.length) osLine("Any other income", "AnyOtherIncome");

  const osGross = src.num(`${osPath}.GrossIncChrgblTaxAtAppRate`);
  const osDeductions = src.num(`${osPath}.Deductions.TotDeductions`);
  const osNet = src.num("ScheduleOS.IncChargeable");
  if (osRows.length > 1 || osDeductions) osRows.push(subtotal("Gross income chargeable under Other Sources", osGross));
  if (osDeductions) osRows.push(sub("Less: Deductions u/s 57", osDeductions, { ref: "Sec. 57" }));
  if (osRows.length) osRows.push(total("Income chargeable under the head Other Sources", osNet));
  src.num("ScheduleOS.TotOthSrcNoRaceHorse");

  /* ---- E. Deductions under Chapter VI-A -----------------------------------
   *
   * §10: the return carries what was CLAIMED and what is ALLOWED after the
   * statutory caps, in two parallel blocks. The computation states the allowed
   * figure — that is what enters the total — and notes the claim wherever the
   * two differ. A s.80C claim of 2,28,513 restricted to 1,50,000 is exactly
   * what a reader wants to see; printing only one of the two hides it.
   */
  const claimed = src.claim("ScheduleVIA.UsrDeductUndChapVIA") || {};
  const allowed = src.claim("ScheduleVIA.DeductUndChapVIA") || {};
  const viaRows = [];
  const viaKeys = Object.keys(allowed)
    .filter((k) => k !== "TotalChapVIADeductions" && Number(allowed[k]) > 0)
    .sort((a, b) => viaOrder(a) - viaOrder(b));
  for (const k of viaKeys) {
    const amt = Number(allowed[k]);
    const askedFor = Number(claimed[k] || 0);
    viaRows.push(sub(viaLabel(k), amt, {
      ref: k.replace(/^Section/, ""),
      note: askedFor > amt
        ? `Claimed ${askedFor.toLocaleString("en-IN")}; restricted to the statutory limit`
        : undefined,
    }));
  }
  const viaTotal = src.num("ScheduleVIA.DeductUndChapVIA.TotalChapVIADeductions");
  if (viaRows.length) viaRows.push(total("Total deductions under Chapter VI-A", viaTotal));
  // Schedules 80C / 80D / 80G itemise what the summary above already totals.
  src.claim("Schedule80C");
  src.claim("Schedule80D");
  src.claim("Schedule80G");
  src.claim("Schedule80GGA");
  src.claim("Schedule80DD");
  src.claim("Schedule80U");

  /* ---- F. Computation of total income -------------------------------------- */
  const tiSalary = src.num("PartB-TI.Salaries");
  const tiHP = src.num("PartB-TI.IncomeFromHP");
  const tiCG = src.num("PartB-TI.CapGain.TotalCapGains");
  const tiOS = src.num("PartB-TI.IncFromOS.TotIncFromOS");
  const totalOfHeads = src.num("PartB-TI.TotalTI");
  const cyla = src.num("PartB-TI.CurrentYearLoss");
  const balanceAfterCyla = src.num("PartB-TI.BalanceAfterSetoffLosses");
  const bfla = src.num("PartB-TI.BroughtFwdLossesSetoff");
  const gti = src.num("PartB-TI.GrossTotalIncome");
  const chapterVIA = src.num("PartB-TI.DeductionsUnderScheduleVIA");
  const totalIncome = src.num("PartB-TI.TotalIncome");
  const splRateIncome = src.num("PartB-TI.IncChargeableTaxSplRates");
  const aggregateIncome = src.num("PartB-TI.AggregateIncome");

  const cylaHeads = [
    ["house property loss", src.num("ScheduleCYLA.TotalCurYr.TotHPlossCurYr")],
    ["loss from other sources", src.num("ScheduleCYLA.TotalCurYr.TotOthSrcLossNoRaceHorse")],
  ].filter(([, v]) => v !== 0).map(([l]) => l);
  const cylaLabel = cylaHeads.length ? cylaHeads.join(" and ") : "loss";

  const tiRows = [
    headRow("Income from Salaries", "Sch. S", tiSalary),
    headRow("Income from House Property", "Sch. HP", tiHP),
    // No business head. ITR-2 is the return for an assessee with no income
    // under that head, and its Part B-TI has no such row — printing a nil one
    // would state something the return does not.
    headRow("Capital Gains", "Sch. CG", tiCG),
    headRow("Income from Other Sources", "Sch. OS", tiOS),
    subtotal("Total of Heads of Income", totalOfHeads),
    cyla !== 0 && sub(`Less: Set-off of current year ${cylaLabel} u/s 71`, cyla, { ref: "Sch. CYLA" }),
    cyla !== 0 && sub("Balance after set-off of current year loss", balanceAfterCyla),
    bfla !== 0 && sub("Less: Set-off of brought forward loss u/s 72", bfla, { ref: "Sch. BFLA" }),
    subtotal("Gross Total Income", gti),
    sub("Less: Deductions under Chapter VI-A", chapterVIA, { ref: "Sch. VI-A" }),
    total("Total Income (rounded off u/s 288A)", totalIncome),
    splRateIncome !== 0 && sub("of which, income taxable at special rates", splRateIncome, { ref: "Sch. SI" }),
    splRateIncome !== 0 && sub("balance taxable at the rates in force", aggregateIncome),
  ];

  /* ---- G. Computation of tax liability -------------------------------------- */
  const onTI = src.claim("PartB_TTI.ComputationOfTaxLiability.TaxPayableOnTI") || {};
  const taxNormal = Number(onTI.TaxAtNormalRatesOnAggrInc ?? onTI.TaxAtNormalRates ?? 0);
  const taxSpecial = Number(onTI.TaxAtSpecialRates || 0);
  const taxOnTotal = Number(onTI.TaxPayableOnTotInc || 0);
  const rebate87A = src.num("PartB_TTI.ComputationOfTaxLiability.Rebate87A");
  const afterRebate = src.num("PartB_TTI.ComputationOfTaxLiability.TaxPayableOnRebate");
  const surcharge = src.num("PartB_TTI.ComputationOfTaxLiability.TotalSurcharge");
  const cess = src.num("PartB_TTI.ComputationOfTaxLiability.EducationCess");
  const grossTax = src.num("PartB_TTI.ComputationOfTaxLiability.GrossTaxPayable");
  const relief = src.num("PartB_TTI.ComputationOfTaxLiability.TaxRelief.TotTaxRelief");
  const interest = src.num("PartB_TTI.ComputationOfTaxLiability.IntrstPay.TotalIntrstPay");
  const aggregate = src.num("PartB_TTI.ComputationOfTaxLiability.AggregateTaxInterestLiability");

  const taxRows = [
    sub("Tax on income at the rates in force", taxNormal, { ref: "Para A, Sch. I" }),
  ];
  // One row per special rate the return actually used, captioned and rated from
  // Schedule SI rather than from any assumption about what the law says.
  for (const r of siRows) {
    const inc = Number(r.SplRateInc || 0);
    if (!inc) continue;
    taxRows.push(sub(`${specialRateLabel(r.SecCode)} — at ${r.SplRatePercent}%`, Number(r.SplRateIncTax || 0), {
      note: `on ${inc.toLocaleString("en-IN")}`,
      ref: "Sch. SI",
    }));
  }
  if (taxSpecial && !siRows.some((r) => Number(r.SplRateInc))) {
    taxRows.push(sub("Tax at special rates", taxSpecial, { ref: "Sch. SI" }));
  }
  taxRows.push(subtotal("Tax on Total Income", taxOnTotal));
  taxRows.push(sub("Less: Rebate u/s 87A", rebate87A, { ref: "Sec. 87A" }));
  if (rebate87A) taxRows.push(sub("Tax after rebate", afterRebate));
  taxRows.push(sub("Add: Surcharge", surcharge, { note: totalIncome <= 5000000 ? "Total income does not exceed ₹ 50 lakh" : undefined }));
  taxRows.push(sub("Add: Health & Education Cess @ 4%", cess));
  taxRows.push(subtotal("Gross Tax Liability", grossTax));
  taxRows.push(sub("Less: Relief u/s 89 / 90 / 90A / 91", relief));
  taxRows.push(sub("Add: Interest u/s 234A / 234B / 234C and fee u/s 234F", interest));
  taxRows.push(total("Total Tax and Interest Payable", aggregate));

  // §12: state why AMT is nil rather than omitting the line.
  const amtIncome = src.num("ScheduleAMT.AdjustedUnderSec115JC");
  const amtTax = src.num("ScheduleAMT.TaxPayableUnderSec115JC");
  src.claim("ScheduleAMT");
  src.claim("ScheduleAMTC");
  const amtFootnote = amtTax === 0 && amtIncome
    ? `Adjusted total income u/s 115JC is ${amtIncome.toLocaleString("en-IN")}; as no deduction under Chapter VI-A Part C or s.10AA has been claimed, Alternate Minimum Tax is Nil and no AMT credit arises.`
    : "";

  /* ---- H. Taxes paid -------------------------------------------------------- */
  const paidRows = [];
  const salaryTds = src.claim("ScheduleTDS1.TDSonSalary") || [];
  if (salaryTds.length) {
    paidRows.push(columnHeader("Tax Deducted at Source — TAN of Deductor", { ref: "Gross Receipt" }));
    for (const t of salaryTds) {
      const d = t.EmployerOrDeductorOrCollectDetl || {};
      paidRows.push(sub(d.TAN || "", Number(t.TotalTDSSal || 0), {
        note: [d.EmployerOrDeductorOrCollecterName, "Salary · Sec. 192"].filter(Boolean).join(" · "),
        cols: { ref: Number(t.IncChrgSal || 0).toLocaleString("en-IN") },
      }));
    }
  }
  const otherTds = src.claim("ScheduleTDS2.TDSOthThanSalaryDtls") || [];
  const byTanSection = new Map();
  for (const t of otherTds) {
    const sec = tdsSection(t.TDSSection);
    const key = `${t.TANOfDeductor}|${sec}`;
    const prev = byTanSection.get(key) || { tan: t.TANOfDeductor, section: sec, gross: 0, credit: 0, count: 0 };
    prev.gross += Number(t.GrossAmount || 0);
    prev.credit += Number(t.TaxDeductCreditDtls?.TaxClaimedOwnHands || 0);
    prev.count += 1;
    byTanSection.set(key, prev);
  }
  if (byTanSection.size && !salaryTds.length) paidRows.push(columnHeader("Tax Deducted at Source — TAN of Deductor", { ref: "Gross Receipt" }));
  for (const g of byTanSection.values()) {
    paidRows.push(sub(g.tan, g.credit, {
      note: [tdsNature(g.section), `Sec. ${g.section}`, g.count > 1 ? `${g.count} entries` : ""].filter(Boolean).join(" · "),
      cols: { ref: g.gross ? g.gross.toLocaleString("en-IN") : "" },
    }));
  }

  const tds = src.num("PartB_TTI.TaxPaid.TaxesPaid.TDS");
  const tcs = src.num("PartB_TTI.TaxPaid.TaxesPaid.TCS");
  const advance = src.num("PartB_TTI.TaxPaid.TaxesPaid.AdvanceTax");
  const selfAssessment = src.num("PartB_TTI.TaxPaid.TaxesPaid.SelfAssessmentTax");
  const totalPaid = src.num("PartB_TTI.TaxPaid.TaxesPaid.TotalTaxesPaid");
  src.claim("ScheduleTCS");
  src.claim("ScheduleIT");
  src.num("ScheduleTDS1.TotalTDSonSalaries");
  src.num("ScheduleTDS2.TotalTDSonOthThanSals");

  paidRows.push(subtotal("Total Tax Deducted at Source", tds, { ref: "Sch. TDS" }));
  paidRows.push(sub("Advance Tax Paid", advance, { ref: "Sch. IT" }));
  paidRows.push(sub("Self-Assessment Tax Paid", selfAssessment, { ref: "Sch. IT" }));
  paidRows.push(sub("Tax Collected at Source", tcs, { ref: "Sch. TCS" }));
  paidRows.push(subtotal("Total Taxes Paid", totalPaid));
  paidRows.push(sub("Less: Total Tax and Interest Payable", aggregate));

  const refundDue = src.num("PartB_TTI.Refund.RefundDue");
  const balPayable = src.num("PartB_TTI.TaxPaid.BalTaxPayable");
  paidRows.push(total(refundDue > 0 ? "Refund Due" : "Tax Payable", refundDue > 0 ? refundDue : balPayable));

  /* ---- I. Losses carried forward -------------------------------------------- */
  const cflRows = [];
  const carried = src.num("PartB-TI.LossesOfCurrentYearCarriedFwd");
  src.claim("ScheduleCFL");
  src.claim("ScheduleCYLA");
  src.claim("ScheduleBFLA");
  if (carried) {
    cflRows.push(columnHeader("Assessment Year / Nature of loss", { ref: "Nature" }));
    cflRows.push(sub(`A.Y. ${ctx.ay} · loss of the current year`, carried, { cols: { ref: "Carried forward" } }));
    cflRows.push(total("Total Loss Carried Forward", carried));
  }

  /* ---- the banner ----------------------------------------------------------- */
  let refund = null;
  let payable = null;
  if (refundDue > 0) {
    const banks = src.claim("PartB_TTI.Refund.BankAccountDtls.AddtnlBankDetails") || [];
    let bank = banks.find((b) => String(b.UseForRefund).toLowerCase() === "true");
    if (!bank && banks.length) {
      bank = banks[0];
      notes.push({ severity: "attention", text: "No bank account is flagged for the refund in the return; the first account listed is shown." });
    }
    refund = {
      amount: refundDue,
      bank: bank ? { name: bank.BankName || "", accountNo: bank.BankAccountNo || "", type: bank.AccountType || "", ifsc: bank.IFSCCode || "" } : null,
    };
  } else if (balPayable > 0) {
    payable = { amount: balPayable };
  }

  /* ---- notes ----------------------------------------------------------------- */
  notes.unshift({
    severity: "info",
    text: `This computation has been prepared from the ITR-2 return data (JSON) for A.Y. ${ctx.ay} and the figures correspond to Schedule S, Schedule HP, Schedule CG, Schedule OS, Schedule VI-A and Part B-TI / Part B-TTI of the return.`,
  });
  // Lower-case the first letter only. toLowerCase() on the whole label turns the
  // section reference into "s.115bac(1a)", which is not how a section is written
  // on a document somebody signs.
  if (regime) {
    notes.push({ severity: "info", text: `The return is filed under the ${regime[0].toLowerCase()}${regime.slice(1)}.` });
  }

  const restrictedTotal = Number(claimed.TotalChapVIADeductions || 0) - viaTotal;
  if (restrictedTotal > 0) {
    notes.push({
      severity: "attention",
      text: `Deductions under Chapter VI-A of ${Number(claimed.TotalChapVIADeductions).toLocaleString("en-IN")} were claimed, of which ${restrictedTotal.toLocaleString("en-IN")} was restricted by the statutory limits; ${viaTotal.toLocaleString("en-IN")} has been allowed.`,
    });
  }
  const exempt = src.num("ScheduleEI.TotalExemptInc");
  src.claim("ScheduleEI");
  src.claim("ScheduleTR1");
  if (exempt) notes.push({ severity: "info", text: `Exempt income reported under Schedule EI: ${exempt.toLocaleString("en-IN")}.` });

  /* ---- assemble --------------------------------------------------------------- */
  const sections = [
    section("SALARY", "Income from Salaries", salaryRows, { tone: "navy" }),
    section("HP", "Income from House Property", hpRows, { tone: "navy" }),
    section("CG", "Capital Gains", cgRows, { tone: "navy" }),
    section("OS", "Income from Other Sources", osRows, { tone: "navy" }),
    viaRows.length ? section("VIA", "Deductions under Chapter VI-A", viaRows, { tone: "navy" }) : null,
    section("TI", "Computation of Total Income", tiRows, { tone: "navy", omitIfAllNil: false }),
    section("TAX", "Computation of Tax Liability", taxRows, { tone: "gold", omitIfAllNil: false, footnote: amtFootnote }),
    section("TAXES_PAID", "Taxes Paid & Prepaid Taxes", paidRows, { tone: "navy", omitIfAllNil: false }),
    cflRows.length ? section("CFL", "Losses Carried Forward to Subsequent Years", cflRows, { tone: "navy" }) : null,
  ];

  const doc = document({
    meta: {
      form: "ITR2",
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
      name: declaration.AssesseeVerName || name,
      capacity: capacityName(verification.Capacity),
      pan: declaration.AssesseeVerPAN || pan,
      place: verification.Place || "",
      date: verification.Date || "",
    },
    unmapped: [],
  });

  /* Figures the return states more than once on the way to a total this mapper
     has already taken. Listed explicitly so a genuinely new field still
     surfaces — see §8. */
  src.restate([
    "ScheduleS.Salaries[0].Salarys.GrossSalary",
    "ScheduleS.AllwncExemptUs10.AllwncExemptUs10Dtls[0].SalOthAmount",
    "PartB-TI.CapGain.ShortTermLongTermTotal",
    "PartB-TI.CapGain.ShortTerm.TotalShortTerm",
    "PartB-TI.CapGain.LongTerm.TotalLongTerm",
    "PartB-TI.CapGain.ShortTerm.ShortTerm15Per",
    "PartB-TI.CapGain.ShortTerm.ShortTerm20Per",
    "PartB-TI.CapGain.ShortTerm.ShortTerm30Per",
    "PartB-TI.CapGain.LongTerm.LongTerm10Per",
    "PartB-TI.CapGain.LongTerm.LongTerm12_5Per",
    "PartB-TI.CapGain.LongTerm.LongTerm20Per",
    "PartB-TI.IncFromOS.OtherSrcThanOwnRaceHorse",
    "PartB-TI.IncChargeTaxSplRate111A112",
    "PartB-TI.DeemedIncomeUs115JC",
    "ScheduleOS.IncOthThanOwnRaceHorse.InterestGross",
    "ScheduleOS.IncOthThanOwnRaceHorse.DividendOthThan22e",
    "ScheduleOS.IncOthThanOwnRaceHorse.BalanceNoRaceHorse",
    "ScheduleOS.DividendIncUs115BBDA.DateRange.Upto15Of6",
    "ScheduleSI.TotSplRateInc",
    "ScheduleSI.TotSplRateIncTax",
    "PartB_TTI.ComputationOfTaxLiability.NetTaxLiability",
    "PartB_TTI.ComputationOfTaxLiability.TaxPayAfterCreditUs115JD",
    "PartB_TTI.ComputationOfTaxLiability.GrossTaxLiability",
    "PartB_TTI.ComputationOfTaxLiability.GrossTaxPay.TaxInc17",
  ]);

  doc.unmapped = findUnmapped(body, src.consumed);
  return doc;
}
