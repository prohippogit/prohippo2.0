/* What lands on a printed cause list. The sheet is carried into a hearing room,
   so the rules that decide what is on it — which days, which hearings, in what
   order — are worth pinning down: a missing row is a missed appearance, and an
   adjourned row is a wasted trip. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  weekRange, monthRange, rangeDays, addDays, causeListRows, groupByDay,
  causeListSummary, shouldShowEmptyDays, MAX_RANGE_DAYS,
} from "../src/causeList.js";

const h = (date, extra = {}) => ({ id: date + (extra.time || ""), date, time: "10:30", assessee: "A", authority: "ITAT", ...extra });

test("the week runs Monday to Sunday, whichever day you ask on", () => {
  // 11 Aug 2026 is a Tuesday; 16 Aug is the Sunday that closes its week.
  assert.deepEqual(weekRange(new Date(2026, 7, 11)), { from: "2026-08-10", to: "2026-08-16" });
  // Asked on the Monday itself, and on the Sunday, the same week comes back.
  assert.deepEqual(weekRange(new Date(2026, 7, 10)), { from: "2026-08-10", to: "2026-08-16" });
  assert.deepEqual(weekRange(new Date(2026, 7, 16)), { from: "2026-08-10", to: "2026-08-16" });
});

test("a month range covers the first to the last, February included", () => {
  assert.deepEqual(monthRange(new Date(2026, 7, 11)), { from: "2026-08-01", to: "2026-08-31" });
  assert.deepEqual(monthRange(new Date(2026, 1, 5)), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(monthRange(new Date(2028, 1, 5)), { from: "2028-02-01", to: "2028-02-29" });
});

test("days step across a month boundary without skipping one", () => {
  assert.deepEqual(rangeDays("2026-08-30", "2026-09-02"), ["2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"]);
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.deepEqual(rangeDays("2026-08-10", "2026-08-10"), ["2026-08-10"], "a single day is a range");
  assert.deepEqual(rangeDays("2026-08-10", "2026-08-01"), [], "an inverted range is no range");
  assert.deepEqual(rangeDays("", "2026-08-01"), []);
});

test("a typo in the year cannot ask for an unbounded document", () => {
  // A range typed by hand reaches the PDF; 20260 instead of 2026 must not draw
  // eighteen thousand year's worth of day headers.
  assert.equal(rangeDays("2026-08-10", "9999-12-31").length, MAX_RANGE_DAYS);
});

test("only hearings inside the range are listed, both ends included", () => {
  const rows = causeListRows([
    h("2026-08-09"), h("2026-08-10"), h("2026-08-14"), h("2026-08-16"), h("2026-08-17"), h(""),
  ], { from: "2026-08-10", to: "2026-08-16" });
  assert.deepEqual(rows.map((r) => r.date), ["2026-08-10", "2026-08-14", "2026-08-16"]);
});

test("an adjourned hearing is off the list unless it is asked for", () => {
  // The adjourned date is the one day nobody should turn up on.
  const list = [h("2026-08-11", { status: "Adjourned" }), h("2026-08-12", { status: "Upcoming" })];
  const opts = { from: "2026-08-10", to: "2026-08-16" };
  assert.deepEqual(causeListRows(list, opts).map((r) => r.date), ["2026-08-12"]);
  assert.equal(causeListRows(list, { ...opts, includeAdjourned: true }).length, 2);
});

test("the authority filter narrows the sheet", () => {
  const list = [h("2026-08-11", { authority: "ITAT" }), h("2026-08-11", { authority: "CIT(A)", time: "11:00" })];
  const opts = { from: "2026-08-10", to: "2026-08-16" };
  assert.equal(causeListRows(list, { ...opts, authority: "ITAT" }).length, 1);
  assert.equal(causeListRows(list, { ...opts, authority: "All" }).length, 2);
});

test("rows read in the order the day is worked", () => {
  const list = [
    h("2026-08-11", { time: "14:00", assessee: "Zaveri" }),
    h("2026-08-10", { time: "11:00", assessee: "Mehta" }),
    h("2026-08-11", { time: "10:30", assessee: "Shah" }),
    h("2026-08-11", { time: "10:30", assessee: "Ahuja" }),
  ];
  assert.deepEqual(
    causeListRows(list, { from: "2026-08-10", to: "2026-08-16" }).map((r) => `${r.date} ${r.time} ${r.assessee}`),
    ["2026-08-10 11:00 Mehta", "2026-08-11 10:30 Ahuja", "2026-08-11 10:30 Shah", "2026-08-11 14:00 Zaveri"]
  );
});

test("a week shows its empty days; a quarter does not", () => {
  // "Thursday is clear" is half of what a weekly sheet is for. Thirty blank
  // rows over a quarter are just paper.
  assert.equal(shouldShowEmptyDays("2026-08-10", "2026-08-16"), true);
  assert.equal(shouldShowEmptyDays("2026-07-01", "2026-09-30"), false);
});

test("grouping fills in the quiet days when asked, and only then", () => {
  const rows = causeListRows([h("2026-08-10"), h("2026-08-12"), h("2026-08-12", { time: "15:00" })], { from: "2026-08-10", to: "2026-08-13" });
  const full = groupByDay(rows, { from: "2026-08-10", to: "2026-08-13", withEmptyDays: true });
  // The 11th is a gap between two listed days and is printed; the 13th trails
  // the last hearing and is not — see the trimming test below.
  assert.deepEqual(full.map((d) => `${d.iso}:${d.hearings.length}`), ["2026-08-10:1", "2026-08-11:0", "2026-08-12:2"]);

  const sparse = groupByDay(rows, { from: "2026-08-10", to: "2026-08-13", withEmptyDays: false });
  assert.deepEqual(sparse.map((d) => d.iso), ["2026-08-10", "2026-08-12"]);
});

test("quiet days at the ends are trimmed, quiet days in the middle are not", () => {
  /* A gap between two hearings is the free afternoon somebody is looking for.
     A quiet Saturday and Sunday after the week's last hearing are not — and on
     a full sheet those two lines are what push it onto a second page. */
  const rows = causeListRows([h("2026-08-12"), h("2026-08-14")], { from: "2026-08-10", to: "2026-08-16" });
  const days = groupByDay(rows, { from: "2026-08-10", to: "2026-08-16", withEmptyDays: true });
  assert.deepEqual(days.map((d) => d.iso), ["2026-08-12", "2026-08-13", "2026-08-14"]);

  // A week with nothing in it at all is no days, not seven empty ones.
  assert.deepEqual(groupByDay([], { from: "2026-08-10", to: "2026-08-16", withEmptyDays: true }), []);
});

test("the summary counts people once, however many years they are listed for", () => {
  // "12 hearings for 5 assessees" is a different day from "12 for 12".
  const rows = [
    h("2026-08-10", { pan: "ABCPS1234F", authority: "ITAT" }),
    h("2026-08-10", { pan: "ABCPS1234F", authority: "ITAT", time: "11:00" }),
    h("2026-08-11", { pan: "AABCS9821K", authority: "CIT(A)", mode: "Video Conference" }),
  ];
  assert.deepEqual(causeListSummary(rows), { hearings: 3, days: 2, assessees: 2, authorities: 2, videoConference: 1 });
  assert.deepEqual(causeListSummary([]), { hearings: 0, days: 0, assessees: 0, authorities: 0, videoConference: 0 });
});

test("nothing here throws on an empty practice", () => {
  assert.deepEqual(causeListRows(undefined, { from: "2026-08-10", to: "2026-08-16" }), []);
  assert.deepEqual(causeListRows([h("2026-08-11")], {}), []);
  assert.deepEqual(groupByDay(undefined, {}), []);
});
