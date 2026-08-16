/*
 * Computation of Income — ITR-1, A.Y. 2024-25, the return that found the bugs.
 *
 *   node --test test/computation/itr1-80ggc-tds.test.mjs
 *
 * A salaried assessee on the old regime with tax deducted by three deductors, a
 * refund, and a s.80GGC claim of 13,00,000 spread over six contributions to a
 * political party. Anonymised (§11).
 *
 * It arrived as a bug report: the computation it produced listed 26 "items
 * requiring review". Both causes were readings taken from ITR-2 that ITR-1 does
 * not share, and both are now fixed and pinned here.
 *
 *   Schedule 80GGC was not read at all — 21 of the 26 items. It is the same
 *   schedule ITR-2 carries, under the same path, and §10 requires it PRINTED
 *   rather than claimed: the Department is reopening these claims on the strength
 *   of the date, the mode of payment and the bank reference.
 *
 *   The credit rows are NOT ITD's shared row type, though the block totals share
 *   ITR-2's names. ITR-1 states a deduction as AmtForTaxDeduct / TotTDSOnAmtPaid
 *   / ClaimOutOfTotTDSOnAmtPaid against an EmployerOrDeductorOrCollectDetl, where
 *   ITR-2 has GrossAmount and a nested TaxDeductCreditDtls.
 *
 * Nothing was ever printed wrongly — every figure surfaced for review instead,
 * which is §8 doing its job — but a practitioner had to read a page of JSON paths
 * to see that the document was complete.
 *
 * What this fixture covers that no other ITR-1 does:
 *   - a refund, and a return whose tax is not extinguished by the rebate;
 *   - three deductors, two of them the same insurer, and one credit claimed
 *     against a receipt that had none deducted from it;
 *   - Schedule 80GGC, Schedule 80D, and a professional tax u/s 16(iii);
 *   - the `IFD` other-sources code, captioned from the return's own description;
 *   - a refund the return flags no bank account for.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { detect, validate } from "../../src/computation/index.js";
import { mapItr1 } from "../../src/computation/mappers/itr1/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "..", "fixtures", "itr1-80ggc-tds-refund-ay2024-25.json");
const GOLDEN = path.join(here, "..", "golden", "itr1-80ggc-tds-refund-ay2024-25.model.json");

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

test("unmapped is empty — this is the bug this fixture exists for", () => {
  const { doc } = build();
  // 26 items before the fix: 21 from Schedule 80GGC and 5 from the credit rows.
  assert.deepEqual(doc.unmapped, []);
});

/* ---------------- Schedule 80GGC, on the face of the document ---------------- */

test("every contribution to a political party is printed, with its date and reference", () => {
  const { doc, body } = build();
  const stated = body.Schedule80GGC.Schedule80GGCDetails;
  assert.equal(stated.length, 6);

  const via = section(doc, "VIA");
  const header = via.rows.find((r) => r.kind === "columnHeader");
  assert.match(header.label, /^Contributions claimed u\/s 80GGC/);
  assert.deepEqual(header.cols, { ref: "Mode of payment", amt: "Amount (₹)" });

  // One row per contribution, in the order the return states them, captioned by
  // the date — which with the mode of payment and the bank reference is what a
  // s.80GGC enquiry actually asks about (§10).
  const dated = via.rows.filter((r) => /^\d{2} [A-Z][a-z]+ \d{4}$/.test(r.label));
  assert.equal(dated.length, 6);
  assert.equal(dated[0].label, "04 May 2023");
  assert.equal(dated[0].amount, 200000);
  assert.equal(dated[0].cols.ref, "Banking channel");
  assert.match(dated[0].note, /Ref\. \d+ · IFSC [A-Z0-9]+/);
  // Nothing was paid in cash here; s.80GGC allows nothing that was.
  assert.equal(body.Schedule80GGC.TotalDonationAmtCash80GGC, 0);
  assert.ok(dated.every((r) => r.cols.ref === "Banking channel"));

  assert.equal(via.rows.at(-1).label, "Total Contributions Claimed u/s 80GGC");
  assert.equal(via.rows.at(-1).amount, 1300000);
});

test("the contributions sit AFTER the Chapter VI-A total, so the column still adds up", () => {
  const { doc } = build();
  const labels = section(doc, "VIA").rows.map((r) => r.label);
  const total = labels.indexOf("Total deductions under Chapter VI-A");
  const first = labels.findIndex((l) => /^Contributions claimed/.test(l));
  assert.ok(total < first, "particulars of a deduction already counted come after it");
  // 1,50,000 + 65,000 + 13,00,000 + 10,000 = 15,25,000, and the rows above the
  // total are exactly those four.
  assert.equal(section(doc, "VIA").rows[total].amount, 1525000);
  assert.deepEqual(section(doc, "VIA").rows.slice(0, total).map((r) => r.amount), [150000, 65000, 1300000, 10000]);
  assert.match(row(doc, "VIA", /80GGC/).note, /Each contribution is itemised below/);
});

/* ---------------- the credit rows, in ITR-1's own shape ---------------- */

test("each deductor is named from the row shape ITR-1 actually uses", () => {
  const { doc, body } = build();
  const stated = body.TDSonOthThanSals.TDSonOthThanSal[0];
  // The shape that matters: no TANOfDeductor, no GrossAmount, no nested
  // TaxDeductCreditDtls. Reading ITR-2's names here found nothing at all.
  assert.ok(!("TANOfDeductor" in stated) && !("GrossAmount" in stated));
  assert.ok("AmtForTaxDeduct" in stated && "ClaimOutOfTotTDSOnAmtPaid" in stated);

  const paid = section(doc, "TAXES_PAID");
  const salary = paid.rows.find((r) => /Salary · Sec\. 192/.test(r.note || ""));
  assert.equal(salary.amount, 34000);
  assert.equal(salary.cols.ref, "21,10,163");

  const fund = paid.rows.find((r) => r.amount === 555);
  assert.equal(fund.cols.ref, "5,551");
  assert.match(fund.note, /^SAMPLE NAME/, "the deductor is named — ITR-1 carries the name, ITR-2 does not");
  assert.equal(row(doc, "TAXES_PAID", /^Total Tax Deducted at Source/).amount, 34555);
});

test("two entries from one deductor are one row carrying the count", () => {
  const { doc, body } = build();
  // The insurer deducted nothing from either of two small payments. §12: one row
  // with the count, not two near-identical lines — and the row is KEPT despite
  // the nil credit, because a receipt reported with no deduction against it is
  // what a s.143(1) mismatch turns on.
  const insurer = body.TDSonOthThanSals.TDSonOthThanSal.filter((t) => !t.TotTDSOnAmtPaid);
  assert.equal(insurer.length, 2);
  const merged = section(doc, "TAXES_PAID").rows.find((r) => /2 entries/.test(r.note || ""));
  assert.equal(merged.amount, 0);
  assert.equal(merged.cols.ref, "105", "45 + 60, summed across the two entries");
});

test("a deduction only part-claimed this year says so, and it is not the same figure twice", () => {
  // Our rule, on a mutation of this return: TotTDSOnAmtPaid is what was deducted
  // and ClaimOutOfTotTDSOnAmtPaid what is claimed out of it. Where they differ
  // the balance is a credit left for another year, and the row says so.
  const partial = JSON.parse(JSON.stringify(json));
  partial.ITR.ITR1.TDSonOthThanSals.TDSonOthThanSal[2].ClaimOutOfTotTDSOnAmtPaid = 400;
  partial.ITR.ITR1.TDSonOthThanSals.TotalTDSonOthThanSals = 400;
  partial.ITR.ITR1.TaxPaid.TaxesPaid.TDS = 34400;
  partial.ITR.ITR1.TaxPaid.TaxesPaid.TotalTaxesPaid = 34400;
  partial.ITR.ITR1.Refund.RefundDue = 11675;

  const { body, ay, schemaVersion } = detect(partial);
  const doc = mapItr1(body, { ...CTX, ay, schemaVersion });
  const fund = section(doc, "TAXES_PAID").rows.find((r) => r.amount === 400);
  assert.match(fund.note, /Deducted 555, of which 400 claimed this year/);
  assert.deepEqual(doc.unmapped, []);
  assert.deepEqual(validate(doc, body).failures, []);
});

/* ---------------- the refund ---------------- */

test("the refund names an account and says the return flagged none", () => {
  const { doc, body } = build();
  assert.equal(doc.payable, null);
  assert.equal(doc.refund.amount, 11830);
  // Two accounts, neither carrying UseForRefund. Showing the first without
  // saying so would assert something the return does not.
  assert.equal(body.Refund.BankAccountDtls.AddtnlBankDetails.length, 2);
  assert.equal(doc.refund.bank.name, body.Refund.BankAccountDtls.AddtnlBankDetails[0].BankName);
  const note = doc.notes.find((n) => /No bank account is flagged/.test(n.text));
  assert.equal(note.severity, "attention");

  assert.equal(row(doc, "TAXES_PAID", /^Total Taxes Paid/).amount, 34555);
  assert.equal(closing(section(doc, "TAXES_PAID")).label, "Refund Due");
  assert.equal(closing(section(doc, "TAXES_PAID")).amount, 11830);
});

/* ---------------- the rest of the document ---------------- */

test("the old regime reconciles here against a table the new one cannot match", () => {
  const { doc, body } = build();
  assert.equal(body.FilingStatus.OptOutNewTaxRegime, "Y");
  assert.match(doc.assessee.facts.find((f) => f.label === "Tax regime").value, /^Old regime/);
  // 12,500 + 20% of (5,46,760 − 5,00,000) = 21,852, which is the old table to the
  // rupee. s.115BAC(1A) for this year would give 12,338 — the first ITR-1 we hold
  // whose income is high enough for the two to differ (§10).
  assert.equal(body.ITR1_IncomeDeductions.TotalIncome, 546760);
  assert.equal(body.ITR1_TaxComputation.TotalTaxPayable, 21852);
  assert.equal(12500 + Math.round((546760 - 500000) * 0.2), 21852);
  // No rebate: total income is over 5,00,000, so s.87A gives nothing and the
  // cess is charged. Every ITR-1 before this one closed at nil.
  assert.equal(row(doc, "TAX", /^Less: Rebate u\/s 87A/).amount, 0);
  assert.equal(row(doc, "TAX", /^Tax after rebate/), undefined);
  assert.equal(row(doc, "TAX", /^Add: Health & Education Cess/).amount, 874);
  assert.equal(closing(section(doc, "TAX")).amount, 22726);
});

test("tax on employment is a line of its own under s.16(iii)", () => {
  const { doc } = build();
  // 52,400 is 50,000 + 2,400, and the two are different sections. The first ITR-1
  // we hold that claims anything beyond the standard deduction.
  assert.equal(row(doc, "SALARY", /^Less: Standard deduction u\/s 16\(ia\)/).amount, 50000);
  assert.equal(row(doc, "SALARY", /^Less: Tax on employment u\/s 16\(iii\)/).amount, 2400);
  assert.equal(closing(section(doc, "SALARY")).amount, 2057764);
});

test("the IFD other-sources code is captioned from the return's own description", () => {
  const { doc, body } = build();
  const stated = body.ITR1_IncomeDeductions.OthersInc.OthersIncDtlsOthSrc;
  assert.deepEqual(stated.map((o) => o.OthSrcNatureDesc), ["SAV", "IFD"]);
  // Both codes are named from returns that state the department's own wording
  // beside them — never from what a code looks like it might mean (§5).
  assert.equal(section(doc, "OS").rows[0].label, "Interest from a savings bank account");
  assert.equal(section(doc, "OS").rows[1].label, "Interest from deposits with a bank, post office or co-operative society");
  assert.equal(closing(section(doc, "OS")).amount, 14000);
  // s.80TTA is capped at 10,000 against savings interest of 10,628, and the
  // return itself applied the cap — claimed and allowed both read 10,000.
  assert.equal(row(doc, "VIA", /80TTA/).amount, 10000);
  assert.equal(row(doc, "VIA", /80TTA/).note, undefined);
});

test("Schedule 80D is claimed wholesale, because the block above already totals it", () => {
  const { doc, body } = build();
  // §10: the itemising schedules restate the deduction block. 80GGC is the one
  // exception and is printed; 80D is not, so it must not reach the review block
  // either.
  assert.equal(body.Schedule80D.Sec80DSelfFamSrCtznHealth.EligibleAmountOfDedn, 65000);
  assert.equal(row(doc, "VIA", /80D/).amount, 65000);
  assert.ok(!section(doc, "VIA").rows.some((r) => /health check|Sec80D/i.test(r.label)));
  assert.deepEqual(doc.unmapped, []);
});
