/* Unit tests for the ITR JSON tax-position reader.
 *
 * The property under test throughout: a figure this returns is a figure the
 * return PRINTS. Where it cannot find one it must say null, never zero — a
 * fabricated nil here becomes a confident red or green flag on the dashboard.
 *
 * Run:  node functions/itrTaxPosition.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { readTaxPosition } = require("./itrTaxPosition.js");

/* ---------------- shapes ---------------- */

// ITR-1 / ITR-4: TaxPaid and Refund sit at the form's own root.
const itr1 = ({ bal = 0, refund = 0, paid = 100000, ay = 2024 } = {}) => ({
  ITR: {
    ITR1: {
      Form_ITR1: { AssessmentYear: ay },
      ITR1_TaxComputation: { TotalTaxPayable: 95000, TotalIntrstPay: 1200 },
      TaxPaid: { TaxesPaid: { TDS: paid, TotalTaxesPaid: paid }, BalTaxPayable: bal },
      Refund: { RefundDue: refund },
    },
  },
});

// ITR-2/3/5/6/7: the authoritative totals live in Part B-TTI.
const itr3 = ({ bal = 0, refund = 0, paid = 500000, gross = 480000, ay = 2024 } = {}) => ({
  ITR: {
    ITR3: {
      Form_ITR3: { AssessmentYear: ay },
      PartB_TTI: {
        ComputationOfTaxLiability: { TotalTaxPlusIntrstPay: gross, NetTaxLiability: gross },
        TaxPaid: { TaxesPaid: { TDS: paid, TotalTaxesPaid: paid }, BalTaxPayable: bal },
        Refund: { RefundDue: refund },
      },
    },
  },
});

/* ---------------- the sign convention ---------------- */

test("a refund claimed is positive", () => {
  const p = readTaxPosition(itr1({ bal: 0, refund: 42000 }));
  assert.equal(p.refundDue, 42000);
  assert.equal(p.balTaxPayable, 0);
  assert.equal(p.netPayable, 42000);
});

test("tax still payable is negative", () => {
  const p = readTaxPosition(itr1({ bal: 42000, refund: 0 }));
  assert.equal(p.netPayable, -42000);
});

test("a return closing level is zero, not null", () => {
  const p = readTaxPosition(itr1({ bal: 0, refund: 0 }));
  assert.equal(p.netPayable, 0);
});

/* ---------------- where the figures are found ---------------- */

test("ITR-1 figures are read from the form root", () => {
  const p = readTaxPosition(itr1({ refund: 15000 }));
  assert.equal(p.form, "ITR1");
  assert.equal(p.source, "form-root");
  assert.equal(p.ay, "2024-25");
});

test("ITR-3 figures are read from Part B-TTI", () => {
  const p = readTaxPosition(itr3({ bal: 30000 }));
  assert.equal(p.form, "ITR3");
  assert.equal(p.source, "PartB_TTI");
  assert.equal(p.taxAndInterest, 480000);
});

test("Part B-TTI wins over a same-named field at the form root", () => {
  // Schedule-level data at the root must never outrank the Part B-TTI total —
  // this is the read that decides which figure the whole comparison rests on.
  const json = itr3({ bal: 30000 });
  json.ITR.ITR3.TaxPaid = { BalTaxPayable: 999999 };
  const p = readTaxPosition(json);
  assert.equal(p.balTaxPayable, 30000);
  assert.equal(p.source, "PartB_TTI");
});

test("a form nobody wrote a mapper for is still readable", () => {
  // ITR-6 has no computation mapper. The variance must work anyway.
  const json = {
    ITR: {
      ITR6: {
        Form_ITR6: { AssessmentYear: 2025 },
        PartB_TTI: { TaxPaid: { BalTaxPayable: 1250000 }, Refund: { RefundDue: 0 } },
      },
    },
  };
  const p = readTaxPosition(json);
  assert.equal(p.form, "ITR6");
  assert.equal(p.netPayable, -1250000);
});

test("figures in an unexpected place are found by the fallback scan", () => {
  const json = {
    ITR: {
      ITR7: {
        Form_ITR7: { AssessmentYear: 2025 },
        SomeNewBlock: { Totals: { BalTaxPayable: 0, RefundDue: 8000 } },
      },
    },
  };
  const p = readTaxPosition(json);
  assert.equal(p.source, "scan");
  assert.equal(p.netPayable, 8000);
});

/* ---------------- absent is not nil ---------------- */

test("a return stating neither side yields null, not zero", () => {
  const json = { ITR: { ITR2: { Form_ITR2: { AssessmentYear: 2024 }, PartB_TTI: {} } } };
  const p = readTaxPosition(json);
  assert.equal(p.balTaxPayable, null);
  assert.equal(p.refundDue, null);
  assert.equal(p.netPayable, null, "no figures must not read as a nil position");
});

test('"" and "null" are absent, not zero', () => {
  const json = {
    ITR: { ITR1: { Form_ITR1: { AssessmentYear: 2024 }, TaxPaid: { BalTaxPayable: "null" }, Refund: { RefundDue: "" } } },
  };
  const p = readTaxPosition(json);
  assert.equal(p.netPayable, null);
});

test("numeric strings are accepted", () => {
  const json = {
    ITR: { ITR1: { Form_ITR1: { AssessmentYear: 2024 }, TaxPaid: { BalTaxPayable: "0" }, Refund: { RefundDue: "17500" } } },
  };
  assert.equal(readTaxPosition(json).netPayable, 17500);
});

/* ---------------- not an ITR at all ---------------- */

test("anything that is not a portal ITR JSON returns null", () => {
  assert.equal(readTaxPosition(null), null);
  assert.equal(readTaxPosition({}), null);
  assert.equal(readTaxPosition({ ITR: {} }), null);
  assert.equal(readTaxPosition({ ITR: { NotAForm: {} } }), null);
  assert.equal(readTaxPosition("a string"), null);
});
