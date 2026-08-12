/*
 * Computation of Income — ITR-1, A.Y. 2022-23 and 2023-24.
 *
 *   node --test test/computation/itr1-early-years.test.mjs
 *
 * The two years that ask the regime as `NewTaxRegime`, whose sense is the reverse
 * of the `OptOutNewTaxRegime` of the years after them. Both anonymised (§11).
 *
 * They are tested together because what they have in common is what matters: on
 * neither of them can the regime be reconciled from the return's own tax, because
 * below ₹5 lakh the two tables charge the same and the rebate u/s 87A then
 * extinguishes it. §10 requires that to be stated rather than glossed over, and
 * these tests are where it is stated — the sense of the field is verified once, in
 * mappers/individual/labels.js, against an ITR-3 of the same year whose income is
 * large enough to separate the tables.
 *
 * What each covers that the other does not:
 *   2022-23  a belated return u/s 139(4); no other head at all, so the document
 *            is four sections long and no "Gross Salary" line is invented for a
 *            salary with no perquisite in it.
 *   2023-24  the first year the other-sources itemisation appears, and the first
 *            s.80TTA deduction.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { detect, validate } from "../../src/computation/index.js";
import { mapItr1 } from "../../src/computation/mappers/itr1/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CTX = { generatedAt: "2026-01-01T00:00:00.000Z" };

const YEARS = {
  "2022-23": "itr1-salary-belated-nil-ay2022-23",
  "2023-24": "itr1-salary-commission-80tta-ay2023-24",
};

const load = (ay) => {
  const name = YEARS[ay];
  const json = JSON.parse(readFileSync(path.join(here, "..", "fixtures", `${name}.json`), "utf8"));
  const { form, body, ay: detected, schemaVersion } = detect(json);
  assert.equal(form, "ITR1");
  assert.equal(detected, ay);
  return {
    json,
    body,
    doc: mapItr1(body, { ...CTX, ay: detected, schemaVersion }),
    golden: path.join(here, "..", "golden", `${name}.model.json`),
  };
};

const section = (doc, id) => doc.sections.find((s) => s.id === id);
const row = (doc, id, re) => section(doc, id).rows.find((r) => re.test(r.label));
const closing = (s) => s.rows.filter((r) => r.kind === "total").pop();

/* ---------------- §11: the three required tests, for each year ---------------- */

for (const ay of Object.keys(YEARS)) {
  test(`A.Y. ${ay} — mapper produces the golden model`, () => {
    const { doc, golden } = load(ay);
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(golden)) {
      writeFileSync(golden, JSON.stringify(doc, null, 1) + "\n");
    }
    assert.deepEqual(doc, JSON.parse(readFileSync(golden, "utf8")));
  });

  test(`A.Y. ${ay} — validate() passes against the source return`, () => {
    const { doc, body } = load(ay);
    assert.deepEqual(validate(doc, body).failures, []);
  });

  test(`A.Y. ${ay} — unmapped is empty`, () => {
    assert.deepEqual(load(ay).doc.unmapped, []);
  });
}

/* ---------------- the regime, and the honest limit of what these returns prove ---------------- */

test("NewTaxRegime \"N\" is the OLD regime — the reverse of the later years' field", () => {
  for (const ay of Object.keys(YEARS)) {
    const { doc, body } = load(ay);
    assert.equal(body.FilingStatus.NewTaxRegime, "N");
    assert.equal(body.FilingStatus.OptOutNewTaxRegime, undefined, "this year does not ask it that way");
    // Read with the later field's sense, "N" would print "New regime" above a
    // Chapter VI-A block that could not exist under it.
    assert.equal(
      doc.assessee.facts.find((f) => f.label === "Tax regime").value,
      "Old regime — s.115BAC not opted for"
    );
  }
});

test("neither return can reconcile its own regime, and the tests say why", () => {
  // §10 requires the reconciliation to be recorded where the field is read. Here
  // it cannot be made, and that is a fact about these returns rather than a
  // shortcut taken: below ₹5 lakh the old table and the then-s.115BAC table are
  // the same — nil to 2,50,000, then 5% — so both give the figure stated.
  const y2023 = load("2023-24");
  assert.equal(y2023.body.ITR1_IncomeDeductions.TotalIncome, 464020);
  assert.equal(y2023.body.ITR1_TaxComputation.TotalTaxPayable, 10701);
  assert.equal(Math.round((464020 - 250000) * 0.05), 10701);

  // 2022-23 is below the exemption limit under either table, so the return states
  // nil tax and there is nothing at all to reconcile against.
  const y2022 = load("2022-23");
  assert.equal(y2022.body.ITR1_IncomeDeductions.TotalIncome, 239500);
  assert.equal(y2022.body.ITR1_TaxComputation.TotalTaxPayable, 0);
  assert.equal(row(y2022.doc, "TAX", /^Tax on Total Income/).amount, 0);
  // No rebate was needed, so no "Tax after rebate" row: the same figure twice on
  // consecutive rows reads as an error (§6).
  assert.equal(row(y2022.doc, "TAX", /^Less: Rebate u\/s 87A/).amount, 0);
  assert.equal(row(y2022.doc, "TAX", /^Tax after rebate/), undefined);
});

/* ---------------- A.Y. 2022-23: salary and nothing else ---------------- */

test("a return with one head is four sections long, lettered without a gap", () => {
  const { doc } = load("2022-23");
  assert.deepEqual(doc.sections.map((s) => s.id), ["SALARY", "TI", "TAX", "TAXES_PAID"]);
  // §4: lettering happens after the empty sections are dropped, so there is no
  // gap where the other-sources section would have been.
  assert.deepEqual(doc.sections.map((s) => s.letter), ["A", "B", "C", "D"]);
  // Nil heads are still listed in the TI section, because a computation that
  // omits a head looks incomplete to an assessing officer.
  assert.equal(row(doc, "TI", /^Income from House Property/).amount, 0);
  assert.equal(row(doc, "TI", /^Income from Other Sources/).amount, 0);
});

test("a salary with no perquisite gets no \"Gross Salary\" line of its own", () => {
  const { doc, body } = load("2022-23");
  const inc = body.ITR1_IncomeDeductions;
  assert.equal(inc.Salary, inc.GrossSalary);
  // Two rows carrying 2,89,500 under two captions would read as an error, so the
  // subtotal appears only where something has been added to s.17(1).
  assert.deepEqual(section(doc, "SALARY").rows.map((r) => r.label), [
    "Salary as per section 17(1)",
    "Less: Standard deduction u/s 16(ia)",
    "Income chargeable under the head Salaries",
  ]);
  assert.equal(closing(section(doc, "SALARY")).amount, 239500);
});

test("a belated return is stated in the particulars and repeated as an attention note", () => {
  const { doc, body } = load("2022-23");
  assert.equal(body.FilingStatus.ReturnFileSec, 12);
  assert.equal(
    doc.assessee.facts.find((f) => f.label === "Return filed under").value,
    "Section 139(4) — belated"
  );
  const note = doc.notes.find((n) => /139\(4\)/.test(n.text));
  // s.80 denies the carry-forward of losses on a belated return, so this is not
  // a detail to leave in a fact box alone.
  assert.equal(note.severity, "attention");
});

/* ---------------- A.Y. 2023-24: the itemisation arrives ---------------- */

test("other sources is itemised, and s.80TTA is allowed at the savings interest", () => {
  const { doc, body } = load("2023-24");
  const stated = body.ITR1_IncomeDeductions.OthersInc.OthersIncDtlsOthSrc;
  assert.deepEqual(stated.map((o) => o.OthSrcNatureDesc), ["SAV", "OTH"]);
  assert.equal(row(doc, "OS", /^Interest from a savings bank account/).amount, 18);
  assert.equal(section(doc, "OS").rows[1].label, stated[1].OthSrcOthNatOfInc);
  assert.equal(closing(section(doc, "OS")).amount, 198428);

  assert.equal(row(doc, "VIA", /80TTA/).amount, 18);
  assert.equal(closing(section(doc, "TI")).amount, 464020);
  // 4,64,038 − 18 = 4,64,020 exactly, so this year exercises no s.288A rounding.
  assert.equal(row(doc, "TI", /^Gross Total Income/).amount, 464038);
});

test("this year has no GrossTotIncomeIncLTCG112A, so gross total income is the plain field", () => {
  const { doc, body } = load("2023-24");
  const inc = body.ITR1_IncomeDeductions;
  assert.ok(!("GrossTotIncomeIncLTCG112A" in inc), "the field arrives only in A.Y. 2025-26");
  assert.equal(row(doc, "TI", /^Gross Total Income/).amount, inc.GrossTotIncome);
  assert.equal(row(doc, "TI", /Capital Gains/), undefined);
});
