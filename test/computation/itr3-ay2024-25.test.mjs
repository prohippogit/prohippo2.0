/*
 * Computation of Income — ITR-3, A.Y. 2024-25.
 *
 *   node --test test/computation/itr3-ay2024-25.test.mjs
 *
 * The same partner as the A.Y. 2025-26 fixture, a year earlier, and a much
 * busier return: a presumptive business u/s 44AD, land and building sold both
 * short-term and long-term, listed equity, and gains taxed at four different
 * rates. Anonymised (spec §11).
 *
 * This year is what proved two labels wrong — see the capital-gains tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildComputation, detect, validate, UnsupportedFormError } from "../../src/computation/index.js";
import { mapItr3 } from "../../src/computation/mappers/itr3/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "..", "fixtures", "itr3-partner-capgains-44ad-ay2024-25.json");
const GOLDEN = path.join(here, "..", "golden", "itr3-partner-capgains-44ad-ay2024-25.model.json");

const json = JSON.parse(readFileSync(FIXTURE, "utf8"));
const CTX = { generatedAt: "2026-01-01T00:00:00.000Z" };

const build = () => {
  const { form, body, ay, schemaVersion } = detect(json);
  assert.equal(form, "ITR3");
  assert.equal(ay, "2024-25");
  return { body, doc: mapItr3(body, { ...CTX, ay, schemaVersion }) };
};

const section = (doc, id) => doc.sections.find((s) => s.id === id);
const closing = (s) => s.rows.filter((r) => r.kind === "total").pop();
const labels = (s) => s.rows.map((r) => r.label);

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

/* ---------------- capital gains: the two labels this return corrected ------- */

test("a head is captioned by rate, never by a section that only some of it falls under", () => {
  const { doc } = build();
  const cg = section(doc, "CG");
  // 9,64,853 of short-term gain, of which only 2,13,018 is STT-paid equity
  // taxable u/s 111A — the other 7,51,835 is a land sale taxable at slab rates.
  // A subtotal reading "Short-term Capital Gain u/s 111A" would be a false
  // statutory statement about three quarters of the figure.
  assert.ok(labels(cg).includes("Total Short-term Capital Gains"));
  assert.ok(labels(cg).includes("Total Long-term Capital Gains"));
  assert.ok(!labels(cg).some((l) => /Capital Gain u\/s/.test(l)));

  const amt = (re) => cg.rows.find((r) => re.test(r.label)).amount;
  assert.equal(amt(/^Total Short-term/), 964853);
  assert.equal(amt(/taxable at 15%/), 213018);
  assert.equal(amt(/taxable at the rates in force/), 751835);
  assert.equal(amt(/^Total Long-term/), 372387);
  assert.equal(amt(/taxable at 10%/), 16327);
  assert.equal(amt(/taxable at 20%/), 356060);
});

test("Schedule SI code 21 is long-term gain u/s 112, not short-term u/s 111A", () => {
  const { doc } = build();
  const si = section(doc, "TAX").rows.filter((r) => r.ref === "Sch. SI");
  const at20 = si.find((r) => /at 20%/.test(r.label));
  // The return carries code 21 at 20% against 3,56,060, which is exactly its own
  // PartB-TI.CapGain.LongTerm.LongTerm20Per. The table used to caption it
  // "short-term capital gains u/s 111A" — a guess, and the wrong one.
  assert.match(at20.label, /Long-term capital gains u\/s 112/);
  assert.equal(at20.amount, 71212);
  assert.match(at20.note, /on 3,56,060/);

  const at15 = si.find((r) => /at 15%/.test(r.label));
  assert.match(at15.label, /Short-term capital gains u\/s 111A/);
  assert.equal(at15.amount, 31953);
});

test("land and building shows the indexed cost, and says when s.50C substitutes", () => {
  const { doc } = build();
  const cg = section(doc, "CG");
  const indexed = cg.rows.filter((r) => /Indexed cost of acquisition/.test(r.label));
  assert.equal(indexed.length, 2, "both long-term properties");
  assert.equal(indexed[0].amount, 50982);
  assert.match(indexed[0].note, /Cost 29,300, indexed/);
  assert.equal(indexed[1].amount, 327858);

  // The short-term property is not indexed — indexation is a long-term relief.
  const shortTermCost = cg.rows.find((r) => r.label === "Less: Cost of acquisition" && r.amount === 900565);
  assert.ok(shortTermCost, "the short-term land sale deducts a plain cost");

  // Stamp value equals consideration in this return, so no s.50C note is due.
  assert.ok(!cg.rows.some((r) => /50C/.test(r.note || "")));
});

/* ---------------- the business head ---------------- */

test("a presumptive business takes the book profit out and puts the deemed profit in", () => {
  const { doc } = build();
  const bp = section(doc, "BP");
  const amt = (re) => bp.rows.find((r) => re.test(r.label)).amount;
  assert.equal(amt(/Net profit before tax/), 67851);
  assert.equal(amt(/covered u\/s 44AD, as per the profit & loss account/), 67851);
  assert.equal(amt(/Profit deemed u\/s 44AD/), 67851);
  // Interest from the firms is business income and is not in any P&L.
  assert.equal(amt(/interest from firms/), 541012);
  assert.equal(closing(bp).amount, 608863);
});

/* ---------------- total income and tax ---------------- */

test("the total income section states what the slab rates are applied to", () => {
  const { doc } = build();
  const ti = section(doc, "TI");
  const amt = (re) => ti.rows.find((r) => re.test(r.label)).amount;
  assert.equal(amt(/^Total Income/), 3270030);
  assert.equal(amt(/income taxable at special rates/), 585405);
  // 32,70,030 − 5,85,405. Without this row a reader has to subtract two figures
  // to check the largest line in the tax section.
  assert.equal(amt(/balance taxable at the rates in force/), 2684625);
  assert.equal(section(doc, "TAX").rows[0].amount, 505386);
});

test("the standard deduction is this year's, read from the return", () => {
  const { doc } = build();
  // 50,000 under the new regime for A.Y. 2024-25; 75,000 from A.Y. 2025-26.
  // Neither is hardcoded — both are whatever Schedule S states.
  const salary = section(doc, "SALARY");
  assert.equal(salary.rows.find((r) => /16\(ia\)/.test(r.label)).amount, 50000);
  assert.equal(closing(salary).amount, 430000);
  assert.match(doc.assessee.facts.find((f) => f.label === "Tax regime").value, /New regime/);
});

/* ---------------- taxes paid ---------------- */

test("a TDS row with no section code says nothing rather than 'Sec.'", () => {
  const { doc, body } = build();
  // This year's return carries no TDSSection at all on any of its 42 rows.
  assert.ok(body.ScheduleTDS2.TDSOthThanSalaryDtls.every((t) => !t.TDSSection));
  const rows = section(doc, "TAXES_PAID").rows;
  assert.ok(!rows.some((r) => /Sec\.\s*$/.test(r.note || "")), "no dangling 'Sec.'");
  assert.ok(rows.some((r) => /39 entries/.test(r.note || "")), "still grouped by deductor");
  assert.equal(rows.find((r) => /^Total Tax Deducted at Source/.test(r.label)).amount, 71899);
  assert.equal(rows.find((r) => /^Self-Assessment Tax Paid/.test(r.label)).amount, 629110);
});

test("the return closes level, so neither banner is shown", () => {
  const { doc } = build();
  assert.equal(doc.refund, null);
  assert.equal(doc.payable, null);
  assert.match(closing(section(doc, "TAXES_PAID")).label, /Nothing further payable or refundable/);
});

/* ---------------- shape ---------------- */

test("every head this assessee has is shown, lettered without gaps", () => {
  const { doc } = build();
  assert.deepEqual(doc.sections.map((s) => s.id), ["SALARY", "BP", "CG", "OS", "TI", "TAX", "TAXES_PAID"]);
  assert.deepEqual(doc.sections.map((s) => s.letter), ["A", "B", "C", "D", "E", "F", "G"]);
});

test("an unsupported year still raises — two supported years is not all years", () => {
  const wrongYear = JSON.parse(JSON.stringify(json));
  wrongYear.ITR.ITR3.Form_ITR3.AssessmentYear = "2019";
  assert.throws(() => buildComputation(wrongYear, CTX), UnsupportedFormError);
});
