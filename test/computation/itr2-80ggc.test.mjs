/*
 * Computation of Income — ITR-2, A.Y. 2024-25, contributions u/s 80GGC.
 *
 *   node --test test/computation/itr2-80ggc.test.mjs
 *
 * A salaried assessee on the OLD regime claiming 5,20,000 under s.80GGC, which
 * brings total income to 4,99,880 — inside the 5,00,000 limit for the rebate
 * u/s 87A, so the whole of the tax but 810 rupees falls away and the TDS comes
 * back as a refund. Anonymised (spec §11).
 *
 * What this fixture covers that no other does:
 *   - Schedule 80GGC, whose particulars — the date of each contribution, the
 *     mode of payment, the bank reference — the computation used to drop into
 *     the amber "items requiring review" block because nothing consumed them;
 *   - a rebate u/s 87A that all but extinguishes the liability, with a cess of
 *     31 rupees left on top of it;
 *   - Schedule TDS1 stating the SAME employer eight times over, month by month;
 *   - Schedule TDS2 rows carrying a gross receipt and no tax at all.
 *
 * s.80GGC is the deduction the Department is currently reopening in bulk, and
 * the date and the payment reference are what those enquiries turn on. That is
 * why they are printed rather than summarised away — see politicalContributionRows
 * in mappers/individual/heads.js.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildComputation, detect, validate } from "../../src/computation/index.js";
import { mapItr2 } from "../../src/computation/mappers/itr2/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "..", "fixtures", "itr2-80ggc-rebate87a-ay2024-25.json");
const GOLDEN = path.join(here, "..", "golden", "itr2-80ggc-rebate87a-ay2024-25.model.json");

const json = JSON.parse(readFileSync(FIXTURE, "utf8"));
const CTX = { generatedAt: "2026-01-01T00:00:00.000Z" };

const build = () => {
  const { form, body, ay, schemaVersion } = detect(json);
  assert.equal(form, "ITR2");
  assert.equal(ay, "2024-25");
  return { body, doc: mapItr2(body, { ...CTX, ay, schemaVersion }) };
};

const section = (doc, id) => doc.sections.find((s) => s.id === id);
const row = (doc, id, re) => section(doc, id).rows.find((r) => re.test(r.label));

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

/* ---------------- Schedule 80GGC ---------------- */

test("every contribution is itemised, with its date, mode and bank reference", () => {
  const { doc, body } = build();
  const via = section(doc, "VIA");
  const items = via.rows.filter((r) => /^\d{2} February 2024$/.test(r.label));

  assert.deepEqual(items.map((r) => [r.label, r.cols.ref, r.amount]), [
    ["20 February 2024", "Banking channel", 200000],
    ["27 February 2024", "Banking channel", 320000],
  ]);
  // The reference and the IFSC are free text the anonymiser masks, so the shape
  // is what is asserted; on the real return they read "MSNUR5…" and "MSNU00…".
  for (const r of items) assert.match(r.note, /^Ref\. \S+ · IFSC \S+$/);

  assert.equal(body.Schedule80GGC.Schedule80GGCDetails.length, 2);
  assert.equal(items.length, 2);
});

test("the itemisation follows the Chapter VI-A total, and ties to the 80GGC row", () => {
  const { doc } = build();
  const rows = section(doc, "VIA").rows;
  const at = (re) => rows.findIndex((r) => re.test(r.label));

  // Before the total, the rows are deductions and add up to it. Particulars of
  // a deduction already counted go after, or anyone adding up the column on the
  // page gets a different answer from the one printed on it.
  assert.ok(at(/^Contributions claimed u\/s 80GGC/) > at(/^Total deductions under Chapter VI-A/));
  assert.equal(row(doc, "VIA", /^u\/s 80GGC/).amount, 520000);
  assert.equal(row(doc, "VIA", /^u\/s 80GGC/).note, "Each contribution is itemised below");
  assert.equal(row(doc, "VIA", /^Total Contributions Claimed u\/s 80GGC/).amount, 520000);
  assert.equal(row(doc, "VIA", /^Total deductions under Chapter VI-A/).amount, 726449);

  const header = rows.find((r) => r.kind === "columnHeader");
  assert.deepEqual([header.label, header.cols.ref, header.cols.amt, header.amount],
    ["Contributions claimed u/s 80GGC — date of payment", "Mode of payment", "Amount (₹)", null]);
});

test("a return with no Schedule 80GGC prints no itemisation and no empty heading", () => {
  const other = JSON.parse(readFileSync(path.join(here, "..", "fixtures",
    "itr2-oldregime-hploss-via-ay2024-25.json"), "utf8"));
  assert.equal(other.ITR.ITR2.Schedule80GGC, undefined);
  const { doc } = buildComputation(other, CTX);
  assert.ok(!section(doc, "VIA").rows.some((r) => /80GGC/.test(r.label)));
});

/* ---------------- what the deduction does to the tax ---------------- */

test("the rebate u/s 87A leaves 810 rupees payable, and the TDS comes back", () => {
  const { doc, body } = build();
  // 12,26,330 gross less 7,26,449 of Chapter VI-A is 4,99,880 — inside the
  // 5,00,000 limit s.87A sets, which is the whole point of the claim.
  assert.equal(row(doc, "TI", /^Total Income/).amount, 499880);
  assert.equal(body.PartB_TTI.ComputationOfTaxLiability.Rebate87A, 12500);
  assert.equal(row(doc, "TAX", /^Less: Rebate u\/s 87A/).amount, 12500);
  assert.equal(row(doc, "TAX", /^Add: Health/).amount, 31);
  assert.equal(row(doc, "TAX", /^Total Tax and Interest Payable/).amount, 810);

  assert.equal(doc.payable, null);
  assert.equal(doc.refund.amount, 14190);
  assert.equal(row(doc, "TAXES_PAID", /^Total Tax Deducted at Source/).amount, 15000);
});

test("one employer deducting month by month is eight rows, not one", () => {
  const { doc, body } = build();
  // Schedule TDS1 states the same TAN once per month. Collapsing them would
  // stop the computation tying line for line to the return.
  assert.equal(body.ScheduleTDS1.TDSonSalary.length, 8);
  const tds = section(doc, "TAXES_PAID").rows.filter((r) => r.kind === "sub" && r.cols);
  assert.equal(tds.filter((r) => r.amount === 2000).length, 7);
  assert.equal(row(doc, "TAXES_PAID", /^Total Tax Deducted at Source/).amount, 15000);
});
