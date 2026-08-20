/*
 * The income ALREADY DECLARED for a year, read out of that year's filed ITR JSON.
 *
 * WHY THIS IS NOT src/computation/. That machinery builds a full Computation of
 * Total Income and is deliberately per-form and per-year (docs/computation-spec.md
 * §2), so it covers ITR-1/2/3/5 for the years somebody wrote a mapper for. A
 * block period is seven years long and an assessee who has been searched has
 * usually filed a different form in at least two of them — an ITR-4 in the early
 * years, an ITR-3 later. Refusing to read a year because no mapper exists for
 * its form would leave holes in the middle of the block period, which is the one
 * place the practitioner cannot work around.
 *
 * So this reads HEAD TOTALS AND NOTHING ELSE, the way functions/itrTaxPosition.js
 * reads four leaf figures for the s.143(1) variance. It never adds anything up,
 * never applies a rate, and never decides what income is: every number it returns
 * is printed in the return exactly as returned here. That is what makes it safe
 * against a form nobody has mapped — there is no arithmetic to get wrong, only a
 * field to find or not find.
 *
 * WHAT IT IS FOR. Under s.158BB(1) the undisclosed income of the block period is
 * the total income computed on the evidence found, REDUCED by the income already
 * disclosed in the returns filed. The figures here are that reduction. They are
 * the assessee's own declared position, so they belong in the ITR-B as filed —
 * never as something this tool recalculated.
 *
 * `null` means the return does not state the figure, and that is not the same as
 * nil. A head absent from ITR-1 (there is no capital gains head on it) reads
 * null, and the UI shows a dash rather than a zero somebody might mistake for a
 * declaration.
 */
import { filedSectionFrom } from "./partA.js";

// The form is the sole key under ITR — the same read src/computation/detect.js
// makes, because the wrapper key is what every schedule hangs off.
const FORMS = ["ITR1", "ITR2", "ITR3", "ITR4", "ITR5", "ITR6", "ITR7"];

/* A rupee figure out of a portal JSON. Absent, blank and the string "null" all
   mean "the return does not say". Mirrors num() in functions/itrTaxPosition.js. */
function num(v) {
  if (v === null || v === undefined || v === "" || v === "null") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function at(obj, path) {
  let cur = obj;
  for (const key of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[key];
  }
  return cur;
}

/* First container that carries any of these paths wins.
 *
 * The ORDER of `containers` is the substance of this module, not a fallback
 * chain. ITR-2/3/5/6/7 state head totals in Part B-TI; ITR-1 and ITR-4 state
 * the same quantities under their own IncomeDeductions block, and an ITR-3's
 * root additionally holds schedule data whose keys collide with the totals.
 * Part B-TI is therefore asked first everywhere, so a form that has both is
 * read from the authoritative half. */
function pick(containers, paths) {
  for (const c of containers) {
    for (const p of paths) {
      const v = num(at(c, p));
      if (v !== null) return v;
    }
  }
  return null;
}

function text(containers, paths) {
  for (const c of containers) {
    for (const p of paths) {
      const v = at(c, p);
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return "";
}

/** Human form name from the wrapper key: "ITR3" → "ITR-3". */
export const formLabel = (form) => String(form || "").replace(/^ITR/, "ITR-");

/**
 * → {
 *     form, formLabel, ay, pan, name, filedOn, ackNum,
 *     salary, houseProperty, business, capitalGains, otherSources,
 *     grossTotalIncome, chapterVIA, totalIncome,
 *     taxesPaid, balTaxPayable, refundDue,
 *   }
 * or null when the input is not a portal ITR JSON at all.
 */
export function readDeclared(itrJson) {
  const root = itrJson && itrJson.ITR;
  if (!root || typeof root !== "object") return null;

  const form = FORMS.find((f) => root[f] && typeof root[f] === "object") || "";
  if (!form) return null;
  const body = root[form];

  const formBlock = body[`Form_${form}`] || {};
  const startYear = Number(formBlock.AssessmentYear || 0);
  const ay = startYear >= 1900 ? `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}` : "";

  const income = [
    body["PartB-TI"],
    body.ITR1_IncomeDeductions,
    body.IncomeDeductions,
    body["PartB_TI"],
    body,
  ].filter((c) => c && typeof c === "object");

  const taxes = [
    body.PartB_TTI,
    body["PartB-TTI"],
    body.ITR1_TaxComputation,
    body,
  ].filter((c) => c && typeof c === "object");

  const identity = [
    body.PartA_GEN1 && body.PartA_GEN1.PersonalInfo,
    // ITR-5/6 name the same block OrgFirmInfo, because the assessee is a firm
    // rather than a person. Same keys inside it, so one candidate list covers
    // both once the container is listed.
    body.PartA_GEN1 && body.PartA_GEN1.OrgFirmInfo,
    body.PersonalInfo,
    body.PartA_GEN1,
    body.CreationInfo,
    body,
  ].filter((c) => c && typeof c === "object");

  const filing = [
    body.PartA_GEN1 && body.PartA_GEN1.FilingStatus,
    body.FilingStatus,
    body.PartB_TTI,
    body,
  ].filter((c) => c && typeof c === "object");

  return {
    form,
    formLabel: formLabel(form),
    ay,
    pan: text(identity, ["PAN", "AssesseePAN"]).toUpperCase(),
    name: text(identity, ["AssesseeName.SurNameOrOrgName", "Name", "AssesseeName"]),
    filedOn: text(filing, ["Verification.Date", "ReturnFileDt", "DateOfFiling"]),
    ackNum: text(filing, ["AcknowledgementNo", "AckNum"]),
    // The section the return was furnished under, where the code is one we can
    // evidence. Part A asks for it per year; partA.js holds the mapping.
    filedSection: filedSectionFrom(itrJson),

    /* Head totals. ITR-1 has no business or capital-gains head at all, so those
       read null on it — which is the truth, and prints as a dash. */
    salary: pick(income, ["Salaries", "IncomeFromSal"]),
    houseProperty: pick(income, ["IncomeFromHP", "TotalIncomeOfHP", "TotalIncomeChargeableUnHP"]),
    business: pick(income, ["ProfBusGain.TotProfBusGain", "IncomeFromBusinssProf", "ProfBusGain"]),
    capitalGains: pick(income, ["CapGain.TotalCapGains", "CapGain.ShortTermLongTermTotal"]),
    otherSources: pick(income, ["IncFromOS.TotIncFromOS", "IncomeOthSrc"]),

    grossTotalIncome: pick(income, ["GrossTotalIncome", "GrossTotIncome", "GrossTotIncomeIncLTCG112A"]),
    chapterVIA: pick(income, [
      "DeductionsUnderScheduleVIA",
      "DeductionsUndSchVIADtl.TotDeductUndSchVIA",
      "DeductUndChapVIA.TotalChapVIADeductions",
      "TotalChapVIADeductions",
    ]),
    totalIncome: pick(income, ["TotalIncome"]),

    taxesPaid: pick(taxes, ["TaxPaid.TaxesPaid.TotalTaxesPaid", "TaxesPaid.TotalTaxesPaid"]),
    balTaxPayable: pick(taxes, ["TaxPaid.BalTaxPayable", "BalTaxPayable"]),
    refundDue: pick(taxes, ["Refund.RefundDue", "RefundDue"]),
  };
}

/* The five heads, in the order the computation of total income runs. Exported
   so the form, the computation and the PDF all iterate one list — a head added
   here appears in all three, which is the point.

   Three names for each because three places need different lengths: `label` in
   a computation, `short` on a form control, `abbr` in a PDF column header seven
   columns wide. Working the abbreviation out at the call site is how one table
   ends up saying "HOUSE PROPER…". */
export const HEADS = [
  { key: "salary", label: "Salaries", short: "Salary", abbr: "SALARY" },
  { key: "houseProperty", label: "Income from house property", short: "House property", abbr: "HOUSE PROP." },
  { key: "business", label: "Profits and gains of business or profession", short: "Business", abbr: "BUSINESS" },
  { key: "capitalGains", label: "Capital gains", short: "Capital gains", abbr: "CAP. GAINS" },
  { key: "otherSources", label: "Income from other sources", short: "Other sources", abbr: "OTHER SRC." },
];

/** The declared total for a year, preferring the return's own stated total. */
export function declaredTotal(d) {
  if (!d) return null;
  if (d.totalIncome !== null && d.totalIncome !== undefined) return d.totalIncome;
  const heads = HEADS.map((h) => d[h.key]).filter((v) => v !== null && v !== undefined);
  if (!heads.length) return null;
  return heads.reduce((a, b) => a + b, 0);
}
