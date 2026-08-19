/*
 * The ITR-B tool's arithmetic and its reads.
 *
 *   node --test test/itrb.test.mjs
 *
 * A block return is a document a practitioner signs and files against a notice
 * that carries a sixty-day clock, so the parts that can be wrong without anyone
 * noticing are the ones tested here: the block period derived from a date, the
 * declared income read out of a filed return, and the tax chain under s.113.
 * The form itself is not tested — it has no arithmetic in it, by design.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { blockPeriod, dueDateFor, monthsOfDelay, fyStart, ayOfPy, pyOfAy } from "../src/tools/itrb/blockPeriod.js";
import { DII_ITEMS, furnishingMode, VERIFICATION_TEXT } from "../src/tools/itrb/form.js";
import { readDeclared, declaredTotal, HEADS } from "../src/tools/itrb/declared.js";
import { computeItrB, round288B, UNDISCLOSED_HEADS } from "../src/tools/itrb/compute.js";
import {
  blankDraft, withBlockPeriod, fromAssessee, fromNotice, isBlockNotice,
  withDeclared, withDueDate, readiness,
} from "../src/tools/itrb/draft.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

/* ------------------------------ block period ------------------------------ */

test("the block period is six previous years plus the part of the search year", () => {
  const bp = blockPeriod("2025-11-15");
  assert.equal(bp.ok, true);
  assert.equal(bp.years.length, 7);
  // s.158B(b): six A.Y.s PRECEDING the A.Y. relevant to the search year
  // (A.Y. 2026-27), so A.Y. 2020-21 to 2025-26, oldest first.
  assert.deepEqual(bp.years.map((y) => y.ay),
    ["2020-21", "2021-22", "2022-23", "2023-24", "2024-25", "2025-26", "2026-27"]);
  assert.equal(bp.from, "2019-04-01");
  assert.equal(bp.to, "2025-11-15");
});

test("only the last row is a part period, and it ends on the date of the search", () => {
  const bp = blockPeriod("2025-11-15");
  assert.deepEqual(bp.years.map((y) => y.part), [false, false, false, false, false, false, true]);
  assert.equal(bp.years[6].from, "2025-04-01");
  assert.equal(bp.years[6].to, "2025-11-15");
  // Every full year runs 1 April to 31 March.
  assert.equal(bp.years[0].from, "2019-04-01");
  assert.equal(bp.years[0].to, "2020-03-31");
});

test("a search in January falls in the previous financial year", () => {
  // 20 January 2025 is P.Y. 2024-25, so the block runs to A.Y. 2025-26 and the
  // part period starts 1 April 2024 — not 1 April 2025.
  const bp = blockPeriod("2025-01-20");
  assert.equal(bp.initiationPy, "2024-25");
  assert.equal(bp.years[6].ay, "2025-26");
  assert.equal(bp.years[6].from, "2024-04-01");
  assert.equal(bp.years[0].ay, "2019-20");
});

test("a search before 1 September 2024 has no block period at all", () => {
  // Chapter XIV-B was revived for searches from that date; earlier ones are
  // assessed under s.153A and there is no ITR-B to file.
  const bp = blockPeriod("2024-08-31");
  assert.equal(bp.ok, false);
  assert.deepEqual(bp.years, []);
  assert.match(bp.reason, /153A/);
  assert.equal(blockPeriod("2024-09-01").ok, true);
});

test("a missing or malformed search date is refused rather than guessed", () => {
  for (const bad of ["", null, undefined, "15-11-2025", "2025-13-01"]) {
    assert.equal(blockPeriod(bad).ok, false, `${bad} should not produce a block period`);
  }
});

test("financial year and assessment year conversions agree with each other", () => {
  assert.equal(fyStart("2025-03-31"), 2024);
  assert.equal(fyStart("2025-04-01"), 2025);
  assert.equal(ayOfPy(2024), "2025-26");
  assert.equal(pyOfAy("2025-26"), 2024);
  assert.equal(ayOfPy(2099), "2100-01");
});

test("the due date is sixty days from service, and delay counts part months whole", () => {
  assert.equal(dueDateFor("2026-01-10"), "2026-03-11");
  assert.equal(dueDateFor(""), "");
  // On time, and one day early, are both nil.
  assert.equal(monthsOfDelay("2026-03-11", "2026-03-11"), 0);
  assert.equal(monthsOfDelay("2026-03-11", "2026-03-10"), 0);
  // s.158BFA(1) charges "every month or part of a month".
  assert.equal(monthsOfDelay("2026-03-11", "2026-03-12"), 1);
  assert.equal(monthsOfDelay("2026-03-11", "2026-06-11"), 3);
  assert.equal(monthsOfDelay("2026-03-11", "2026-06-12"), 4);
});

/* -------------------------- reading a filed return -------------------------- */

test("head totals are read from Part B-TI on the forms that have one", () => {
  const d = readDeclared(fixture("itr3-partner-capgains-44ad-ay2024-25"));
  assert.equal(d.form, "ITR3");
  assert.equal(d.formLabel, "ITR-3");
  assert.equal(d.ay, "2024-25");
  assert.equal(d.salary, 430000);
  assert.equal(d.business, 608863);
  assert.equal(d.capitalGains, 1337240);
  assert.equal(d.otherSources, 893926);
  assert.equal(d.totalIncome, 3270030);
});

test("ITR-1 is read from its own block, and its absent heads read null not nil", () => {
  const d = readDeclared(fixture("itr1-80ggc-tds-refund-ay2024-25"));
  assert.equal(d.form, "ITR1");
  assert.equal(d.salary, 2057764);
  assert.equal(d.otherSources, 14000);
  assert.equal(d.totalIncome, 546760);
  // There is no business or capital-gains head on ITR-1. Null, so the form
  // prints a dash: a zero there would read as a declaration of nil.
  assert.equal(d.business, null);
  assert.equal(d.capitalGains, null);
});

test("a firm's PAN and name come out of OrgFirmInfo, not PersonalInfo", () => {
  const d = readDeclared(fixture("itr5-firm-business-loss-ay2025-26"));
  assert.equal(d.form, "ITR5");
  assert.equal(d.pan, "AAAFZ1234A");
  assert.equal(d.name, "SAMPLE FOODS");
});

test("every fixture in the repo reads without throwing and states its year", () => {
  const names = [
    "itr1-salary-belated-nil-ay2022-23", "itr2-salary-hp-capgains-ay2025-26",
    "itr3-books-surcharge-unqshares-ay2026-27", "itr5-firm-house-property-loss-ay2025-26",
  ];
  for (const n of names) {
    const d = readDeclared(fixture(n));
    assert.ok(d, `${n} should read`);
    assert.match(d.ay, /^\d{4}-\d{2}$/, `${n} should state an A.Y.`);
    assert.equal(d.pan.length > 0 || d.form === "ITR5", true);
  }
});

test("anything that is not a portal ITR JSON reads as null", () => {
  for (const junk of [null, undefined, {}, { ITR: {} }, { ITR: "no" }, { notITR: { ITR1: {} } }]) {
    assert.equal(readDeclared(junk), null);
  }
});

test("the declared total prefers the return's own stated total income", () => {
  const d = readDeclared(fixture("itr2-oldregime-hploss-via-ay2024-25"));
  // 22,23,750 is stated after Chapter VI-A; adding the heads would give the
  // gross total income instead, which is not what s.158BB reduces by.
  assert.equal(declaredTotal(d), 2223750);
  // With no stated total, the heads are summed rather than nothing returned.
  assert.equal(declaredTotal({ salary: 100, otherSources: 50, totalIncome: null }), 150);
  assert.equal(declaredTotal({ totalIncome: null }), null);
  assert.equal(declaredTotal(null), null);
});

/* -------------------------------- the tax -------------------------------- */

const draftWith = (years, extra = {}) => ({ years, ...extra });

test("undisclosed income is aggregated across the block period", () => {
  const r = computeItrB(draftWith([
    { ay: "2020-21", undisclosed: { business: 250000 } },
    { ay: "2021-22", undisclosed: { deemed: 1000000, otherSources: 50000 } },
  ]));
  assert.equal(r.totalUndisclosed, 1300000);
  assert.equal(r.byHead.business, 250000);
  assert.equal(r.byHead.deemed, 1000000);
  assert.equal(r.hasContent, true);
});

test("a year that nets to a loss is carried at nil — s.158BB(4)", () => {
  const r = computeItrB(draftWith([
    { ay: "2020-21", undisclosed: { business: 250000 } },
    { ay: "2021-22", undisclosed: { business: -400000 } },
  ]));
  // The loss does not reduce the other year.
  assert.equal(r.totalUndisclosed, 250000);
  assert.equal(r.years[1].floored, true);
  assert.equal(r.years[1].grossUndisclosed, -400000);
  assert.equal(r.years[1].totalUndisclosed, 0);
});

test("the head-wise totals cast to the grand total even when a year is floored", () => {
  // A floored year contributing its heads while its total is disregarded would
  // leave Part C's head row and Part C's total disagreeing.
  const r = computeItrB(draftWith([
    { undisclosed: { business: 250000, deemed: 1000000 } },
    { undisclosed: { business: -50000 } },
  ]));
  const sum = UNDISCLOSED_HEADS.reduce((a, h) => a + r.byHead[h.key], 0);
  assert.equal(sum, r.totalUndisclosed);
});

test("tax runs 60% under s.113, then surcharge, then cess on both", () => {
  const r = computeItrB(draftWith([{ undisclosed: { deemed: 10000000 } }], { surchargeRate: 25 }));
  assert.equal(r.tax.rate, 60);
  assert.equal(r.tax.amount, 6000000);
  assert.equal(r.tax.surcharge, 1500000);
  // Cess is on tax plus surcharge, not on tax alone.
  assert.equal(r.tax.cess, 300000);
  assert.equal(r.tax.grossLiability, 7800000);
});

test("interest is derived from the dates and can be overridden", () => {
  const years = [{ undisclosed: { deemed: 1000000 } }];
  const derived = computeItrB(draftWith(years, { dueDate: "2026-03-11", filedOn: "2026-06-12" }));
  assert.equal(derived.tax.derivedMonths, 4);
  assert.equal(derived.tax.interestMonths, 4);
  // 1.5% of 6,00,000 for four months.
  assert.equal(derived.tax.interest, 36000);

  const overridden = computeItrB(draftWith(years, { dueDate: "2026-03-11", filedOn: "2026-06-12", interestMonths: 2 }));
  assert.equal(overridden.tax.interestMonths, 2);
  assert.equal(overridden.tax.interest, 18000);

  // Interest runs on the TAX, not on tax-plus-cess.
  assert.equal(derived.tax.interest, derived.tax.amount * 0.015 * 4);
});

test("a return filed on time carries no interest", () => {
  const r = computeItrB(draftWith([{ undisclosed: { deemed: 1000000 } }], { dueDate: "2026-03-11", filedOn: "2026-03-01" }));
  assert.equal(r.tax.interestMonths, 0);
  assert.equal(r.tax.interest, 0);
});

test("credits are totalled per year and across the block, and net off the liability", () => {
  const r = computeItrB(draftWith([
    { undisclosed: { deemed: 1000000 }, credits: { tds: 25000, advance: 100000 } },
    { undisclosed: { business: 500000 }, credits: { tcs: 5000, selfAssessment: 20000 } },
  ]));
  assert.equal(r.years[0].credits.total, 125000);
  assert.equal(r.credits.total, 150000);
  assert.equal(r.credits.tds, 25000);
  // 15,00,000 × 60% = 9,00,000; cess 36,000; less 1,50,000 of credit.
  assert.equal(r.netPayable, 786000);
  assert.equal(r.refundDue, 0);
});

test("credit exceeding the whole liability is reported as a refund, not a negative payable", () => {
  const r = computeItrB(draftWith([{ undisclosed: { deemed: 100000 }, credits: { advance: 200000 } }]));
  assert.equal(r.netPayable, 0);
  assert.equal(r.refundDue, 137600);
});

test("s.288B rounding is to the nearest ten rupees, and applies to the two places the Act applies it", () => {
  assert.equal(round288B(1234), 1230);
  assert.equal(round288B(1235), 1240);
  assert.equal(round288B(-1234), -1230);
  assert.equal(round288B(0), 0);
  const r = computeItrB(draftWith([{ undisclosed: { deemed: 100004 } }]));
  assert.equal(r.totalUndisclosed, 100004);
  assert.equal(r.roundedUndisclosed, 100000);
});

test("penalty exposure is reported but never added into the liability", () => {
  const r = computeItrB(draftWith([{ undisclosed: { deemed: 1000000 } }]));
  assert.equal(r.penaltyExposure, r.tax.amount * 0.5);
  assert.equal(r.tax.aggregate, r.tax.grossLiability + r.tax.interest);
  assert.ok(r.netPayable < r.penaltyExposure + r.tax.aggregate);
});

test("an empty draft computes to nothing rather than throwing", () => {
  for (const d of [undefined, {}, { years: null }]) {
    const r = computeItrB(d);
    assert.equal(r.totalUndisclosed, 0);
    assert.equal(r.netPayable, 0);
    assert.equal(r.hasContent, false);
  }
});

/* ------------------------------- the draft ------------------------------- */

test("Part A is filled from the assessee register, and the PAN is upper-cased", () => {
  const d = fromAssessee(blankDraft(), {
    id: "a1", name: "Rajesh M. Shah", pan: "abcps1234f", status: "HUF",
    address: "Ahmedabad", mobile: "+91 98250 11234", email: "r@example.com",
  });
  assert.equal(d.pan, "ABCPS1234F");
  assert.equal(d.assessee, "Rajesh M. Shah");
  assert.equal(d.status, "HUF");
  assert.equal(d.assesseeId, "a1");
  // The person verifying is the assessee until somebody says otherwise.
  assert.equal(d.verifierName, "Rajesh M. Shah");
  assert.equal(d.verifierPan, "ABCPS1234F");
});

test("filling from an assessee never blanks something already typed", () => {
  const typed = { ...blankDraft(), address: "Typed by hand", mobile: "999" };
  const d = fromAssessee(typed, { id: "a1", name: "X", pan: "AAAPZ1234A" });
  assert.equal(d.address, "Typed by hand");
  assert.equal(d.mobile, "999");
});

test("correcting the search date keeps the years that survive the move", () => {
  let d = withBlockPeriod(blankDraft(), "2025-11-15");
  d.years = d.years.map((y) => (y.ay === "2024-25" ? { ...y, declaredTotal: 500000, undisclosed: { ...y.undisclosed, deemed: 900000 } } : y));

  // A typo corrected inside the same financial year keeps everything.
  const sameFy = withBlockPeriod(d, "2025-11-20");
  assert.equal(sameFy.years.find((y) => y.ay === "2024-25").declaredTotal, 500000);
  assert.equal(sameFy.years[6].to, "2025-11-20");

  // A genuine change of year keeps the overlap and drops the rest.
  const nextFy = withBlockPeriod(d, "2026-05-01");
  assert.equal(nextFy.years.find((y) => y.ay === "2024-25").declaredTotal, 500000);
  assert.equal(nextFy.years[0].ay, "2021-22");
  assert.equal(nextFy.years.find((y) => y.ay === "2027-28").declaredTotal, "");

  // A search date that has no block period leaves no rows behind.
  assert.deepEqual(withBlockPeriod(d, "2024-01-01").years, []);
});

test("a year filled from a return records where the figures came from", () => {
  const d = withBlockPeriod(blankDraft(), "2025-11-15");
  const row = d.years.find((y) => y.ay === "2025-26");
  const filled = withDeclared(row, readDeclared(fixture("itr2-salary-hp-capgains-ay2025-26")), "sync");
  assert.equal(filled.declaredTotal, 2353890);
  assert.equal(filled.declaredForm, "ITR-2");
  assert.equal(filled.declaredSource, "sync");
  assert.equal(filled.declared.salary, 2647321);
  for (const h of HEADS) assert.ok(h.key in filled.declared);
  // A reading that could not be made leaves the row exactly as it was.
  assert.deepEqual(withDeclared(row, null), row);
});

test("the due date is filled from service, and never overwritten once set", () => {
  const filled = withDueDate({ ...blankDraft(), serviceDate: "2026-01-10" });
  assert.equal(filled.dueDate, "2026-03-11");
  const kept = withDueDate({ ...blankDraft(), serviceDate: "2026-01-10", dueDate: "2026-02-28" });
  assert.equal(kept.dueDate, "2026-02-28");
});

test("readiness names what is missing, and goes quiet once it is all there", () => {
  const empty = blankDraft();
  const gaps = readiness(empty, computeItrB(empty));
  assert.ok(gaps.some((g) => /PAN/.test(g)));
  assert.ok(gaps.some((g) => /date of the search/.test(g)));

  let d = withBlockPeriod(fromAssessee(blankDraft(), { id: "a1", name: "R Shah", pan: "ABCPS1234F" }), "2025-11-15");
  d = { ...d, serviceDate: "2026-01-10", noticeDin: "ITBA/1", verificationPlace: "Ahmedabad" };
  d.years = d.years.map((y, i) => (i === 2 ? { ...y, undisclosed: { ...y.undisclosed, deemed: 900000 } } : y));

  // Undisclosed income with no explanation of how it was derived is the one
  // gap that is about the substance rather than the paperwork.
  const withoutManner = readiness(d, computeItrB(d));
  assert.ok(withoutManner.some((g) => /manner in which the income was derived/.test(g)));

  d.years = d.years.map((y, i) => (i === 2 ? { ...y, manner: "Suppressed cash sales." } : y));
  assert.deepEqual(readiness(d, computeItrB(d)), []);
});


/* ---------------------------------------------------------------------------
 * The notified form — Notification No. 30/2025, G.S.R. 221(E).
 *
 * These pin the parts of the tool that were built from the gazette rather than
 * from a description of it, because a description is what got them wrong first.
 * ------------------------------------------------------------------------- */

test("the block period is derived from BOTH search dates, as A19 and A20 require", () => {
  // The form's own worked examples (Note 1). Same six preceding years in each;
  // what differs is the tail.
  const same = blockPeriod("2025-07-01", "2025-07-31");
  assert.deepEqual(same.years.map((y) => y.slot), ["Y6", "Y5", "Y4", "Y3", "Y2", "Y1", "Y0"]);
  assert.equal(same.spansYears, false);
  assert.equal(same.years[6].from, "2025-04-01");
  assert.equal(same.years[6].to, "2025-07-31");
  assert.equal(same.years[6].part, true);

  const spans = blockPeriod("2026-03-15", "2026-04-05");
  assert.deepEqual(spans.years.map((y) => y.slot), ["Y6", "Y5", "Y4", "Y3", "Y2", "Y1", "Y0", "Y+1"]);
  assert.equal(spans.spansYears, true);
  // Y0 becomes a COMPLETE year once the tail moves into the next previous year.
  assert.equal(spans.years[6].part, false);
  assert.equal(spans.years[6].from, "2026-04-01".replace("2026", "2025"));
  assert.equal(spans.years[6].to, "2026-03-31");
  assert.equal(spans.years[7].from, "2026-04-01");
  assert.equal(spans.years[7].to, "2026-04-05");
  assert.equal(spans.years[7].part, true);

  // Y6…Y1 are identical in both — they hang off the year of INITIATION alone.
  assert.deepEqual(same.years.slice(0, 6).map((y) => y.ay), spans.years.slice(0, 6).map((y) => y.ay));
});

test("exactly one row is ever the part period, however far apart the dates are", () => {
  const bp = blockPeriod("2025-11-15", "2027-06-10");
  assert.equal(bp.years.filter((y) => y.part).length, 1);
  assert.equal(bp.years[bp.years.length - 1].to, "2027-06-10");
  // Whole years in between are carried whole rather than special-cased away.
  assert.equal(bp.years[7].to, "2027-03-31");
  assert.equal(bp.years[7].part, false);
});

test("an execution date before the initiation date is refused", () => {
  const bp = blockPeriod("2025-11-15", "2025-01-01");
  assert.equal(bp.ok, false);
  assert.match(bp.reason, /before the search was initiated/);
});

test("a draft written before the second date existed keeps the period it had", () => {
  // Backward compatibility is the point: a stored draft carries searchDate and
  // no lastAuthDate, and must not silently acquire a different block period.
  const legacy = blockPeriod("2025-11-15");
  assert.equal(legacy.years.length, 7);
  assert.equal(legacy.to, "2025-11-15");
  assert.equal(legacy.spansYears, false);
  assert.deepEqual(legacy.years.map((y) => y.ay), blockPeriod("2025-11-15", "2025-11-15").years.map((y) => y.ay));
});

test("Part D-II carries the form's fourteen items, in the form's order", () => {
  assert.equal(DII_ITEMS.length, 14);
  assert.deepEqual(DII_ITEMS.map((i) => i.no), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.equal(DII_ITEMS[0].label, "Money");
  assert.equal(DII_ITEMS[4].label, "Virtual Digital Asset");
  assert.equal(DII_ITEMS[13].label, "Any Other");
  // Rows 11 and 12 are the two the form restricts to a complete Y0.
  assert.deepEqual(DII_ITEMS.filter((i) => i.completeYearOnly).map((i) => i.no), [11, 12]);
});

test("Part D-II is expected to tie to Part D-I, and says so when it does not", () => {
  const tied = computeItrB(draftWith([
    { undisclosed: { deemed: 1500000 }, items: { money: 1200000, jewellery: 300000 } },
  ]));
  assert.equal(tied.totalByItem, 1500000);
  assert.equal(tied.itemsTie, true);
  assert.equal(tied.years[0].itemMismatch, false);

  const off = computeItrB(draftWith([
    { undisclosed: { deemed: 1500000 }, items: { money: 1200000 } },
  ]));
  assert.equal(off.itemsTie, false);
  assert.equal(off.years[0].itemMismatch, true);
  assert.ok(readiness(blankDraft(), off).some((g) => /Part D-II totals/.test(g)));

  // An untouched Part D-II is not a mismatch — most drafts never reach it.
  const untouched = computeItrB(draftWith([{ undisclosed: { deemed: 1500000 } }]));
  assert.equal(untouched.itemsEntered, false);
  assert.equal(untouched.itemsTie, true);
});

test("s.158BB(3) — transaction income in a PART period is flagged, not silently taxed", () => {
  let d = withBlockPeriod(blankDraft(), { searchDate: "2025-11-15" });
  d.years[6].undisclosed.business = 800000;          // Y0, the part period
  d.years[6].items.internationalTxn = 800000;
  const r = computeItrB(d);
  assert.deepEqual(r.misplaced158BB3, ["2026-27"]);
  assert.equal(r.years[6].excluded158BB3, 800000);
  assert.ok(readiness(d, r).some((g) => /158BB\(3\)/.test(g)));
});

test("s.158BB(3) — the same figures on a COMPLETE Y0 are perfectly proper", () => {
  // Note 4 confines the exclusion to a part previous year, and Part D-II marks
  // rows 11 and 12 fillable where Y0 is a complete year. Flagging those would
  // be as wrong as missing the part-period case.
  let d = withBlockPeriod(blankDraft(), { searchDate: "2026-03-15", lastAuthDate: "2026-04-05" });
  d.years[6].undisclosed.business = 800000;          // Y0, now a complete year
  d.years[6].items.internationalTxn = 800000;
  const r = computeItrB(d);
  assert.deepEqual(r.misplaced158BB3, []);
  assert.equal(r.itemsTie, true);
});

test("credits are split the way Parts G and H split them", () => {
  const r = computeItrB(draftWith([
    { undisclosed: { deemed: 1000000 }, credits: { advance: 100000, selfAssessment: 20000, tds: 30000, tcs: 5000 } },
  ]));
  // Part G — advance tax and self-assessment tax paid earlier.
  assert.equal(r.credits.partG, 120000);
  // Part H — TDS and TCS not claimed earlier.
  assert.equal(r.credits.partH, 35000);
  assert.equal(r.credits.total, 155000);
  assert.equal(r.years[0].credits.partG, 120000);
});

test("Part F — self-assessment tax for the block period reduces the balance", () => {
  const base = computeItrB(draftWith([{ undisclosed: { deemed: 1000000 } }]));
  const paid = computeItrB(draftWith([{ undisclosed: { deemed: 1000000 } }], {
    blockTaxPaid: [
      { bsrCode: "0510308", date: "2026-06-10", challanNo: "00123", amount: 400000 },
      { bsrCode: "0510308", date: "2026-06-11", challanNo: "00124", amount: 100000 },
    ],
  }));
  assert.equal(paid.blockTaxPaidTotal, 500000);
  assert.equal(paid.netPayable, base.netPayable - 500000);
});

test("rule 12AE(2) decides how the return must be furnished", () => {
  assert.equal(furnishingMode({ status: "Company" }).dscOnly, true);
  assert.equal(furnishingMode({ status: "Individual", auditUs44AB: true }).dscOnly, true);
  assert.equal(furnishingMode({ status: "Trust", politicalParty: true }).dscOnly, true);
  const ordinary = furnishingMode({ status: "Individual" });
  assert.equal(ordinary.dscOnly, false);
  assert.match(ordinary.label, /electronic verification code/);
});

test("the verification is the form's sentence, with the blanks filled", () => {
  const t = VERIFICATION_TEXT("A B Shah", "C D Shah", "Karta", "ABCPS1234F");
  assert.match(t, /^I, A B Shah son\/ daughter of C D Shah solemnly declare/);
  assert.match(t, /in my capacity as Karta/);
  assert.match(t, /permanent account number ABCPS1234F\.$/);
  // An unfilled name leaves a rule to write on rather than the word undefined.
  assert.match(VERIFICATION_TEXT("", "", "", ""), /^I, _+ son/);
});

test("a s.158BC notice is recognised, and an ordinary notice is not", () => {
  assert.equal(isBlockNotice({ section: "158BC" }), true);
  assert.equal(isBlockNotice({ section: "158BC r.w.s. 158BD" }), true);
  assert.equal(isBlockNotice({ section: "158 BC" }), true);
  assert.equal(isBlockNotice({ section: "", subject: "Notice u/s 158BC for the block period" }), true);
  assert.equal(isBlockNotice({ section: "143(2)" }), false);
  assert.equal(isBlockNotice({ section: "148" }), false);
  assert.equal(isBlockNotice(null), false);
});

test("a draft started from the notice takes Part A's notice details from it", () => {
  const notice = {
    id: "n1", section: "158BC", din: "ITBA/AST/S/158BC/2025-26/1234567",
    date: "2026-01-05", servedOn: "2026-01-10", responseDueDate: "2026-04-10",
    pan: "ABCPS1234F", proceedingReqId: "P-9",
  };
  const a = { id: "a1", name: "Rajesh M. Shah", pan: "ABCPS1234F", status: "Individual" };
  const d = fromNotice(blankDraft(), notice, a);
  assert.equal(d.noticeDin, notice.din);
  assert.equal(d.noticeDate, "2026-01-05");
  assert.equal(d.serviceDate, "2026-01-10");
  // The AO's own period is taken from the notice rather than derived: it may be
  // sixty days or ninety under the fifth proviso, and the notice says which.
  assert.equal(d.dueDate, "2026-04-10");
  assert.equal(withDueDate(d).dueDate, "2026-04-10");
  assert.equal(d.returnSection, "158BC");
  assert.equal(d.noticeId, "n1");
  assert.equal(d.proceedingReqId, "P-9");
  // Part A also fills from the assessee the notice belongs to.
  assert.equal(d.pan, "ABCPS1234F");
  assert.equal(d.assessee, "Rajesh M. Shah");
});

test("a notice under s.158BD picks the other limb of s.158BC", () => {
  const d = fromNotice(blankDraft(), { section: "158BC r.w.s. 158BD", din: "X" }, null);
  assert.equal(d.returnSection, "158BC/158BD");
  // And a draft with no notice is returned untouched.
  const blank = blankDraft();
  assert.deepEqual(fromNotice(blank, null, null), blank);
});

test("the due date honours the period the notice actually allowed", () => {
  assert.equal(withDueDate({ ...blankDraft(), serviceDate: "2026-01-10" }).dueDate, "2026-03-11");
  // The fifth proviso to s.158BC(1)(a) allows a further thirty days.
  assert.equal(withDueDate({ ...blankDraft(), serviceDate: "2026-01-10", dueDateDays: 90 }).dueDate, "2026-04-10");
});
