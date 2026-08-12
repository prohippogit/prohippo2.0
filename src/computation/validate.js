/*
 * Validation — docs/computation-spec.md §7.
 *
 * Every ITR JSON already states the answer. Part B-TI carries the assessee's own
 * total income, Part B-TTI the tax and the refund. So for every document we
 * build we assert our restatement against the return that produced it.
 *
 * This is the check that stops a mis-mapped set-off reaching a client. A
 * computation that does not tie to the return is worse than no computation, so
 * a failure raises rather than warns.
 */
import { findRow } from "./model.js";

export class ValidationError extends Error {
  constructor(failures) {
    super(
      `This computation doesn't reconcile with the filed return (${failures.length} check${failures.length > 1 ? "s" : ""} failed): ` +
      failures.map((f) => `${f.check} — return says ${f.expected}, computation says ${f.actual}`).join("; ")
    );
    this.name = "ValidationError";
    this.failures = failures;
  }
}

const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/* Where each form states the answer — docs/computation-spec.md §7.
 *
 * ITR-2, ITR-3 and ITR-5 carry Part B-TI and Part B-TTI. ITR-1 carries neither:
 * it states the same figures in two flat blocks of its own, with the taxes paid
 * and the refund at the top level. So the PATHS are per-form and the CHECKS
 * below are not — a second validate() for ITR-1 would be the one that stops
 * being updated when a check is added.
 *
 * A list of paths means "the first one the return actually carries", which is
 * how the refund has always been read: `NetRefundAdjust` where it exists,
 * `RefundDue` otherwise. Presence, not truth — nil is a figure (§3).
 */
const PART_B = {
  totalOfHeads: ["PartB-TI.TotalTI"],
  grossTotalIncome: ["PartB-TI.GrossTotalIncome"],
  totalIncome: ["PartB-TI.TotalIncome"],
  grossTax: ["PartB_TTI.ComputationOfTaxLiability.GrossTaxPayable"],
  aggregate: ["PartB_TTI.ComputationOfTaxLiability.AggregateTaxInterestLiability"],
  totalTaxesPaid: ["PartB_TTI.TaxPaid.TaxesPaid.TotalTaxesPaid"],
  refund: ["PartB_TTI.TaxPaid.NetRefundAdjust", "PartB_TTI.Refund.RefundDue"],
  payable: ["PartB_TTI.TaxPaid.BalTaxPayable"],
  /* Part B-TI floors a negative head at nil and sends the loss through Schedule
     CYLA instead, so a working closing at a loss is checked against the return's
     own statement of that loss. See check 8. */
  floorsNegativeHeads: true,
  headLoss: {
    HP: "ScheduleCYLA.TotalCurYr.TotHPlossCurYr",
    BP: "ScheduleCYLA.TotalCurYr.TotBusLoss",
  },
};

const ITR1 = {
  /* One figure answers checks 1 and 2 on this form: it allows no set-off, so a
     house property loss is already inside gross total income as a negative head
     and there is no separate total of heads. Both checks still run — one sums the
     rows we built, the other reads the row we printed (§7). */
  totalOfHeads: ["ITR1_IncomeDeductions.GrossTotIncomeIncLTCG112A", "ITR1_IncomeDeductions.GrossTotIncome"],
  grossTotalIncome: ["ITR1_IncomeDeductions.GrossTotIncomeIncLTCG112A", "ITR1_IncomeDeductions.GrossTotIncome"],
  totalIncome: ["ITR1_IncomeDeductions.TotalIncome"],
  grossTax: ["ITR1_TaxComputation.GrossTaxLiability"],
  aggregate: ["ITR1_TaxComputation.TotTaxPlusIntrstPay"],
  totalTaxesPaid: ["TaxPaid.TaxesPaid.TotalTaxesPaid"],
  refund: ["Refund.RefundDue"],
  payable: ["TaxPaid.BalTaxPayable"],
  /* Nothing is floored here, because there is nothing to floor into: the loss a
     house property leaves is set off within Part B itself, already capped by the
     return at the 2,00,000 s.71 allows. So the head row carries the loss and
     check 8 compares it directly. */
  floorsNegativeHeads: false,
  headLoss: {},
};

const oracleFor = (body) => (body && body.ITR1_IncomeDeductions ? ITR1 : PART_B);

const at = (body, path) => String(path).split(".").reduce((o, k) => (o == null ? o : o[k]), body);

/** The first of these paths the return actually carries; undefined if none does. */
const stated = (body, paths) => {
  for (const p of paths || []) {
    const v = at(body, p);
    if (v !== undefined) return v;
  }
  return undefined;
};

/**
 * @returns { ok, failures: [{ check, expected, actual }] }
 *
 * Exact-match on integers throughout. Returns deal in whole rupees, and a
 * tolerance here would hide precisely the class of error this is for.
 */
export function validate(doc, body) {
  const oracle = oracleFor(body);
  const says = (key) => stated(body, oracle[key]);
  const failures = [];

  const check = (name, expected, actual) => {
    if (n(expected) !== n(actual)) failures.push({ check: name, expected: n(expected), actual: n(actual) });
  };
  const rowAmount = (sectionId, labelPrefix) => {
    const r = findRow(doc, sectionId, labelPrefix);
    if (!r) return null;
    // A loss row carries its magnitude with isLoss set; compare signed values.
    return r.isLoss && r.amount > 0 ? -r.amount : r.amount;
  };

  // 1. The heads sum to the return's own total of heads.
  const tiSection = doc.sections.find((s) => s.id === "TI");
  if (tiSection) {
    const headSum = tiSection.rows.filter((r) => r.kind === "head")
      .reduce((sum, r) => sum + (r.isLoss && r.amount > 0 ? -n(r.amount) : n(r.amount)), 0);
    check("Total of heads of income", says("totalOfHeads"), headSum);
  }

  // 2-3. Gross total income and total income.
  check("Gross Total Income", says("grossTotalIncome"), rowAmount("TI", "Gross Total Income"));
  check("Total Income", says("totalIncome"), rowAmount("TI", "Total Income"));

  // 4-5. Tax: the gross liability and the final payable figure.
  //
  // Note the two similarly-named fields on the forms that carry Part B-TTI.
  // `TaxPayableOnTI.GrossTaxLiability` is tax on total income at normal + special
  // rates, plus surcharge and cess. `GrossTaxPayable`, one level up, is that
  // figure after the s.115JC deemed-income comparison — i.e. the higher of the
  // normal computation and AMT. The computation's "Gross Tax Liability" row
  // states the latter, because that is the figure the rest of Part B-TTI carries
  // forward. ITR-1 has no AMT and one field, `GrossTaxLiability`.
  check("Gross Tax Liability", says("grossTax"), rowAmount("TAX", "Gross Tax Liability"));
  check("Total Tax and Interest Payable", says("aggregate"), rowAmount("TAX", "Total Tax and Interest Payable"));

  // 6. Prepaid taxes tie to the return's own total.
  const paidSection = doc.sections.find((s) => s.id === "TAXES_PAID");
  if (paidSection) {
    const paidRow = findRow(doc, "TAXES_PAID", "Total Taxes Paid");
    check("Total Taxes Paid", says("totalTaxesPaid"), paidRow && paidRow.amount);
  }

  // 7. The banner: refund due, or tax payable. Never both.
  if (doc.refund) check("Refund due", says("refund"), doc.refund.amount);
  if (doc.payable) check("Balance tax payable", says("payable"), doc.payable.amount);
  if (doc.refund && doc.payable) {
    failures.push({ check: "Refund and payable are mutually exclusive", expected: "one of them", actual: "both" });
  }

  // 8. Each head-working section closes at the figure the TI section carries.
  //
  // With one wrinkle that is ITD's design, not ours: Part B-TI floors a negative
  // head at nil. A firm that closes at a loss of 185 has TotProfBusGain: 0 and
  // the loss travels through Schedule CYLA instead. So a working that closes at
  // a loss is checked differently — the TI row must be nil, AND the loss must
  // match the return's own statement of it. Asserting only the first half would
  // pass a computation that lost the loss altogether, which is exactly the
  // silent omission §8 exists to prevent.
  //
  // ITR-1 does not floor anything: it has no Part B-TI and no Schedule CYLA, and
  // the loss a house property leaves sits in gross total income as a negative
  // head. There the closing figure and the head row must simply agree.
  const WORKINGS = [
    ["SALARY", "Income from Salaries"],
    ["HP", "Income from House Property"],
    ["BP", "Profits and Gains of Business or Profession"],
    ["CG", "Capital Gains"],
    ["OS", "Income from Other Sources"],
  ];
  for (const [id, tiLabel] of WORKINGS) {
    const s = doc.sections.find((x) => x.id === id);
    if (!s) continue;
    const closing = s.rows.filter((r) => r.kind === "total").pop();
    if (!closing) continue;
    const closingValue = closing.isLoss && closing.amount > 0 ? -n(closing.amount) : n(closing.amount);
    const tiValue = rowAmount("TI", tiLabel);

    if (closingValue >= 0 || !oracle.floorsNegativeHeads) {
      check(`${id} working ties to the head`, tiValue, closingValue);
      continue;
    }

    check(`${id} closes at a loss, so the head is nil in Part B-TI`, 0, tiValue);
    const lossPath = oracle.headLoss[id];
    if (lossPath) check(`${id} loss matches the return`, at(body, lossPath), -closingValue);
  }

  return { ok: failures.length === 0, failures };
}
