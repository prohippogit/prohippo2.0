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
