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
import { columnsFor, labelFor, appliesTo, partBColumns, determinedFromReturn, PART_C_COLUMNS } from "../src/tools/itrb/partC.js";
import { variantFor, filedSectionFrom, partYearIncome, missingFor, FIELD_NUMBERS } from "../src/tools/itrb/partA.js";
import { PART_B_ROWS, PART_B_LEAVES, computePartB, partBYear, tiesToPartC } from "../src/tools/itrb/partB.js";
import { completeness, summarise, STATUS } from "../src/tools/itrb/completeness.js";
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


/* ---------------------------------------------------------------------------
 * Part C, columns [B] to [H] — the income already on record.
 * ------------------------------------------------------------------------- */

test("the second Part C table has one more column than the first", () => {
  assert.deepEqual(columnsFor(false).map((c) => c.letter), ["B", "C", "D", "E", "F", "G"]);
  assert.deepEqual(columnsFor(true).map((c) => c.letter), ["B", "C", "D", "E", "F", "G", "H"]);
});

test("column [G] means different periods in the two tables", () => {
  const g = PART_C_COLUMNS.find((c) => c.key === "postInitiation");
  // Table 1 runs to the execution of the last authorisation…
  assert.match(labelFor(g, false), /to the date of execution of the last of the authorisations/);
  // …table 2 stops at 31 March, because Y+1 picks the rest up.
  assert.match(labelFor(g, true), /to 31 March of the previous year/);
});

test("each period column belongs to exactly one row", () => {
  const letters = (slot, spans) =>
    columnsFor(spans).filter((c) => appliesTo(c, { slot }, spans)).map((c) => c.letter).join("");

  // [B], [C] and [D] are about the year and apply throughout.
  assert.equal(letters("Y6", false), "BCD");
  assert.equal(letters("Y4", true), "BCD");
  // [E] is the year that had ended with its return not yet due.
  assert.equal(letters("Y1", false), "BCDE");
  // [F] and [G] carve up Y0…
  assert.equal(letters("Y0", false), "BCDFG");
  // …and once Y0 is a complete year it takes [E] as well (Note 3).
  assert.equal(letters("Y0", true), "BCDEFG");
  // [H] is the Y+1 part period, and exists only in the second table.
  assert.equal(letters("Y+1", true), "BCDH");
  assert.equal(letters("Y+1", false), "BCD");
});

test("the columns Part B must tie to depend on which table applies", () => {
  // Table 1: Part B breaks up Y0's part period, which is [F] plus [G].
  assert.deepEqual(partBColumns(false), ["preInitiation", "postInitiation"]);
  // Table 2: Y0 is complete, so the part year is Y+1 — column [H] alone.
  assert.deepEqual(partBColumns(true), ["nextYearPart"]);
});

test("Part C's column totals carry across the block, and name Part B's figure", () => {
  let d = withBlockPeriod(blankDraft(), { searchDate: "2026-03-15", lastAuthDate: "2026-04-05" });
  d.years[5].partC.determined = 2400000;      // Y1
  d.years[6].partC.preInitiation = 700000;    // Y0 [F]
  d.years[6].partC.postInitiation = 150000;   // Y0 [G]
  d.years[7].partC.nextYearPart = 90000;      // Y+1 [H]
  const r = computeItrB(d);
  assert.equal(r.spansYears, true);
  assert.equal(r.byPartCColumn.determined, 2400000);
  assert.equal(r.byPartCColumn.preInitiation, 700000);
  // Table 2 ties Part B to [H] alone — NOT to [F] + [G], which describe Y0 and
  // in this table Y0 is a complete year that Part B does not cover.
  assert.equal(r.partBTotal, 90000);

  // The same figures under table 1 tie [F] + [G] instead.
  let one = withBlockPeriod(blankDraft(), { searchDate: "2025-07-01", lastAuthDate: "2025-07-31" });
  one.years[6].partC.preInitiation = 700000;
  one.years[6].partC.postInitiation = 150000;
  assert.equal(computeItrB(one).partBTotal, 850000);
});

test("a figure keyed into a column that cannot hold it is reported, not totalled", () => {
  let d = withBlockPeriod(blankDraft(), { searchDate: "2025-11-15" });
  d.years[0].partC.preInitiation = 50000;   // [F] against Y6 — nowhere to go
  const r = computeItrB(d);
  assert.deepEqual(r.misplacedPartC, [{ ay: "2020-21", slot: "Y6", letter: "F" }]);
  // It is excluded from the total rather than silently carried into it.
  assert.equal(r.byPartCColumn.preInitiation, 0);
  assert.ok(readiness(d, r).some((g) => /do not belong to those rows/.test(g)));
});

test("Part C's columns never touch the tax — they are context, not arithmetic", () => {
  // The pre-Finance-Act-2025 scheme deducted disclosed income from total income.
  // The substituted s.158BB taxes column [A] alone, and this is the guard.
  const bare = computeItrB(draftWith([{ undisclosed: { deemed: 1000000 } }]));
  const withContext = computeItrB(draftWith([{
    undisclosed: { deemed: 1000000 },
    partC: { determined: 5000000, returned: 4000000, tdsOnly: 250000 },
  }]));
  assert.equal(withContext.totalUndisclosed, bare.totalUndisclosed);
  assert.equal(withContext.tax.amount, bare.tax.amount);
  assert.equal(withContext.netPayable, bare.netPayable);
});

test("column [C] fills from the return the practice already holds", () => {
  const d = withBlockPeriod(blankDraft(), { searchDate: "2025-11-15" });
  const row = d.years.find((y) => y.ay === "2025-26");
  const filled = withDeclared(row, readDeclared(fixture("itr2-salary-hp-capgains-ay2025-26")), "sync");
  assert.equal(filled.partC.returned, 2353890);
  assert.equal(filled.partC.returned, filled.declaredTotal);
  assert.equal(filled.partC.returnedSection, "139(1)");
});

test("column [B] is suggested from the intimation, latest order first", () => {
  const ret = { orders: [
    { orderDate: "2023-02-01", section: "143(1)", commRefNo: "C1",
      reading: { lines: [{ head: "Total Income", asReturned: 500000, asComputed: 560000 }] } },
    { orderDate: "2024-05-01", section: "154", commRefNo: "C2",
      reading: { lines: [{ head: "Total Income", asComputed: 545000 }] } },
  ] };
  const s = determinedFromReturn(ret);
  // A s.154 order supersedes the s.143(1) it rectifies.
  assert.equal(s.amount, 545000);
  assert.equal(s.commRefNo, "C2");
  // Reported under s.143(1) all the same: column [B] has no entry for s.154,
  // and a rectified figure is still the income determined under s.143(1).
  assert.equal(s.section, "143(1)");
});

test("column [B] takes CPC's figure, and never the gross total income", () => {
  // The two sit adjacent in every intimation and differ by the Chapter VI-A
  // deductions, so picking the wrong one overstates [B] by exactly that much.
  const ret = { orders: [{ orderDate: "2024-01-01", reading: { lines: [
    { head: "Gross Total Income", asComputed: 3000000 },
    { head: "Tax on Total Income", asComputed: 780000 },
    { head: "Total Income", asReturned: 2200000, asComputed: 2400000 },
  ] } }] };
  const s = determinedFromReturn(ret);
  assert.equal(s.amount, 2400000);          // CPC's column, not the taxpayer's
  assert.equal(s.head, "Total Income");
});

test("no intimation, no reading, and no figure all suggest nothing", () => {
  assert.equal(determinedFromReturn(null), null);
  assert.equal(determinedFromReturn({}), null);
  assert.equal(determinedFromReturn({ orders: [{ orderDate: "2024-01-01" }] }), null);
  // A read that found the row but no computed figure is not a suggestion.
  assert.equal(determinedFromReturn({ orders: [{ reading: { lines: [{ head: "Total Income" }] } }] }), null);
});


/* ---------------------------------------------------------------------------
 * Part A — the per-year questions, A25 to A34.
 * ------------------------------------------------------------------------- */

test("Part A asks three different sets of questions, by row", () => {
  const v = (slot, part, spans) => variantFor({ slot, part }, spans);
  // Y6 to Y2 get the short set — four questions about the return and nothing more.
  assert.equal(v("Y6", false, false), "brief");
  assert.equal(v("Y2", false, false), "brief");
  // Y1 always gets the full set.
  assert.equal(v("Y1", false, false), "full");
  assert.equal(v("Y1", false, true), "full");
  // Y0 depends on whether it is a part period or a complete year.
  assert.equal(v("Y0", true, false), "partYear");     // A32
  assert.equal(v("Y0", false, true), "full");         // A33
  // A part period is asked almost nothing — there is no return to describe.
  assert.equal(v("Y+1", true, true), "partYear");     // A34
});

test("each variant carries the form's own field numbers", () => {
  assert.equal(FIELD_NUMBERS.brief.pending, "(iv)");
  assert.equal(FIELD_NUMBERS.full.declaredTotal, "(v)");
  assert.equal(FIELD_NUMBERS.full.determined, "(vi)");
  assert.equal(FIELD_NUMBERS.full.dueDateExpired, "(ix)");
  assert.equal(FIELD_NUMBERS.partYear.partYearIncome, "(i)");
});

test("the section a return was filed under is read only where the code is evidenced", () => {
  // 12 is carried by the fixture named for being belated, which is what makes
  // the mapping evidence rather than recollection.
  assert.equal(filedSectionFrom(fixture("itr1-salary-belated-nil-ay2022-23")), "139(4)");
  assert.equal(filedSectionFrom(fixture("itr2-salary-hp-capgains-ay2025-26")), "139(1)");
  // ITR-5 nests the code a level deeper, under IncomeTaxSec.
  assert.equal(filedSectionFrom(fixture("itr5-firm-business-loss-ay2025-26")), "139(1)");
  // An unrecognised code is left for the practitioner rather than guessed at.
  assert.equal(filedSectionFrom({ ITR: { ITR2: { FilingStatus: { ReturnFileSec: 99 } } } }), "");
  assert.equal(filedSectionFrom({}), "");
  assert.equal(filedSectionFrom(null), "");
});

test("reading a return fills the section, and never overwrites a chosen one", () => {
  const d = withBlockPeriod(blankDraft(), { searchDate: "2025-11-15" });
  const filled = withDeclared(d.years[5], readDeclared(fixture("itr2-salary-hp-capgains-ay2025-26")), "sync");
  assert.equal(filled.partA.filedSection, "139(1)");
  assert.equal(filled.declaredForm, "ITR-2");

  const chosen = { ...d.years[5], partA: { ...d.years[5].partA, filedSection: "148" } };
  const again = withDeclared(chosen, readDeclared(fixture("itr2-salary-hp-capgains-ay2025-26")), "sync");
  assert.equal(again.partA.filedSection, "148");
});

test("A32(i) / A34(i) is derived from Part C, not asked for twice", () => {
  // The form sends the break-up of this income to Part B and states the same
  // figure in Part C's part-period columns. One number, one place.
  const t1 = { part: true, partC: { preInitiation: 700000, postInitiation: 150000 } };
  assert.equal(partYearIncome(t1, { spansYears: false }), 850000);
  const t2 = { part: true, partC: { nextYearPart: 90000 } };
  assert.equal(partYearIncome(t2, { spansYears: true }), 90000);
  // A complete year has no part-period income at all.
  assert.equal(partYearIncome({ part: false, partC: { preInitiation: 700000 } }, { spansYears: false }), 0);
  assert.equal(partYearIncome(null, { spansYears: false }), 0);
});

test("Part A reports what each variant is still missing", () => {
  // A part period is asked almost nothing, so it is never short of anything.
  assert.deepEqual(missingFor({ slot: "Y0", part: true, partA: {} }, false), []);

  const brief = missingFor({ slot: "Y6", partA: {} }, false);
  assert.ok(brief.includes("section filed under"));
  // The one question nothing else on the row answers.
  assert.ok(brief.includes("whether an assessment was pending at the date of initiation"));

  // A full row where no return was filed asks a different pair of questions.
  const notFiled = missingFor({ slot: "Y1", returnFiled: false, partA: {} }, false);
  assert.deepEqual(notFiled, ["whether the s.139(1) due date had expired"]);
  const openDueDate = missingFor({ slot: "Y1", returnFiled: false, partA: { dueDateExpired: "No" } }, false);
  assert.ok(openDueDate.includes("the ITR form the income will be furnished in"));
  // Once the due date has expired the form stops asking.
  assert.deepEqual(missingFor({ slot: "Y1", returnFiled: false, partA: { dueDateExpired: "Yes" } }, false), []);

  // A complete row is complete.
  const done = missingFor({
    slot: "Y1", returnFiled: true, filedOn: "2025-07-28", ackNum: "123", declaredForm: "ITR-2",
    declaredTotal: 2353890, partA: { filedSection: "139(1)" },
  }, false);
  assert.deepEqual(done, []);
});


/* ---------------------------------------------------------------------------
 * Part B — the part period's income, head by head.
 * ------------------------------------------------------------------------- */

test("Part B belongs to the part period, and to nothing else", () => {
  // Same-year search: Y0 is the part period.
  const t1 = [{ slot: "Y1" }, { slot: "Y0", part: true }];
  assert.equal(partBYear(t1, false).slot, "Y0");
  // Search running into a later previous year: Y0 is complete, Y+1 is the part.
  const t2 = [{ slot: "Y0", part: false }, { slot: "Y+1", part: true }];
  assert.equal(partBYear(t2, true).slot, "Y+1");
  assert.equal(partBYear([], false), null);
  assert.equal(partBYear(null, false), null);
});

test("the subtotals are computed, following the form's own formulae", () => {
  const { rows, total } = computePartB({
    salaries: 300000, bpNonSpec: 450000, bpSpecialRate: 25000,
    stcg20: 120000, stcg30: 30000, ltcg125: 200000, cg115BBH: 60000,
    osNormal: 40000, osSpecial: 10000,
  });
  assert.equal(rows.bpTotal, 475000);        // 3v = 3i + 3ii + 3iii + 3iv
  assert.equal(rows.stcgTotal, 150000);      // 4av
  assert.equal(rows.ltcgTotal, 200000);      // 4biv
  assert.equal(rows.cgSum, 350000);          // 4c = 4av + 4biv
  assert.equal(rows.cgTotal, 410000);        // 4e = 4c + 4d
  assert.equal(rows.osTotal, 50000);         // 5d
  // 6 = 1 + 2 + 3v + 4e + 5d
  assert.equal(total, 300000 + 0 + 475000 + 410000 + 50000);
});

test("\"enter nil if loss\" is applied, and every row it bites on is named", () => {
  // Not a rounding convention: it is what stops a head that lost money in the
  // part period sheltering income in another head of the same period.
  const { rows, total, floored } = computePartB({
    salaries: 300000, houseProperty: -80000, bpNonSpec: 450000, bpSpeculative: -50000,
    osNormal: 40000, osRaceHorses: -15000,
  });
  assert.equal(rows.houseProperty, 0);
  assert.equal(rows.bpSpeculative, 0);
  assert.equal(rows.osRaceHorses, 0);
  // The losses do not reduce the heads they sit beside.
  assert.equal(rows.bpTotal, 450000);
  assert.equal(rows.osTotal, 40000);
  assert.equal(total, 790000);
  assert.deepEqual(floored.map((f) => f.no), ["2", "3ii", "5c"]);
  // And the figure that was disregarded is reported, so it can be reconciled.
  assert.equal(floored[0].was, -80000);
});

test("a subtotal that nets to a loss is floored too, not just the leaves", () => {
  // 4av, 4biv and 4c all carry the instruction in the form.
  const { rows } = computePartB({ stcg20: 100000, stcg30: -250000, ltcg125: 40000 });
  assert.equal(rows.stcgTotal, 0);           // 4av netted to a loss
  assert.equal(rows.ltcgTotal, 40000);
  assert.equal(rows.cgSum, 40000);           // 4c sees the floored 4av, not the loss
});

test("Part B's shape is the form's shape", () => {
  assert.equal(PART_B_ROWS.filter((r) => r.heading).length, 5);
  assert.equal(PART_B_ROWS.filter((r) => r.of).length, 7);
  assert.equal(PART_B_LEAVES.length, 17);
  // Row 6 sums the five heads, not the seventeen leaves.
  const six = PART_B_ROWS.find((r) => r.no === "6");
  assert.deepEqual(six.of, ["salaries", "houseProperty", "bpTotal", "cgTotal", "osTotal"]);
  // The nine rows the form marks "enter nil if loss".
  assert.deepEqual(PART_B_ROWS.filter((r) => r.nilIfLoss).map((r) => r.no),
    ["2", "3i", "3ii", "3iii", "4av", "4biv", "4c", "5a", "5c"]);
});

test("Part B and Part C must agree about the same period", () => {
  assert.equal(tiesToPartC(850000, 850000).ties, true);
  assert.equal(tiesToPartC(850000, 900000).ties, false);
  // Untouched is not a discrepancy — plenty of drafts never reach Part B.
  assert.deepEqual(tiesToPartC(0, 0), { entered: false, ties: true, partBTotal: 0, partCTotal: 0 });
});

test("the tie runs end to end, and readiness reports it", () => {
  let d = withBlockPeriod(blankDraft(), { searchDate: "2026-03-15", lastAuthDate: "2026-04-05" });
  d.years[7].partB.salaries = 300000;
  d.years[7].partB.bpNonSpec = 450000;
  d.years[7].partC.nextYearPart = 670000;    // deliberately short of Part B's 750000

  let r = computeItrB(d);
  assert.equal(r.partBRow.slot, "Y+1");
  assert.equal(r.partB.total, 750000);
  assert.equal(r.partBTie.ties, false);
  assert.ok(readiness(d, r).some((g) => /Part B's row 6/.test(g)));

  d.years[7].partC.nextYearPart = 750000;
  r = computeItrB(d);
  assert.equal(r.partBTie.ties, true);
  assert.equal(readiness(d, r).some((g) => /Part B's row 6/.test(g)), false);
});

test("Part B never touches the tax — the part period's income is disclosed income", () => {
  const base = computeItrB(draftWith([{ undisclosed: { deemed: 1000000 } }]));
  let d = withBlockPeriod(blankDraft(), { searchDate: "2025-11-15" });
  d.years[2].undisclosed.deemed = 1000000;
  d.years[6].partB.salaries = 5000000;
  const r = computeItrB(d);
  assert.equal(r.totalUndisclosed, base.totalUndisclosed);
  assert.equal(r.tax.amount, base.tax.amount);
});


/* ---------------------------------------------------------------------------
 * Where the form stands, part by part.
 * ------------------------------------------------------------------------- */

const partsOf = (d) => {
  const map = {};
  for (const p of completeness(d, computeItrB(d))) map[p.id] = p;
  return map;
};

test("an untouched draft is empty everywhere, and Part B does not apply yet", () => {
  const p = partsOf(blankDraft());
  assert.equal(p.A.status, STATUS.EMPTY);
  assert.equal(p.C.status, STATUS.EMPTY);
  // No block period means no part period means nothing for Part B to describe.
  assert.equal(p.B.status, STATUS.NA);
  const { done, total, complete } = summarise(completeness(blankDraft(), computeItrB(blankDraft())));
  assert.equal(done, 0);
  assert.equal(complete, false);
  // The N/A part is not counted against the draft.
  assert.equal(total, 7);
});

test("each part reports on itself, not on the draft as a whole", () => {
  let d = withBlockPeriod(blankDraft(), { searchDate: "2025-11-15" });
  d.pan = "ABCPS1234F"; d.assessee = "R Shah"; d.noticeDin = "ITBA/1";
  d.serviceDate = "2026-01-10"; d.dueDate = "2026-03-11";
  d.years[2].undisclosed.deemed = 1500000;
  d.years[2].items.money = 1500000;

  const p = partsOf(d);
  assert.equal(p.A.status, STATUS.DONE);
  // Column [A] is in but the context columns are not, which is exactly the
  // hole this panel exists to show: the sheet looks finished without them.
  assert.equal(p.C.status, STATUS.PARTIAL);
  assert.match(p.C.detail, /columns \[B\] to \[H\] are still blank/);
  assert.equal(p.D.status, STATUS.DONE);      // D-I in, D-II ties
  assert.equal(p.E.status, STATUS.DONE);      // computed off Part C
  // The per-year half of Part A is a different question from the general half.
  assert.equal(p.A25.status, STATUS.PARTIAL);
  assert.match(p.A25.detail, /Y6 wants the/);
  // Part B now applies, and has not been started.
  assert.equal(p.B.status, STATUS.EMPTY);
  assert.equal(p.V.status, STATUS.EMPTY);
});

test("a part that does not tie reads as partly done, and says by how much", () => {
  let d = withBlockPeriod(blankDraft(), { searchDate: "2025-11-15" });
  d.years[2].undisclosed.deemed = 1500000;
  d.years[2].items.money = 1200000;           // Part D-II short of Part D-I
  const p = partsOf(d);
  assert.equal(p.D.status, STATUS.PARTIAL);
  assert.match(p.D.detail, /12,00,000 against Part D-I's 15,00,000/);
});

test("nothing claimed under Parts F, G and H is a legitimate answer", () => {
  let d = withBlockPeriod(blankDraft(), { searchDate: "2025-11-15" });
  d.years[2].undisclosed.deemed = 1500000;
  assert.match(partsOf(d).FGH.detail, /the form does not require a figure/);
  d.years[2].credits.tds = 45000;
  assert.equal(partsOf(d).FGH.status, STATUS.DONE);
});
