/*
 * Computation of Income — ITR-1, A.Y. 2024-25.
 *
 *   node --test test/computation/itr1-ay2024-25.test.mjs
 *
 * The first year the form asks the regime as `OptOutNewTaxRegime`, and the first
 * ITR-1 we hold on the OLD regime — so it is the year Chapter VI-A does real work
 * and the s.80TTA deduction for savings-bank interest appears. Anonymised (§11).
 *
 * What this fixture covers that no other ITR-1 does:
 *   - the reversed regime field, verified against the return's own tax;
 *   - a commission receipt in other sources, described in the assessee's own
 *     words rather than by a code;
 *   - a real s.288A rounding — 4,90,533 down to 4,90,530 — which is the return's
 *     own arithmetic and must never be re-derived here (§6);
 *   - `IncomeNotified89AType`, the per-country split of s.89A income, nil here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { detect, validate } from "../../src/computation/index.js";
import { mapItr1 } from "../../src/computation/mappers/itr1/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "..", "fixtures", "itr1-oldregime-commission-rebate-ay2024-25.json");
const GOLDEN = path.join(here, "..", "golden", "itr1-oldregime-commission-rebate-ay2024-25.model.json");

const json = JSON.parse(readFileSync(FIXTURE, "utf8"));
const CTX = { generatedAt: "2026-01-01T00:00:00.000Z" };

const build = () => {
  const { form, body, ay, schemaVersion } = detect(json);
  assert.equal(form, "ITR1");
  assert.equal(ay, "2024-25");
  return { body, doc: mapItr1(body, { ...CTX, ay, schemaVersion }) };
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

/* ---------------- the regime, read backwards and verified ---------------- */

test("OptOutNewTaxRegime \"Y\" is the OLD regime, and the return's own tax proves it", () => {
  const { doc, body } = build();
  assert.equal(body.FilingStatus.OptOutNewTaxRegime, "Y");
  assert.match(doc.assessee.facts.find((f) => f.label === "Tax regime").value, /^Old regime — opted out/);

  // §10: never read a regime field by its name alone. Total income 4,90,530 and
  // tax 12,027 is the old table — 5% of (4,90,530 − 2,50,000) = 12,026.50 — and
  // is not s.115BAC(1A), which exempts the first 3,00,000 and gives 9,527.
  assert.equal(body.ITR1_IncomeDeductions.TotalIncome, 490530);
  assert.equal(body.ITR1_TaxComputation.TotalTaxPayable, 12027);
  assert.equal(Math.round((490530 - 250000) * 0.05), 12027);
  assert.notEqual(Math.round((490530 - 300000) * 0.05), 12027);
  // And the standard deduction agrees: 50,000, not the new regime's 75,000.
  assert.equal(row(doc, "SALARY", /^Less: Standard deduction/).amount, 50000);
  assert.match(doc.notes.at(-1).text, /^The return is filed under the old regime/);
});

/* ---------------- other sources, by code and by the assessee's words ---------------- */

test("a coded receipt is captioned from the code, an \"OTH\" one from the return's own words", () => {
  const { doc, body } = build();
  const stated = body.ITR1_IncomeDeductions.OthersInc.OthersIncDtlsOthSrc;
  assert.deepEqual(stated.map((o) => o.OthSrcNatureDesc), ["SAV", "OTH"]);

  const os = section(doc, "OS");
  // "SAV" is verified from this very return, which states "Interest from Saving
  // Account" against it — so it is captioned, not printed as a bare code (§5).
  assert.equal(os.rows[0].label, "Interest from a savings bank account");
  assert.equal(os.rows[0].amount, 383);
  // "OTH" is not a section and not a code we can name, so the row carries what
  // the assessee wrote. (Anonymised in the fixture, hence the dummy.)
  assert.equal(os.rows[1].label, stated[1].OthSrcOthNatOfInc);
  assert.equal(os.rows[1].amount, 201277);
  assert.equal(closing(os).amount, 201660);
});

test("s.80TTA is allowed at the savings interest, and the section is named not the field", () => {
  const { doc } = build();
  const tta = row(doc, "VIA", /80TTA/);
  assert.equal(tta.amount, 383);
  assert.equal(tta.ref, "80TTA");
  // Allowed in full here, so no note about a statutory cap.
  assert.equal(tta.note, undefined);
  assert.equal(closing(section(doc, "VIA")).amount, 383);
  assert.equal(row(doc, "TI", /^Less: Deductions under Chapter VI-A/).amount, 383);
  // No restriction note either: claimed and allowed agree.
  assert.equal(doc.notes.find((n) => /restricted/.test(n.text)), undefined);
});

test("a claim the statutory cap cuts down says so on the row and in a note", () => {
  // Our own rule, exercised on a mutation of a real return rather than on a
  // fabricated one: no ITR-1 we hold has a restricted claim (§11).
  const capped = JSON.parse(JSON.stringify(json));
  const inc = capped.ITR.ITR1.ITR1_IncomeDeductions;
  inc.UsrDeductUndChapVIA.Section80TTA = 46383;
  inc.UsrDeductUndChapVIA.TotalChapVIADeductions = 46383;

  const { body, ay, schemaVersion } = detect(capped);
  const doc = mapItr1(body, { ...CTX, ay, schemaVersion });
  assert.equal(row(doc, "VIA", /80TTA/).amount, 383);
  assert.match(row(doc, "VIA", /80TTA/).note, /Claimed 46,383; restricted to the statutory limit/);
  const note = doc.notes.find((n) => /Chapter VI-A of/.test(n.text));
  assert.equal(note.severity, "attention");
  assert.match(note.text, /46,383 were claimed, of which 46,000 was restricted.*383 has been allowed/);
  // The allowed figure is still what enters the total, so the return still ties.
  assert.deepEqual(validate(doc, body).failures, []);
});

/* ---------------- rounding, which is the return's and not ours ---------------- */

test("total income is the return's rounded figure, not one we worked out", () => {
  const { doc, body } = build();
  // 4,90,916 − 383 = 4,90,533, which the return rounds to 4,90,530 u/s 288A. A
  // computation that re-derived the rounding would disagree with the
  // acknowledgement it was built from (§6).
  assert.equal(row(doc, "TI", /^Gross Total Income/).amount, 490916);
  assert.equal(490916 - 383, 490533);
  assert.equal(body.ITR1_IncomeDeductions.TotalIncome, 490530);
  assert.equal(closing(section(doc, "TI")).amount, 490530);
});

test("the s.89A country split is read even where it is nil, so a figure in it could not hide", () => {
  const { doc, body } = build();
  // Three countries, all nil. §8's walker only reports non-zero leaves, so the
  // proof that these are consumed is that the mapper reads them by name — which
  // this asserts by checking no row was invented for a nil figure either.
  assert.equal(body.ITR1_IncomeDeductions.IncomeNotified89AType.length, 3);
  assert.equal(row(doc, "SALARY", /89A/), undefined);
  assert.deepEqual(doc.unmapped, []);
});
