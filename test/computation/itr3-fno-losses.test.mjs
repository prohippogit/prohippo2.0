/*
 * Computation of Income — ITR-3, a derivatives trader across two years.
 *
 *   node --test test/computation/itr3-fno-losses.test.mjs
 *
 * One assessee whose whole business is futures and options, filed for five
 * consecutive years. Two of those years are fixtures here because between them
 * they exercise every part of Schedule CFL and Schedule UD:
 *
 *   A.Y. 2024-25  a BUSINESS LOSS of the year, set off against capital gains
 *                 and other sources; six earlier years of loss brought forward,
 *                 one of them in the differently-named LossCFFromPrev3rdYearFromAY
 *                 block; unabsorbed depreciation still to be carried forward.
 *
 *   A.Y. 2026-27  a profitable year in which 27,88,516 of BROUGHT-FORWARD loss
 *                 is set off u/s 72, and the unabsorbed depreciation is fully
 *                 absorbed so nothing of it carries forward.
 *
 * Both are anonymised (spec §11).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { detect, validate } from "../../src/computation/index.js";
import { mapItr3 } from "../../src/computation/mappers/itr3/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CTX = { generatedAt: "2026-01-01T00:00:00.000Z" };

const YEARS = {
  "2024-25": "itr3-fno-busloss-unabsdepr-ay2024-25",
  "2026-27": "itr3-fno-bfloss-setoff-ay2026-27",
};

const build = (ay) => {
  const json = JSON.parse(readFileSync(path.join(here, "..", "fixtures", `${YEARS[ay]}.json`), "utf8"));
  const d = detect(json);
  assert.equal(d.form, "ITR3");
  assert.equal(d.ay, ay);
  return { body: d.body, doc: mapItr3(d.body, { ...CTX, ay: d.ay, schemaVersion: d.schemaVersion }) };
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
}

/* ---------------- each loss is listed once ---------------- */

test("a business loss stated twice in the return is printed once", () => {
  const { doc, body } = build("2026-27");
  // Every CFL block states the same business loss against BOTH BrtFwdBusLoss and
  // BusLossOthThanSpecLossCF, and only the second enters the return's own
  // totals. Captioning both printed each loss twice, so the rows on the page
  // added to double the subtotal beneath them.
  const block = body.ScheduleCFL.LossCFCurrentAssmntYear.CarryFwdLossDetail;
  assert.equal(block.BrtFwdBusLoss, 2446909);
  assert.equal(block.BusLossOthThanSpecLossCF, 2446909);

  const cfl = section(doc, "CFL");
  assert.equal(cfl.rows.filter((r) => r.amount === 2446909).length, 1);
  // Seven losses across six years, then the set-off line of the reconciliation.
  assert.equal(cfl.rows.filter((r) => r.kind === "sub").length, 8);
  assert.deepEqual(
    cfl.rows.filter((r) => r.kind === "subtotal").map((r) => [r.label, r.amount]),
    [["Total Brought Forward from Earlier Years", 6645024],
      ["Business loss, other than speculative carried forward", 3668028],
      ["Short-term capital loss carried forward", 189277]]
  );
  assert.equal(closing(cfl).amount, 3857305);
});

test("a loss in the differently-named earlier-year block is not dropped", () => {
  const { doc, body } = build("2024-25");
  // 5,65,132 of 2016-17 business loss sits in LossCFFromPrev3rdYearFromAY, not
  // in a LossCFCurrentAssmntYear… key. Matching only the latter dropped it
  // silently, because the schedule is claimed wholesale afterwards.
  assert.equal(body.ScheduleCFL.LossCFFromPrev3rdYearFromAY.CarryFwdLossDetail.BusLossOthThanSpecLossCF, 565132);
  const r = section(doc, "CFL").rows.find((x) => x.amount === 565132 && x.kind === "sub");
  assert.equal(r.label, "Business loss, other than speculative");
  assert.equal(r.cols.ref, "23 July 2016");
  // No year is derivable for this slot, and the row says so rather than guessing.
  assert.match(r.note, /does not state the assessment year/);
});

test("the assessment year is named from the slot, verified against later returns", () => {
  const { doc } = build("2026-27");
  // Slot suffix N holds the loss of A.Y. (N-1)-N. Checked against this
  // assessee's own consecutive returns: slot …2026 carries 12,74,083, which is
  // the A.Y. 2025-26 return's own loss of 12,74,229 less that year's 146 of
  // unabsorbed depreciation, and carries that return's filing date.
  const rows = section(doc, "CFL").rows.filter((r) => /^A\.Y\. /.test(r.label));
  assert.deepEqual(rows.map((r) => [r.label, r.amount, r.cols.ref]), [
    ["A.Y. 2020-21 · Business loss, other than speculative", 94856, "16 July 2022"],
    ["A.Y. 2021-22 · Business loss, other than speculative", 830179, "22 November 2021"],
    ["A.Y. 2023-24 · Business loss, other than speculative", 1513184, "24 June 2023"],
    ["A.Y. 2023-24 · Short-term capital loss", 194592, "24 June 2023"],
    ["A.Y. 2024-25 · Business loss, other than speculative", 291221, "29 June 2024"],
    ["A.Y. 2025-26 · Business loss, other than speculative", 1274083, "05 September 2025"],
  ]);
});

test("the table reconciles brought forward, the year's loss, set-off and carry-forward", () => {
  const a = build("2024-25").doc;
  // 56,44,852 brought forward + 2,91,465 of this year - 5,65,132 not carried
  // = 53,71,185. Every figure is one the return states.
  assert.equal(row(a, "CFL", /^Total Brought Forward/).amount, 5644852);
  assert.equal(row(a, "CFL", /^Add: Loss of the current year/).amount, 291465);
  const lapsed = row(a, "CFL", /^Less: Loss of an earlier year not carried forward/);
  assert.equal(lapsed.amount, 565132);
  assert.match(lapsed.note, /neither set off this year nor carried to the next/);
  assert.equal(5644852 + 291465 - 565132, 5371185);
  assert.equal(closing(section(a, "CFL")).label, "Unabsorbed Depreciation Carried Forward u/s 32(2)");
  assert.equal(row(a, "CFL", /^Total Loss Carried Forward/).amount, 5371185);

  // 66,45,024 brought forward - 27,87,719 set off = 38,57,305, and nothing of an
  // earlier year lapses, so that line is absent.
  const b = build("2026-27").doc;
  assert.equal(row(b, "CFL", /^Total Brought Forward/).amount, 6645024);
  assert.equal(row(b, "CFL", /^Less: Set off against the income of the year/).amount, 2787719);
  assert.ok(!section(b, "CFL").rows.some((r) => /not carried forward/.test(r.label)));
  assert.equal(6645024 - 2787719, 3857305);
  assert.equal(closing(section(b, "CFL")).amount, 3857305);
});

/* ---------------- unabsorbed depreciation ---------------- */

test("unabsorbed depreciation is carried forward under its own total", () => {
  const { doc, body } = build("2024-25");
  // s.32(2) allowance, not a loss: carried forward without limit of time and set
  // off against any head, so the return keeps it in a schedule of its own and
  // the document totals it separately.
  assert.equal(body.ITR3ScheduleUD.TotDepritBalCFNY, 651);
  const ud = section(doc, "CFL").rows.filter((r) => /Unabsorbed depreciation/.test(r.label));
  assert.deepEqual(ud.map((r) => [r.amount, r.cols.ref]), [[407, "A.Y. 2023-24"], [244, "A.Y. 2024-25"]]);
  assert.equal(closing(section(doc, "CFL")).label, "Unabsorbed Depreciation Carried Forward u/s 32(2)");
  assert.equal(closing(section(doc, "CFL")).amount, 651);
  assert.equal(row(doc, "CFL", /^Total Loss Carried Forward/).amount, 5371185);
});

test("unabsorbed depreciation fully absorbed leaves nothing to carry forward", () => {
  const { doc, body } = build("2026-27");
  // 797 brought forward, 797 set off, nil carried. A nil block is not printed.
  assert.equal(body.ITR3ScheduleUD.TotBFUDepritAmt, 797);
  assert.equal(body.ITR3ScheduleUD.TotDepritBalCFNY, 0);
  assert.ok(!section(doc, "CFL").rows.some((r) => /Unabsorbed depreciation/.test(r.label)));
});

/* ---------------- the two set-off paths ---------------- */

test("2024-25: the current year's business loss is named in the set-off line", () => {
  const { doc } = build("2024-25");
  assert.equal(closing(section(doc, "BP")).label, "Loss under the head Profits and Gains of Business or Profession");
  assert.equal(closing(section(doc, "BP")).amount, 327038);
  // ScheduleCYLA states the loss as TotalCurYr.TotBusLoss; TotBusLossSetoff is a
  // field of TotalLossSetOff, and reading it here left the loss unnamed.
  const setOff = row(doc, "TI", /^Less: Set-off of current year/);
  assert.equal(setOff.label, "Less: Set-off of current year business loss u/s 71");
  assert.equal(setOff.amount, 35573);
  assert.equal(closing(section(doc, "TI")).amount, 0);
});

test("2026-27: brought-forward loss is set off u/s 72 against a profitable year", () => {
  const { doc } = build("2026-27");
  assert.equal(closing(section(doc, "BP")).amount, 2782404);
  assert.equal(row(doc, "TI", /^Total of Heads of Income/).amount, 2790434);
  assert.equal(row(doc, "TI", /^Less: Set-off of brought forward loss u\/s 72/).amount, 2788516);
  assert.equal(closing(section(doc, "TI")).amount, 1918);
  // Nothing left to tax, and nothing paid.
  assert.equal(closing(section(doc, "TAX")).amount, 0);
  assert.equal(doc.refund, null);
  assert.equal(doc.payable, null);
});
