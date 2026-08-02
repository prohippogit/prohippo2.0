/*
 * ITR-3 → ComputationDocument. Shared by every assessment year we support.
 *
 * Each year still has its own module (./ay2025-26.js, ./ay2024-25.js), its own
 * registration and its own golden test — §9's rule is that a mapper must never
 * be run against a year nobody checked it against, not that identical code must
 * be typed twice. Where a year genuinely diverges, its module is the place that
 * divergence goes, and the golden test for the other year is what proves the
 * change did not reach it.
 *
 * Verified across A.Y. 2024-25 and 2025-26: the schedules this reads are the
 * same fields in both. What differs between those years is the DATA — the
 * capital-gains rate buckets, the standard deduction, the slab table — and all
 * of it is read from the return rather than assumed.
 *
 * Read docs/computation-spec.md before changing anything here. §4 fixes the
 * section order, §5 the labels, §6 the treatment of nil and losses, §10 the
 * schema traps this mapper is written around.
 *
 * ITR-3 is the widest of the individual returns: the same assessee may have
 * salary, house property, a business or profession, capital gains and other
 * sources, in any combination. So nothing here assumes a shape. The head
 * workings come from ../individual/heads.js, which ITR-2 shares, and each one
 * emits rows only for what the return actually carries; the business head, which
 * ITR-2 has no schedule for, is in ./businessHead.js.
 *
 * Two things ITR-2 never has to deal with and this mapper does:
 *
 *   Agricultural income. Exempt, but aggregated with total income to fix the
 *   rate, and then backed out through a rebate. Both movements are printed, or
 *   the tax looks computed on the wrong figure.
 *
 *   Partnership. A partner's interest, salary, bonus and commission from a firm
 *   are business income that no profit & loss account carries, while the share of
 *   the firm's profit is exempt u/s 10(2A). Schedule IF names the firms.
 *
 * The rule that governs every line: this is a presentation layer. Every figure
 * printed is a figure the return states.
 */
import { head, sub, subtotal, total, columnHeader, section, document } from "../../model.js";
import { reader, findUnmapped } from "../../unmapped.js";
import { pyLabel, longDate } from "../../format.js";
import {
  regimeLabel, capacityName, residentialStatus, personName, joinAddress,
  filingSection, isNonOrdinaryFiling, sourceSchedules,
} from "../individual/labels.js";
import {
  salaryRows, housePropertyRows, capitalGainsRows, otherSourcesRows,
  chapterVIA, taxRows, taxesPaidRows, refundOrPayable, carriedForwardRows,
} from "../individual/heads.js";
import { businessRows } from "./businessHead.js";

const inr = (v) => Number(v || 0).toLocaleString("en-IN");

const headRow = (label, ref, amount) =>
  head(label, amount, { ref, isLoss: amount < 0 ? true : undefined, amount: amount < 0 ? -amount : amount });

export function buildItr3(body, ctx) {
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
  src.claim("Form_ITR3");
  src.claim("CreationInfo");

  const verification = body.Verification || {};
  const declaration = verification.Declaration || {};
  const filingSectionCode = filing.ReturnFileSec;
  const regime = regimeLabel(filing);

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

  const businesses = (body.PartA_GEN2?.NatOfBus?.NatureOfBusiness || [])
    .map((b) => b.TradeName1).filter(Boolean);
  if (businesses.length) facts.push({ label: businesses.length > 1 ? "Businesses" : "Business", value: businesses.join("\n") });

  const directorships = (filing.CompDirectorPrvYr?.CompDirectorPrvYrDtls || []).map((d) => d.NameOfCompany).filter(Boolean);
  if (directorships.length) {
    facts.push({ label: "Directorships", value: `Director in ${directorships.length} ${directorships.length > 1 ? "companies" : "company"}` });
  }

  // Tax audit is a fact about the return that changes its due date and who has
  // to sign what, so it belongs in the particulars rather than in a footnote.
  const audit = body.PartA_GEN2?.AuditInfo || {};
  if (String(audit.LiableSec44ABflg || "").toUpperCase() === "Y") {
    facts.push({ label: "Tax audit", value: "Accounts audited u/s 44AB" });
  }

  const contact = personal.Address || {};
  facts.push({ label: "E-mail / mobile", value: [contact.EmailAddress, contact.MobileNo && `+91 ${contact.MobileNo}`].filter(Boolean).join("\n") });

  /* Schedule IF — the firms the assessee is a partner in. The card is the same
     one ITR-5 uses for a firm's partners, read the other way round. */
  const firms = (src.claim("ScheduleIF.PartnerFirmDetails") || []).map((f) => ({
    name: f.FirmName || "",
    pan: f.FirmPAN || "",
    detail: [
      f.FirmPAN && `PAN ${f.FirmPAN}`,
      f.ProfitSharePercent != null ? `Share ${f.ProfitSharePercent}%` : "",
      Number(f.FirmCapBalOn31Mar) ? `Capital balance ${inr(f.FirmCapBalOn31Mar)}` : "",
      String(f.IsLiableToAudit || "").toUpperCase() === "Y" ? "audited u/s 44AB" : "",
    ].filter(Boolean).join(" · "),
  }));
  src.num("ScheduleIF.TotalProfitShareAmt");
  src.num("ScheduleIF.TotalFirmCapBalOn31Mar");
  // The same firms are listed a second time in the filing status block.
  src.claim("PartA_GEN1.FilingStatus.PartnerInFirm");

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
    constitutionTitle: firms.length ? "Partner in firms" : "",
    partners: firms,
  };

  if (isNonOrdinaryFiling(filingSectionCode)) {
    notes.push({ severity: "attention", text: `This computation is prepared from a return filed under ${filingSection(filingSectionCode)}.` });
  }

  /* ---- A to F. the heads and Chapter VI-A ---------------------------------- */
  const salary = salaryRows(src);
  const hp = housePropertyRows(src);
  const bp = businessRows(src);
  const siRows = src.claim("ScheduleSI.SplCodeRateTax") || [];
  const cg = capitalGainsRows(src);
  const os = otherSourcesRows(src);
  const via = chapterVIA(src);

  /* ---- G. Computation of total income -------------------------------------- */
  const tiSalary = src.num("PartB-TI.Salaries");
  const tiHP = src.num("PartB-TI.IncomeFromHP");
  const tiBP = src.num("PartB-TI.ProfBusGain.TotProfBusGain");
  const tiCG = src.num("PartB-TI.CapGain.TotalCapGains");
  const tiOS = src.num("PartB-TI.IncFromOS.TotIncFromOS");
  const totalOfHeads = src.num("PartB-TI.TotalTI");
  const cyla = src.num("PartB-TI.CurrentYearLoss");
  const balanceAfterCyla = src.num("PartB-TI.BalanceAfterSetoffLosses");
  const bfla = src.num("PartB-TI.BroughtFwdLossesSetoff");
  const gti = src.num("PartB-TI.GrossTotalIncome");
  const chapterVIATotal = src.num("PartB-TI.DeductionsUndSchVIADtl.TotDeductUndSchVIA");
  const deduction10AA = src.num("PartB-TI.DeductionsUnder10Aor10AA");
  const totalIncome = src.num("PartB-TI.TotalIncome");
  const splRateIncome = src.num("PartB-TI.IncChargeableTaxSplRates");
  const agriForRate = src.num("PartB-TI.NetAgricultureIncomeOrOtherIncomeForRate");
  const aggregateIncome = src.num("PartB-TI.AggregateIncome");

  const cylaHeads = [
    ["house property loss", src.num("ScheduleCYLA.TotalCurYr.TotHPlossCurYr")],
    // TotalCurYr states the loss as TotBusLoss; TotBusLossSetoff is a field of
    // TotalLossSetOff, so reading it here left every business loss unnamed.
    ["business loss", src.num("ScheduleCYLA.TotalCurYr.TotBusLoss")],
    ["loss from other sources", src.num("ScheduleCYLA.TotalCurYr.TotOthSrcLossNoRaceHorse")],
  ].filter(([, v]) => v !== 0).map(([l]) => l);
  const cylaLabel = cylaHeads.length ? cylaHeads.join(" and ") : "loss";

  const tiRows = [
    headRow("Income from Salaries", "Sch. S", tiSalary),
    headRow("Income from House Property", "Sch. HP", tiHP),
    headRow("Profits and Gains of Business or Profession", "Sch. BP", tiBP),
    headRow("Capital Gains", "Sch. CG", tiCG),
    headRow("Income from Other Sources", "Sch. OS", tiOS),
    subtotal("Total of Heads of Income", totalOfHeads),
    cyla !== 0 && sub(`Less: Set-off of current year ${cylaLabel} u/s 71`, cyla, { ref: "Sch. CYLA" }),
    cyla !== 0 && sub("Balance after set-off of current year loss", balanceAfterCyla),
    bfla !== 0 && sub("Less: Set-off of brought forward loss u/s 72", bfla, { ref: "Sch. BFLA" }),
    subtotal("Gross Total Income", gti),
    deduction10AA !== 0 && sub("Less: Deduction u/s 10AA", deduction10AA, { ref: "Sec. 10AA" }),
    sub("Less: Deductions under Chapter VI-A", chapterVIATotal, { ref: "Sch. VI-A" }),
    total("Total Income (rounded off u/s 288A)", totalIncome),
    splRateIncome !== 0 && sub("of which, income taxable at special rates", splRateIncome, { ref: "Sch. SI" }),
    // What is left is what the slab rates are applied to, and it is the figure
    // the tax section's first row is computed on. Without it a reader has to
    // subtract two numbers to check the largest line in the document.
    splRateIncome !== 0 && agriForRate === 0 && sub("balance taxable at the rates in force", aggregateIncome),
    // Agricultural income is exempt. It appears here only because s.2(13) of the
    // Finance Act aggregates it to fix the rate, and the tax section takes it
    // back out. Showing the aggregate without saying why would read as a charge.
    agriForRate !== 0 && sub("Add: Net agricultural income, aggregated for rate purposes only", agriForRate, {
      ref: "Sch. EI",
      note: "Exempt u/s 10(1); it does not enter total income",
    }),
    agriForRate !== 0 && sub("Aggregate income on which the rate is determined", aggregateIncome),
  ];

  /* ---- H. Computation of tax liability -------------------------------------- */
  const tax = taxRows(src, { siRows, totalIncome });

  // §12: state why AMT is nil rather than omitting the line. On ITR-3 the AMT
  // schedule is the assessee's own, and the credit table below it carries what
  // earlier years left behind.
  const amtIncome = src.num("ScheduleAMT.AdjustedUnderSec115JC");
  const amtTax = src.num("ScheduleAMT.TaxPayableUnderSec115JC");
  const amtCreditAvailable = src.num("ScheduleAMTC.AmtTaxCreditAvailable");
  src.claim("ScheduleAMT");
  src.claim("ScheduleAMTC");
  let amtFootnote = "";
  if (amtTax === 0 && amtIncome) {
    amtFootnote = `Adjusted total income u/s 115JC is ${inr(amtIncome)}; as no deduction under Chapter VI-A Part C or s.10AA has been claimed, Alternate Minimum Tax is Nil and no AMT credit arises.`;
  } else if (amtTax === 0 && amtCreditAvailable) {
    amtFootnote = `Alternate Minimum Tax u/s 115JC is Nil, so tax under the regular provisions of ${inr(amtCreditAvailable)} is payable.`;
  }

  /* ---- I. Taxes paid -------------------------------------------------------- */
  const paidRows = taxesPaidRows(src, { aggregate: tax.aggregate });
  const banner = refundOrPayable(src, notes);
  // A return can close level: CPC neither refunds nor demands a few rupees, and
  // the return states nil against both. Saying so beats a "Refund Due — nil" row
  // that reads like a rejected claim.
  if (banner.refundDue > 0 || banner.balPayable > 0) {
    paidRows.push(total(banner.refundDue > 0 ? "Refund Due" : "Tax Payable", banner.refundDue > 0 ? banner.refundDue : banner.balPayable));
  } else {
    paidRows.push(total("Nothing further payable or refundable", 0));
  }

  /* ---- J. Losses carried forward -------------------------------------------- */
  const cfl = carriedForwardRows(src, ctx);
  const cflRows = cfl.rows || [];
  src.num("PartB-TI.LossesOfCurrentYearCarriedFwd");
  src.claim("ScheduleCYLA");
  src.claim("ScheduleBFLA");

  /* ---- notes ----------------------------------------------------------------- */
  notes.unshift({
    severity: "info",
    text: `This computation has been prepared from the ITR-3 return data (JSON) for A.Y. ${ctx.ay} and the figures correspond to ${sourceSchedules(body)} and Part B-TI / Part B-TTI of the return.`,
  });
  if (regime) {
    notes.push({ severity: "info", text: `The return is filed under the ${regime[0].toLowerCase()}${regime.slice(1)}.` });
  }

  const restrictedTotal = via.claimedTotal - via.allowedTotal;
  if (restrictedTotal > 0) {
    notes.push({
      severity: "attention",
      text: `Deductions under Chapter VI-A of ${inr(via.claimedTotal)} were claimed, of which ${inr(restrictedTotal)} was restricted by the statutory limits; ${inr(via.allowedTotal)} has been allowed.`,
    });
  }

  const agriGross = src.num("ScheduleEI.GrossAgriRecpt");
  const exempt = src.num("ScheduleEI.TotalExemptInc");
  src.claim("ScheduleEI");
  src.claim("ScheduleTR1");
  src.claim("ScheduleFA");
  src.claim("ScheduleSPI");
  src.claim("ScheduleTPSA");
  if (agriGross) {
    notes.push({
      severity: "info",
      text: `Net agricultural income of ${inr(agriForRate || agriGross)} is exempt u/s 10(1) and has been aggregated with total income only to determine the rate of tax, the tax on it being allowed as a rebate above.`,
    });
  } else if (exempt) {
    notes.push({ severity: "info", text: `Exempt income reported under Schedule EI: ${inr(exempt)}.` });
  }
  if (firms.length) {
    notes.push({
      severity: "info",
      text: `The assessee is a partner in ${firms.length} firm${firms.length > 1 ? "s" : ""}. Interest, salary, bonus and commission from a firm are chargeable under the head Business or Profession; the share of the firm's profit is exempt u/s 10(2A).`,
    });
  }

  /* ---- assemble --------------------------------------------------------------- */
  const sections = [
    section("SALARY", "Income from Salaries", salary, { tone: "navy" }),
    section("HP", "Income from House Property", hp, { tone: "navy" }),
    section("BP", "Profits and Gains of Business or Profession", bp, { tone: "navy" }),
    section("CG", "Capital Gains", cg, { tone: "navy" }),
    section("OS", "Income from Other Sources", os, { tone: "navy" }),
    via.rows.length ? section("VIA", "Deductions under Chapter VI-A", via.rows, { tone: "navy" }) : null,
    section("TI", "Computation of Total Income", tiRows, { tone: "navy", omitIfAllNil: false }),
    section("TAX", "Computation of Tax Liability", tax.rows, { tone: "gold", omitIfAllNil: false, footnote: amtFootnote }),
    section("TAXES_PAID", "Taxes Paid & Prepaid Taxes", paidRows, { tone: "navy", omitIfAllNil: false }),
    cflRows.length ? section("CFL", "Losses Carried Forward to Subsequent Years", cflRows, { tone: "navy", layout: "table", footnote: cfl.note }) : null,
  ];

  const doc = document({
    meta: {
      form: "ITR3",
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

  /* Figures the return states more than once on the way to a total this mapper
     has already taken. Listed explicitly so a genuinely new field still
     surfaces — see §8. */
  src.restate([
    "ScheduleS.Salaries[0].Salarys.GrossSalary",
    "ScheduleS.AllwncExemptUs10.AllwncExemptUs10Dtls[0].SalOthAmount",
    "PartB-TI.ProfBusGain.ProfGainNoSpecBus",
    "PartB-TI.ProfBusGain.ProfGainSpecBus",
    "PartB-TI.ProfBusGain.ProfGainSpecifiedBus",
    "PartB-TI.ProfBusGain.ProfIncome115BBF",
    "PartB-TI.CapGain.ShortTermLongTermTotal",
    "PartB-TI.CapGain.ShortTerm.TotalShortTerm",
    "PartB-TI.CapGain.LongTerm.TotalLongTerm",
    // Part B-TI's rate buckets. Which of these exist varies by year — A.Y.
    // 2024-25 has no 20% short-term or 12.5% long-term bucket, A.Y. 2025-26
    // added both — and the composition they describe is already shown in the
    // capital-gains working and again in the tax section from Schedule SI.
    "PartB-TI.CapGain.ShortTerm.ShortTerm15Per",
    "PartB-TI.CapGain.ShortTerm.ShortTerm20Per",
    "PartB-TI.CapGain.ShortTerm.ShortTerm30Per",
    "PartB-TI.CapGain.ShortTerm.ShortTermAppRate",
    "PartB-TI.CapGain.LongTerm.LongTerm10Per",
    "PartB-TI.CapGain.LongTerm.LongTerm12_5Per",
    "PartB-TI.CapGain.LongTerm.LongTerm20Per",
    "PartB-TI.IncFromOS.OtherSrcThanOwnRaceHorse",
    "PartB-TI.IncChargeTaxSplRate111A112",
    "PartB-TI.DeemedIncomeUs115JC",
    "PartB-TI.DeductionsUndSchVIADtl.PartBchapterVIA",
    "PartB-TI.DeductionsUndSchVIADtl.PartCchapterVIA",
    "ScheduleOS.IncOthThanOwnRaceHorse.InterestGross",
    "ScheduleOS.IncOthThanOwnRaceHorse.DividendOthThan22e",
    "ScheduleOS.IncOthThanOwnRaceHorse.BalanceNoRaceHorse",
    "ScheduleOS.IncOthThanOwnRaceHorse.Deductions.Expenses",
    "ScheduleEI.NetAgriIncOrOthrIncRule7",
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
