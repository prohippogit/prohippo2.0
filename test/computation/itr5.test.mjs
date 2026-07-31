/*
 * Computation of Income — ITR-5, A.Y. 2025-26.
 * docs/computation-spec.md §11: every fixture gets three tests — the mapper
 * produces the golden model, validate() passes against the source JSON, and
 * `unmapped` is empty.
 *
 *   node --test test/computation
 *
 * The fixture is anonymised (CLAUDE.md rule 5). It is a real return's structure
 * with every identifier replaced by a syntactically valid dummy, so the mapper
 * sees exactly the shapes ITD emits without any client data entering the repo.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildComputation, detect, validate, UnsupportedFormError } from "../../src/computation/index.js";
import { mapItr5 } from "../../src/computation/mappers/itr5/index.js";
import { inr, inWords, amountText, longDate } from "../../src/computation/format.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "..", "fixtures", "itr5-firm-business-loss-ay2025-26.json");
const GOLDEN = path.join(here, "..", "golden", "itr5-firm-business-loss-ay2025-26.model.json");

const json = JSON.parse(readFileSync(FIXTURE, "utf8"));
// Pinned so the golden comparison does not churn on `generatedAt`.
const CTX = { generatedAt: "2026-01-01T00:00:00.000Z" };

const build = () => {
  const { form, body, ay, schemaVersion } = detect(json);
  assert.equal(form, "ITR5");
  return { body, doc: mapItr5(body, { ...CTX, ay, schemaVersion }) };
};

/* ---------------- §11: the three required tests ---------------- */

test("mapper produces the golden model", () => {
  const { doc } = build();
  // Regenerate deliberately with UPDATE_GOLDEN=1 when a change to the model is
  // intended; never as a reflex when a test goes red.
  if (process.env.UPDATE_GOLDEN === "1" || !existsSync(GOLDEN)) {
    writeFileSync(GOLDEN, JSON.stringify(doc, null, 1) + "\n");
  }
  assert.deepEqual(doc, JSON.parse(readFileSync(GOLDEN, "utf8")));
});

test("validate() passes against the source return", () => {
  const { doc, body } = build();
  const result = validate(doc, body);
  assert.deepEqual(result.failures, [], "every figure must tie back to Part B-TI / Part B-TTI");
  assert.equal(result.ok, true);
});

test("unmapped is empty — nothing in the return is silently dropped", () => {
  const { doc } = build();
  assert.deepEqual(doc.unmapped, [], "non-zero figures the mapper never read");
});

/* ---------------- what this particular return exercises ---------------- */

test("a loss-making head is nil in Part B-TI, and the loss survives", () => {
  const { doc } = build();
  const bp = doc.sections.find((s) => s.id === "BP");
  const closing = bp.rows.filter((r) => r.kind === "total").pop();
  assert.equal(closing.label, "Loss from Business or Profession");
  assert.equal(closing.isLoss, true);
  assert.equal(closing.amount, 185);

  // Part B-TI floors the head at nil (spec §7, "check 8 and loss-making heads").
  const tiHead = doc.sections.find((s) => s.id === "TI").rows
    .find((r) => r.label === "Profits and Gains of Business or Profession");
  assert.equal(tiHead.amount, 0);

  // And it reappears as a carry-forward rather than vanishing.
  const cfl = doc.sections.find((s) => s.id === "CFL");
  assert.ok(cfl, "a carried-forward loss must have its own section");
  assert.equal(cfl.rows.filter((r) => r.kind === "total").pop().amount, 140);
});

test("brought-forward unabsorbed depreciation is labelled u/s 32(2), not u/s 72", () => {
  const { doc } = build();
  // §10: unabsorbed depreciation sets off under s.32(2) and sits in Schedule UD.
  // Calling it a brought-forward business loss is a substantive error.
  const ud = doc.sections.find((s) => s.id === "CFL").rows
    .find((r) => /Unabsorbed [Dd]epreciation/.test(r.label));
  assert.ok(ud, "Schedule UD's carry-forward must be shown");
  assert.match(ud.cols.ref, /32\(2\)/);
  assert.doesNotMatch(JSON.stringify(doc.sections), /brought forward business loss u\/s 72/i);
});

test("sections are lettered with no gaps once empty ones are dropped", () => {
  const { doc } = build();
  // This return has no salary, house property or capital gains, so those
  // workings are absent and the letters must still run A, B, C… (§4).
  assert.deepEqual(doc.sections.map((s) => s.letter), ["A", "B", "C", "D", "E", "F"]);
  assert.deepEqual(doc.sections.map((s) => s.id), ["BP", "OS", "TI", "TAX", "TAXES_PAID", "CFL"]);
});

test("all five heads appear in the TI section even at nil", () => {
  const { doc } = build();
  const heads = doc.sections.find((s) => s.id === "TI").rows.filter((r) => r.kind === "head");
  assert.deepEqual(heads.map((h) => h.label), [
    "Income from Salaries",
    "Income from House Property",
    "Profits and Gains of Business or Profession",
    "Capital Gains",
    "Income from Other Sources",
  ]);
});

test("TDS rows carry the real section, not the portal's code", () => {
  const { doc } = build();
  const row = doc.sections.find((s) => s.id === "TAXES_PAID").rows.find((r) => /^AAAB/.test(r.label));
  // §10: "94O" is not a section number — it is s.194-O.
  assert.match(row.note, /Sec\. 194-O/);
  assert.match(row.note, /e-commerce operator/);
});

test("the refund banner carries the account flagged for the refund", () => {
  const { doc } = build();
  assert.equal(doc.payable, null);
  assert.equal(doc.refund.amount, 1320);
  assert.equal(doc.refund.bank.ifsc, "SBIN0000001");
});

test("the s.244A gap between taxes paid and the refund is explained, not hidden", () => {
  const { doc } = build();
  // Taxes paid 1,319 but refund 1,320 — the ₹1 is interest CPC determined.
  assert.ok(doc.notes.some((n) => /244A/.test(n.text)), "the difference must be stated");
});

test("an unsupported year raises rather than falling back to another mapper", () => {
  const wrongYear = JSON.parse(JSON.stringify(json));
  wrongYear.ITR.ITR5.Form_ITR5.AssessmentYear = "2019";
  assert.throws(() => buildComputation(wrongYear, CTX), UnsupportedFormError);
});

test("a non-ITR payload is rejected clearly", () => {
  assert.throws(() => buildComputation({ nope: true }, CTX), UnsupportedFormError);
});

/* ---------------- §6 formatting ---------------- */

test("amounts use Indian digit grouping", () => {
  assert.equal(inr(4814564), "48,14,564");
  assert.equal(inr(1320), "1,320");
  assert.equal(inr(100000), "1,00,000");
});

test("nil is an em dash, a loss is parenthesised, null is blank", () => {
  assert.equal(amountText(0), "—");
  assert.equal(amountText(464191, true), "(4,64,191)");
  assert.equal(amountText(null), "");
  assert.equal(amountText(1320), "1,320");
});

test("amount in words uses the Indian scale", () => {
  assert.equal(inWords(445470), "Rupees Four Lakh Forty Five Thousand Four Hundred Seventy Only.");
  assert.equal(inWords(1320), "Rupees One Thousand Three Hundred Twenty Only.");
  assert.equal(inWords(0), "Rupees Nil Only.");
  assert.equal(inWords(10000000), "Rupees One Crore Only.");
});

test("dates render long-form", () => {
  assert.equal(longDate("2015-11-04"), "04 November 2015");
  assert.equal(longDate(""), "");
});
