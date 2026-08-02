/*
 * ITR-2 → ComputationDocument. Shared by every assessment year we support.
 *
 * Each year has its own module (./ay2025-26.js, ./ay2026-27.js), its own
 * registration and its own golden test — §9's rule is that no year runs against
 * code nobody checked it against, not that identical code must be typed twice.
 * Where a year diverges, its module is where that goes.
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
 * are printed as stated: the workings read rates off Schedule SI rather than
 * asserting what the law was on any given date.
 *
 * The head workings themselves live in ../individual/heads.js, because ITR-3
 * carries the same schedules field for field and the two must not drift.
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

const headRow = (label, ref, amount) =>
  head(label, amount, { ref, isLoss: amount < 0 ? true : undefined, amount: amount < 0 ? -amount : amount });

export function buildItr2(body, ctx) {
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

  /* ---- A to E. the heads and Chapter VI-A ---------------------------------- */
  const salary = salaryRows(src);
  const hp = housePropertyRows(src);
  const siRows = src.claim("ScheduleSI.SplCodeRateTax") || [];
  const cg = capitalGainsRows(src);
  const os = otherSourcesRows(src);
  const via = chapterVIA(src);

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
  const chapterVIATotal = src.num("PartB-TI.DeductionsUnderScheduleVIA");
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
    sub("Less: Deductions under Chapter VI-A", chapterVIATotal, { ref: "Sch. VI-A" }),
    total("Total Income (rounded off u/s 288A)", totalIncome),
    splRateIncome !== 0 && sub("of which, income taxable at special rates", splRateIncome, { ref: "Sch. SI" }),
    splRateIncome !== 0 && sub("balance taxable at the rates in force", aggregateIncome),
  ];

  /* ---- G. Computation of tax liability -------------------------------------- */
  const tax = taxRows(src, { siRows, totalIncome });

  // §12: state why AMT is nil rather than omitting the line.
  const amtIncome = src.num("ScheduleAMT.AdjustedUnderSec115JC");
  const amtTax = src.num("ScheduleAMT.TaxPayableUnderSec115JC");
  src.claim("ScheduleAMT");
  src.claim("ScheduleAMTC");
  const amtFootnote = amtTax === 0 && amtIncome
    ? `Adjusted total income u/s 115JC is ${amtIncome.toLocaleString("en-IN")}; as no deduction under Chapter VI-A Part C or s.10AA has been claimed, Alternate Minimum Tax is Nil and no AMT credit arises.`
    : "";

  /* ---- H. Taxes paid -------------------------------------------------------- */
  const paidRows = taxesPaidRows(src, { aggregate: tax.aggregate });
  const banner = refundOrPayable(src, notes);
  paidRows.push(total(banner.refundDue > 0 ? "Refund Due" : "Tax Payable", banner.refundDue > 0 ? banner.refundDue : banner.balPayable));

  /* ---- I. Losses carried forward -------------------------------------------- */
  const cflRows = carriedForwardRows(src, ctx);
  src.num("PartB-TI.LossesOfCurrentYearCarriedFwd");
  src.claim("ScheduleCYLA");
  src.claim("ScheduleBFLA");

  /* ---- notes ----------------------------------------------------------------- */
  notes.unshift({
    severity: "info",
    text: `This computation has been prepared from the ITR-2 return data (JSON) for A.Y. ${ctx.ay} and the figures correspond to ${sourceSchedules(body)} and Part B-TI / Part B-TTI of the return.`,
  });
  // Lower-case the first letter only. toLowerCase() on the whole label turns the
  // section reference into "s.115bac(1a)", which is not how a section is written
  // on a document somebody signs.
  if (regime) {
    notes.push({ severity: "info", text: `The return is filed under the ${regime[0].toLowerCase()}${regime.slice(1)}.` });
  }

  const restrictedTotal = via.claimedTotal - via.allowedTotal;
  if (restrictedTotal > 0) {
    notes.push({
      severity: "attention",
      text: `Deductions under Chapter VI-A of ${via.claimedTotal.toLocaleString("en-IN")} were claimed, of which ${restrictedTotal.toLocaleString("en-IN")} was restricted by the statutory limits; ${via.allowedTotal.toLocaleString("en-IN")} has been allowed.`,
    });
  }
  const exempt = src.num("ScheduleEI.TotalExemptInc");
  src.claim("ScheduleEI");
  src.claim("ScheduleTR1");
  if (exempt) notes.push({ severity: "info", text: `Exempt income reported under Schedule EI: ${exempt.toLocaleString("en-IN")}.` });

  /* ---- assemble --------------------------------------------------------------- */
  const sections = [
    section("SALARY", "Income from Salaries", salary, { tone: "navy" }),
    section("HP", "Income from House Property", hp, { tone: "navy" }),
    section("CG", "Capital Gains", cg, { tone: "navy" }),
    section("OS", "Income from Other Sources", os, { tone: "navy" }),
    via.rows.length ? section("VIA", "Deductions under Chapter VI-A", via.rows, { tone: "navy" }) : null,
    section("TI", "Computation of Total Income", tiRows, { tone: "navy", omitIfAllNil: false }),
    section("TAX", "Computation of Tax Liability", tax.rows, { tone: "gold", omitIfAllNil: false, footnote: amtFootnote }),
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
