/*
 * The dashboard's intimation-variance selector.
 *
 *   node --test test/intimations.test.mjs
 *
 * The arithmetic is tested in functions/returnVariance.test.mjs; what is tested
 * here is the SELECTION — which orders reach a practitioner's dashboard and
 * which do not. A selector that quietly drops a red-flagged order is worse than
 * one that shows too much, so the omissions are what the assertions are about.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  intimationVariances,
  varianceSummary,
  needsVarianceBackfill,
  describeVariance,
  windowStart,
  inr,
  DEFAULT_WINDOW_MONTHS,
} from "../src/intimations.js";

const TODAY = "2026-08-03";

const variance = (flag, amount, kind = "return") => ({
  engine: 1,
  cpcNet: -1000,
  baseline: kind ? { kind, ref: kind === "order" ? "PREV" : "", net: 0 } : null,
  amount,
  flag,
  direction: amount < 0 ? "demand" : "refund",
  adjusted: false,
  note: "",
});

const ret = (over = {}) => ({
  id: "ret_a",
  assesseeId: "a1",
  assessee: "Ramesh Kumar",
  pan: "AAAPK1234C",
  ay: "2024-25",
  orders: [],
  ...over,
});

const ord = (over = {}) => ({
  commRefNo: "REF1",
  section: "143(1)",
  statusDesc: "Processed with demand due",
  orderDate: "2026-06-01",
  variance: variance("red", -124560),
  ...over,
});

/* ---------------- the window ---------------- */

test("the window is six months back from today by default", () => {
  assert.equal(DEFAULT_WINDOW_MONTHS, 6);
  assert.equal(windowStart(6, new Date("2026-08-03T00:00:00")), "2026-02-03");
});

test("an order inside the window is listed and one outside is not", () => {
  const data = { returns: [ret({ orders: [ord({ commRefNo: "IN", orderDate: "2026-04-02" }), ord({ commRefNo: "OUT", orderDate: "2025-11-30" })] })] };
  const rows = intimationVariances(data, { today: TODAY });
  assert.deepEqual(rows.map((r) => r.commRefNo), ["IN"]);
});

test("months:null keeps everything on file", () => {
  const data = { returns: [ret({ orders: [ord({ commRefNo: "OLD", orderDate: "2019-01-01" })] })] };
  assert.equal(intimationVariances(data, { today: TODAY, months: null }).length, 1);
});

test("an undated order is kept, and sorts first", () => {
  /* A date the portal never sent is not a reason to hide an order — it is a
     reason to look at it. Sorting it to the end would bury it. */
  const data = { returns: [ret({ orders: [ord({ commRefNo: "DATED", orderDate: "2026-06-01" }), ord({ commRefNo: "UNDATED", orderDate: "" })] })] };
  const rows = intimationVariances(data, { today: TODAY });
  assert.deepEqual(rows.map((r) => r.commRefNo), ["UNDATED", "DATED"]);
});

test("rows are newest first", () => {
  const data = { returns: [ret({ orders: [
    ord({ commRefNo: "MAY", orderDate: "2026-05-01" }),
    ord({ commRefNo: "JUL", orderDate: "2026-07-01" }),
    ord({ commRefNo: "JUN", orderDate: "2026-06-01" }),
  ] })] };
  assert.deepEqual(intimationVariances(data, { today: TODAY }).map((r) => r.commRefNo), ["JUL", "JUN", "MAY"]);
});

/* ---------------- what belongs on the card ---------------- */

test("both 143(1) and 154 are listed", () => {
  const data = { returns: [ret({ orders: [ord({ commRefNo: "A", section: "143(1)" }), ord({ commRefNo: "B", section: "154" })] })] };
  assert.equal(intimationVariances(data, { today: TODAY }).length, 2);
});

test("an order under any other section is not an intimation", () => {
  const data = { returns: [ret({ orders: [ord({ commRefNo: "X", section: "143(3)" })] })] };
  assert.equal(intimationVariances(data, { today: TODAY }).length, 0);
});

test("an order that could not be compared is still listed", () => {
  /* "We could not check this one" is information a practitioner needs. Dropping
     it would make the card silently understate the work. */
  const data = { returns: [ret({ orders: [ord({ variance: { engine: 1, flag: "unknown", amount: null, note: "no figure" } })] })] };
  const rows = intimationVariances(data, { today: TODAY });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].variance.flag, "unknown");
});

test("an order with no variance at all is still listed", () => {
  // Pre-backfill data. It must appear, not vanish until someone runs a refresh.
  const data = { returns: [ret({ orders: [ord({ variance: undefined })] })] };
  assert.equal(intimationVariances(data, { today: TODAY }).length, 1);
});

test("flags can be narrowed, and unflagged orders count as unknown", () => {
  const data = { returns: [ret({ orders: [
    ord({ commRefNo: "R", variance: variance("red", -5000) }),
    ord({ commRefNo: "G", variance: variance("green", 5000) }),
    ord({ commRefNo: "N", variance: undefined }),
  ] })] };
  assert.deepEqual(intimationVariances(data, { today: TODAY, flags: ["red"] }).map((r) => r.commRefNo), ["R"]);
  assert.deepEqual(intimationVariances(data, { today: TODAY, flags: ["unknown"] }).map((r) => r.commRefNo), ["N"]);
});

/* ---------------- ticking one off ---------------- */

test("a reviewed order drops off the card but can be asked for", () => {
  const data = { returns: [ret({
    varianceReviewed: { REF1: true },
    orders: [ord({ commRefNo: "REF1" }), ord({ commRefNo: "REF2" })],
  })] };
  assert.deepEqual(intimationVariances(data, { today: TODAY }).map((r) => r.commRefNo), ["REF2"]);
  const all = intimationVariances(data, { today: TODAY, includeReviewed: true });
  assert.equal(all.length, 2);
  assert.equal(all.find((r) => r.commRefNo === "REF1").reviewed, true);
});

/* ---------------- the practice-wide position ---------------- */

test("demand and refund are never netted off against each other", () => {
  /* Two clients, opposite directions, same amount. A single net figure would
     read as "nothing happened" when in fact two conversations are due. */
  const rows = intimationVariances({ returns: [
    ret({ id: "r1", assesseeId: "a1", orders: [ord({ commRefNo: "A", variance: variance("red", -500000) })] }),
    ret({ id: "r2", assesseeId: "a2", orders: [ord({ commRefNo: "B", variance: variance("green", 500000) })] }),
  ] }, { today: TODAY });
  const s = varianceSummary(rows);
  assert.equal(s.additionalDemand, 500000);
  assert.equal(s.extraRefund, 500000);
  assert.equal(s.red, 1);
  assert.equal(s.green, 1);
  assert.equal(s.assessees, 2);
});

test("the assessee count covers only flagged clients", () => {
  const rows = intimationVariances({ returns: [
    ret({ id: "r1", assesseeId: "a1", orders: [ord({ commRefNo: "A", variance: variance("red", -1000) })] }),
    ret({ id: "r2", assesseeId: "a2", orders: [ord({ commRefNo: "B", variance: variance("neutral", 0) })] }),
  ] }, { today: TODAY });
  const s = varianceSummary(rows);
  assert.equal(s.assessees, 1);
  assert.equal(s.neutral, 1);
});

test("one client with two flagged years counts once", () => {
  const rows = intimationVariances({ returns: [
    ret({ id: "r1", assesseeId: "a1", ay: "2023-24", orders: [ord({ commRefNo: "A", variance: variance("red", -1000) })] }),
    ret({ id: "r2", assesseeId: "a1", ay: "2024-25", orders: [ord({ commRefNo: "B", variance: variance("red", -2000) })] }),
  ] }, { today: TODAY });
  assert.equal(varianceSummary(rows).assessees, 1);
});

/* ---------------- wording ---------------- */

test("a variance says what it was measured against", () => {
  assert.match(describeVariance(variance("red", -124560, "return")), /1,24,560 worse vs the return as filed/);
  assert.match(describeVariance(variance("green", 200000, "order")), /2,00,000 better vs the previous order/);
  assert.match(describeVariance(variance("neutral", 0, "return")), /Agrees with the return/);
});

test("an uncomparable order gives its reason rather than a number", () => {
  assert.equal(describeVariance({ flag: "unknown", note: "The portal recorded no figure." }), "The portal recorded no figure.");
  assert.match(describeVariance(null), /Could not be compared/);
});

test("rupees are grouped the Indian way", () => {
  assert.equal(inr(1000), "1,000");
  assert.equal(inr(124560), "1,24,560");
  assert.equal(inr(10000000), "1,00,00,000");
  assert.equal(inr(999), "999");
});

/* ---------------- the backfill trigger ---------------- */

test("backfill is needed only for intimations that never went through the engine", () => {
  assert.equal(needsVarianceBackfill({ returns: [ret({ orders: [ord()] })] }), false);
  assert.equal(needsVarianceBackfill({ returns: [ret({ orders: [ord({ variance: undefined })] })] }), true);
  // A non-intimation order without a variance is not work.
  assert.equal(needsVarianceBackfill({ returns: [ret({ orders: [ord({ section: "143(3)", variance: undefined })] })] }), false);
  assert.equal(needsVarianceBackfill({ returns: [] }), false);
});

/* ---------------- robustness ---------------- */

test("empty and malformed data do not throw", () => {
  assert.deepEqual(intimationVariances({}, { today: TODAY }), []);
  assert.deepEqual(intimationVariances({ returns: [ret({ orders: null })] }, { today: TODAY }), []);
  assert.deepEqual(intimationVariances({ returns: [ret({ orders: [null, { section: "143(1)" }] })] }, { today: TODAY }), []);
  assert.equal(varianceSummary([]).total, 0);
});

/* ============================================================================
   The statutory clocks.

   These decide whether the app tells a practitioner a remedy is still open, so
   the dates are pinned to worked examples rather than to the formula that
   produced them. If the law changes, these tests should FAIL — that is what
   they are for.
   ============================================================================ */

import {
  endOfFinancialYear, rectificationDeadline, rectificationDisposalDue,
  appealWindow, clocksFor, refundPosition, groupByAssessee, groupByCause,
  practiceSummary, matchesFilter, allIntimations, CAUSES, DECISIONS,
} from "../src/intimations.js";

test("the financial year ends on the 31st of March after the order", () => {
  assert.equal(endOfFinancialYear("2024-09-12"), "2025-03-31", "September falls in the FY ending next March");
  assert.equal(endOfFinancialYear("2025-01-20"), "2025-03-31", "January still belongs to the FY that ends in March");
  assert.equal(endOfFinancialYear("2025-04-01"), "2026-03-31", "the 1st of April starts a new FY");
  assert.equal(endOfFinancialYear("2025-03-31"), "2025-03-31", "the last day of the FY is its own year end");
});

test("s.154(7) — rectification runs four years from the end of that financial year", () => {
  // Order passed 12 Sep 2024 → FY ends 31 Mar 2025 → four years → 31 Mar 2029.
  assert.equal(rectificationDeadline("2024-09-12"), "2029-03-31");
  // An order passed in January is in the FY ending that same March, so it gets
  // nearly three months LESS than one passed in April. Easy to get wrong.
  assert.equal(rectificationDeadline("2025-01-20"), "2029-03-31");
  assert.equal(rectificationDeadline("2025-04-01"), "2030-03-31");
  assert.equal(rectificationDeadline(""), "");
});

test("s.154(8) — CPC must dispose of our application within six months of month end", () => {
  // Filed 15 Jan 2026 → six months from the end of January → 31 Jul 2026.
  assert.equal(rectificationDisposalDue("2026-01-15"), "2026-07-31");
  assert.equal(rectificationDisposalDue("2026-01-31"), "2026-07-31", "the day within the month makes no difference");
  assert.equal(rectificationDisposalDue(""), "");
});

test("the appeal window follows the Act in force when the order was served", () => {
  // 1961 Act: 30 days from service.
  const older = appealWindow({ orderDate: "2026-03-01", ay: "2024-25" });
  assert.equal(older.deadline, "2026-03-31");
  assert.match(older.label, /30 days/);

  // 2025 Act (from 1 Apr 2026): one month from the end of the month of service.
  const newer = appealWindow({ orderDate: "2026-06-14", ay: "2024-25" });
  assert.equal(newer.deadline, "2026-07-31");
  assert.match(newer.label, /end of the month/);

  // The assessment year does not decide it — an old year served under the new
  // Act runs on the new Act's clock.
  assert.equal(newer.act, "Act 2025");
});

test("an order with no date yields no appeal deadline rather than a guessed one", () => {
  const w = appealWindow({ orderDate: "", ay: "2024-25" });
  assert.equal(w.deadline, "");
  assert.equal(w.daysLeft, null);
  assert.equal(w.urgency, "none");
});

test("both clocks are returned for every intimation, and the disposal clock only once filed", () => {
  const row = { orderDate: "2026-06-14", ay: "2024-25", tracking: null };
  const c = clocksFor(row);
  assert.ok(c.appeal.deadline, "the appeal window is always computed");
  assert.equal(c.rectification.deadline, "2031-03-31");
  assert.equal(c.disposal, null, "nothing is owed by CPC until we have applied");

  const filed = clocksFor({ ...row, tracking: { rectFiledOn: "2026-08-10" } });
  assert.equal(filed.disposal.deadline, "2027-02-28");
});

/* ---------------- refunds determined but not received ---------------- */

test("a refund still not received after a month is worth chasing", () => {
  const base = { refund: "40000", activityCd: "62", orderDate: "2020-01-01", tracking: null };
  assert.equal(refundPosition(base).state, "overdue");
  assert.equal(refundPosition(base).amount, 40000);
});

test("a refund marked received stops being chased", () => {
  const row = { refund: "40000", activityCd: "62", orderDate: "2020-01-01", tracking: { refundReceivedOn: "2020-02-01" } };
  assert.equal(refundPosition(row).state, "received");
});

test("a fully adjusted refund is never chased — no money was ever coming", () => {
  // Codes 64 / 74: set off in full against an earlier demand u/s 245.
  assert.equal(refundPosition({ refund: "80000", activityCd: "64", orderDate: "2020-01-01" }).state, "adjusted");
  assert.equal(refundPosition({ refund: "80000", activityCd: "74", orderDate: "2020-01-01" }).state, "adjusted");
});

test("a partly adjusted refund IS chased — the balance is still paid out", () => {
  assert.equal(refundPosition({ refund: "80000", activityCd: "65", orderDate: "2020-01-01" }).state, "overdue");
});

test("an order with no refund has no refund position", () => {
  assert.equal(refundPosition({ refund: "", activityCd: "61" }).state, "none");
  assert.equal(refundPosition({ refund: "0", activityCd: "63" }).state, "none");
});

/* ---------------- grouping ---------------- */

const trackedReturn = (over = {}) => ({
  id: "ret_x", assesseeId: "a1", assessee: "ramesh kumar", pan: "AAAPK1234C", ay: "2024-25",
  orders: [], ...over,
});

test("clients needing a decision come first, then the most at stake", () => {
  const rows = allIntimations({ returns: [
    trackedReturn({ id: "r1", assesseeId: "a1", assessee: "quiet client",
      intimationTracking: { A: { decision: "resolved" } },
      orders: [ord({ commRefNo: "A", variance: variance("red", -900000) })] }),
    trackedReturn({ id: "r2", assesseeId: "a2", assessee: "needs work",
      orders: [ord({ commRefNo: "B", variance: variance("red", -10000) })] }),
  ] });
  const groups = groupByAssessee(rows);
  assert.equal(groups[0].assessee, "needs work", "an undecided ₹10k beats a settled ₹9L");
  assert.equal(groups[0].pending, 1);
  assert.equal(groups[1].pending, 0);
});

test("one cause across many clients is one finding, and untagged sorts last", () => {
  const rows = allIntimations({ returns: [
    trackedReturn({ id: "r1", assesseeId: "a1", intimationTracking: { A: { cause: "rebate-87a" } },
      orders: [ord({ commRefNo: "A", variance: variance("red", -25000) })] }),
    trackedReturn({ id: "r2", assesseeId: "a2", intimationTracking: { B: { cause: "rebate-87a" } },
      orders: [ord({ commRefNo: "B", variance: variance("red", -30000) })] }),
    trackedReturn({ id: "r3", assesseeId: "a3",
      orders: [ord({ commRefNo: "C", variance: variance("red", -5000) })] }),
  ] });
  const groups = groupByCause(rows);
  assert.equal(groups[0].cause, "rebate-87a");
  assert.equal(groups[0].assessees, 2, "two different clients, one legal position");
  assert.equal(groups[0].atStake, 55000);
  assert.equal(groups[groups.length - 1].label, "Not yet tagged");
});

test("the practice summary counts work, not rows", () => {
  const rows = allIntimations({ returns: [
    trackedReturn({ id: "r1", assesseeId: "a1",
      orders: [ord({ commRefNo: "A", variance: variance("red", -50000) })] }),
    trackedReturn({ id: "r2", assesseeId: "a2", intimationTracking: { B: { decision: "resolved", cause: "tds-credit" } },
      orders: [ord({ commRefNo: "B", variance: variance("green", 20000) })] }),
  ] });
  const s = practiceSummary(rows);
  assert.equal(s.total, 2);
  assert.equal(s.pending, 1, "only the undecided one is work");
  assert.equal(s.assessees, 2);
  assert.equal(s.additionalDemand, 50000);
  assert.equal(s.extraRefund, 20000);
  assert.equal(s.untagged, 1);
});

/* ---------------- filters and vocabulary ---------------- */

test("every filter chip has a working predicate", () => {
  const row = { decision: "pending", cause: "", variance: variance("red", -1000), refund: "", activityCd: "61", tracking: null };
  assert.equal(matchesFilter(row, "All"), true);
  assert.equal(matchesFilter(row, "Needs a decision"), true);
  assert.equal(matchesFilter(row, "More payable"), true);
  assert.equal(matchesFilter(row, "In the assessee's favour"), false);
  assert.equal(matchesFilter(row, "Not yet tagged"), true);
  assert.equal(matchesFilter(row, "Refund awaited"), false);
});

test("the decision list stays short enough to hold in your head", () => {
  assert.ok(DECISIONS.length <= 8, "a status list nobody can remember gets filled in at random");
  assert.equal(DECISIONS[0].id, "pending");
  assert.ok(DECISIONS.some((d) => d.id === "rectify" && !d.terminal));
  assert.ok(DECISIONS.some((d) => d.id === "resolved" && d.terminal));
});

test("the statutory adjustment grounds are all offered as causes", () => {
  for (const clause of ["143(1)(a)(i)", "143(1)(a)(ii)", "143(1)(a)(iii)", "143(1)(a)(iv)", "143(1)(a)(v)", "143(1)(a)(vi)"]) {
    assert.ok(CAUSES.some((c) => (c.statute || "").startsWith(clause)), `no cause cites ${clause}`);
  }
  assert.ok(CAUSES.some((c) => c.id === "other"), "there is always a case the list does not cover");
});

test("the page shows every year on file, not just the dashboard's six months", () => {
  const data = { returns: [trackedReturn({ orders: [ord({ orderDate: "2019-05-01" })] })] };
  assert.equal(intimationVariances(data, { today: TODAY }).length, 0, "too old for the card");
  assert.equal(allIntimations(data).length, 1, "still rectifiable, so it belongs on the page");
});
