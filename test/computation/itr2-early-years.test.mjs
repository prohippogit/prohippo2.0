/*
 * Computation of Income — ITR-2, A.Y. 2022-23 and 2023-24.
 *
 *   node --test test/computation/itr2-early-years.test.mjs
 *
 * The same salaried assessee two and three years before the A.Y. 2024-25 return
 * already held as a fixture. Both are on the OLD regime, and both ask the regime
 * question the third way — `NewTaxRegime`, whose sense runs opposite to the
 * `OptOutNewTaxRegime` of the middle years. Anonymised (spec §11).
 *
 * What these two cover that no other ITR-2 fixture does:
 *   A.Y. 2022-23  a return that closes exactly LEVEL — nothing payable, nothing
 *                 refundable; a s.80GGC political contribution; perquisites
 *                 itemised by code; a self-assessment challan.
 *   A.Y. 2023-24  `ifLetOut: "N"` on a self-occupied flat, the yes/no spelling
 *                 the later schema replaced with "S"; an s.10 allowance under
 *                 the "OTH" code; a refund.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildComputation, detect, validate, UnsupportedFormError } from "../../src/computation/index.js";
import { mapItr2 } from "../../src/computation/mappers/itr2/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CTX = { generatedAt: "2026-01-01T00:00:00.000Z" };

const YEARS = {
  "2022-23": "itr2-salary-80ggc-level-ay2022-23",
  "2023-24": "itr2-salary-hploss-refund-ay2023-24",
};

const load = (ay) => JSON.parse(readFileSync(path.join(here, "..", "fixtures", `${YEARS[ay]}.json`), "utf8"));
const build = (ay) => {
  const d = detect(load(ay));
  assert.equal(d.form, "ITR2");
  assert.equal(d.ay, ay);
  return { body: d.body, doc: mapItr2(d.body, { ...CTX, ay: d.ay, schemaVersion: d.schemaVersion }) };
};

const section = (doc, id) => doc.sections.find((s) => s.id === id);
const row = (doc, id, re) => section(doc, id).rows.find((r) => re.test(r.label));
const closing = (s) => s.rows.filter((r) => r.kind === "total").pop();

/* ---------------- §11: the three required tests, for each year ---------------- */

for (const [ay, name] of Object.entries(YEARS)) {
  const GOLDEN = path.join(here, "..", "golden", `${name}.model.json`);

  test(`${ay}: mapper produces the golden model`, () => {
    const { doc } = build(ay);
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(GOLDEN)) {
      writeFileSync(GOLDEN, JSON.stringify(doc, null, 1) + "\n");
    }
    assert.deepEqual(doc, JSON.parse(readFileSync(GOLDEN, "utf8")));
  });

  test(`${ay}: validate() passes against the source return`, () => {
    const { doc, body } = build(ay);
    assert.deepEqual(validate(doc, body).failures, []);
  });

  test(`${ay}: unmapped is empty`, () => {
    const { doc } = build(ay);
    assert.deepEqual(doc.unmapped, []);
  });

  test(`${ay}: NewTaxRegime "N" is the OLD regime`, () => {
    const { doc, body } = build(ay);
    // These years ask whether the assessee opted IN. Every middle year asks
    // whether they opted OUT. Reading "N" the later way would print "New regime"
    // above a Chapter VI-A block that cannot exist under it.
    assert.equal(body.PartA_GEN1.FilingStatus.NewTaxRegime, "N");
    assert.equal(body.PartA_GEN1.FilingStatus.OptOutNewTaxRegime, undefined);
    assert.match(doc.assessee.facts.find((f) => f.label === "Tax regime").value, /^Old regime/);
    assert.ok(closing(section(doc, "VIA")).amount > 0);
  });
}

/* ---------------- A.Y. 2022-23: a return that closes level ---------------- */

test("2022-23: nothing payable and nothing refundable is said, not shown as a nil demand", () => {
  const { doc, body } = build("2022-23");
  // TDS 2,73,651 plus a self-assessment challan of 4,800 exactly meets the
  // liability. "Tax Payable — nil" reads like a demand for nothing.
  assert.equal(body.PartB_TTI.Refund.RefundDue, 0);
  assert.equal(body.PartB_TTI.TaxPaid.BalTaxPayable, 0);
  assert.equal(doc.refund, null);
  assert.equal(doc.payable, null);

  const paid = section(doc, "TAXES_PAID");
  assert.equal(row(doc, "TAXES_PAID", /^Total Tax Deducted at Source/).amount, 273651);
  assert.equal(row(doc, "TAXES_PAID", /^Self-Assessment Tax Paid/).amount, 4800);
  assert.equal(row(doc, "TAXES_PAID", /^Total Taxes Paid/).amount, 278451);
  assert.equal(closing(paid).label, "Nothing further payable or refundable");
  assert.equal(closing(paid).amount, 0);
});

test("2022-23: the political contribution and the two capped deductions are named", () => {
  const { doc } = build("2022-23");
  assert.deepEqual(
    section(doc, "VIA").rows.filter((r) => r.kind === "sub").map((r) => [r.ref, r.amount]),
    [["80C", 150000], ["80CCD(1B)", 45837], ["80CCD(2)", 64556], ["80D", 10562], ["80GGC", 100000], ["80TTA", 10000]]
  );
  assert.match(row(doc, "VIA", /80GGC/).label, /contribution to a political party/);
  assert.match(row(doc, "VIA", /80C —/).note, /Claimed 1,68,608; restricted/);
  assert.match(row(doc, "VIA", /80TTA/).note, /Claimed 19,144; restricted/);
  assert.equal(closing(section(doc, "VIA")).amount, 380955);
});

test("2022-23: a perquisite under the OTH code carries the assessee's own words", () => {
  const { doc } = build("2022-23");
  const perq = row(doc, "SALARY", /^Add: Value of perquisites u\/s 17\(2\)/);
  assert.equal(perq.amount, 26000);
  // One component equal to the whole line goes in the note, and "OTH" is a code
  // the assessee describes in words — so both are printed. The description
  // itself is free text the anonymiser replaces, so the shape is what is
  // asserted; on the real return it reads "As per Form 16".
  assert.match(perq.note, /^Other benefits or amenities — .+/);
  assert.equal(closing(section(doc, "SALARY")).amount, 1701405);
});

/* ---------------- A.Y. 2023-24: the older self-occupied code ---------------- */

test("2023-24: ifLetOut \"N\" is a self-occupied property, not a let-out one", () => {
  const { doc, body } = build("2023-24");
  // The current schema's enum is L / D / S. These years answer the same question
  // as a yes/no, so "N" means NOT let out. Confirmed rather than assumed: the
  // A.Y. 2024-25 return carries "S" against the same flat, with the same nil
  // annual value and the same interest-only working.
  assert.equal(body.ScheduleHP.PropertyDetails[0].ifLetOut, "N");
  const later = JSON.parse(readFileSync(path.join(here, "..", "fixtures", "itr2-oldregime-hploss-via-ay2024-25.json"), "utf8"));
  assert.equal(later.ITR.ITR2.ScheduleHP.PropertyDetails[0].ifLetOut, "S");

  const annual = row(doc, "HP", /^Annual/);
  assert.equal(annual.label, "Annual value of the self-occupied property");
  assert.match(annual.note, /self-occupied — annual value taken as nil/);
  assert.equal(row(doc, "HP", /^Less: Interest on borrowed capital/).amount, 60080);
  assert.equal(closing(section(doc, "HP")).label, "Loss from House Property");
  assert.equal(closing(section(doc, "HP")).isLoss, true);
});

test("2023-24: the house property loss is set off against salary u/s 71", () => {
  const { doc } = build("2023-24");
  assert.equal(row(doc, "TI", /^Income from House Property/).amount, 0);
  const setOff = row(doc, "TI", /^Less: Set-off of current year/);
  assert.equal(setOff.label, "Less: Set-off of current year house property loss u/s 71");
  assert.equal(setOff.amount, 60080);
  assert.equal(closing(section(doc, "TI")).amount, 2222660);
});

test("2023-24: an s.10 allowance under the OTH code is named and quotes the return", () => {
  const { doc } = build("2023-24");
  assert.equal(row(doc, "SALARY", /^Less: House rent allowance exempt/).amount, 27816);
  const other = row(doc, "SALARY", /^Less: Any other allowance exempt/);
  assert.equal(other.amount, 69080);
  // The code is named from the schema and the assessee's own description of it
  // is carried in the note. That description is free text the anonymiser
  // replaces; on the real return it reads "Others".
  assert.ok(other.note && other.note.length > 0);
});

test("2023-24: TDS over the liability produces a refund", () => {
  const { doc } = build("2023-24");
  assert.equal(doc.payable, null);
  assert.equal(doc.refund.amount, 3216);
  assert.equal(row(doc, "TAXES_PAID", /^Total Taxes Paid/).amount, 501686);
  assert.equal(closing(section(doc, "TAXES_PAID")).label, "Refund Due");
});

/* ---------------- the year gate ---------------- */

test("an unsupported year raises rather than using another year's mapper", () => {
  const wrongYear = load("2022-23");
  wrongYear.ITR.ITR2.Form_ITR2.AssessmentYear = "2020";
  assert.throws(() => buildComputation(wrongYear, CTX), UnsupportedFormError);
});
