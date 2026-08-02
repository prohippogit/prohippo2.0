/*
 * Computation of Income — ITR-3, A.Y. 2026-27.
 *
 *   node --test test/computation/itr3-ay2026-27.test.mjs
 *
 * A professional keeping full books of account — balance sheet, trading and
 * profit & loss account, block-wise depreciation — with listed-equity gains, a
 * sale of unquoted shares, and total income over a crore. Anonymised (spec §11).
 *
 * What this fixture covers that no other does:
 *   - books of account. Every earlier ITR-3 fixture was a partner in firms or a
 *     44AD presumptive case, so the P&L-to-Schedule-BP working ran empty;
 *   - a real SURCHARGE, on total income above ₹ 1 crore;
 *   - the regime asked as Form 10-IEA flags rather than an opt-out field;
 *   - Schedule CG's "other assets" block nested a level deeper than in 2025-26;
 *   - five challans of advance and self-assessment tax;
 *   - a return that closes exactly level — nothing payable, nothing refundable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildComputation, detect, validate, UnsupportedFormError } from "../../src/computation/index.js";
import { mapItr3 } from "../../src/computation/mappers/itr3/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "..", "fixtures", "itr3-books-surcharge-unqshares-ay2026-27.json");
const GOLDEN = path.join(here, "..", "golden", "itr3-books-surcharge-unqshares-ay2026-27.model.json");

const json = JSON.parse(readFileSync(FIXTURE, "utf8"));
const CTX = { generatedAt: "2026-01-01T00:00:00.000Z" };

const build = () => {
  const { form, body, ay, schemaVersion } = detect(json);
  assert.equal(form, "ITR3");
  assert.equal(ay, "2026-27");
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

/* ---------------- books of account ---------------- */

test("the working starts at net profit per the P&L and the accounts are not restated", () => {
  const { doc, body } = build();
  // The return carries a full balance sheet, trading account, P&L and three
  // depreciation schedules. A Computation of Total Income restates none of them
  // — it takes the one figure Schedule BP carries and works from there.
  assert.ok(body.PARTA_BS && body.TradingAccount && body.PARTA_PL && body.ScheduleDPM);
  assert.equal(row(doc, "BP", /^Net profit before tax/).amount, 10877536);
  assert.equal(row(doc, "BP", /assessable under capital gains/).amount, 8850661);
  assert.equal(closing(section(doc, "BP")).amount, 1665434);
});

test("book depreciation comes back and the s.32 allowance goes out", () => {
  const { doc } = build();
  assert.equal(row(doc, "BP", /^Add: Depreciation debited/).amount, 402986);
  const allowed = row(doc, "BP", /^Less: Depreciation allowable u\/s 32/);
  assert.equal(allowed.amount, 400392);
  assert.match(allowed.note, /Schedules DPM, DOA and DEP/);
});

test("the parts of an other-heads credit are not subtracted a second time", () => {
  const { doc, body } = build();
  // The return states 3,64,035 against OtherSources and the same 3,64,035
  // against its OtherThanDividend part. Only one of them is subtracted on the
  // way to the adjusted profit, so only one line may carry it.
  const credits = body.ITR3ScheduleBP.BusinessIncOthThanSpec.IncRecCredPLOthHeadDtls;
  assert.equal(credits.OtherSources, 364035);
  assert.equal(credits.OtherThanDividend, 364035);
  const lines = section(doc, "BP").rows.filter((r) => r.amount === 364035);
  assert.equal(lines.length, 1);
  assert.match(lines[0].label, /assessable under other sources$/);
  assert.equal(lines[0].note, "Being income from sources other than dividend");
});

test("a subtotal the return leaves blank is not printed as nil", () => {
  const { doc, body } = build();
  // TotAfterAddToPLDeprOthSpecInc is nil on a return whose adjusted profit is
  // 16,65,434. A "Profit after the additions above — nil" line between the
  // depreciation rows and that total would state something untrue.
  assert.equal(body.ITR3ScheduleBP.BusinessIncOthThanSpec.TotAfterAddToPLDeprOthSpecInc, 0);
  assert.equal(body.ITR3ScheduleBP.BusinessIncOthThanSpec.AdjustPLAfterDeprOthSpecInc, 1665434);
  assert.ok(!section(doc, "BP").rows.some((r) => /^Profit after the/.test(r.label)));
});

/* ---------------- capital gains ---------------- */

test("the unquoted-share sale is found even though the schema nested it deeper", () => {
  const { doc, body } = build();
  // A.Y. 2024-25 carries this block flat as SaleofAssetNA, 2025-26 splits it
  // into _BE / _AE inside SaleofAssetNADtls, and 2026-27 puts a single
  // SaleofAssetNA back inside that wrapper. Reading a fixed path missed the
  // 37,71,160 entirely and put it in the review block.
  const lt = body.ScheduleCGFor23.LongTermCapGain23;
  assert.equal(lt.SaleofAssetNADtls.SaleofAssetNA.FullConsideration, 3771160);
  const cg = section(doc, "CG");
  const consideration = cg.rows.filter((r) => /^Full value of consideration/.test(r.label));
  assert.deepEqual(consideration.map((r) => r.amount), [835867, 22302570, 3771160]);
  assert.match(consideration[2].label, /assets other than those listed separately$/);
  assert.equal(closing(cg).amount, 9144431);
});

test("the head is captioned by rate nowhere and the sections come from Schedule SI", () => {
  const { doc } = build();
  assert.ok(!section(doc, "CG").rows.some((r) => /u\/s 11[12]/.test(r.label) && r.kind !== "sub"));
  const si = section(doc, "TAX").rows.filter((r) => r.ref === "Sch. SI");
  assert.deepEqual(si.map((r) => r.label), [
    "Short-term capital gains u/s 111A — at 20%",
    "Long-term capital gains u/s 112 — at 12.5%",
    "Long-term capital gains u/s 112A — at 12.5%",
  ]);
  assert.deepEqual(si.map((r) => r.amount), [12708, 153191, 966296]);
});

/* ---------------- the regime, verified rather than inferred ---------------- */

test("the regime is read from the Form 10-IEA flags, and ties to the slab table", () => {
  const { doc, body } = build();
  const fs = body.PartA_GEN1.FilingStatus;
  // Neither OptOutNewTaxRegime nor No_OptOutNewTaxReg exists on this year's form.
  assert.equal(fs.OptOutNewTaxRegime, undefined);
  assert.equal(fs.No_OptOutNewTaxReg, undefined);
  assert.equal(fs.F10IEACurrAYOldRegime, "N");
  assert.equal(fs.Form10IEAEarlierAYOldRegime, "N");
  assert.match(doc.assessee.facts.find((f) => f.label === "Tax regime").value, /^New regime/);

  // The reading is checked against the return's own arithmetic, not the field
  // name: 2,09,250 on 20,37,001 is the s.115BAC(1A) table for this year
  // (nil to 4L, then 5 / 10 / 15 / 20 / 25%) and nothing else.
  assert.equal(row(doc, "TI", /^balance taxable at the rates in force/).amount, 2037001);
  assert.equal(row(doc, "TAX", /^Tax on income at the rates in force/).amount, 209250);
  const slabs = [[400000, 0], [400000, 0.05], [400000, 0.10], [400000, 0.15], [400000, 0.20], [37001, 0.25]];
  assert.equal(Math.floor(slabs.reduce((t, [amt, rate]) => t + amt * rate, 0)), 209250);
});

/* ---------------- surcharge ---------------- */

test("the surcharge says why it is charged", () => {
  const { doc } = build();
  const sc = row(doc, "TAX", /^Add: Surcharge/);
  assert.equal(sc.amount, 201217);
  // The threshold is read off this return's own total income, not off the field
  // name `SurchargeOnAboveCrore` — which the A.Y. 2022-23 return fills on a
  // total income of 51,43,580, nowhere near a crore.
  assert.equal(sc.note, "Total income exceeds ₹ 50 lakh");
  // No marginal relief on this return — the return states the same figure before
  // and after it — so the note does not claim any.
  assert.ok(!/marginal relief/i.test(sc.note));
  assert.equal(row(doc, "TAX", /^Add: Health & Education Cess/).amount, 61706);
  assert.equal(row(doc, "TAX", /^Gross Tax Liability/).amount, 1604368);
});

test("interest u/s 234B and 234C is named, not just totalled", () => {
  const { doc } = build();
  const interest = row(doc, "TAX", /^Add: Interest u\/s 234A/);
  assert.equal(interest.amount, 75299);
  assert.equal(interest.note, "s.234B 36,172 · s.234C 39,127");
  assert.equal(closing(section(doc, "TAX")).amount, 1679667);
});

/* ---------------- taxes paid ---------------- */

test("challans are listed in date order, whatever order the return keyed them", () => {
  const { doc, body } = build();
  assert.deepEqual(
    body.ScheduleIT.TaxPayment.map((c) => c.DateDep),
    ["2026-01-07", "2026-07-08", "2025-09-09", "2026-07-12", "2025-06-05"]
  );
  const challans = section(doc, "TAXES_PAID").rows
    .filter((r) => r.cols && /^\d{2} /.test(r.cols.ref || ""));
  assert.deepEqual(challans.map((r) => r.amount), [250000, 150000, 300000, 400000, 579667]);
  assert.deepEqual(challans.map((r) => r.cols.ref), [
    "05 June 2025", "09 September 2025", "07 January 2026", "08 July 2026", "12 July 2026",
  ]);
  assert.equal(row(doc, "TAXES_PAID", /^Advance Tax Paid/).amount, 700000);
  assert.equal(row(doc, "TAXES_PAID", /^Self-Assessment Tax Paid/).amount, 979667);
});

test("a return that closes level gets no banner and says so", () => {
  const { doc } = build();
  assert.equal(doc.refund, null);
  assert.equal(doc.payable, null);
  const paid = section(doc, "TAXES_PAID");
  assert.equal(row(doc, "TAXES_PAID", /^Total Taxes Paid/).amount, 1679667);
  assert.equal(closing(paid).label, "Nothing further payable or refundable");
});

/* ---------------- shape and the year gate ---------------- */

test("only the heads this assessee has become sections", () => {
  const { doc } = build();
  // No salary, no house property, no Chapter VI-A. The heads still appear in the
  // total-income table as nil, because Part B-TI states them.
  assert.deepEqual(doc.sections.map((s) => s.id), ["BP", "CG", "OS", "TI", "TAX", "TAXES_PAID"]);
  assert.equal(row(doc, "TI", /^Income from Salaries/).amount, 0);
  assert.equal(row(doc, "TI", /^Less: Deductions under Chapter VI-A/).amount, 0);
  assert.equal(closing(section(doc, "TI")).amount, 11181432);
});

test("Schedule AL is a disclosure, not a figure requiring review", () => {
  const { doc, body } = build();
  // Assets and liabilities are disclosed once total income exceeds ₹ 50 lakh.
  // Nothing in that schedule enters the computation of income.
  assert.ok(body.ScheduleAL);
  assert.ok(!doc.unmapped.some((u) => u.path.startsWith("ScheduleAL")));
});

test("an unsupported year raises rather than using another year's mapper", () => {
  const wrongYear = JSON.parse(JSON.stringify(json));
  wrongYear.ITR.ITR3.Form_ITR3.AssessmentYear = "2020";
  assert.throws(() => buildComputation(wrongYear, CTX), UnsupportedFormError);
});
