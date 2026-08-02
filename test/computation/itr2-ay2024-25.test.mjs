/*
 * Computation of Income — ITR-2, A.Y. 2024-25.
 *
 *   node --test test/computation/itr2-ay2024-25.test.mjs
 *
 * A salaried assessee on the OLD regime with a housing loan on a self-occupied
 * flat, listed-equity gains under both s.111A and s.112A, and a Chapter VI-A
 * claim that the statutory caps cut down. Anonymised (spec §11).
 *
 * What this fixture covers that no other does:
 *   - the old regime, so Chapter VI-A does real work and the claimed and
 *     allowed columns of Schedule VI-A differ;
 *   - a house property LOSS set off against salary u/s 71;
 *   - salary itemised by the department's component codes, decoded from ITD's
 *     own schema rather than guessed at (see mappers/individual/labels.js);
 *   - a refund whose bank account carries no UseForRefund flag, so the fallback
 *     and its note are exercised;
 *   - Schedule TDS2 rows with no section code and, in one case, no figures at
 *     all — both of which used to print badly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildComputation, detect, validate, UnsupportedFormError } from "../../src/computation/index.js";
import { mapItr2 } from "../../src/computation/mappers/itr2/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "..", "fixtures", "itr2-oldregime-hploss-via-ay2024-25.json");
const GOLDEN = path.join(here, "..", "golden", "itr2-oldregime-hploss-via-ay2024-25.model.json");

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

/* ---------------- the old regime ---------------- */

test("the old regime is stated, and Chapter VI-A is a section rather than a nil line", () => {
  const { doc } = build();
  assert.match(doc.assessee.facts.find((f) => f.label === "Tax regime").value, /^Old regime/);
  assert.deepEqual(doc.sections.map((s) => s.id), ["SALARY", "HP", "CG", "OS", "VIA", "TI", "TAX", "TAXES_PAID"]);
  assert.equal(closing(section(doc, "VIA")).amount, 264506);
});

test("a deduction cut down by the statutory cap says so on its own line and in a note", () => {
  const { doc } = build();
  // 80C claimed 2,64,597 against a 1,50,000 cap; 80TTA claimed 46,383 against
  // 10,000. Printing only the allowed figure would hide both.
  assert.equal(row(doc, "VIA", /80C/).amount, 150000);
  assert.match(row(doc, "VIA", /80C/).note, /Claimed 2,64,597; restricted/);
  assert.equal(row(doc, "VIA", /80TTA/).amount, 10000);
  assert.match(row(doc, "VIA", /80TTA/).note, /Claimed 46,383; restricted/);
  // 80CCD(2) and 80D were allowed in full, so they carry no note.
  assert.equal(row(doc, "VIA", /80CCD\(2\)/).note, undefined);

  const note = doc.notes.find((n) => /Chapter VI-A of/.test(n.text));
  assert.equal(note.severity, "attention");
  assert.match(note.text, /4,15,486 were claimed, of which 1,50,980 was restricted.*2,64,506 has been allowed/);
});

/* ---------------- the salary components ---------------- */

test("gross salary is broken down by the department's own component codes", () => {
  const { doc, body } = build();
  // The return states components as bare codes — "1" and "4". They are named
  // from ITR2_2024_Main_V1.4.json, not from what a code looks like it means.
  const stated = body.ScheduleS.Salaries[0].Salarys.NatureOfSalary.OthersIncDtls;
  assert.deepEqual(stated.map((c) => c.NatureDesc), ["4", "1"]);

  const labels = section(doc, "SALARY").rows.map((r) => r.label);
  assert.deepEqual(labels.slice(0, 3), [
    "Salary as per section 17(1)",
    // Listed in the schema's order — basic pay, then the allowances — not in the
    // order the filing software happened to write them.
    "— Basic salary",
    "— House rent allowance",
  ]);
  assert.equal(row(doc, "SALARY", /^— Basic salary/).amount, 2110460);
  assert.equal(row(doc, "SALARY", /^— House rent allowance/).amount, 472312);
  assert.equal(row(doc, "SALARY", /^Salary as per section 17\(1\)/).amount, 2582772);
});

test("the HRA exemption is a separate line from the HRA component of salary", () => {
  const { doc } = build();
  // 4,72,312 received, 1,56,685 exempt. A computation that showed one and not
  // the other is the one a s.143(1) adjustment argues about.
  assert.equal(row(doc, "SALARY", /^Less: House rent allowance exempt/).amount, 156685);
  assert.equal(row(doc, "SALARY", /^Less: Standard deduction/).amount, 50000);
  assert.equal(closing(section(doc, "SALARY")).amount, 2376087);
});

/* ---------------- the house property loss ---------------- */

test("interest on a self-occupied flat produces a loss, set off against salary u/s 71", () => {
  const { doc } = build();
  const hp = section(doc, "HP");
  // No annual value to work with: the whole head is the s.24(b) interest.
  assert.equal(row(doc, "HP", /^Annual value of the self-occupied/).amount, 0);
  assert.equal(row(doc, "HP", /^Less: Interest on borrowed capital/).amount, 176493);
  assert.equal(closing(hp).label, "Loss from House Property");
  assert.equal(closing(hp).isLoss, true);
  assert.equal(closing(hp).amount, 176493);

  // Part B-TI states the head as nil and the loss as a set-off below it — which
  // is the return's own presentation, and the reason both lines are printed.
  assert.equal(row(doc, "TI", /^Income from House Property/).amount, 0);
  const setOff = row(doc, "TI", /^Less: Set-off of current year/);
  assert.equal(setOff.label, "Less: Set-off of current year house property loss u/s 71");
  assert.equal(setOff.amount, 176493);
  assert.equal(row(doc, "TI", /^Gross Total Income/).amount, 2488253);
  assert.equal(closing(section(doc, "TI")).amount, 2223750);
});

/* ---------------- capital gains and the rates of this year ---------------- */

test("this year has one rate per head, so nothing is split", () => {
  const { doc, body } = build();
  // A.Y. 2024-25 predates the mid-year rate change: 15% short-term and 10%
  // long-term, with no 20% short-term or 12.5% long-term bucket to split into.
  assert.equal(body["PartB-TI"].CapGain.ShortTerm.ShortTerm15Per, 3936);
  assert.equal(body["PartB-TI"].CapGain.LongTerm.LongTerm10Per, 164483);
  assert.ok(!("LongTerm12_5Per" in body["PartB-TI"].CapGain.LongTerm));
  assert.ok(!section(doc, "CG").rows.some((r) => /taxable at/.test(r.label)));
  assert.equal(closing(section(doc, "CG")).amount, 168419);

  const si = section(doc, "TAX").rows.filter((r) => r.ref === "Sch. SI");
  assert.deepEqual(si.map((r) => r.label), [
    "Short-term capital gains u/s 111A — at 15%",
    "Long-term capital gains u/s 112A — at 10%",
  ]);
  assert.deepEqual(si.map((r) => r.amount), [590, 6448]);
});

test("tax is worked on the aggregate and the special-rate income is shown apart", () => {
  const { doc } = build();
  assert.equal(row(doc, "TI", /^of which, income taxable at special rates/).amount, 168419);
  assert.equal(row(doc, "TI", /^balance taxable at the rates in force/).amount, 2055331);
  assert.equal(row(doc, "TAX", /^Tax on income at the rates in force/).amount, 429099);
  assert.equal(row(doc, "TAX", /^Add: Health & Education Cess/).amount, 17445);
  assert.equal(closing(section(doc, "TAX")).amount, 453582);
  assert.match(section(doc, "TAX").footnote, /Alternate Minimum Tax is Nil/);
});

/* ---------------- taxes paid and the refund ---------------- */

test("a deductor entry with no figures at all is dropped; one with a receipt is kept", () => {
  const { doc, body } = build();
  const stated = body.ScheduleTDS2.TDSOthThanSalaryDtls;
  assert.equal(stated.length, 7);
  // One of the seven reports neither a gross receipt nor a credit. It says
  // nothing, so it is not printed; the five that report a receipt without a
  // deduction are, because that is what a s.143(1) mismatch turns on.
  const tans = section(doc, "TAXES_PAID").rows.filter((r) => /^[A-Z]{4}\d{5}[A-Z]$/.test(r.label));
  assert.equal(tans.length, 7);
  assert.equal(tans.filter((r) => r.amount === 0).length, 5);
  assert.equal(tans[0].amount, 452874);
  assert.match(tans[0].note, /Salary · Sec\. 192/);
});

test("no return carries a section code here, so no row says a dangling \"Sec.\"", () => {
  const { doc, body } = build();
  assert.ok(body.ScheduleTDS2.TDSOthThanSalaryDtls.every((t) => t.TDSSection === undefined));
  assert.ok(!section(doc, "TAXES_PAID").rows.some((r) => /Sec\.\s*$|Sec\.\s*·/.test(r.note || "")));
});

test("the refund names an account, and says the return did not flag one", () => {
  const { doc } = build();
  assert.equal(doc.payable, null);
  assert.equal(doc.refund.amount, 4527);
  assert.equal(doc.refund.bank.type, "SB");
  assert.ok(doc.refund.bank.ifsc);
  // The return lists one account and flags none for the refund. Showing it
  // without saying so would assert something the return does not.
  const note = doc.notes.find((n) => /No bank account is flagged/.test(n.text));
  assert.equal(note.severity, "attention");

  const paid = section(doc, "TAXES_PAID");
  assert.equal(row(doc, "TAXES_PAID", /^Total Taxes Paid/).amount, 458109);
  assert.equal(closing(paid).label, "Refund Due");
  assert.equal(closing(paid).amount, 4527);
});

/* ---------------- the year gate ---------------- */

test("an unsupported year raises rather than using another year's mapper", () => {
  const wrongYear = JSON.parse(JSON.stringify(json));
  wrongYear.ITR.ITR2.Form_ITR2.AssessmentYear = "2020";
  assert.throws(() => buildComputation(wrongYear, CTX), UnsupportedFormError);
});

test("the signatory's capacity is named from the schema's own enum", () => {
  const { doc } = build();
  // Verification.Capacity is one of S / R / K / A. "Self" here; a Karta signs
  // as "K", which this table used to miss entirely.
  assert.equal(doc.signatory.capacity, "Self");
});
