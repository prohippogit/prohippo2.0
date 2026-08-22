/* Computation of Income — ITR-3, A.Y. 2024-25: two plots sold, the whole gain
 * reinvested in agricultural land under s.54B.
 *
 *   node --test test/computation/itr3-landsale-54b.test.mjs
 *
 * THE REPORT: "The computation is not mapped properly. The capital gains are
 * required to be shown properly with a separate tabular format with sale and
 * purchase details and gain thereon and any other deduction."
 *
 * What the page actually did was worse than badly laid out. Two plots sold for
 * 2,36,50,000, an indexed cost of 20,71,818, a long-term gain of 2,15,78,182 and
 * the entire gain reinvested under s.54B across six purchases of agricultural
 * land — and the computation had NO CAPITAL GAINS SECTION AT ALL. Twenty-six
 * figures went to "items requiring review" and nothing else about the largest
 * transaction in the return appeared anywhere.
 *
 * Two faults, and the first hid the second:
 *
 *   the head was gated on `TotalLTCG`, which is nil when the gain is fully
 *   exempt, so the whole working was skipped;
 *
 *   and the working, when it did run, was a flat list of rows — so two
 *   properties interleaved into "property 1 / property 2 / property 1" with the
 *   dates, the buyers and the reinvestment particulars not printed at all.
 *
 * Anonymised (§11). The anonymiser learned something from this return too: the
 * portal had put the landline in as a STRING, and `PhoneNo` was only catalogued
 * as a number, so a real one went straight through the field-name rules.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { detect, validate } from "../../src/computation/index.js";
import { mapItr3 } from "../../src/computation/mappers/itr3/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "..", "fixtures", "itr3-landsale-54b-ay2024-25.json");
const GOLDEN = path.join(here, "..", "golden", "itr3-landsale-54b-ay2024-25.model.json");

const json = JSON.parse(readFileSync(FIXTURE, "utf8"));
const CTX = { generatedAt: "2026-01-01T00:00:00.000Z" };

const build = () => {
  const { form, body, ay, schemaVersion } = detect(json);
  assert.equal(form, "ITR3");
  assert.equal(ay, "2024-25");
  return { body, doc: mapItr3(body, { ...CTX, ay, schemaVersion }) };
};

const section = (doc, id) => doc.sections.find((s) => s.id === id);
const schedule = (doc, re) => section(doc, "CG").rows.find((r) => r.kind === "matrix" && re.test(r.label));

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

test("unmapped is empty — 26 items surfaced before the fix", () => {
  const { doc } = build();
  assert.deepEqual(doc.unmapped, []);
});

/* ---------------- the head exists at all ---------------- */

test("a gain reinvested down to nil still gets a Capital Gains section", () => {
  /* THE FAULT, in one assertion. `TotalLTCG` is 0 because s.54B took all of it,
     and the head used to be gated on that figure — so a 2.36 crore sale of land
     produced a computation with no capital gains in it whatsoever. A head is
     shown when there was a TRANSACTION, not when there is a taxable gain. */
  const { doc, body } = build();
  assert.equal(body.ScheduleCGFor23.LongTermCapGain23.TotalLTCG, 0);
  assert.equal(body.ScheduleCGFor23.TotScheduleCGFor23, 0);

  const cg = section(doc, "CG");
  assert.ok(cg, "the section exists");
  const closing = cg.rows.filter((r) => r.kind === "total").pop();
  assert.equal(closing.label, "Income chargeable under the head Capital Gains");
  assert.equal(closing.amount, 0, "and states the nil, rather than being absent");
  // Still nil in the total-income working — nothing about showing the schedule
  // changes what is taxable.
  assert.equal(section(doc, "TI").rows.find((r) => /^Capital Gains/.test(r.label)).amount, 0);
});

/* ---------------- the schedule the report asked for ---------------- */

test("each property is a line: its own banner, then sale, purchase, gain and deduction", () => {
  const { doc, body } = build();
  const m = schedule(doc, /long term$/);
  const stated = body.ScheduleCGFor23.LongTermCapGain23.SaleofLandBuild.SaleofLandBuildDtls;
  const rows = m.lines.filter((l) => !l.span);
  const at = (i, label) => rows[i].cells[m.columns.findIndex((c) => c.label === label)];

  /* THE SECOND HALF OF THE REPORT: "a horizontal property wise data so that the
     property details and purchaser details can be displayed well". A column per
     property gave the address 55px and three joint buyers with their PANs
     fourteen lines. A line per property gives them the width of the page. */
  assert.equal(m.lines[0].span, true);
  assert.equal(m.lines[0].label, `Property 1 · ${stated[0].TrnsfImmblPrprty.TrnsfImmblPrprtyDtls[0].AddressOfProperty}`);
  assert.match(m.lines[0].note, /^Sold to SAMPLE NAME 8 · PAN /);
  assert.equal(m.lines[2].span, true);
  assert.match(m.lines[2].label, /^Property 2 · /);

  assert.deepEqual(m.columns.map((c) => c.label), [
    "Sold", "Acquired", "Full value", "Cost", "Indexed cost", "Deductions",
    "Capital gain", "Exemption", "Chargeable",
  ]);
  // The qualifier lives under the caption, so the statutory words are all there
  // without any one of them setting the width of its column.
  assert.deepEqual(m.columns.map((c) => c.note), [
    "date of transfer", "date of purchase", "of consideration", "of acquisition",
    "of acquisition", "u/s 48", "long-term", "u/s 54B", "gain",
  ]);

  // The sale and purchase details.
  assert.deepEqual([at(0, "Sold"), at(0, "Acquired")], ["28 Jul 2023", "01 Apr 2001"]);
  // The gain thereon.
  assert.deepEqual([at(0, "Full value"), at(1, "Full value")], [11875000, 11775000]);
  assert.deepEqual([at(0, "Cost"), at(1, "Cost")], [291550, 303800]);
  assert.deepEqual([at(0, "Indexed cost"), at(1, "Indexed cost")], [1014594, 1057224]);
  assert.deepEqual([at(0, "Deductions"), at(1, "Deductions")], [1014594, 1057224]);
  assert.deepEqual([at(0, "Capital gain"), at(1, "Capital gain")], [10860406, 10717776]);
  // …and the other deduction.
  assert.deepEqual([at(0, "Exemption"), at(1, "Exemption")], [10860406, 10717776]);
  assert.deepEqual([at(0, "Chargeable"), at(1, "Chargeable")], [0, 0]);

  // Every line adds up on its own, which is the only thing that makes a
  // schedule worth printing, and the last line adds the lines up.
  stated.forEach((d, i) => {
    assert.equal(at(i, "Full value") - at(i, "Deductions") - at(i, "Exemption"), d.CapgainonAssets);
  });
  assert.deepEqual(m.lines.at(-1).cells, [null, null, 23650000, 595350, 2071818, 2071818, 21578182, 21578182, 0]);
  assert.equal(m.lines.at(-1).kind, "total");
});

test("three claims of s.54B against one property are one line, itemised below", () => {
  /* Each property claims s.54B three times, because the proceeds went into
     several purchases of agricultural land. The property column carries what
     came off that property's gain; the six purchases — cost, date, and how much
     of each was claimed — are the substance an officer asks about, and Schedule
     CG's own DeducClaimInfo block was being claimed as a subtree and never
     printed. */
  const { doc, body } = build();
  const claims = body.ScheduleCGFor23.DeducClaimInfo.DeducClaimDtlsUs54B;
  assert.equal(claims.length, 6);
  assert.equal(body.ScheduleCGFor23.LongTermCapGain23.SaleofLandBuild.SaleofLandBuildDtls[0]
    .ExemptionOrDednUs54.ExemptionOrDednUs54Dtls.length, 3, "three parts on the first property alone");

  const d = schedule(doc, /54B$/);
  assert.deepEqual(d.columns.map((c) => c.label), [
    "Date of transfer", "Cost of new agricultural land", "Date of purchase / construction",
    "Deposited in the CGAS", "Deduction claimed",
  ]);
  assert.equal(d.lines.length, 7, "six claims and their total");
  assert.deepEqual(d.lines[0].cells, ["28 Jul 2023", 17100000, "07 Apr 2023", 0, 4275000]);
  assert.equal(d.lines.at(-1).cells.at(-1), body.ScheduleCGFor23.DeducClaimInfo.TotDeductClaim);
  assert.equal(d.lines.at(-1).cells.at(-1), 21578182);
  assert.match(d.note, /already deducted in the working above/);
});

test("no s.50C line, because the stamp value is the consideration", () => {
  const { doc, body } = build();
  for (const d of body.ScheduleCGFor23.LongTermCapGain23.SaleofLandBuild.SaleofLandBuildDtls) {
    assert.equal(d.PropertyValuation, d.FullConsideration);
  }
  const m = schedule(doc, /long term$/);
  assert.ok(!m.columns.some((c) => /50C|Stamp-duty|Adopted|Received/.test(c.label)),
    "saying a substitution happened where it did not is as wrong as staying quiet where it did");
});

/* ---------------- the rest of the return still ties ---------------- */

test("the TDS the buyer deducted u/s 194-IA is credited against a nil gain", () => {
  // 1,17,750 on one of the two sales. The gain is exempt and the tax is still
  // deducted, which is exactly why this return is a refund.
  const { doc } = build();
  const paid = section(doc, "TAXES_PAID");
  assert.equal(paid.rows.find((r) => /^Total Tax Deducted at Source/.test(r.label)).amount, 117750);
  assert.equal(paid.rows.filter((r) => r.kind === "total").pop().label, "Refund Due");
  assert.equal(doc.refund.amount, 76190);
});
