/*
 * Computation of Income — ITR-1, A.Y. 2026-27.
 *
 *   node --test test/computation/itr1-ay2026-27.test.mjs
 *
 * The newest year on the form, and the one that renames a field the mapper reads:
 * the house property total becomes `TotalIncomeChargeableUnHP`, where every
 * earlier year calls it `TotalIncomeOfHP`. Anonymised (§11).
 *
 * What this fixture covers that no other ITR-1 does:
 *   - that rename, and the reading-whichever-is-present that handles it without
 *     a year branch (§9, §10);
 *   - a second contact and an alternate address on the personal block, which the
 *     anonymiser had to learn about before this fixture could be committed;
 *   - `FeeFurnish234I`, new alongside the s.234 interest;
 *   - the new regime with a 4,00,000 exemption, which is what makes the tax on
 *     this return reconcile to that table and to no other.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { detect, validate } from "../../src/computation/index.js";
import { mapItr1 } from "../../src/computation/mappers/itr1/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "..", "fixtures", "itr1-newregime-altaddress-rebate-ay2026-27.json");
const GOLDEN = path.join(here, "..", "golden", "itr1-newregime-altaddress-rebate-ay2026-27.model.json");

const json = JSON.parse(readFileSync(FIXTURE, "utf8"));
const CTX = { generatedAt: "2026-01-01T00:00:00.000Z" };

const build = () => {
  const { form, body, ay, schemaVersion } = detect(json);
  assert.equal(form, "ITR1");
  assert.equal(ay, "2026-27");
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

/* ---------------- the renamed house property total ---------------- */

test("the house property total is read under this year's name, not the old one", () => {
  const { doc, body } = build();
  const inc = body.ITR1_IncomeDeductions;
  assert.equal(inc.TotalIncomeChargeableUnHP, 0);
  assert.ok(!("TotalIncomeOfHP" in inc), "this year drops the earlier spelling");
  // Read under the wrong name the head would still print nil here and nothing
  // would catch it — which is why the head row is asserted against the field.
  assert.equal(row(doc, "TI", /^Income from House Property/).amount, 0);
});

test("a loss under the renamed field reaches the head row, and is not floored to nil", () => {
  // Our own rule on a mutation of a real return: ITR-1 has no Part B-TI to floor
  // a negative head and no Schedule CYLA for the loss to travel through, so the
  // loss stays on the head row. No return we hold carries one (§11).
  const withLoss = JSON.parse(JSON.stringify(json));
  const inc = withLoss.ITR.ITR1.ITR1_IncomeDeductions;
  inc.InterestPayable = 200000;
  inc.TotalIncomeChargeableUnHP = -200000;
  inc.GrossTotIncome -= 200000;
  inc.GrossTotIncomeIncLTCG112A -= 200000;
  inc.TotalIncome -= 200000;

  const { body, ay, schemaVersion } = detect(withLoss);
  const doc = mapItr1(body, { ...CTX, ay, schemaVersion });
  const hp = section(doc, "HP");
  assert.equal(closing(hp).label, "Loss from House Property");
  assert.equal(closing(hp).isLoss, true);
  assert.equal(closing(hp).amount, 200000);
  // The interest is a line of its own under s.24(b) — never merged with the 30%.
  assert.equal(row(doc, "HP", /^Less: Interest payable on borrowed capital/).amount, 200000);
  // On the head row the loss is signed, and validate() checks it that way round
  // for this form rather than expecting a nil (§7).
  const head = row(doc, "TI", /^Income from House Property/);
  assert.equal(head.isLoss, true);
  assert.equal(head.amount, 200000);
  assert.deepEqual(validate(doc, body).failures, []);
});

/* ---------------- the new regime, reconciled against this year's table ---------------- */

test("the new regime reconciles against the 4,00,000 exemption this year introduced", () => {
  const { doc, body } = build();
  assert.equal(body.FilingStatus.OptOutNewTaxRegime, "N");
  assert.match(doc.assessee.facts.find((f) => f.label === "Tax regime").value, /^New regime/);
  // 5% of (5,18,970 − 4,00,000) = 5,948.50, the 5,949 the return states. The old
  // table would give 16,294 on the same income, so the reading is verified and
  // not taken from the field's name (§10).
  assert.equal(body.ITR1_IncomeDeductions.TotalIncome, 518970);
  assert.equal(body.ITR1_TaxComputation.TotalTaxPayable, 5949);
  assert.equal(Math.round((518970 - 400000) * 0.05), 5949);
  assert.equal(closing(section(doc, "TI")).amount, 518970);
  // 5,18,967 rounded up by the return itself u/s 288A.
  assert.equal(row(doc, "TI", /^Gross Total Income/).amount, 518967);
});

test("the rebate leaves nothing to pay, so there is no banner and the closing row says so", () => {
  const { doc } = build();
  assert.equal(row(doc, "TAX", /^Less: Rebate u\/s 87A/).amount, 5949);
  assert.equal(closing(section(doc, "TAX")).amount, 0);
  assert.equal(doc.refund, null);
  assert.equal(doc.payable, null);
  assert.equal(closing(section(doc, "TAXES_PAID")).label, "Nothing further payable or refundable");
});

/* ---------------- the fee this year adds ---------------- */

test("the interest row names each interest and fee it is made of, including s.234I", () => {
  const { doc, body } = build();
  // Nil throughout on this return, so the note is omitted rather than printed as
  // a list of nils.
  assert.ok("FeeFurnish234I" in body.ITR1_TaxComputation.IntrstPay);
  assert.equal(row(doc, "TAX", /^Add: Interest u\/s 234A/).note, undefined);

  const late = JSON.parse(JSON.stringify(json));
  const pay = late.ITR.ITR1.ITR1_TaxComputation;
  pay.IntrstPay.IntrstPayUs234B = 5049;
  pay.IntrstPay.LateFilingFee234F = 1000;
  pay.IntrstPay.FeeFurnish234I = 500;
  pay.TotalIntrstPay = 6549;
  pay.TotTaxPlusIntrstPay = 6549;
  const { body: lateBody, ay, schemaVersion } = detect(late);
  const doc2 = mapItr1(lateBody, { ...CTX, ay, schemaVersion });
  assert.equal(row(doc2, "TAX", /^Add: Interest u\/s 234A/).amount, 6549);
  assert.equal(
    row(doc2, "TAX", /^Add: Interest u\/s 234A/).note,
    "s.234B 5,049 · fee u/s 234F 1,000 · fee u/s 234I 500"
  );
});

/* ---------------- the second contact ---------------- */

test("the second contact and the alternate address are carried without becoming figures", () => {
  const { doc, body } = build();
  const addr = body.PersonalInfo.Address;
  // Both present in the schema from this year. Neither is an amount, and neither
  // may reach the review block as though it were one (§8).
  assert.ok("MobileNoSec" in addr && "EmailAddressSec" in addr);
  assert.equal(body.PersonalInfo.SecondaryAdd, "Y");
  assert.ok(body.PersonalInfo.AlternateAddress);
  assert.deepEqual(doc.unmapped, []);
  // The particulars card shows the assessee's own contact, not the second one.
  const contact = doc.assessee.facts.find((f) => f.label === "E-mail / mobile").value;
  assert.match(contact, /sample@example\.com/);
  assert.match(contact, /\+91 9800000001/);
});
