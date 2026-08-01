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

/**
 * @returns { ok, failures: [{ check, expected, actual }] }
 *
 * Exact-match on integers throughout. Returns deal in whole rupees, and a
 * tolerance here would hide precisely the class of error this is for.
 */
export function validate(doc, body) {
  const ti = body["PartB-TI"] || {};
  const tti = body.PartB_TTI || {};
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

  // 1. The five heads sum to the return's own total of heads.
  const tiSection = doc.sections.find((s) => s.id === "TI");
  if (tiSection) {
    const headSum = tiSection.rows.filter((r) => r.kind === "head")
      .reduce((sum, r) => sum + (r.isLoss && r.amount > 0 ? -n(r.amount) : n(r.amount)), 0);
    check("Total of heads of income", ti.TotalTI, headSum);
  }

  // 2-3. Gross total income and total income.
  check("Gross Total Income", ti.GrossTotalIncome, rowAmount("TI", "Gross Total Income"));
  check("Total Income", ti.TotalIncome, rowAmount("TI", "Total Income"));

  // 4-5. Tax: the gross liability and the final payable figure.
  //
  // Note the two similarly-named fields. `TaxPayableOnTI.GrossTaxLiability` is
  // tax on total income at normal + special rates, plus surcharge and cess.
  // `GrossTaxPayable`, one level up, is that figure after the s.115JC deemed-
  // income comparison — i.e. the higher of the normal computation and AMT. The
  // computation's "Gross Tax Liability" row states the latter, because that is
  // the figure the rest of Part B-TTI carries forward.
  const tax = tti.ComputationOfTaxLiability || {};
  check("Gross Tax Liability", tax.GrossTaxPayable, rowAmount("TAX", "Gross Tax Liability"));
  check("Total Tax and Interest Payable", tax.AggregateTaxInterestLiability, rowAmount("TAX", "Total Tax and Interest Payable"));

  // 6. Prepaid taxes tie to the return's own total.
  const paidSection = doc.sections.find((s) => s.id === "TAXES_PAID");
  if (paidSection) {
    const paidRow = findRow(doc, "TAXES_PAID", "Total Taxes Paid");
    check("Total Taxes Paid", (tti.TaxPaid || {}).TaxesPaid?.TotalTaxesPaid, paidRow && paidRow.amount);
  }

  // 7. The banner: refund due, or tax payable. Never both.
  if (doc.refund) check("Refund due", (tti.TaxPaid || {}).NetRefundAdjust ?? (tti.Refund || {}).RefundDue, doc.refund.amount);
  if (doc.payable) check("Balance tax payable", (tti.TaxPaid || {}).BalTaxPayable, doc.payable.amount);
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
  const WORKINGS = [
    ["SALARY", "Income from Salaries", null],
    ["HP", "Income from House Property", "ScheduleCYLA.TotalCurYr.TotHPlossCurYr"],
    ["BP", "Profits and Gains of Business or Profession", "ScheduleCYLA.TotalCurYr.TotBusLoss"],
    ["CG", "Capital Gains", null],
    ["OS", "Income from Other Sources", null],
  ];
  for (const [id, tiLabel, lossPath] of WORKINGS) {
    const s = doc.sections.find((x) => x.id === id);
    if (!s) continue;
    const closing = s.rows.filter((r) => r.kind === "total").pop();
    if (!closing) continue;
    const closingValue = closing.isLoss && closing.amount > 0 ? -n(closing.amount) : n(closing.amount);
    const tiValue = rowAmount("TI", tiLabel);

    if (closingValue >= 0) {
      check(`${id} working ties to the head`, tiValue, closingValue);
      continue;
    }

    check(`${id} closes at a loss, so the head is nil in Part B-TI`, 0, tiValue);
    if (lossPath) {
      const stated = lossPath.split(".").reduce((o, k) => (o == null ? o : o[k]), body);
      check(`${id} loss matches the return`, stated, -closingValue);
    }
  }

  return { ok: failures.length === 0, failures };
}
