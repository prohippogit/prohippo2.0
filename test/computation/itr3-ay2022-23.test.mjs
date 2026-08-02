/*
 * Computation of Income — ITR-3, A.Y. 2022-23.
 *
 *   node --test test/computation/itr3-ay2022-23.test.mjs
 *
 * The earliest year supported, and the one furthest from the current schema: a
 * professional on the OLD regime with books of account, capital gains at the
 * pre-2024 rates, and a surcharge cut down by marginal relief. Anonymised (§11).
 *
 * What this fixture covers that no other does:
 *   - `NewTaxRegime`, a third spelling of the regime question whose sense is the
 *     OPPOSITE of `OptOutNewTaxRegime` — "N" here means the old regime;
 *   - MARGINAL RELIEF on the surcharge, 1,22,349 cut to 1,00,506;
 *   - a Schedule VI-A block carrying its own Part B / Part C subtotals beside
 *     the real sections;
 *   - Schedule CG's blocks flat, before the wrappers later years put round them;
 *   - Schedule AL with immovable property, which must not reach the review block;
 *   - a return with no filing due date and no verification date or place.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildComputation, detect, validate, UnsupportedFormError } from "../../src/computation/index.js";
import { mapItr3 } from "../../src/computation/mappers/itr3/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "..", "fixtures", "itr3-oldregime-marginal-relief-ay2022-23.json");
const GOLDEN = path.join(here, "..", "golden", "itr3-oldregime-marginal-relief-ay2022-23.model.json");

const json = JSON.parse(readFileSync(FIXTURE, "utf8"));
const CTX = { generatedAt: "2026-01-01T00:00:00.000Z" };

const build = () => {
  const { form, body, ay, schemaVersion } = detect(json);
  assert.equal(form, "ITR3");
  assert.equal(ay, "2022-23");
  return { body, doc: mapItr3(body, { ...CTX, ay, schemaVersion }) };
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

/* ---------------- the regime, asked backwards ---------------- */

test("NewTaxRegime reads the opposite way to OptOutNewTaxRegime, and ties to the slab table", () => {
  const { doc, body } = build();
  const fs = body.PartA_GEN1.FilingStatus;
  // This year asks whether the assessee opted IN. Every other year we support
  // asks whether they opted OUT. Reading "N" with the later years' sense would
  // print "New regime" on a return claiming 2,11,064 of Chapter VI-A deductions.
  assert.equal(fs.NewTaxRegime, "N");
  assert.equal(fs.OptOutNewTaxRegime, undefined);
  assert.equal(fs.No_OptOutNewTaxReg, undefined);
  assert.match(doc.assessee.facts.find((f) => f.label === "Tax regime").value, /^Old regime/);

  // Checked against the return's own arithmetic: 10,17,521 on 40,25,070 is the
  // old-regime table for an assessee over 60 — exemption 3,00,000, then 5% to
  // 5 lakh, 20% to 10 lakh, 30% above — and nothing else.
  assert.equal(row(doc, "TI", /^balance taxable at the rates in force/).amount, 4025070);
  assert.equal(row(doc, "TAX", /^Tax on income at the rates in force/).amount, 1017521);
  const oldRegime = 200000 * 0.05 + 500000 * 0.20 + (4025070 - 1000000) * 0.30;
  assert.equal(Math.floor(oldRegime), 1017521);
});

/* ---------------- marginal relief ---------------- */

test("the surcharge states the threshold and the marginal relief the return allowed", () => {
  const { doc, body } = build();
  const tti = body.PartB_TTI.ComputationOfTaxLiability.TaxPayableOnTI;
  assert.equal(tti.SurchargeOnAboveCroreBeforeMarginal, 122349);
  assert.equal(tti.SurchargeOnAboveCrore, 100506);

  const sc = row(doc, "TAX", /^Add: Surcharge/);
  assert.equal(sc.amount, 100506);
  // The relief is the return's own subtraction between those two fields.
  assert.equal(sc.note, "Total income exceeds ₹ 50 lakh · After marginal relief of 21,843");
  // And the note does NOT say "exceeds ₹ 1 crore" — total income here is
  // 51,43,580, though the field carrying the charge is called
  // SurchargeOnAboveCrore.
  assert.equal(closing(section(doc, "TI")).amount, 5143580);
  assert.ok(!/crore/.test(sc.note));
});

/* ---------------- Chapter VI-A ---------------- */

test("the block's own subtotals are not printed as if they were deductions", () => {
  const { doc, body } = build();
  // This year's Schedule VI-A carries TotPartBchapterVIA and
  // TotPartCAandDchapterVIA alongside the four real sections. Printing them gave
  // a "deduction under u/s TotPartBchapterVIA — 2,02,250" line that
  // double-counted the whole of Part B.
  const allowed = body.ScheduleVIA.DeductUndChapVIA;
  assert.equal(allowed.TotPartBchapterVIA, 202250);
  assert.equal(allowed.TotPartCAandDchapterVIA, 8814);

  const via = section(doc, "VIA");
  assert.deepEqual(via.rows.filter((r) => r.kind === "sub").map((r) => r.ref), ["80C", "80D", "80G", "80TTB"]);
  // Four deduction lines and the closing total, nothing else.
  assert.equal(via.rows.length, 5);
  assert.ok(!via.rows.some((r) => /chapterVIA/.test(r.label)));
  assert.equal(closing(via).amount, 211064);
  assert.match(row(doc, "VIA", /80C/).note, /Claimed 2,26,234; restricted/);
});

/* ---------------- capital gains at the pre-2024 rates ---------------- */

test("the flat Schedule CG blocks of this year are read, and the rates split", () => {
  const { doc, body } = build();
  // 2022-23 carries SaleofAssetNA and SlumpSaleInLtcg flat, without the
  // SaleofAssetNADtls / SlumpSaleInLtcgDtls wrappers of the later years.
  const lt = body.ScheduleCGFor23.LongTermCapGain23;
  assert.equal(lt.SaleofAssetNA.FullConsideration, 1029887);
  assert.equal(lt.SaleofAssetNADtls, undefined);
  assert.ok(lt.SlumpSaleInLtcg && !lt.SlumpSaleInLtcgDtls);

  const cg = section(doc, "CG");
  assert.equal(row(doc, "CG", /assets other than those listed separately/).amount, 1029887);
  // Two long-term rates this year — 10% and 20%, with no 12.5% bucket — so the
  // subtotal is broken out. The captions are rates, never sections.
  assert.deepEqual(
    cg.rows.filter((r) => /^— taxable at/.test(r.label)).map((r) => [r.label, r.amount]),
    [["— taxable at 10%", 88623], ["— taxable at 20%", 1029887]]
  );
  assert.equal(closing(cg).amount, 1168538);
});

test("a special rate that yields nil tax is still stated", () => {
  const { doc } = build();
  const si = section(doc, "TAX").rows.filter((r) => r.ref === "Sch. SI");
  assert.deepEqual(si.map((r) => r.label), [
    "Long-term capital gains u/s 112 — at 20%",
    "Long-term capital gains u/s 112A — at 10%",
  ]);
  // 88,623 of s.112A gain falls under the exemption, so the tax is nil. The row
  // is printed so a reader can see the figure was considered.
  assert.deepEqual(si.map((r) => r.amount), [205977, 0]);
  assert.match(si[1].note, /on 88,623/);
});

/* ---------------- shape, disclosures and closing ---------------- */

test("Schedule AL's immovable property is a disclosure, not a figure for review", () => {
  const { doc, body } = build();
  // Two properties of 6,51,000 and 75,44,820. Neither enters the computation of
  // income, and both would otherwise have filled the review block.
  assert.equal(body.ScheduleAL.ImmovableDetails.length, 2);
  assert.deepEqual(doc.unmapped, []);
});

test("a return with no due date and no verification date drops the blank fields", () => {
  const { doc, body } = build();
  assert.equal(body.PartA_GEN1.FilingStatus.ItrFilingDueDate, undefined);
  assert.equal(body.Verification.Date, undefined);
  // The fact list still carries the label; the renderer drops facts with no
  // value, so nothing prints an empty "Due date".
  assert.equal(doc.assessee.facts.find((f) => f.label === "Due date").value, "");
  assert.equal(doc.signatory.date, "");
  assert.equal(doc.signatory.capacity, "Self");
});

test("the return closes level, and the challans are in date order", () => {
  const { doc } = build();
  assert.equal(doc.refund, null);
  assert.equal(doc.payable, null);
  const challans = section(doc, "TAXES_PAID").rows.filter((r) => r.cols && /^\d{2} /.test(r.cols.ref || ""));
  assert.deepEqual(challans.map((r) => r.amount), [100000, 120000, 111000, 125000, 400000, 594749]);
  assert.equal(row(doc, "TAXES_PAID", /^Advance Tax Paid/).amount, 456000);
  assert.equal(row(doc, "TAXES_PAID", /^Self-Assessment Tax Paid/).amount, 994749);
  assert.equal(row(doc, "TAXES_PAID", /^Total Taxes Paid/).amount, 1457671);
  assert.equal(closing(section(doc, "TAXES_PAID")).label, "Nothing further payable or refundable");
});

test("only the heads this assessee has become sections", () => {
  const { doc } = build();
  assert.deepEqual(doc.sections.map((s) => s.id), ["BP", "CG", "OS", "VIA", "TI", "TAX", "TAXES_PAID"]);
  assert.equal(closing(section(doc, "BP")).amount, 4112669);
  assert.equal(closing(section(doc, "OS")).amount, 73433);
});

test("an unsupported year raises rather than using another year's mapper", () => {
  const wrongYear = JSON.parse(JSON.stringify(json));
  wrongYear.ITR.ITR3.Form_ITR3.AssessmentYear = "2020";
  assert.throws(() => buildComputation(wrongYear, CTX), UnsupportedFormError);
});
