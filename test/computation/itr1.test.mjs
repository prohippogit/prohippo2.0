/*
 * Computation of Income — ITR-1, A.Y. 2025-26, and the form-level rules.
 * docs/computation-spec.md §11: every fixture gets three tests — the mapper
 * produces the golden model, validate() passes against the source JSON, and
 * `unmapped` is empty.
 *
 *   node --test test/computation
 *
 * A salaried assessee on the new regime with a savings-bank interest of 503, a
 * standard deduction of 75,000, and a tax of 8,238 that the rebate u/s 87A
 * extinguishes. Anonymised (spec §11).
 *
 * What ITR-1 exercises that no other form does:
 *   - a return with NO schedules and no Part B-TI or Part B-TTI, so validate()
 *     has to find the figures it asserts against somewhere else entirely (§7);
 *   - `GrossTotIncomeIncLTCG112A`, the field that arrives with this year;
 *   - a return that closes at nil against both the refund and the payable, which
 *     is §12's third case and is the norm rather than the exception here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildComputation, detect, validate, UnsupportedFormError } from "../../src/computation/index.js";
import { mapItr1 } from "../../src/computation/mappers/itr1/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "..", "fixtures");
const FIXTURE = path.join(FIXTURES, "itr1-newregime-savings-rebate-ay2025-26.json");
const GOLDEN = path.join(here, "..", "golden", "itr1-newregime-savings-rebate-ay2025-26.model.json");

const json = JSON.parse(readFileSync(FIXTURE, "utf8"));
const CTX = { generatedAt: "2026-01-01T00:00:00.000Z" };

const build = () => {
  const { form, body, ay, schemaVersion } = detect(json);
  assert.equal(form, "ITR1");
  assert.equal(ay, "2025-26");
  return { body, doc: mapItr1(body, { ...CTX, ay, schemaVersion }) };
};

const section = (doc, id) => doc.sections.find((s) => s.id === id);
const row = (doc, id, re) => section(doc, id).rows.find((r) => re.test(r.label));
const closing = (s) => s.rows.filter((r) => r.kind === "total").pop();

/* ---------------- §11: the three required tests ---------------- */

test("mapper produces the golden model", () => {
  const { doc } = build();
  if (process.env.UPDATE_GOLDEN === "1" || !existsSync(GOLDEN)) {
    writeFileSync(GOLDEN, JSON.stringify(doc, null, 1) + "\n");
  }
  assert.deepEqual(doc, JSON.parse(readFileSync(GOLDEN, "utf8")));
});

test("validate() passes against the source return", () => {
  const { doc, body } = build();
  assert.deepEqual(validate(doc, body).failures, []);
});

test("unmapped is empty", () => {
  const { doc } = build();
  assert.deepEqual(doc.unmapped, []);
});

/* ---------------- the new regime, reconciled ---------------- */

test("the new regime is stated, and the return's own tax is what proves it", () => {
  const { doc, body } = build();
  assert.equal(body.FilingStatus.OptOutNewTaxRegime, "N");
  assert.match(doc.assessee.facts.find((f) => f.label === "Tax regime").value, /^New regime u\/s 115BAC\(1A\)/);

  // §10 forbids reading a regime field by its name alone. 5% of (4,64,760 −
  // 3,00,000) is 8,238 to the rupee, which is the s.115BAC(1A) table for this
  // year and nothing else — the old table would give 10,738 on the same income.
  assert.equal(body.ITR1_IncomeDeductions.TotalIncome, 464760);
  assert.equal(body.ITR1_TaxComputation.TotalTaxPayable, 8238);
  assert.equal(Math.round((464760 - 300000) * 0.05), 8238);
  // The standard deduction agrees: 75,000 is the new regime's, 50,000 the old.
  assert.equal(row(doc, "SALARY", /^Less: Standard deduction/).amount, 75000);
});

test("the rebate u/s 87A extinguishes the tax, and every row below it says nil", () => {
  const { doc } = build();
  assert.equal(row(doc, "TAX", /^Tax on Total Income/).amount, 8238);
  assert.equal(row(doc, "TAX", /^Less: Rebate u\/s 87A/).amount, 8238);
  assert.equal(row(doc, "TAX", /^Tax after rebate/).amount, 0);
  // Nil is a figure and prints as an em dash; the rows are not dropped, because
  // a reader checking a computation looks for the line before the figure (§6).
  assert.equal(row(doc, "TAX", /^Add: Health & Education Cess/).amount, 0);
  assert.equal(closing(section(doc, "TAX")).amount, 0);
});

/* ---------------- the shape of a form with no schedules ---------------- */

test("the heads go straight to gross total income, with no total-of-heads row", () => {
  const { doc } = build();
  // ITR-1 allows no set-off, so its gross total income IS the total of the
  // heads. Printing both would state one figure twice (§10).
  assert.deepEqual(section(doc, "TI").rows.map((r) => r.label), [
    "Income from Salaries",
    "Income from House Property",
    "Income from Other Sources",
    "Gross Total Income",
    "Less: Deductions under Chapter VI-A",
    "Total Income (rounded off u/s 288A)",
  ]);
  assert.equal(row(doc, "TI", /^Gross Total Income/).amount, 464759);
  // 4,64,759 rounded up to the nearest ten by the return itself, not by us (§6).
  assert.equal(closing(section(doc, "TI")).amount, 464760);
});

test("head rows cite Part B, because this form has no schedule to cite", () => {
  const { doc } = build();
  const heads = section(doc, "TI").rows.filter((r) => r.kind === "head");
  assert.equal(heads.length, 3);
  for (const h of heads) assert.equal(h.ref, "Part B");
  // Naming Schedule S or Schedule HP would send a reader looking for workings
  // that do not exist on an ITR-1.
  for (const s of doc.sections) {
    for (const r of s.rows) assert.doesNotMatch(r.ref || "", /Sch\. (S|HP|CG|OS|VI-A|SI)\b/);
  }
});

test("the house property head is printed even at nil, and capital gains is not printed at all", () => {
  const { doc } = build();
  // §4: the TI section lists the heads including the nil ones, because a
  // computation that silently omits a head looks incomplete to an officer.
  assert.equal(row(doc, "TI", /^Income from House Property/).amount, 0);
  // But there is no head row for one the form cannot carry. This year's return
  // states GrossTotIncomeIncLTCG112A equal to GrossTotIncome, so there is no
  // s.112A gain in it and no row for one.
  assert.equal(json.ITR.ITR1.ITR1_IncomeDeductions.GrossTotIncomeIncLTCG112A, 464759);
  assert.equal(row(doc, "TI", /Capital Gains/), undefined);
  assert.equal(section(doc, "CG"), undefined);
  assert.equal(section(doc, "BP"), undefined);
});

test("a s.112A gain, where the return's two gross totals differ, becomes a head of its own", () => {
  // Not a fixture: no return we hold carries this gain, and inventing one would
  // be testing our reading of the schema against itself (§11). What IS ours to
  // test is the arithmetic rule — the gain is the difference between the return's
  // own two statements of gross total income — so the rule is exercised on a
  // mutation of a real return rather than on a fabricated return.
  const withGain = JSON.parse(JSON.stringify(json));
  const inc = withGain.ITR.ITR1.ITR1_IncomeDeductions;
  inc.GrossTotIncomeIncLTCG112A = inc.GrossTotIncome + 100000;
  inc.TotalIncome = 564760;

  const { body, ay, schemaVersion } = detect(withGain);
  const doc = mapItr1(body, { ...CTX, ay, schemaVersion });
  const gain = row(doc, "TI", /^Long-term Capital Gains u\/s 112A/);
  assert.equal(gain.amount, 100000);
  assert.equal(row(doc, "TI", /^Gross Total Income/).amount, 564759);
  assert.match(doc.notes.find((n) => /112A/.test(n.text)).text, /1,00,000/);
  // And it still reconciles: the including figure is the one Chapter VI-A comes
  // off, so the heads sum to it and the total income row ties.
  assert.deepEqual(validate(doc, body).failures, []);
});

/* ---------------- the credit rows, and a shape taken from the wrong form -------- */

test("a row shaped the way ITR-2 states one is not read, and every figure in it surfaces", () => {
  /* This mapper once read the credit blocks with ITR-2's field names, on the
     strength of the two forms sharing four block TOTAL keys. A real ITR-1 (see
     itr1-80ggc-tds.test.mjs) proved the rows inside are ITR-1's own, and this
     test pins the behaviour that made the wrong reading safe: nothing is
     printed against a caption it does not belong to, and every figure the
     mapper could not read is reported for review (§8).

     If a future ITR-1 does carry ITR-2's shape, this test is what will say so —
     by failing here rather than by a figure going quietly missing from a
     document somebody signs. */
  const itr2Shaped = JSON.parse(JSON.stringify(json));
  itr2Shaped.ITR.ITR1.TDSonOthThanSals = {
    TDSonOthThanSal: [{
      TANOfDeductor: "AAAB00001A",
      TDSSection: "94A",
      TaxDeductCreditDtls: { TaxDeductedOwnHands: 500, TaxClaimedOwnHands: 500 },
      GrossAmount: 5000,
      HeadOfIncome: "OS",
    }],
    TotalTDSonOthThanSals: 0,
  };
  const { body, ay, schemaVersion } = detect(itr2Shaped);
  const doc = mapItr1(body, { ...CTX, ay, schemaVersion });

  assert.deepEqual(doc.unmapped.map((u) => u.value), [5000, 500, 500]);
  for (const u of doc.unmapped) assert.match(u.path, /^TDSonOthThanSals\.TDSonOthThanSal\[0\]/);
  // No row was invented for figures the mapper could not read.
  assert.equal(section(doc, "TAXES_PAID").rows.find((r) => r.label === "AAAB00001A"), undefined);
});

/* ---------------- §7: the oracle is wired to ITR-1's own fields ---------------- */

test("validate() asserts against ITR-1's blocks, not against absent Part B fields", () => {
  // The failure this guards: an oracle that reads PartB-TI on a form that has
  // none compares every figure against nil, and passes anything. So break the
  // return's stated total income and require the check to fail.
  const { body, doc } = build();
  const broken = JSON.parse(JSON.stringify(body));
  broken.ITR1_IncomeDeductions.TotalIncome = 999999;
  const { ok, failures } = validate(doc, broken);
  assert.equal(ok, false);
  assert.deepEqual(failures.map((f) => f.check), ["Total Income"]);
  assert.equal(failures[0].expected, 999999);
  assert.equal(failures[0].actual, 464760);
});

test("a mis-stated tax or refund is caught the same way", () => {
  const { body, doc } = build();
  const broken = JSON.parse(JSON.stringify(body));
  broken.ITR1_TaxComputation.GrossTaxLiability = 5000;
  broken.TaxPaid.TaxesPaid.TotalTaxesPaid = 700;
  assert.deepEqual(
    validate(doc, broken).failures.map((f) => f.check),
    ["Gross Tax Liability", "Total Taxes Paid"]
  );
});

/* ---------------- form-level rules, across every ITR-1 fixture ---------------- */

const itr1Fixtures = readdirSync(FIXTURES).filter((f) => /^itr1-.*\.json$/.test(f)).sort();

test("all five years are represented among the fixtures", () => {
  const years = new Set(itr1Fixtures.map((f) => /ay(\d{4}-\d{2})/.exec(f)[1]));
  assert.deepEqual([...years].sort(), ["2022-23", "2023-24", "2024-25", "2025-26", "2026-27"]);
  assert.ok(itr1Fixtures.length >= 6, itr1Fixtures.join(", "));
});

for (const file of itr1Fixtures) {
  test(`${file.replace(/\.json$/, "")} — builds, ties and accounts for every figure`, () => {
    const source = JSON.parse(readFileSync(path.join(FIXTURES, file), "utf8"));
    const { doc } = buildComputation(source, CTX);
    // buildComputation raises on a validation failure (§7), so reaching here is
    // itself the reconciliation. What is asserted is what a reader would check.
    assert.deepEqual(doc.unmapped, []);
    assert.equal(doc.meta.form, "ITR1");
    assert.equal(doc.assessee.status, "Individual");
    assert.equal(doc.signatory.capacity, "Self");
    // The three sections §4 requires always, in order, whatever heads exist.
    const ids = doc.sections.map((s) => s.id);
    assert.deepEqual(ids.slice(-3), ["TI", "TAX", "TAXES_PAID"]);
    assert.deepEqual([...ids].sort(), ids.slice().sort());

    /* §12: refund, or payable, or neither — never both, and the closing row of
       the taxes-paid section names whichever it is. Five of these returns close
       at nil, which CPC neither refunds nor demands; the sixth is a refund. */
    assert.ok(!(doc.refund && doc.payable), "one banner at most");
    const close = closing(section(doc, "TAXES_PAID"));
    if (doc.refund) {
      assert.equal(close.label, "Refund Due");
      assert.equal(close.amount, doc.refund.amount);
    } else if (doc.payable) {
      assert.equal(close.label, "Tax Payable");
      assert.equal(close.amount, doc.payable.amount);
    } else {
      // Not "Refund Due — nil", which reads like a claim that was rejected.
      assert.equal(close.label, "Nothing further payable or refundable");
    }
  });
}

test("five of the six returns close at nil, and one is a refund", () => {
  // Stated as a fact about the fixture set rather than asserted per file: §11's
  // coverage table says the same thing, and the two should not drift.
  const banners = itr1Fixtures.map((f) => {
    const { doc } = buildComputation(JSON.parse(readFileSync(path.join(FIXTURES, f), "utf8")), CTX);
    return doc.refund ? "refund" : doc.payable ? "payable" : "nil";
  });
  assert.equal(banners.filter((b) => b === "refund").length, 1);
  assert.equal(banners.filter((b) => b === "nil").length, 5);
  assert.equal(banners.filter((b) => b === "payable").length, 0, "§11 records tax-payable as not yet exercised");
});

test("a capacity code ITR-2's table would name prints as itself instead", () => {
  // §10: a form's code list must be read from that form's own schema. No ITR-1
  // schema has been read here, so "S" is the only code this table claims — and a
  // Karta's "K", which ITR-2's enum does carry, must NOT be borrowed.
  const karta = JSON.parse(JSON.stringify(json));
  karta.ITR.ITR1.Verification.Capacity = "K";
  const { body, ay, schemaVersion } = detect(karta);
  assert.equal(mapItr1(body, { ...CTX, ay, schemaVersion }).signatory.capacity, "K");
});

/* ---------------- the year gate ---------------- */

test("an unsupported year raises rather than using another year's mapper", () => {
  const wrongYear = JSON.parse(JSON.stringify(json));
  wrongYear.ITR.ITR1.Form_ITR1.AssessmentYear = "2019";
  assert.throws(() => buildComputation(wrongYear, CTX), UnsupportedFormError);
  // The message names the form and the year, because the Returns tab shows it
  // to a practitioner as it stands.
  assert.throws(() => buildComputation(wrongYear, CTX), /ITR-1 A\.Y\. 2019-20/);
});
