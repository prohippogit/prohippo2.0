/*
 * Computation of Income — ITR-5, A.Y. 2025-26, house property loss.
 *
 *   node --test test/computation
 *
 * The second ITR-5 fixture, and the one that exists because the first was not
 * enough. A firm whose only income was interest, whose let-out property ran at a
 * loss because the s.24(b) interest exceeded its annual value, and which carried
 * three earlier years' business losses forward. The mapper written against the
 * first fixture omitted the entire house property head — the unmapped walker
 * (spec §8) caught it in production, which is exactly what it is for.
 *
 * Anonymised: every PAN, TAN, name, address, bank account and GSTIN replaced by
 * a syntactically valid dummy, shapes preserved.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { detect, validate } from "../../src/computation/index.js";
import { mapItr5 } from "../../src/computation/mappers/itr5/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "..", "fixtures", "itr5-firm-house-property-loss-ay2025-26.json");
const GOLDEN = path.join(here, "..", "golden", "itr5-firm-house-property-loss-ay2025-26.model.json");

const json = JSON.parse(readFileSync(FIXTURE, "utf8"));
const CTX = { generatedAt: "2026-01-01T00:00:00.000Z" };

const build = () => {
  const { form, body, ay, schemaVersion } = detect(json);
  assert.equal(form, "ITR5");
  assert.equal(ay, "2025-26");
  return { body, doc: mapItr5(body, { ...CTX, ay, schemaVersion }) };
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

test("unmapped is empty — the whole point of this fixture", () => {
  const { doc } = build();
  // The regression this file exists to prevent: a head of income silently
  // missing from a document a client signs.
  assert.deepEqual(doc.unmapped, []);
});

/* ---------------- house property ---------------- */

test("the house property head is present and worked statutorily", () => {
  const { doc } = build();
  const hp = doc.sections.find((s) => s.id === "HP");
  assert.ok(hp, "a return with Schedule HP must produce a house property section");
  assert.equal(hp.letter, "A", "house property comes before business (§4)");

  const labels = hp.rows.map((r) => r.label);
  assert.ok(labels.some((l) => /Annual letable value/.test(l)));
  assert.ok(labels.some((l) => /Standard deduction u\/s 24\(a\) @ 30%/.test(l)));
  assert.ok(labels.some((l) => /Interest on borrowed capital u\/s 24\(b\)/.test(l)));
});

test("the head closes at a loss, in the return's own figures", () => {
  const { doc } = build();
  const hp = doc.sections.find((s) => s.id === "HP");
  const closing = hp.rows.filter((r) => r.kind === "total").pop();
  assert.equal(closing.label, "Loss from House Property");
  assert.equal(closing.isLoss, true);
  assert.equal(closing.amount, 201552);

  // 5,31,606 − 1,59,482 − 5,73,676 = −2,01,552. The figures are the return's;
  // this asserts we did not silently substitute arithmetic of our own (§1).
  const amt = (re) => hp.rows.find((r) => re.test(r.label)).amount;
  assert.equal(amt(/Annual letable value/), 531606);
  assert.equal(amt(/24\(a\)/), 159482);
  assert.equal(amt(/24\(b\)/), 573676);
});

test("Part B-TI floors the loss-making head at nil, and check 8 knows it", () => {
  const { doc, body } = build();
  const tiHead = doc.sections.find((s) => s.id === "TI").rows
    .find((r) => r.label === "Income from House Property");
  assert.equal(tiHead.amount, 0);
  assert.deepEqual(validate(doc, body).failures, []);
});

/* ---------------- set-off and carry-forward ---------------- */

test("the s.71 set-off names the head whose loss it actually is", () => {
  const { doc } = build();
  const row = doc.sections.find((s) => s.id === "TI").rows
    .find((r) => /Set-off of current year/.test(r.label));
  // Calling a house property loss a "business loss" is a substantive error on
  // the face of a signed document — and is what this said before.
  assert.match(row.label, /house property loss u\/s 71/);
  assert.doesNotMatch(row.label, /business loss/);
  assert.equal(row.amount, 12351);
});

test("brought-forward losses are listed by year with their filing dates", () => {
  const { doc } = build();
  const cfl = doc.sections.find((s) => s.id === "CFL");
  const rows = cfl.rows.filter((r) => r.kind === "sub");

  assert.deepEqual(
    rows.map((r) => [r.label, r.cols.ref, r.amount]),
    [
      ["A.Y. 2019-20 · Return filed on 22 October 2019", "Business Loss", 949559],
      ["A.Y. 2020-21 · Return filed on 07 October 2020", "Business Loss", 1790595],
      ["A.Y. 2021-22 · Return filed on 13 December 2021", "Business Loss", 390674],
      ["A.Y. 2025-26 · loss of the current year", "House Property Loss", 189201],
    ]
  );
});

test("the carry-forward total covers every nature of loss, not just business", () => {
  const { doc } = build();
  const cfl = doc.sections.find((s) => s.id === "CFL");
  // 31,30,828 brought forward + 1,89,201 of this year's house property loss.
  assert.equal(cfl.rows.filter((r) => r.kind === "total").pop().amount, 3320029);
});

/* ---------------- the rest of the return ---------------- */

test("TDS rows sharing a TAN and a section are shown once, with a count", () => {
  const { doc } = build();
  const rows = doc.sections.find((s) => s.id === "TAXES_PAID").rows;
  const rent = rows.find((r) => /3 entries/.test(r.note || ""));
  assert.ok(rent, "three quarterly deductions by one tenant collapse to one line");
  assert.match(rent.note, /Sec\. 194-IB|Sec\. 4-IB/);
});

test("a refund is reported with the account it is payable to", () => {
  const { doc } = build();
  assert.equal(doc.payable, null);
  assert.equal(doc.refund.amount, 54400);
  assert.ok(doc.refund.bank.name);
});
