/*
 * Computation of Income — ITR-2, A.Y. 2026-27.
 *
 *   node --test test/computation/itr2-ay2026-27.test.mjs
 *
 * A salaried assessee with a self-occupied flat, listed-equity gains u/s 112A
 * and bank income, whose TDS overshoots the liability — the first refund case
 * on an ITR-2 fixture. Anonymised (spec §11).
 *
 * The year matters: A.Y. 2025-26 straddled the mid-year capital-gains rate
 * change and carries two long-term buckets. 2026-27 is the first full year on
 * the amended rates and carries one. Nothing branches on that — the workings
 * read whichever buckets the return puts a figure against.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildComputation, detect, validate, UnsupportedFormError } from "../../src/computation/index.js";
import { mapItr2 } from "../../src/computation/mappers/itr2/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "..", "fixtures", "itr2-salary-112a-refund-ay2026-27.json");
const GOLDEN = path.join(here, "..", "golden", "itr2-salary-112a-refund-ay2026-27.model.json");

const json = JSON.parse(readFileSync(FIXTURE, "utf8"));
const CTX = { generatedAt: "2026-01-01T00:00:00.000Z" };

const build = () => {
  const { form, body, ay, schemaVersion } = detect(json);
  assert.equal(form, "ITR2");
  assert.equal(ay, "2026-27");
  return { body, doc: mapItr2(body, { ...CTX, ay, schemaVersion }) };
};

const section = (doc, id) => doc.sections.find((s) => s.id === id);
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

/* ---------------- the refund case ---------------- */

test("TDS over the liability produces a refund, with the account it credits to", () => {
  const { doc } = build();
  // The first ITR-2 fixture that ends in a refund rather than closing level.
  assert.equal(doc.payable, null);
  assert.equal(doc.refund.amount, 95545);
  assert.equal(doc.refund.bank.type, "SB");
  assert.ok(doc.refund.bank.ifsc);

  const paid = section(doc, "TAXES_PAID");
  assert.equal(paid.rows.find((r) => /^Total Tax Deducted at Source/.test(r.label)).amount, 692694);
  assert.equal(paid.rows.find((r) => /^Total Taxes Paid/.test(r.label)).amount, 692694);
  assert.match(closing(paid).label, /^Refund Due$/);
  assert.equal(closing(paid).amount, 95545);
});

test("salary TDS names the employer and the income it was deducted on", () => {
  const { doc } = build();
  const rows = section(doc, "TAXES_PAID").rows;
  const salary = rows.find((r) => /Sec\. 192/.test(r.note || ""));
  assert.equal(salary.amount, 686403);
  assert.equal(salary.cols.ref, "32,73,900");
});

/* ---------------- the year's capital gains ---------------- */

test("one long-term rate this year, and the head is not captioned by section", () => {
  const { doc, body } = build();
  const cg = section(doc, "CG");
  const labels = cg.rows.map((r) => r.label);

  // 2025-26 splits a s.112A gain across two rates. This year has one, so there
  // is nothing to split — and the code does not need to know which year it is.
  assert.equal(body["PartB-TI"].CapGain.LongTerm.LongTerm12_5Per, 96366);
  assert.ok(!("LongTerm10Per" in body["PartB-TI"].CapGain.LongTerm), "no 10% bucket this year");
  assert.ok(labels.includes("Total Long-term Capital Gains"));
  assert.ok(!labels.some((l) => /taxable at/.test(l)), "a single rate is not a split");
  assert.ok(!labels.some((l) => /Capital Gain u\/s/.test(l)));
  assert.equal(closing(cg).amount, 96366);

  // The working comes from Schedule 112A's own totals, not from the scrip list.
  assert.equal(cg.rows.find((r) => /Full value of consideration/.test(r.label)).amount, 331842);
  assert.equal(cg.rows.find((r) => /Cost of acquisition/.test(r.label)).amount, 235476);
});

test("the tax section states the rate the return applied, even where the tax is nil", () => {
  const { doc } = build();
  const si = section(doc, "TAX").rows.filter((r) => r.ref === "Sch. SI");
  assert.equal(si.length, 1);
  assert.match(si[0].label, /Long-term capital gains u\/s 112A — at 12\.5%/);
  // Nil tax on a real gain is a fact about this return, not an omission: the
  // row is printed so a reader can see the figure was considered.
  assert.equal(si[0].amount, 0);
  assert.match(si[0].note, /on 96,366/);
});

/* ---------------- shape and the year gate ---------------- */

test("no capital-loss or Chapter VI-A section is invented from nil schedules", () => {
  const { doc } = build();
  // New regime, no deductions claimed: the VI-A section is dropped entirely,
  // while the TI section still carries its nil "Less: Deductions" line.
  assert.deepEqual(doc.sections.map((s) => s.id), ["SALARY", "CG", "OS", "TI", "TAX", "TAXES_PAID"]);
  assert.equal(section(doc, "TI").rows.find((r) => /Chapter VI-A/.test(r.label)).amount, 0);
  assert.match(doc.assessee.facts.find((f) => f.label === "Tax regime").value, /New regime/);
});

test("the house property is nil and stays a head, not a section", () => {
  const { doc } = build();
  // Self-occupied with no housing loan: nothing to work, so no HP section —
  // but Part B-TI still lists the head, and so does the total-income table.
  assert.equal(section(doc, "HP"), undefined);
  assert.equal(section(doc, "TI").rows.find((r) => r.label === "Income from House Property").amount, 0);
});

test("an unsupported year raises rather than using another year's mapper", () => {
  const wrongYear = JSON.parse(JSON.stringify(json));
  wrongYear.ITR.ITR2.Form_ITR2.AssessmentYear = "2020";
  assert.throws(() => buildComputation(wrongYear, CTX), UnsupportedFormError);
});
