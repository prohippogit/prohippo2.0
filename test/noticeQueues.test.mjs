/* The dashboard's two notice queues. Both are counted on a card a practitioner
   reads in a glance and acts on without opening anything, so the boundaries —
   which day counts, what "no reply" means, what is not a notice at all — are
   the whole feature. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isoDaysAgo,
  noticesIssuedInLast24h,
  noticesAwaitingReply,
  countIssuedToday,
  countPastDue,
  hasReply,
} from "../src/noticeQueues.js";

// A fixed "now" so the tests read the same in January as in July. Mid-morning
// IST, deliberately: a date computed in UTC would still be on the 9th.
const NOW = new Date(2026, 6, 10, 9, 30); // 10 Jul 2026, local time
const on = (date, extra = {}) => ({ id: date + JSON.stringify(extra), date, assessee: "A", ...extra });

test("isoDaysAgo counts back in local days, across a month boundary", () => {
  assert.equal(isoDaysAgo(0, NOW), "2026-07-10");
  assert.equal(isoDaysAgo(1, NOW), "2026-07-09");
  assert.equal(isoDaysAgo(15, NOW), "2026-06-25");
  // Early morning must still be today, which a UTC-based helper gets wrong.
  assert.equal(isoDaysAgo(0, new Date(2026, 6, 10, 0, 30)), "2026-07-10");
});

test("the 24-hour queue is today and yesterday, and nothing dated ahead", () => {
  const rows = noticesIssuedInLast24h([
    on("2026-07-11"),          // future-dated — the portal does this
    on("2026-07-10"),
    on("2026-07-09"),
    on("2026-07-08"),          // day before yesterday
    on(""),                    // no issue date at all
  ], NOW);
  assert.deepEqual(rows.map((n) => n.date), ["2026-07-10", "2026-07-09"]);
});

test("an order issued overnight belongs in the 24-hour queue", () => {
  // The appeal clock starts on an order, so it is the last thing to hide.
  const rows = noticesIssuedInLast24h([on("2026-07-10", { isOrder: true })], NOW);
  assert.equal(rows.length, 1);
});

test("the 24-hour queue reads newest first", () => {
  const rows = noticesIssuedInLast24h([on("2026-07-09"), on("2026-07-10")], NOW);
  assert.deepEqual(rows.map((n) => n.date), ["2026-07-10", "2026-07-09"]);
});

test("countIssuedToday splits today's news from yesterday's", () => {
  const rows = noticesIssuedInLast24h([on("2026-07-10"), on("2026-07-10"), on("2026-07-09")], NOW);
  assert.equal(countIssuedToday(rows, NOW), 2);
});

test("the unanswered queue spans 15 days, inclusive of the far edge", () => {
  const rows = noticesAwaitingReply([
    on("2026-07-10"),
    on("2026-06-25"), // exactly 15 days back — in
    on("2026-06-24"), // 16 days back — out
    on("2026-07-11"), // future-dated — out
  ], { now: NOW });
  assert.deepEqual(rows.map((n) => n.date), ["2026-07-10", "2026-06-25"]);
});

test("a reply on record takes a notice out, whichever way it was recorded", () => {
  const rows = noticesAwaitingReply([
    on("2026-07-01", { responses: [{ responseId: "1" }] }),
    on("2026-07-02", { hasResponse: true }),
    on("2026-07-03", { responses: [] }),   // synced, nothing filed — stays
    on("2026-07-04"),                      // added by hand — stays
  ], { now: NOW });
  assert.deepEqual(rows.map((n) => n.date), ["2026-07-04", "2026-07-03"]);
});

test("an order is not something a reply can be filed against", () => {
  // Its answer is an appeal, which has its own card and its own deadline.
  const rows = noticesAwaitingReply([
    on("2026-07-05", { isOrder: true }),
    on("2026-07-05"),
  ], { now: NOW });
  assert.equal(rows.length, 1);
  assert.ok(!rows[0].isOrder);
});

test("a notice the practitioner has closed off stays closed", () => {
  const rows = noticesAwaitingReply([
    on("2026-07-05", { status: "Replied" }),
    on("2026-07-05", { status: "Closed" }),
    on("2026-07-05", { status: "Awaiting review" }), // the ingest default — open
    on("2026-07-05", { status: "" }),
  ], { now: NOW });
  assert.equal(rows.length, 2);
});

test("the window is caller-set, so 15 days is a choice and not a constant", () => {
  const notices = [on("2026-07-08"), on("2026-06-30")];
  assert.equal(noticesAwaitingReply(notices, { days: 5, now: NOW }).length, 1);
  assert.equal(noticesAwaitingReply(notices, { days: 30, now: NOW }).length, 2);
});

test("hasReply reads both shapes and neither crashes on a bare notice", () => {
  assert.equal(hasReply({}), false);
  assert.equal(hasReply({ responses: [] }), false);
  assert.equal(hasReply({ responses: [{}] }), true);
  assert.equal(hasReply({ hasResponse: true }), true);
});

test("an empty practice produces empty queues, not an error", () => {
  assert.deepEqual(noticesIssuedInLast24h(undefined, NOW), []);
  assert.deepEqual(noticesAwaitingReply(undefined, { now: NOW }), []);
});

test("past-due counts only notices whose own deadline has gone by", () => {
  const rows = [
    on("2026-07-01", { responseDueDate: "2026-07-05" }),                        // gone
    on("2026-07-01", { responseDueDate: "2026-07-10" }),                        // due today
    on("2026-07-01", { responseDueDate: "2026-07-20" }),                        // ahead
    on("2026-07-01"),                                                           // no date at all
    // A hearing outranks the compliance date, and this one has passed even
    // though the reply-due date has not.
    on("2026-07-01", { hearingDate: "2026-07-08", responseDueDate: "2026-07-30" }),
  ];
  assert.equal(countPastDue(rows, NOW), 2);
  assert.equal(countPastDue([], NOW), 0);
});
