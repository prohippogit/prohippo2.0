/*
 * Computation of Income — ITR-3, A.Y. 2025-26.
 *
 *   node --test test/computation/itr3.test.mjs
 *
 * A partner in four firms who also draws a salary, earns interest and dividend,
 * and has agricultural income. Between them these exercise the three things
 * ITR-3 adds to ITR-2: the business head with no profit & loss account behind
 * it, agricultural income aggregated for rate purposes and then rebated, and a
 * return that closes level — neither refund nor demand. Anonymised (spec §11).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildComputation, detect, validate, UnsupportedFormError } from "../../src/computation/index.js";
import { mapItr3 } from "../../src/computation/mappers/itr3/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "..", "fixtures", "itr3-partner-salary-agri-ay2025-26.json");
const GOLDEN = path.join(here, "..", "golden", "itr3-partner-salary-agri-ay2025-26.model.json");

const json = JSON.parse(readFileSync(FIXTURE, "utf8"));
const CTX = { generatedAt: "2026-01-01T00:00:00.000Z" };

const build = () => {
  const { form, body, ay, schemaVersion } = detect(json);
  assert.equal(form, "ITR3");
  assert.equal(ay, "2025-26");
  return { body, doc: mapItr3(body, { ...CTX, ay, schemaVersion }) };
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

/* ---------------- the business head ---------------- */

test("a partner's income from firms is worked without inventing a profit & loss account", () => {
  const { doc } = build();
  const bp = section(doc, "BP");
  // This assessee keeps no books: there is no P&L, so there is no net-profit row
  // to add to, and the working must not open with a nil one.
  assert.ok(!bp.rows.some((r) => /profit before tax as per the profit & loss/i.test(r.label)));
  assert.doesNotMatch(bp.rows[0].label, /^Add:/);
  assert.match(bp.rows[0].label, /interest from firms in which the assessee is a partner/);
  assert.equal(bp.rows[0].amount, 572009);
  assert.equal(closing(bp).amount, 572009);
});

test("the business head ties to the figure Part B-TI carries for it", () => {
  const { doc, body } = build();
  const ti = section(doc, "TI");
  assert.equal(
    ti.rows.find((r) => r.label === "Profits and Gains of Business or Profession").amount,
    body["PartB-TI"].ProfBusGain.TotProfBusGain
  );
  assert.deepEqual(validate(doc, body).failures, []);
});

test("the firms are named, with the share and capital balance the return states", () => {
  const { doc } = build();
  assert.equal(doc.assessee.partners.length, 4);
  assert.equal(doc.assessee.constitutionTitle, "Partner in firms");
  const audited = doc.assessee.partners.filter((f) => /audited u\/s 44AB/.test(f.detail));
  assert.equal(audited.length, 2, "two of the four firms are audited, and it says so");
  assert.match(doc.assessee.partners[0].detail, /Share 15%/);
  assert.match(doc.assessee.partners[0].detail, /Capital balance 51,25,281/);
  // The share of a firm's profit is exempt while interest from it is not — a
  // distinction worth stating on a document that shows one and not the other.
  assert.ok(doc.notes.some((n) => /exempt u\/s 10\(2A\)/.test(n.text)));
});

/* ---------------- agricultural income ---------------- */

test("agricultural income is aggregated for the rate and taken back out", () => {
  const { doc } = build();
  const ti = section(doc, "TI");
  const agri = ti.rows.find((r) => /Net agricultural income/.test(r.label));
  assert.equal(agri.amount, 110000);
  assert.match(agri.note, /does not enter total income/);
  assert.equal(ti.rows.find((r) => /Aggregate income/.test(r.label)).amount, 2211440);

  const rebate = section(doc, "TAX").rows.find((r) => /Rebate on agricultural income/.test(r.label));
  assert.equal(rebate.amount, 5500);
  assert.ok(doc.notes.some((n) => /exempt u\/s 10\(1\)/.test(n.text)));
});

test("total income is stated after the rounding the return applied, not the aggregate", () => {
  const { doc } = build();
  const ti = section(doc, "TI");
  assert.equal(ti.rows.find((r) => /^Total Income/.test(r.label)).amount, 2101440);
});

/* ---------------- the tax section ---------------- */

test("the cess is read from where ITR-3 keeps it, not where ITR-2 does", () => {
  const { doc } = build();
  // ITR-2 carries the rebate, surcharge and cess directly under
  // ComputationOfTaxLiability; ITR-3 nests them inside TaxPayableOnTI. Reading
  // the wrong one produces a cess row of nil on a document somebody signs.
  const rows = section(doc, "TAX").rows;
  assert.equal(rows.find((r) => /Health & Education Cess/.test(r.label)).amount, 13917);
  assert.equal(rows.find((r) => /^Gross Tax Liability/.test(r.label)).amount, 361849);
});

test("interest u/s 234B and 234C is broken out in the note", () => {
  const { doc } = build();
  const row = section(doc, "TAX").rows.find((r) => /234A \/ 234B \/ 234C/.test(r.label));
  assert.equal(row.amount, 11100);
  assert.match(row.note, /s\.234B 5,049/);
  assert.match(row.note, /s\.234C 6,051/);
});

/* ---------------- taxes paid ---------------- */

test("38 TDS entries become one row per deductor and section, carrying the count", () => {
  const { doc, body } = build();
  const rows = section(doc, "TAXES_PAID").rows;
  assert.equal(body.ScheduleTDS2.TDSOthThanSalaryDtls.length, 38);
  const tds = rows.filter((r) => /Sec\. 194A/.test(r.note || ""));
  assert.equal(tds.length, 3, "three deductors, not thirty-eight lines");
  assert.ok(tds.some((r) => /36 entries/.test(r.note)));
  assert.equal(rows.find((r) => /^Total Tax Deducted at Source/.test(r.label)).amount, 55703);
});

test("advance tax and self-assessment tax are traceable to their challans", () => {
  const { doc } = build();
  const rows = section(doc, "TAXES_PAID").rows;
  assert.ok(rows.some((r) => r.kind === "columnHeader" && /BSR code \/ challan/.test(r.label)));
  assert.equal(rows.find((r) => /^Advance Tax Paid/.test(r.label)).amount, 250000);
  assert.equal(rows.find((r) => /^Self-Assessment Tax Paid/.test(r.label)).amount, 67250);
  assert.equal(rows.find((r) => /^Total Taxes Paid/.test(r.label)).amount, 372953);
});

test("a return that closes level shows neither a refund nor a demand", () => {
  const { doc } = build();
  // Taxes paid exceed the liability by four rupees, which CPC neither refunds
  // nor demands, so the return states nil against both fields.
  assert.equal(doc.refund, null);
  assert.equal(doc.payable, null);
  assert.match(closing(section(doc, "TAXES_PAID")).label, /Nothing further payable or refundable/);
});

/* ---------------- shape of the document ---------------- */

test("only the heads this assessee has are shown, and they are lettered in order", () => {
  const { doc } = build();
  // No house property and no capital gains in this return: those sections are
  // dropped, and the lettering closes up rather than leaving a gap.
  assert.deepEqual(doc.sections.map((s) => s.id), ["SALARY", "BP", "OS", "TI", "TAX", "TAXES_PAID"]);
  assert.deepEqual(doc.sections.map((s) => s.letter), ["A", "B", "C", "D", "E", "F"]);
  // The total-income section still lists every head, including the nil ones.
  const heads = section(doc, "TI").rows.filter((r) => r.kind === "head").map((r) => r.label);
  assert.equal(heads.length, 5);
  assert.ok(heads.includes("Income from House Property"));
});

test("the regime is stated, and this one is the new regime", () => {
  const { doc } = build();
  // §10: ITR-3 asks the question as No_OptOutNewTaxReg. "N" reads as the new
  // regime, which the return's own tax at normal rates confirms — it reconciles
  // to the rupee against the s.115BAC(1A) slabs and to nothing else.
  assert.match(doc.assessee.facts.find((f) => f.label === "Tax regime").value, /New regime/);
  assert.ok(doc.notes.some((n) => /new regime/i.test(n.text)));
});

test("an unsupported year raises rather than using another year's mapper", () => {
  const wrongYear = JSON.parse(JSON.stringify(json));
  wrongYear.ITR.ITR3.Form_ITR3.AssessmentYear = "2018";
  assert.throws(() => buildComputation(wrongYear, CTX), UnsupportedFormError);
});
