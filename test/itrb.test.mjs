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

import { blockPeriod, dueDateFor, monthsOfDelay, fyStart, ayOfPy, pyOfAy, statedPeriodAgrees } from "../src/tools/itrb/blockPeriod.js";
import { DII_ITEMS, furnishingMode, VERIFICATION_TEXT } from "../src/tools/itrb/form.js";
import {
  columnsFor, labelFor, appliesTo, partBColumns, determinedFromReturn, PART_C_COLUMNS,
  intimationToRead, withOrderReading,
} from "../src/tools/itrb/partC.js";
import { variantFor, filedSectionFrom, partYearIncome, missingFor, FIELD_NUMBERS } from "../src/tools/itrb/partA.js";
import { PART_B_ROWS, PART_B_LEAVES, computePartB, partBYear, tiesToPartC } from "../src/tools/itrb/partB.js";
import { completeness, summarise, STATUS } from "../src/tools/itrb/completeness.js";
import {
  findBlockProceedings, primaryNotice, fieldsFromNotices, describeScan, isBlockSection,
  readingOrder, searchDocsInReplies, isSearchDocName,
} from "../src/tools/itrb/findProceeding.js";
import { createRequire } from "node:module";
const { normaliseSearchDates, sniffKind, readArchive, collectDocuments, isSearchDocName: isSearchDocNameServer } =
  createRequire(import.meta.url)("../functions/blockSearchDates.js");
import { readDeclared, declaredTotal, HEADS } from "../src/tools/itrb/declared.js";
import { checkUpload, looksLikePdf, uploadPath, shortName, MAX_UPLOADS, MAX_UPLOAD_BYTES } from "../src/tools/itrb/uploads.js";
import { documentKind, documentExt, sniffExtension, retypeFilename } from "../src/downloadNames.js";
import { computeItrB, round288B, UNDISCLOSED_HEADS } from "../src/tools/itrb/compute.js";
import {
  blankDraft, withBlockPeriod, fromAssessee, fromNotice, isBlockNotice,
  withDeclared, withFiledParticulars, withDetermined, isoDate, withDueDate, readiness, blankYear,
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


/* ---------------------------------------------------------------------------
 * Finding the block proceeding the practice already holds.
 * ------------------------------------------------------------------------- */

const CASE = {
  matters: [
    { id: "m1", pan: "ABCPS1234F", section: "158BC", type: "Block assessment", proceedingReqId: "P9", bench: "Central Circle 1" },
    { id: "m2", pan: "ABCPS1234F", section: "143(2)", type: "Scrutiny", proceedingReqId: "P1" },
    { id: "m3", pan: "OTHER1234F", section: "158BC", type: "Block assessment", proceedingReqId: "P7" },
  ],
  notices: [
    { id: "n1", pan: "ABCPS1234F", section: "158BC", din: "ITBA/158BC/1", date: "2026-01-05",
      servedOn: "2026-01-10", responseDueDate: "2026-03-11", proceedingReqId: "P9",
      storagePath: "notice.pdf", attachments: [{ storagePath: "panchnama.pdf", filename: "Panchnama.pdf" }] },
    { id: "n2", pan: "ABCPS1234F", section: "158BC", din: "ITBA/158BC/2", date: "2026-02-01",
      servedOn: "2026-01-10", responseDueDate: "2026-03-11", proceedingReqId: "P9", storagePath: "reminder.pdf" },
    { id: "n3", pan: "ABCPS1234F", section: "143(2)", date: "2025-06-01" },
  ],
};

test("the section matcher takes the spacing the portal actually uses", () => {
  assert.equal(isBlockSection("158BC"), true);
  assert.equal(isBlockSection("158 B C"), true);
  assert.equal(isBlockSection("158BC r.w.s. 158BD"), true);
  assert.equal(isBlockSection("158BD"), true);
  assert.equal(isBlockSection("143(2)"), false);
  assert.equal(isBlockSection("153A"), false);   // a different regime entirely
  assert.equal(isBlockSection(""), false);
});

test("the scan finds the block proceeding, and only this assessee's", () => {
  const found = findBlockProceedings(CASE, "abcps1234f");   // case-insensitive
  assert.deepEqual(found.matters.map((m) => m.id), ["m1"]);      // not the scrutiny, not the other PAN
  assert.deepEqual(found.notices.map((n) => n.id), ["n1", "n2"]);
  assert.deepEqual(found.proceedingIds, ["P9"]);
  // Every file that will go to the reader: the notice PDFs plus the panchnama.
  assert.equal(found.attachments.length, 3);
  assert.equal(found.attachments.filter((a) => a.primary).length, 2);
  assert.match(describeScan(found), /1 proceeding, 2 notices, 3 documents/);
});

test("a notice keyed in by hand is found by its section, with no proceeding to hang off", () => {
  // The case where nothing else in the app has the details either, so missing
  // it would be missing the only record there is.
  const found = findBlockProceedings({
    matters: [], notices: [{ id: "x", pan: "ABCPS1234F", section: "158BC", din: "D", date: "2026-01-05" }],
  }, "ABCPS1234F");
  assert.deepEqual(found.notices.map((n) => n.id), ["x"]);
  assert.deepEqual(found.matters, []);
});

test("an empty practice scans to nothing rather than throwing", () => {
  const found = findBlockProceedings({}, "ABCPS1234F");
  assert.deepEqual(found.notices, []);
  assert.match(describeScan(found), /Nothing on file/);
  assert.deepEqual(fieldsFromNotices([]), { fields: {}, conflicts: [], source: null });
});

test("the notice that starts the return is the earliest under s.158BC", () => {
  // An assessee gets several in a block proceeding; the first fixes the sixty
  // days, and a reminder carries its own DIN which is not the one Part A wants.
  const found = findBlockProceedings(CASE, "ABCPS1234F");
  assert.equal(primaryNotice(found.notices).id, "n1");
  const { fields, source } = fieldsFromNotices(found.notices);
  assert.equal(source.id, "n1");
  assert.equal(fields.noticeDin, "ITBA/158BC/1");
  assert.equal(fields.noticeDate, "2026-01-05");
  assert.equal(fields.serviceDate, "2026-01-10");
  // The AO's own period, not one derived from service.
  assert.equal(fields.dueDate, "2026-03-11");
  assert.equal(fields.returnSection, "158BC");
});

test("a s.158BD notice picks the other limb", () => {
  const { fields } = fieldsFromNotices([{ section: "158BC r.w.s. 158BD", din: "D", date: "2026-01-05" }]);
  assert.equal(fields.returnSection, "158BC/158BD");
});

test("notices that disagree about a date fill nothing, and say so", () => {
  // The sixty-day clock runs off the date of service. Quietly picking one of
  // two is how that clock ends up wrong with nobody looking.
  const { fields, conflicts } = fieldsFromNotices([
    { section: "158BC", din: "D1", date: "2026-01-05", servedOn: "2026-01-10", responseDueDate: "2026-03-11" },
    { section: "158BC", din: "D2", date: "2026-02-01", servedOn: "2026-01-15", responseDueDate: "2026-03-11" },
  ]);
  assert.equal("serviceDate" in fields, false);
  assert.deepEqual(conflicts.map((c) => c.field), ["Date of service"]);
  assert.deepEqual(conflicts[0].seen, ["2026-01-10", "2026-01-15"]);
  // The one they agree on still goes in.
  assert.equal(fields.dueDate, "2026-03-11");
});

/* ---------------------------------------------------------------------------
 * Shaping what the reader returned. The network call cannot be tested here;
 * this is the half where a bad read becomes a bad block period.
 * ------------------------------------------------------------------------- */

const normDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "");
const shape = (raw) => normaliseSearchDates(raw, normDate, "T");

test("a clean read comes through with its quotes and sorted panchnama dates", () => {
  const out = shape({
    initiationDate: "2025-11-15", lastAuthorisationDate: "2025-11-20",
    panchnamaDates: ["2025-11-20", "2025-11-15", "2025-11-15"],
    searchSection: "132",
    quotes: { initiationDate: "a search u/s 132 was initiated on 15/11/2025" },
  });
  assert.equal(out.initiationDate, "2025-11-15");
  assert.equal(out.lastAuthorisationDate, "2025-11-20");
  assert.deepEqual(out.panchnamaDates, ["2025-11-15", "2025-11-20"]);   // deduped, oldest first
  assert.equal(out.searchSection, "132");
  assert.match(out.quotes.initiationDate, /initiated on 15\/11\/2025/);
});

test("a conclusion before the initiation is dropped, not kept", () => {
  // The pair is untrustworthy, but the initiation date is what the six
  // preceding years hang off and is the better read of the two. Dropping the
  // conclusion falls back to the same-day case — the shorter block period,
  // never one that invents a year of assessment.
  const out = shape({ initiationDate: "2025-11-15", lastAuthorisationDate: "2025-01-01" });
  assert.equal(out.initiationDate, "2025-11-15");
  assert.equal(out.lastAuthorisationDate, "");
});

test("a date outside the block regime is a misread and is discarded", () => {
  // Chapter XIV-B runs from 01-09-2024, so a 1998 "search date" is an
  // assessment year or a date of incorporation read off the same page.
  assert.equal(shape({ initiationDate: "1998-04-01" }).initiationDate, "");
  assert.equal(shape({ initiationDate: "2200-01-01" }).initiationDate, "");
  assert.deepEqual(shape({ panchnamaDates: ["2019-01-01", "2025-11-15"] }).panchnamaDates, ["2025-11-15"]);
});

test("junk in returns an empty shape rather than throwing", () => {
  for (const junk of [null, undefined, {}, "nonsense", 42]) {
    const out = shape(junk);
    assert.equal(out.initiationDate, "");
    assert.equal(out.lastAuthorisationDate, "");
    assert.deepEqual(out.panchnamaDates, []);
    assert.equal(out.searchSection, "");
  }
});

test("only the two real search sections survive, and quotes are bounded", () => {
  assert.equal(shape({ searchSection: "132" }).searchSection, "132");
  assert.equal(shape({ searchSection: "132A" }).searchSection, "132A");
  assert.equal(shape({ searchSection: "133A" }).searchSection, "");    // a survey is not a search
  assert.equal(shape({ quotes: { initiationDate: "x".repeat(500) } }).quotes.initiationDate.length, 200);
});

test("the read feeds the block period, both shapes", () => {
  // What the whole feature is for: two dates out of a document, seven or eight
  // rows out of the two dates.
  const same = shape({ initiationDate: "2025-07-01", lastAuthorisationDate: "2025-07-31" });
  assert.equal(blockPeriod(same.initiationDate, same.lastAuthorisationDate).years.length, 7);
  const spans = shape({ initiationDate: "2026-03-15", lastAuthorisationDate: "2026-04-05" });
  const bp = blockPeriod(spans.initiationDate, spans.lastAuthorisationDate);
  assert.equal(bp.years.length, 8);
  assert.equal(bp.spansYears, true);
});

/* ---------------------------------------------------------------------------
 * The bundle: several notices, and the ZIPs the department sends them in.
 *
 * The first live run of the reader found nothing on a proceeding that had the
 * dates in it, because it read one notice and could not open an archive. These
 * are the two halves of that fix — what a file actually is, and what came out
 * of the archive — plus the manifest, which exists so that "nothing was found"
 * can be told apart from "nothing was opened".
 *
 * The zip WRITER below is deliberately hand-rolled rather than taken from a
 * library: writing the bytes independently of the code that reads them is the
 * only way this test proves the offsets are right rather than proving that two
 * copies of one mistake agree.
 * ------------------------------------------------------------------------- */
import zlib from "node:zlib";

const crc32 = (buf) => (typeof zlib.crc32 === "function" ? zlib.crc32(buf) : 0) >>> 0;

/** entries: [{ name, data, method?: 0|8, encrypted?: boolean }] */
function makeZip(entries, { comment = "" } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const raw = Buffer.from(e.data ?? "");
    const method = e.method ?? 8;
    const body = method === 0 ? raw : zlib.deflateRawSync(raw);
    const flags = e.encrypted ? 0x1 : 0;

    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(flags, 6);
    loc.writeUInt16LE(method, 8);
    loc.writeUInt32LE(crc32(raw), 14);
    loc.writeUInt32LE(body.length, 18);
    loc.writeUInt32LE(e.declaredSize ?? raw.length, 22);
    loc.writeUInt16LE(name.length, 26);
    locals.push(loc, name, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(flags, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc32(raw), 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(e.declaredSize ?? raw.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    centrals.push(cen, name);

    offset += 30 + name.length + body.length;
  }

  const localBytes = Buffer.concat(locals);
  const centralBytes = Buffer.concat(centrals);
  const tail = Buffer.from(comment, "utf8");
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localBytes.length, 16);
  eocd.writeUInt16LE(tail.length, 20);
  return Buffer.concat([localBytes, centralBytes, eocd, tail]);
}

const pdf = (text = "notice") => Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from(text)]);
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]);

test("a file is what its bytes say, not what its name says", () => {
  assert.equal(sniffKind(pdf()).kind, "pdf");
  assert.equal(sniffKind(makeZip([{ name: "a.pdf", data: pdf() }])).kind, "zip");
  assert.equal(sniffKind(jpeg()).kind, "jpeg");
  assert.equal(sniffKind(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])).kind, "rar");
  assert.equal(sniffKind(Buffer.alloc(0)).kind, "empty");
  assert.equal(sniffKind(Buffer.from("plain text here")).kind, "other");
  // The pdf and the jpeg are the ones that must carry a mime type — those are
  // the only two the model is ever handed.
  assert.equal(sniffKind(pdf()).mimeType, "application/pdf");
  assert.equal(sniffKind(Buffer.from("plain text here")).mimeType, "");
});

test("an archive opens, deflated or stored, and its cruft is left behind", () => {
  const zip = makeZip([
    { name: "folder/", data: "" },
    { name: "__MACOSX/._panchnama.pdf", data: "junk" },
    { name: "folder/panchnama.pdf", data: pdf("panchnama 20-11-2025"), method: 8 },
    { name: "folder/notice.pdf", data: pdf("notice u/s 158BC"), method: 0 },
  ]);
  const out = readArchive(zip);
  assert.equal(out.ok, true);
  assert.deepEqual(out.entries.map((e) => e.name), ["folder/panchnama.pdf", "folder/notice.pdf"]);
  assert.match(out.entries[0].data.toString(), /panchnama 20-11-2025/);
  assert.match(out.entries[1].data.toString(), /158BC/);
});

test("a password-protected entry is named as such, not reported as a bad read", () => {
  // Somebody has to be asked for the password. Calling this "unreadable" sends
  // the practitioner looking for a problem with the file.
  const zip = makeZip([{ name: "locked.pdf", data: pdf(), encrypted: true }]);
  const [entry] = readArchive(zip).entries;
  assert.equal(entry.data, undefined);
  assert.equal(entry.error, "password-protected");
});

test("an entry that claims to be enormous is refused on the claim alone", () => {
  // The declared size is a claim in a stranger's file. It is checked BEFORE
  // anything is decompressed, which is the whole point of a zip-bomb guard.
  const zip = makeZip([{ name: "bomb.pdf", data: pdf(), declaredSize: 500 * 1024 * 1024 }]);
  const [entry] = readArchive(zip).entries;
  assert.equal(entry.data, undefined);
  assert.match(entry.error, /too large/);
});

test("something that is not a zip is refused rather than misparsed", () => {
  assert.equal(readArchive(pdf()).ok, false);
  assert.match(readArchive(pdf()).reason, /not a readable zip/);
});

test("the bundle is expanded and every file is accounted for in the manifest", () => {
  const zip = makeZip([
    { name: "panchnama.pdf", data: pdf("panchnama") },
    { name: "annexure.xlsx", data: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]) },
  ]);
  const { files, manifest, read, skipped } = collectDocuments([
    { notice: "s.158BC dated 2026-06-30", name: "Notice.pdf", buf: pdf("158BC notice") },
    { notice: "s.158BC dated 2026-06-30", name: "search-papers.zip", buf: zip },
    { notice: "s.158BC dated 2026-06-30", name: "missing.pdf", error: "not in storage" },
  ]);

  assert.equal(read, 2);                       // the notice and the panchnama
  assert.equal(files.length, 2);
  assert.ok(files.every((f) => f.mimeType === "application/pdf" && f.data.length > 0));

  // The manifest is the bundle as it stands on file, in the order it was found:
  // the archive itself is listed too, so the practitioner can see it was opened.
  assert.deepEqual(manifest.map((m) => [m.name, m.status]), [
    ["Notice.pdf", "read"],
    ["search-papers.zip", "archive"],
    ["panchnama.pdf", "read"],
    ["annexure.xlsx", "skipped"],
    ["missing.pdf", "unreadable"],
  ]);
  assert.equal(manifest[2].from, "search-papers.zip");    // shown under the archive it came out of
  assert.match(manifest[1].detail, /2 files inside/);
  assert.equal(skipped, 2);                    // the spreadsheet and the file that is not there
});

test("when the bundle is bigger than one read, the panchnama is what goes", () => {
  // The notice states when the search began; only the panchnama states when it
  // ended. On a budget that fits one file, the one that must be sent is the one
  // that answers the question nothing else can.
  const big = (n, text) => ({ notice: "n", name: n, buf: Buffer.concat([pdf(text), Buffer.alloc(3000)]) });
  const { manifest } = collectDocuments(
    [big("covering-letter.pdf", "a"), big("Panchnama-final.pdf", "b"), big("reminder.pdf", "c")],
    { maxTotalBytes: 3500 }
  );
  const byName = Object.fromEntries(manifest.map((m) => [m.name, m.status]));
  assert.equal(byName["Panchnama-final.pdf"], "read");
  assert.equal(byName["covering-letter.pdf"], "too-large");
  assert.equal(byName["reminder.pdf"], "too-large");
  assert.match(manifest.find((m) => m.name === "reminder.pdf").detail, /bigger than one read/);
});

test("a zip inside a zip is opened once, and no further", () => {
  const inner = makeZip([{ name: "panchnama.pdf", data: pdf("inner") }]);
  const deeper = makeZip([{ name: "inner.zip", data: inner }]);
  const outer = makeZip([{ name: "deeper.zip", data: deeper }]);

  const one = collectDocuments([{ notice: "n", name: "bundle.zip", buf: makeZip([{ name: "inner.zip", data: inner }]) }]);
  assert.equal(one.read, 1);

  const two = collectDocuments([{ notice: "n", name: "bundle.zip", buf: outer }]);
  assert.equal(two.read, 0);
  const stopped = two.manifest.find((m) => m.status === "skipped");
  assert.match(stopped.detail, /archive inside an archive/);
});

test("files from several notices are read together, each labelled with its own", () => {
  // The department sends the notice, then the panchnama, then a reminder, and
  // they arrive as separate entries. Reading only the first is what found
  // nothing the first time this ran.
  const { files, manifest } = collectDocuments([
    { notice: "s.158BC dated 2026-06-30", name: "Notice.pdf", buf: pdf("a") },
    { notice: "s.158BD dated 2026-07-14", name: "Panchnama.pdf", buf: pdf("b") },
    { notice: "s.158BD dated 2026-07-14", name: "Reminder.pdf", buf: pdf("c") },
  ]);
  assert.equal(files.length, 3);
  assert.deepEqual([...new Set(manifest.map((m) => m.notice))], ["s.158BC dated 2026-06-30", "s.158BD dated 2026-07-14"]);
});

test("nothing readable still comes back as a manifest, not as an exception", () => {
  // The failure this replaces said "the documents don't state the dates" when
  // the truth was that no document had been opened at all.
  const { files, manifest, read } = collectDocuments([
    { notice: "n", name: "scan.tif", buf: Buffer.from([0x49, 0x49, 0x2a, 0x00, 1, 2, 3, 4]) },
    { notice: "n", name: "papers.rar", buf: Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0, 0]) },
  ]);
  assert.equal(read, 0);
  assert.equal(files.length, 0);
  assert.equal(manifest.length, 2);
  assert.ok(manifest.every((m) => m.status === "skipped" && m.detail));
  assert.match(manifest[1].detail, /RAR/);
});

/* ---------------------------------------------------------------------------
 * The proceeding as the department actually files it.
 *
 * A real block proceeding came back holding one notice out of four. The portal
 * had typed the MATTER "Scrutiny" and hung a s.158BC notice in it alongside
 * three u/s 142(1) calling for the material — and it was one of THOSE that
 * carried the ZIP, and a reply to one of them that carried the panchnama.
 * ------------------------------------------------------------------------- */

const trustPan = "AACTR2704C";
const proceedingData = {
  matters: [
    // Typed "Scrutiny" by the portal, not "Block assessment". This is the shape
    // that used to make the whole proceeding invisible.
    { id: "m1", pan: trustPan, type: "Scrutiny", section: "", proceedingReqId: "PR-1" },
    { id: "m2", pan: trustPan, type: "Scrutiny", section: "", proceedingReqId: "PR-OTHER" },
  ],
  notices: [
    { id: "n158", pan: trustPan, section: "158BC", date: "2026-06-30", din: "100115783112",
      proceedingReqId: "PR-1", storagePath: "p/notice-158bc.pdf", fileName: "Notice us 158BC.pdf" },
    { id: "n142a", pan: trustPan, section: "142(1)", date: "2026-07-31", din: "100117490908",
      proceedingReqId: "PR-1", storagePath: "p/notice-142-a.pdf", fileName: "Notice us 142(1).pdf",
      attachments: [{ storagePath: "p/attachment.pdf", filename: "ATTACHMENT.pdf", contentType: "application/x-zip-compressed" }],
      responses: [{ submittedOn: "2026-08-19", attachments: [
        { storagePath: "p/reply-1.pdf", label: "The Copy of Handwritten Hindi Statement for ref — Comprihansive Panchanama 23.08.25.pdf" },
        { storagePath: "p/reply-2.pdf", label: "Documents set 1" },
        { storagePath: "p/reply-3.pdf", label: "Document set 2" },
      ] }] },
    { id: "n142b", pan: trustPan, section: "142(1)", date: "2026-07-23", din: "100116970322",
      proceedingReqId: "PR-1", storagePath: "p/notice-142-b.pdf", fileName: "Notice us 142(1).pdf" },
    // Same PAN, different proceeding. Nothing to do with the search.
    { id: "nother", pan: trustPan, section: "142(1)", date: "2026-02-01",
      proceedingReqId: "PR-OTHER", storagePath: "p/unrelated.pdf" },
    // Another assessee's block notice. Must never be swept in.
    { id: "nelse", pan: "AAAAA1111A", section: "158BC", date: "2026-06-30", proceedingReqId: "PR-1" },
  ],
};

test("a s.158BC notice makes its whole proceeding a block proceeding", () => {
  // The matter says "Scrutiny". The notice says s.158BC. The notice is the fact.
  const found = findBlockProceedings(proceedingData, trustPan);
  assert.deepEqual(found.notices.map((n) => n.id), ["n158", "n142a", "n142b"]);
  assert.deepEqual(found.matters.map((m) => m.id), ["m1"]);
  assert.deepEqual(found.proceedingIds, ["PR-1"]);
});

test("the proceeding stops at its own boundary, and at this assessee", () => {
  const found = findBlockProceedings(proceedingData, trustPan);
  assert.equal(found.notices.some((n) => n.id === "nother"), false);   // another proceeding
  assert.equal(found.notices.some((n) => n.id === "nelse"), false);    // another PAN
});

test("the ZIP on the 142(1) notice is in the bundle, and every notice is read", () => {
  // The archive with the search papers in it hangs off a s.142(1) notice, not
  // off the notice that starts the return. Finding it is the whole point.
  const found = findBlockProceedings(proceedingData, trustPan);
  assert.ok(found.attachments.some((a) => a.storagePath === "p/attachment.pdf"));
  // Every notice with a file is read, the one that starts the return first.
  assert.deepEqual(readingOrder(found), ["n158", "n142a", "n142b"]);
});

test("the panchnama filed with our own reply is picked up; the ledgers are not", () => {
  const { replies } = findBlockProceedings(proceedingData, trustPan);
  assert.deepEqual(replies.picked.map((r) => r.storagePath), ["p/reply-1.pdf"]);
  assert.equal(replies.considered, 3);
  assert.equal(replies.passedOver, 2);          // counted, so a miss is visible
  assert.match(describeScan(findBlockProceedings(proceedingData, trustPan)), /1 search document also found in the replies/);
});

test("a misspelt panchnama still counts — a name typed by a person is not a fixed string", () => {
  // The real annexure was called "Comprihansive Panchanama". Matching the whole
  // word would have missed it.
  for (const n of ["Comprihansive Panchanama 23.08.25.pdf", "PANCHNAMA-final.pdf", "Warrant of authorisation u-s 132", "search & seizure annexure"]) {
    assert.equal(isSearchDocName(n), true, n);
  }
  for (const n of ["Documents set 1", "Bank statement HDFC", "Ledger 2019-20", ""]) {
    assert.equal(isSearchDocName(n), false, n);
  }
});

test("the client's rule for reply annexures and the server's cannot drift apart", () => {
  // One decides what is READ (the callable), the other what is COUNTED on
  // screen. A disagreement means the card promises a file that is never sent.
  const names = [
    "Comprihansive Panchanama 23.08.25.pdf", "PANCHNAMA.pdf", "panch.pdf",
    "Warrant of authorisation", "Authorization u/s 132", "search and seizure",
    "Documents set 1", "Others", "Partial Reply", "Bank statement", "132 crore turnover note", "",
  ];
  for (const n of names) assert.equal(isSearchDocName(n), isSearchDocNameServer(n), n);
});

/* ---------------------------------------------------------------------------
 * A compressed folder the department called "ATTACHMENT.pdf".
 *
 * The card said ZIP and the download said .pdf, so the practitioner got a file
 * their reader refused to open. Two functions were reading the same two facts
 * and reaching different answers.
 * ------------------------------------------------------------------------- */

test("the kind decides the extension, so the badge and the download agree", () => {
  const filename = "ATTACHMENT.pdf";
  const contentType = "application/x-zip-compressed";
  assert.equal(documentKind(filename, contentType), "zip");
  assert.equal(documentExt(filename, contentType), "zip");        // was "pdf"
});

test("a name that agrees with the kind is kept as it is", () => {
  assert.equal(documentExt("papers.rar", "application/x-rar-compressed"), "rar");
  assert.equal(documentExt("Notice us 148.pdf", "application/pdf"), "pdf");
  assert.equal(documentExt("Annexure.xlsx", ""), "xlsx");
  assert.equal(documentExt("ATTACHMENT", "application/zip"), "zip");
});

test("the first bytes overrule both names, for everything already in Storage", () => {
  // Nothing can be fixed at upload for a file uploaded last month. This is read
  // at the one moment the bytes are in hand.
  assert.equal(sniffExtension([0x50, 0x4b, 0x03, 0x04]), "zip");
  assert.equal(sniffExtension([0x25, 0x50, 0x44, 0x46, 0x2d]), "pdf");
  assert.equal(sniffExtension([0x52, 0x61, 0x72, 0x21]), "rar");
  assert.equal(sniffExtension([0x00, 0x01]), "");                 // says nothing, changes nothing
  assert.equal(sniffExtension(null), "");
});

test("a wrong extension is replaced, not stacked on top of", () => {
  // "ATTACHMENT.pdf.zip" is not an improvement on "ATTACHMENT.pdf".
  assert.equal(retypeFilename("Trust - AY 2020-21 - ATTACHMENT.pdf", "zip"), "Trust - AY 2020-21 - ATTACHMENT.zip");
  assert.equal(retypeFilename("Notice u-s 158BC", "pdf"), "Notice u-s 158BC.pdf");
  assert.equal(retypeFilename("already.zip", "zip"), "already.zip");
  // A dot that is not an extension is left alone — "23.08.25" is a date.
  assert.equal(retypeFilename("Panchanama 23.08.25", "pdf"), "Panchanama 23.08.25.pdf");
});

/* ---------------------------------------------------------------------------
 * The block period the department has already printed.
 *
 * The s.142(1) notices in a real block proceeding carry "Block Period:
 * 01/04/2019-23/08/2025" in the letterhead. It was sitting unread while the app
 * asked the practitioner to find two dates by hand — because the reader had
 * never been given those notices, and because it had never been asked to look.
 * ------------------------------------------------------------------------- */

test("a printed block period gives A20, because s.158B(b) defines it that way", () => {
  // Not an inference: the block period ENDS on the date the last authorisation
  // was executed, so a printed end date is that date, read off the page.
  const out = shape({
    blockPeriodFrom: "2019-04-01", blockPeriodTo: "2025-08-23",
    quotes: { blockPeriod: "Block Period: 01/04/2019-23/08/2025" },
  });
  assert.equal(out.lastAuthorisationDate, "2025-08-23");
  assert.equal(out.lastAuthFrom, "blockPeriod");        // marked, so the screen can say so
  assert.deepEqual(out.statedPeriod, { from: "2019-04-01", to: "2025-08-23", quote: "Block Period: 01/04/2019-23/08/2025" });
  // A19 is NOT invented from it. The start date fixes the year, never the day.
  assert.equal(out.initiationDate, "");
});

test("a date actually read from a document beats one taken from the period", () => {
  const out = shape({
    lastAuthorisationDate: "2025-08-20", blockPeriodFrom: "2019-04-01", blockPeriodTo: "2025-08-23",
  });
  assert.equal(out.lastAuthorisationDate, "2025-08-20");
  assert.equal(out.lastAuthFrom, "document");
  assert.ok(out.statedPeriod);                          // still reported, still checkable
});

test("the block period's own start date survives the misread filter", () => {
  // 2019 is seven years before the search and a perfectly correct start date.
  // The window that throws away misread search dates would have binned it.
  assert.equal(shape({ blockPeriodFrom: "2019-04-01", blockPeriodTo: "2025-08-23" }).statedPeriod.from, "2019-04-01");
  assert.equal(shape({ initiationDate: "2019-04-01" }).initiationDate, "");
  // Still bounded — a 2012 "block period" is a misread of something else.
  assert.equal(shape({ blockPeriodFrom: "2012-04-01", blockPeriodTo: "2025-08-23" }).statedPeriod, null);
});

test("a printed period the wrong way round, or half missing, is not a period", () => {
  assert.equal(shape({ blockPeriodFrom: "2025-08-23", blockPeriodTo: "2019-04-01" }).statedPeriod, null);
  assert.equal(shape({ blockPeriodTo: "2025-08-23" }).statedPeriod, null);
  assert.equal(shape({ blockPeriodFrom: "2019-04-01" }).statedPeriod, null);
});

test("the printed period is checked against the one this app derives", () => {
  // The real case. A same-day reading of the end date reproduces the printed
  // start exactly, so the two periods are the same period — and that can be
  // shown to the practitioner instead of assumed on their behalf.
  const check = statedPeriodAgrees({ from: "2019-04-01", to: "2025-08-23" });
  assert.deepEqual(check, { agrees: true, derivedFrom: "2019-04-01" });

  // And when it does not line up, it says what it derived instead.
  assert.deepEqual(statedPeriodAgrees({ from: "2018-04-01", to: "2025-08-23" }), { agrees: false, derivedFrom: "2019-04-01" });
  assert.equal(statedPeriodAgrees(null), null);
  assert.equal(statedPeriodAgrees({ from: "2019-04-01" }), null);
});

test("the printed period, read end to end, gives the block period on the notice", () => {
  // What the whole thing is for: a line in a letterhead becomes seven rows.
  const out = shape({ blockPeriodFrom: "2019-04-01", blockPeriodTo: "2025-08-23" });
  const bp = blockPeriod(out.lastAuthorisationDate, out.lastAuthorisationDate);
  assert.equal(bp.from, "2019-04-01");
  assert.equal(bp.to, "2025-08-23");
  assert.equal(bp.years.length, 7);
  assert.equal(bp.spansYears, false);
  assert.equal(bp.years[6].part, true);        // 2025-26 is the part year
});

/* ---------------------------------------------------------------------------
 * Documents the practitioner uploads.
 *
 * The panchnama is handed over on paper on the day the search concludes and
 * reaches the portal only if somebody files it as an annexure later — so on a
 * great many cases the two dates that fix seven years of assessment are on a
 * scanner in the practitioner's office and nowhere else.
 * ------------------------------------------------------------------------- */

const PDF_HEAD = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34];   // "%PDF-1.4"
const asFile = (name, size) => ({ name, size });

test("a PDF is taken", () => {
  assert.deepEqual(checkUpload(asFile("Panchnama 23.08.25.pdf", 890_000), PDF_HEAD), { ok: true, reason: "" });
  assert.equal(checkUpload(asFile("NOTICE.PDF", 1000), PDF_HEAD).ok, true);   // the extension's case is not the point
});

test("a file named .pdf that is not one is refused, by its bytes", () => {
  // The failure this prevents: a scanner writes a TIFF called "panchnama.pdf",
  // it uploads, the read runs, it costs money, and it comes back with nothing
  // and nobody able to say why.
  const tiff = [0x49, 0x49, 0x2a, 0x00, 0, 0, 0, 0];
  const out = checkUpload(asFile("panchnama.pdf", 500_000), tiff);
  assert.equal(out.ok, false);
  assert.match(out.reason, /named \.pdf but is not one/);
  assert.match(out.reason, /panchnama\.pdf/);          // says WHICH file
});

test("anything that is not a PDF at all is refused on its name, before its bytes", () => {
  for (const name of ["papers.zip", "notice.docx", "scan.jpg", "panchnama"]) {
    const out = checkUpload(asFile(name, 1000), PDF_HEAD);
    assert.equal(out.ok, false, name);
    assert.match(out.reason, /Only PDFs can be read/);
  }
});

test("an empty file, an oversized one, and one too many are each refused by name", () => {
  assert.match(checkUpload(asFile("a.pdf", 0), PDF_HEAD).reason, /is empty/);

  const big = checkUpload(asFile("scan.pdf", MAX_UPLOAD_BYTES + 1), PDF_HEAD);
  assert.equal(big.ok, false);
  assert.match(big.reason, /the limit is 6 MB/);
  assert.match(big.reason, /lower resolution/);        // says what to do about it

  const full = checkUpload(asFile("a.pdf", 1000), PDF_HEAD, MAX_UPLOADS);
  assert.equal(full.ok, false);
  assert.match(full.reason, /Remove one first/);
  // One below the ceiling still goes through.
  assert.equal(checkUpload(asFile("a.pdf", 1000), PDF_HEAD, MAX_UPLOADS - 1).ok, true);
});

test("the magic number is read strictly", () => {
  assert.equal(looksLikePdf(PDF_HEAD), true);
  assert.equal(looksLikePdf([0x25, 0x50, 0x44]), false);          // truncated
  assert.equal(looksLikePdf([0x50, 0x4b, 0x03, 0x04]), false);    // a zip
  assert.equal(looksLikePdf([]), false);
  assert.equal(looksLikePdf(null), false);
});

test("an upload lands under the user's own itrb folder, and nowhere else", () => {
  // The callable insists on exactly this prefix before it will read a path, so
  // a change here without a change there silently stops uploads being read.
  assert.equal(uploadPath("uid123", "abc-DEF_1"), "users/uid123/itrb/abc-DEF_1.pdf");
  // A crafted id cannot climb out of the folder: dots and slashes are stripped
  // outright, so there is no traversal to sanitise in the first place.
  assert.equal(uploadPath("uid123", "../../notices/x"), "users/uid123/itrb/noticesx.pdf");
  assert.equal(uploadPath("uid123", "a/b"), "users/uid123/itrb/ab.pdf");
});

test("a scanner's filename is shortened in the middle, keeping both ends", () => {
  // The tail matters: "…_30062026.pdf" is how one scan is told from the next.
  const long = "70000000162509875_205130490_2026_AST_AACTR2704C_Notice us 158BC_1090657518(1)_30062026.pdf";
  const out = shortName(long, 40);
  assert.ok(out.length <= 40, out);
  assert.ok(out.startsWith("70000000162509875"));
  assert.ok(out.endsWith("2026.pdf"));
  assert.equal(shortName("Panchnama.pdf", 40), "Panchnama.pdf");   // short enough, untouched
});

/* ---------------------------------------------------------------------------
 * What an uploaded notice says about itself.
 * ------------------------------------------------------------------------- */

test("a notice's own particulars are read, because an upload has no other source", () => {
  const out = shape({
    pan: "aactr2704c", noticeDin: "ITBA100115783112", noticeDate: "2026-06-30",
    noticeSection: "158 BC", responseDueDate: "2026-08-29",
  });
  assert.deepEqual(out.notice, {
    pan: "AACTR2704C",          // upper-cased, and shape-checked
    din: "100115783112",        // the ITBA prefix is not part of the DIN
    date: "2026-06-30",
    section: "158BC",
    serviceDate: "",
    dueDate: "2026-08-29",
  });
});

test("a notice served before it was issued is a misread and is dropped", () => {
  const out = shape({ noticeDate: "2026-06-30", serviceDate: "2026-05-01", responseDueDate: "2026-01-01" });
  assert.equal(out.notice.serviceDate, "");
  assert.equal(out.notice.dueDate, "");
  assert.equal(out.notice.date, "2026-06-30");        // the one that was right survives
});

test("junk particulars come back empty rather than wrong", () => {
  const out = shape({ pan: "NOTAPAN", noticeDin: "no digits here", noticeSection: "143(3)" });
  assert.equal(out.notice.pan, "");
  assert.equal(out.notice.din, "");
  assert.equal(out.notice.section, "");               // 143(3) is not a limb of s.158BC
  assert.deepEqual(shape({}).notice, { pan: "", din: "", date: "", section: "", serviceDate: "", dueDate: "" });
});

/* ---------------------------------------------------------------------------
 * When the return was filed, and under what number.
 *
 * The screen was printing "On file: ITR-2 · ack 946927300190122 · filed 19 Jan
 * 2022" directly above two empty boxes asking for exactly those two things.
 * They are not in the ITR JSON — that is the return as PREPARED, and both are
 * stamped by the portal at submission — so reading the file could never fill
 * them. They are in the returns record the sync writes.
 * ------------------------------------------------------------------------- */

const record = { form: "ITR-2", ackNum: "946927300190122", filedOn: "2022-01-19" };

test("the acknowledgement and the date of filing come off the portal's record", () => {
  const out = withFiledParticulars(blankYear({ ay: "2021-22" }), record);
  assert.equal(out.ackNum, "946927300190122");
  assert.equal(out.filedOn, "2022-01-19");
  assert.equal(out.declaredForm, "ITR-2");
  // A year with an acknowledgement number is a year in which a return was
  // furnished — A26(i) follows rather than being asked again.
  assert.equal(out.returnFiled, true);
});

test("what the practitioner has already typed is never overwritten", () => {
  // They may be correcting a record that is wrong, and a fill that undoes a
  // correction is worse than one that does nothing.
  const edited = { ...blankYear({ ay: "2021-22" }), ackNum: "111111111111111", filedOn: "2022-03-01" };
  const out = withFiledParticulars(edited, record);
  assert.equal(out.ackNum, "111111111111111");
  assert.equal(out.filedOn, "2022-03-01");
  // Unless it is asked to, explicitly.
  assert.equal(withFiledParticulars(edited, record, { over: true }).ackNum, "946927300190122");
});

test("a record with nothing in it changes nothing", () => {
  const year = blankYear({ ay: "2021-22" });
  assert.deepEqual(withFiledParticulars(year, null), year);
  assert.deepEqual(withFiledParticulars(year, {}), year);
  const partial = withFiledParticulars(year, { ackNum: "946927300190122" });
  assert.equal(partial.filedOn, "");                  // no date on the record, none invented
  assert.equal(partial.returnFiled, true);
});

test("a form code that is not an ITR form is not written into the form field", () => {
  assert.equal(withFiledParticulars(blankYear({ ay: "2021-22" }), { form: "ITR-9" }).declaredForm, "");
  assert.equal(withFiledParticulars(blankYear({ ay: "2021-22" }), { form: "2" }).declaredForm, "");
  assert.equal(withFiledParticulars(blankYear({ ay: "2021-22" }), { form: "ITR-7" }).declaredForm, "ITR-7");
});

test("a date input takes one shape, so every recorded shape is turned into it", () => {
  assert.equal(isoDate("2022-01-19"), "2022-01-19");
  assert.equal(isoDate("19/01/2022"), "2022-01-19");        // as the portal prints it
  assert.equal(isoDate("9-1-2022"), "2022-01-09");          // single digits, padded
  assert.equal(isoDate("2022-01-19T00:00:00.000Z"), "2022-01-19");
  assert.equal(isoDate("19 Jan 2022"), "");                 // not a shape to guess at
  assert.equal(isoDate(""), "");
  assert.equal(isoDate(null), "");
});

test("the figures come from the file and the particulars from the record, together", () => {
  // Neither source has the other's answers. This is the whole reason there are
  // two calls rather than one.
  const reading = { ay: "2021-22", formLabel: "ITR-2", salary: 11333, otherSources: 233916, capitalGains: 3756, houseProperty: 0 };
  const out = withFiledParticulars(withDeclared(blankYear({ ay: "2021-22" }), reading, "sync"), record);
  assert.equal(out.declaredTotal, 249005);          // out of the JSON
  assert.equal(out.ackNum, "946927300190122");      // out of the record
  assert.equal(out.filedOn, "2022-01-19");
});

/* ---------------------------------------------------------------------------
 * Taxes already paid for the year — and the line the form draws through them.
 *
 * Part G asks for the advance tax and self-assessment tax paid. Part H asks for
 * TDS and TCS "not claimed in any earlier return". The ITR states all four, but
 * what it states about TDS is precisely the credit it DID claim — so three of
 * the four are not the same kind of fact, and only two of them may be written
 * into the form.
 * ------------------------------------------------------------------------- */

test("all four figures are read out of the return", () => {
  const d = readDeclared(fixture("itr3-partner-salary-agri-ay2025-26"));
  assert.equal(d.advanceTax, 250000);
  assert.equal(d.selfAssessmentTax, 67250);
  assert.equal(d.tds, 55703);
  assert.equal(d.tcs, 0);
});

test("ITR-1 keeps them a level up, and is read all the same", () => {
  // ITR-1 has no PartB_TTI; TaxPaid sits on the body. One candidate list covers
  // both shapes, and a fixture proves it rather than a memory of the schema.
  const d = readDeclared(fixture("itr1-80ggc-tds-refund-ay2024-25"));
  assert.equal(d.tds, 34555);
  assert.equal(d.advanceTax, 0);
  assert.equal(d.taxesPaid, 34555);
});

test("all four credits fill from the return, and Part H says what it still needs", () => {
  const d = readDeclared(fixture("itr3-partner-salary-agri-ay2025-26"));
  const y = withDeclared(blankYear({ ay: "2025-26" }), d, "sync");

  assert.equal(y.credits.advance, 250000);            // Part G — the form asks for the payment
  assert.equal(y.credits.selfAssessment, 67250);

  /* Part H asks for credit NOT claimed in any earlier return, and what the
     return states is the credit it DID claim. The figure lands there as a
     starting point to reduce — which is only safe because `claimed` is carried
     alongside it and the panel prints the caveat under the box every time. */
  assert.equal(y.credits.tds, 55703);
  assert.equal(y.credits.tcs, 0);
  assert.equal(y.claimed.tds, 55703);
  assert.equal(y.claimed.tcs, 0);
});

test("a figure the practitioner has keyed is never replaced by the return's", () => {
  // Part H above all: a practitioner who has worked out what credit is left
  // must not have it reset to the full amount claimed on the next fill.
  const edited = { ...blankYear({ ay: "2025-26" }), credits: { tds: 12000, tcs: "", advance: 999, selfAssessment: "" } };
  const y = withDeclared(edited, readDeclared(fixture("itr3-partner-salary-agri-ay2025-26")), "sync");
  assert.equal(y.credits.advance, 999);
  assert.equal(y.credits.tds, 12000);                 // their reduced figure stands
  assert.equal(y.credits.selfAssessment, 67250);      // the ones they left alone still fill
  assert.equal(y.credits.tcs, 0);
});

test("nil is an answer, and fills; absent is not, and does not", () => {
  // A year with no advance tax says so with a zero. Leaving the box empty would
  // make an answered question look unanswered.
  const nil = withDeclared(blankYear({ ay: "2024-25" }), readDeclared(fixture("itr1-80ggc-tds-refund-ay2024-25")), "sync");
  assert.equal(nil.credits.advance, 0);
  assert.equal(nil.credits.selfAssessment, 0);

  const silent = withDeclared(blankYear({ ay: "2024-25" }), { ay: "2024-25" }, "json");
  assert.equal(silent.credits.advance, "");           // the reading says nothing, so nor does the box
  assert.equal(silent.claimed.tds, null);
});

test("what is entered in Parts G and H reaches the tax computation", () => {
  // The point of filling them: the block return's bottom line moves.
  const draft = withBlockPeriod({ ...blankDraft(), pan: "AACTR2704C" },
    { searchDate: "2025-08-23", lastAuthDate: "2025-08-23" });
  const y = draft.years.find((r) => r.ay === "2025-26");
  const filled = {
    ...draft,
    years: draft.years.map((r) => (r.key === y.key
      ? { ...r, items: { ...r.items, money: 1000000 }, undisclosed: { ...r.undisclosed },
          credits: { advance: 250000, selfAssessment: 67250, tds: "", tcs: 50000 } }
      : r)),
  };
  const res = computeItrB(filled);
  const row = res.years.find((r) => r.key === y.key);
  assert.equal(row.credits.partG, 317250);            // advance + self-assessment
  assert.equal(row.credits.partH, 50000);             // whatever stands in Part H after reducing
});

/* ---------------------------------------------------------------------------
 * Column [B], off the intimation.
 *
 * The one figure on the year panel that comes from a PDF rather than from data.
 * The portal hands over the return as a JSON and its own record of the filing;
 * the income CPC DETERMINED is printed in the s.143(1) intimation and stated in
 * no record at all. So the fill has to find the order, and where nobody has
 * read it yet, read it.
 * ------------------------------------------------------------------------- */

const order = (over = {}) => ({
  commRefNo: "CPC/2021/A1/123", orderDate: "2022-08-12", section: "143(1)",
  storagePath: "p/intimation.pdf", locked: false, ...over,
});
const reading = (total) => ({ lines: [
  { head: "Gross Total Income", asReturned: total + 50000, asComputed: total + 50000 },
  { head: "Total Income", asReturned: 215680, asComputed: total },
] });

test("the newest unread order with a PDF is the one to read", () => {
  const ret = { orders: [
    order({ commRefNo: "OLD", orderDate: "2022-08-12" }),
    order({ commRefNo: "NEW", orderDate: "2023-03-01" }),
  ] };
  assert.equal(intimationToRead(ret).commRefNo, "NEW");
});

test("an order already read, locked, or without a PDF is not read again", () => {
  // Each read costs money. An order CPC only sends by e-mail has no PDF here at
  // all, and one already read has its answer on file.
  assert.equal(intimationToRead({ orders: [order({ reading: reading(300000) })] }), null);
  assert.equal(intimationToRead({ orders: [order({ locked: true })] }), null);
  assert.equal(intimationToRead({ orders: [order({ storagePath: "" })] }), null);
  assert.equal(intimationToRead({ orders: [] }), null);
  assert.equal(intimationToRead(null), null);
});

test("a freshly-read order merges into the return and answers column [B]", () => {
  // What the fill does after the callable returns: no waiting on Firestore to
  // come back round, the reading is used where it is.
  const ret = { orders: [order()] };
  assert.equal(determinedFromReturn(ret), null);            // nothing read yet

  const merged = withOrderReading(ret, "CPC/2021/A1/123", reading(268430));
  const found = determinedFromReturn(merged);
  assert.equal(found.amount, 268430);
  assert.equal(found.section, "143(1)");
  assert.equal(found.orderDate, "2022-08-12");
  assert.equal(found.head, "Total Income");
  // The original is untouched — the merge is a copy, not a mutation.
  assert.equal(determinedFromReturn(ret), null);
});

test("column [B] is written with the order it came from, so it can be checked", () => {
  const found = determinedFromReturn(withOrderReading({ orders: [order()] }, "CPC/2021/A1/123", reading(268430)));
  const y = withDetermined(blankYear({ ay: "2021-22" }), found);
  assert.equal(y.partC.determined, 268430);
  assert.equal(y.partC.determinedSection, "143(1)");
  assert.deepEqual(y.partC.determinedFrom, {
    orderDate: "2022-08-12", commRefNo: "CPC/2021/A1/123", head: "Total Income",
  });
});

test("a figure already in column [B] stands — whoever put it there read the order", () => {
  const keyed = { ...blankYear({ ay: "2021-22" }), partC: { determined: 999999 } };
  const found = determinedFromReturn(withOrderReading({ orders: [order()] }, "CPC/2021/A1/123", reading(268430)));
  const y = withDetermined(keyed, found);
  assert.equal(y.partC.determined, 999999);
  assert.equal(y.partC.determinedFrom, undefined);          // and it is not claimed to be a read
});

test("nothing found means nothing written", () => {
  const year = blankYear({ ay: "2021-22" });
  assert.deepEqual(withDetermined(year, null), year);
  assert.deepEqual(withDetermined(year, { amount: null }), year);
  // A reading with no total-income row is not an answer either.
  assert.equal(determinedFromReturn(withOrderReading({ orders: [order()] }, "CPC/2021/A1/123",
    { lines: [{ head: "Gross Total Income", asComputed: 500000 }] })), null);
});

test("a s.154 rectification supersedes the intimation it corrects", () => {
  // Both read. The later order states the income as it now stands, and column
  // [B]'s section stays 143(1) — a rectification corrects that determination
  // rather than making a fresh one, and [B]'s own list has no entry for s.154.
  const ret = { orders: [
    order({ commRefNo: "ORIG", orderDate: "2022-08-12", reading: reading(268430) }),
    order({ commRefNo: "RECT", orderDate: "2023-03-01", section: "154", reading: reading(241300) }),
  ] };
  const found = determinedFromReturn(ret);
  assert.equal(found.amount, 241300);
  assert.equal(found.commRefNo, "RECT");
  assert.equal(found.section, "143(1)");
});
