/*
 * Computation of Income — ITR-2, A.Y. 2025-26.
 *
 *   node --test test/computation
 *
 * A salaried individual with a self-occupied property funded by a housing loan,
 * listed-equity capital gains straddling the mid-year rate change, bank and
 * dividend income, and Chapter VI-A deductions of which two were restricted by
 * their statutory caps. Anonymised (spec §11).
 *
 * Three of those exercise things no firm's ITR-5 can reach: the salary head,
 * the capital-gains head, and income taxed at special rates.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildComputation, detect, validate, UnsupportedFormError } from "../../src/computation/index.js";
import { mapItr2 } from "../../src/computation/mappers/itr2/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "..", "fixtures", "itr2-salary-hp-capgains-ay2025-26.json");
const GOLDEN = path.join(here, "..", "golden", "itr2-salary-hp-capgains-ay2025-26.model.json");

const json = JSON.parse(readFileSync(FIXTURE, "utf8"));
const CTX = { generatedAt: "2026-01-01T00:00:00.000Z" };

const build = () => {
  const { form, body, ay, schemaVersion } = detect(json);
  assert.equal(form, "ITR2");
  assert.equal(ay, "2025-26");
  return { body, doc: mapItr2(body, { ...CTX, ay, schemaVersion }) };
};

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

/* ---------------- salary ---------------- */

test("salary is worked in statutory order", () => {
  const { doc } = build();
  const s = doc.sections.find((x) => x.id === "SALARY");
  assert.equal(s.letter, "A");
  const amt = (re) => s.rows.find((r) => re.test(r.label)).amount;
  assert.equal(amt(/section 17\(1\)/), 2858463);
  assert.equal(amt(/perquisites u\/s 17\(2\)/), 8000);
  assert.equal(amt(/^Gross Salary/), 2866463);
  assert.equal(amt(/^Net Salary/), 2699821);
  assert.equal(amt(/Standard deduction u\/s 16\(ia\)/), 50000);
  assert.equal(amt(/Tax on employment u\/s 16\(iii\)/), 2500);
  assert.equal(s.rows.filter((r) => r.kind === "total").pop().amount, 2647321);
});

test("the salary component codes are not decoded into guessed labels", () => {
  const { doc } = build();
  const labels = JSON.stringify(doc.sections.find((x) => x.id === "SALARY").rows);
  // §10: NatureDesc "1"/"4"/"7" is an ITD code table we have not verified.
  // Inventing "Basic Salary" or "House Rent Allowance" from it would put an
  // unchecked label on a document that gets signed.
  assert.doesNotMatch(labels, /Basic Salary/);
  assert.doesNotMatch(labels, /Dearness Allowance/);
});

test("the HRA exemption carries its working as a note", () => {
  const { doc } = build();
  const hra = doc.sections.find((x) => x.id === "SALARY").rows
    .find((r) => /10\(13A\)/.test(r.label));
  assert.equal(hra.amount, 157060);
  assert.match(hra.note, /HRA received 2,49,996/);
  assert.match(hra.note, /rent paid 2,60,000/);
});

/* ---------------- house property ---------------- */

test("a self-occupied property says so instead of showing a nil rent", () => {
  const { doc } = build();
  const hp = doc.sections.find((x) => x.id === "HP");
  const first = hp.rows[0];
  assert.match(first.label, /self-occupied/);
  assert.match(first.note, /annual value taken as nil/);
  // No 30% standard deduction row: there is no annual value to take it from.
  assert.ok(!hp.rows.some((r) => /24\(a\)/.test(r.label)));
  assert.equal(hp.rows.find((r) => /24\(b\)/.test(r.label)).amount, 169959);
  assert.equal(hp.rows.filter((r) => r.kind === "total").pop().amount, 169959);
});

test("the house property loss is set off and named correctly", () => {
  const { doc, body } = build();
  const ti = doc.sections.find((x) => x.id === "TI");
  assert.equal(ti.rows.find((r) => r.label === "Income from House Property").amount, 0);
  const setoff = ti.rows.find((r) => /Set-off of current year/.test(r.label));
  assert.match(setoff.label, /house property loss u\/s 71/);
  assert.equal(setoff.amount, 169959);
  assert.deepEqual(validate(doc, body).failures, []);
});

/* ---------------- capital gains and special rates ---------------- */

test("capital gains are split by the rate the return states, not a date we assert", () => {
  const { doc } = build();
  const cg = doc.sections.find((x) => x.id === "CG");
  const labels = cg.rows.map((r) => r.label);
  // The rates on s.111A and s.112A both changed mid-year for A.Y. 2025-26, so
  // one head splits across two. The split is read from Part B-TI's own rate
  // buckets, and the head is captioned by RATE rather than by section: a
  // subtotal saying "u/s 111A" is right only while every rupee under it happens
  // to be STT-paid equity, and wrong the moment a land sale at slab rates joins
  // it. The section attribution lives in the tax section, from Schedule SI.
  assert.ok(labels.some((l) => /^Total Short-term Capital Gains$/.test(l)));
  assert.ok(labels.some((l) => /^Total Long-term Capital Gains$/.test(l)));
  assert.ok(!labels.some((l) => /Capital Gain u\/s/.test(l)), "no section attribution on a subtotal");
  assert.ok(labels.some((l) => /taxable at 10%/.test(l)));
  assert.ok(labels.some((l) => /taxable at 12\.5%/.test(l)));
  assert.equal(cg.rows.find((r) => /taxable at 10%/.test(r.label)).amount, 24697);
  assert.equal(cg.rows.find((r) => /taxable at 12\.5%/.test(r.label)).amount, 57029);
  assert.equal(cg.rows.filter((r) => r.kind === "total").pop().amount, 87291);
});

test("the tax section itemises each special rate from Schedule SI", () => {
  const { doc } = build();
  const rows = doc.sections.find((x) => x.id === "TAX").rows;
  const si = rows.filter((r) => r.ref === "Sch. SI");
  assert.equal(si.length, 3, "one row per special rate the return actually used");
  const stcg = si.find((r) => /111A/.test(r.label));
  assert.match(stcg.label, /at 20%/);
  assert.equal(stcg.amount, 1113);
  assert.match(stcg.note, /on 5,565/);
  // The 112A gains fall within the exemption, so the tax on them is nil — which
  // the document states rather than omitting the rows.
  assert.ok(si.filter((r) => /112A/.test(r.label)).every((r) => r.amount === 0));
});

/* ---------------- Chapter VI-A ---------------- */

test("Chapter VI-A shows what was allowed, and says what was restricted", () => {
  const { doc } = build();
  const via = doc.sections.find((x) => x.id === "VIA");
  assert.ok(via, "a return claiming deductions must show them");

  const c80 = via.rows.find((r) => /80C/.test(r.label));
  assert.equal(c80.amount, 150000, "the allowed figure, not the claim");
  assert.match(c80.note, /Claimed 2,28,513/);
  assert.match(c80.note, /restricted to the statutory limit/);

  const tta = via.rows.find((r) => /80TTA/.test(r.label));
  assert.equal(tta.amount, 10000);
  assert.match(tta.note, /Claimed 24,190/);

  // Not restricted, so no note.
  assert.equal(via.rows.find((r) => /80D/.test(r.label)).note, undefined);
  assert.equal(via.rows.filter((r) => r.kind === "total").pop().amount, 327375);
});

test("the restriction is also stated as a note on the document", () => {
  const { doc } = build();
  assert.ok(doc.notes.some((n) => /restricted by the statutory limits/.test(n.text)));
});

test("VIA sits after the heads and before the total income", () => {
  const { doc } = build();
  const ids = doc.sections.map((s) => s.id);
  assert.ok(ids.indexOf("VIA") > ids.indexOf("OS"));
  assert.ok(ids.indexOf("VIA") < ids.indexOf("TI"));
  // A section id missing from the order used to sort to the FRONT, silently.
  assert.deepEqual(ids, ["SALARY", "HP", "CG", "OS", "VIA", "TI", "TAX", "TAXES_PAID"]);
});

/* ---------------- regime, taxes paid, refund ---------------- */

test("the regime is stated, because every deduction depends on it", () => {
  const { doc } = build();
  // §10: OptOutNewTaxRegime "Y" means opted OUT of the new regime — the
  // negative reads backwards and must not be left for a reader to infer.
  const fact = doc.assessee.facts.find((f) => f.label === "Tax regime");
  assert.match(fact.value, /Old regime/);
  assert.ok(doc.notes.some((n) => /old regime/i.test(n.text)));
});

test("salary TDS is listed with the employer and the income it was deducted on", () => {
  const { doc } = build();
  const rows = doc.sections.find((x) => x.id === "TAXES_PAID").rows;
  const salary = rows.find((r) => /Sec\. 192/.test(r.note || ""));
  assert.equal(salary.amount, 547095);
  assert.equal(salary.cols.ref, "28,66,463");
  assert.equal(rows.find((r) => /^Total Tax Deducted at Source/.test(r.label)).amount, 553131);
  // The collector is named above the total, the same way the deductors are.
  assert.ok(rows.some((r) => r.kind === "columnHeader" && /^Tax Collected at Source — TAN/.test(r.label)));
  assert.equal(rows.find((r) => r.label === "Tax Collected at Source").amount, 12673);
  assert.equal(rows.find((r) => /^Total Taxes Paid/.test(r.label)).amount, 565804);
});

test("the refund banner reads from Refund.RefundDue, which ITR-2 uses", () => {
  const { doc } = build();
  // ITR-5 carries NetRefundAdjust; ITR-2 has only Refund.RefundDue.
  assert.equal(doc.payable, null);
  assert.equal(doc.refund.amount, 52467);
  assert.ok(doc.refund.bank.ifsc);
});

test("an unsupported year raises rather than using another year's mapper", () => {
  const wrongYear = JSON.parse(JSON.stringify(json));
  wrongYear.ITR.ITR2.Form_ITR2.AssessmentYear = "2018";
  assert.throws(() => buildComputation(wrongYear, CTX), UnsupportedFormError);
});
