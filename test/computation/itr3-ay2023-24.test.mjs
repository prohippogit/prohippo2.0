/*
 * Computation of Income — ITR-3, A.Y. 2023-24.
 *
 *   node --test test/computation/itr3-ay2023-24.test.mjs
 *
 * The widest return on any form we hold: pension, a proprietary business with
 * full books, a land sale ending in a long-term capital LOSS, agricultural
 * income credited to the P&L, and a partner's interest in five firms — all on
 * one return. Anonymised (spec §11).
 *
 * What this fixture covers that no other does:
 *   - a capital LOSS, and losses carried forward from an earlier year as well
 *     as this one;
 *   - Schedule TDS3 — tax deducted by a buyer who holds no TAN, and on this
 *     return the only tax deducted at source there is;
 *   - Schedule TCS with named collectors;
 *   - exempt income itemised inside Schedule BP;
 *   - a refund on an ITR-3, and a s.87A rebate that extinguishes the tax.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildComputation, detect, validate, UnsupportedFormError } from "../../src/computation/index.js";
import { mapItr3 } from "../../src/computation/mappers/itr3/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "..", "fixtures", "itr3-partner-cgloss-tds3-ay2023-24.json");
const GOLDEN = path.join(here, "..", "golden", "itr3-partner-cgloss-tds3-ay2023-24.model.json");

const json = JSON.parse(readFileSync(FIXTURE, "utf8"));
const CTX = { generatedAt: "2026-01-01T00:00:00.000Z" };

const build = () => {
  const { form, body, ay, schemaVersion } = detect(json);
  assert.equal(form, "ITR3");
  assert.equal(ay, "2023-24");
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

/* ---------------- the capital loss ---------------- */

test("a sale below indexed cost is captioned a LOSS, not a gain", () => {
  const { doc } = build();
  const cg = section(doc, "CG");
  /* One property, so the schedule is one line — the address and the buyer on
     the banner above it, the figures across. The raw cost and the indexed cost
     are separate columns: the indexation is what turns a 45,90,000 sale of a
     33,07,536 asset into a loss, and a reader who cannot see the number it
     started from cannot check it. */
  const m = cg.rows.find((r) => r.kind === "matrix" && /land or building/.test(r.label));
  const at = (label) => m.lines.find((l) => !l.span).cells[m.columns.findIndex((c) => c.label === label)];
  assert.deepEqual(m.columns.map((c) => c.label), [
    "Sold", "Acquired", "Full value", "Cost", "Indexed cost", "Deductions", "Capital gain",
  ]);
  assert.match(m.lines[0].label, /^Property 1 · /);
  assert.equal(m.lines[0].span, true, "the property and its buyer get the width of the page");
  assert.equal(at("Full value"), 4590000);
  assert.equal(at("Cost"), 3307536);
  assert.equal(at("Indexed cost"), 5473972);
  assert.equal(at("Capital gain"), -883972);

  // The renderer parenthesises a negative either way; the caption must also say
  // the right word. "Total Long-term Capital Gains (8,83,972)" is wrong English
  // on a document somebody signs.
  const subtotal = cg.rows.find((r) => r.kind === "subtotal");
  assert.equal(subtotal.label, "Total Long-term Capital Loss");
  assert.equal(subtotal.amount, 883972);
  assert.equal(subtotal.isLoss, true);
  // The head itself is nil: a capital loss does not reduce other heads.
  assert.equal(closing(cg).amount, 0);
  assert.equal(row(doc, "TI", /^Capital Gains/).amount, 0);
});

test("losses carried forward total what the return carries forward, not this year's loss", () => {
  const { doc, body } = build();
  // The trap: PartB-TI states 8,83,972 as the CURRENT year's loss, while
  // Schedule CFL states 26,15,711 as the total carried forward — the difference
  // being 17,31,739 still unabsorbed from an earlier year. Summarising from
  // Part B-TI understated by 17.3 lakh the relief available in future years.
  assert.equal(body["PartB-TI"].LossesOfCurrentYearCarriedFwd, 883972);
  assert.equal(body.ScheduleCFL.TotalLossCFSummary.LossSummaryDetail.TotalLTCGPTILossCF, 2615711);

  const cfl = section(doc, "CFL");
  // The A.Y. is named from the slot the return keeps the loss in, and the date
  // that year's return was filed is printed beside it: s.80 allows the
  // carry-forward only where that return was in time.
  assert.deepEqual(
    cfl.rows.filter((r) => r.kind === "sub").map((r) => [r.label, r.amount, r.cols && r.cols.ref]),
    [["A.Y. 2021-22 · Long-term capital loss", 1731739, "14 March 2022"],
      ["Add: Loss of the current year — long-term capital loss", 883972, "A.Y. 2023-24"]]
  );
  assert.equal(row(doc, "CFL", /^Total Brought Forward/).amount, 1731739);
  assert.equal(closing(cfl).amount, 2615711);
});

/* ---------------- Schedule TDS3 ---------------- */

test("TDS deducted by a buyer with no TAN is listed, not just totalled", () => {
  const { doc, body } = build();
  // A buyer of immovable property deducts u/s 194-IA against their own PAN, so
  // the credit sits in Schedule TDS3 and never in TDS1 or TDS2. On this return
  // it is the ONLY tax deducted at source: reading only TDS1 and TDS2 printed
  // "Total Tax Deducted at Source — 45,900" with no row above it.
  assert.equal(body.ScheduleTDS1.TotalTDSonSalaries, 0);
  assert.equal(body.ScheduleTDS1.TDSonSalary, undefined);
  assert.equal(body.ScheduleTDS2.TotalTDSonOthThanSals, 0);
  assert.equal(body.ScheduleTDS3.TotalTDS3OnOthThanSal, 45900);

  const paid = section(doc, "TAXES_PAID");
  assert.ok(paid.rows.some((r) => r.kind === "columnHeader" && /PAN of Buyer or Tenant/.test(r.label)));
  const tds3 = paid.rows.find((r) => r.amount === 45900 && r.kind === "sub");
  assert.equal(tds3.cols.ref, "45,90,000");
  assert.match(tds3.note, /not required to hold a TAN · against Capital Gains/);
  assert.equal(row(doc, "TAXES_PAID", /^Total Tax Deducted at Source/).amount, 45900);
});

test("tax collected at source names the collectors", () => {
  const { doc } = build();
  const paid = section(doc, "TAXES_PAID");
  assert.ok(paid.rows.some((r) => r.kind === "columnHeader" && /TAN of Collector/.test(r.label)));
  const collectors = paid.rows.filter((r) => r.amount === 7620 || r.amount === 5953);
  assert.equal(collectors.length, 2);
  assert.equal(row(doc, "TAXES_PAID", /^Tax Collected at Source$/).amount, 13573);
  assert.equal(row(doc, "TAXES_PAID", /^Total Taxes Paid/).amount, 59473);
});

test("the refund is the first on an ITR-3 fixture", () => {
  const { doc } = build();
  assert.equal(doc.payable, null);
  assert.equal(doc.refund.amount, 59470);
  assert.ok(doc.refund.bank.ifsc);
  assert.equal(closing(section(doc, "TAXES_PAID")).label, "Refund Due");
});

/* ---------------- the business head ---------------- */

test("exempt income credited to the P&L is named, not just subtracted", () => {
  const { doc, body } = build();
  // OtherExmptIncDtls is an ARRAY of { OperatingRevenueName, OperatingRevenueAmt }.
  // Reading only the OthExempInc total printed the right figure under a caption
  // that said nothing about what it was, and left the array element for review.
  const items = body.ITR3ScheduleBP.BusinessIncOthThanSpec.IncCredPL.OtherExmptIncDtls;
  assert.equal(items[0].OperatingRevenueName, "Agriculture Income");
  assert.equal(row(doc, "BP", /^Less: Agriculture Income credited/).amount, 212200);
  assert.equal(closing(section(doc, "BP")).amount, 274291);

  // The same 2,12,200 is aggregated for rate purposes and rebated back.
  assert.equal(row(doc, "TI", /^Add: Net agricultural income/).amount, 212200);
  assert.equal(row(doc, "TAX", /^Less: Rebate on agricultural income/).amount, 12440);
});

test("the pension is named from the salary component code", () => {
  const { doc } = build();
  const salary = row(doc, "SALARY", /^Salary as per section 17\(1\)/);
  assert.equal(salary.amount, 315304);
  // One component equal to the whole line goes in the note, not a second row.
  assert.match(salary.note, /Commuted pension$/);
  assert.equal(closing(section(doc, "SALARY")).amount, 265304);
});

/* ---------------- shape ---------------- */

test("the rebate u/s 87A extinguishes the tax, and every head appears", () => {
  const { doc } = build();
  assert.deepEqual(doc.sections.map((s) => s.id), ["SALARY", "BP", "CG", "OS", "VIA", "TI", "TAX", "TAXES_PAID", "CFL"]);
  assert.equal(closing(section(doc, "TI")).amount, 339600);
  assert.equal(row(doc, "TAX", /^Less: Rebate u\/s 87A/).amount, 7920);
  assert.equal(row(doc, "TAX", /^Tax after rebate/).amount, 0);
  assert.equal(closing(section(doc, "TAX")).amount, 0);
});

test("the five firms the assessee is a partner in are carried on the card", () => {
  const { doc } = build();
  assert.equal(doc.assessee.partners.length, 5);
  assert.equal(doc.assessee.constitutionTitle, "Partner in firms");
  assert.ok(doc.notes.some((n) => /partner in 5 firms/.test(n.text)));
});

test("an unsupported year raises rather than using another year's mapper", () => {
  const wrongYear = JSON.parse(JSON.stringify(json));
  wrongYear.ITR.ITR3.Form_ITR3.AssessmentYear = "2020";
  assert.throws(() => buildComputation(wrongYear, CTX), UnsupportedFormError);
});
