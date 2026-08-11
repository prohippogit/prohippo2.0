/* The Matters table's column sorting. Worth pinning down because two of the
   rules are counter-intuitive on purpose — blanks sink in BOTH directions, and
   status follows the workflow rather than the alphabet — and because the
   obvious string comparison gets assessment years and sections wrong. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sortMatters, nextSort, MATTER_SORT_COLUMNS, MATTER_SORT_HINT } from "../src/matterSort.js";

const m = (id, extra = {}) => ({ id, assessee: "z", ay: "2020-21", ...extra });
const ids = (rows) => rows.map((r) => r.id);

test("assessee sorts A→Z and back, case-insensitively", () => {
  const rows = [m("1", { assessee: "banerjee" }), m("2", { assessee: "Ahuja" }), m("3", { assessee: "chopra" })];
  assert.deepEqual(ids(sortMatters(rows, "assessee", "asc")), ["2", "1", "3"]);
  assert.deepEqual(ids(sortMatters(rows, "assessee", "desc")), ["3", "1", "2"]);
});

test("a blank cell sinks in both directions", () => {
  // Reversing a sort to see the other end of the data must not produce a
  // screenful of dashes.
  const rows = [m("1", { bench: "Circle 4(1)" }), m("2", { bench: "" }), m("3", { bench: "Ward 2" })];
  assert.deepEqual(ids(sortMatters(rows, "bench", "asc")), ["1", "3", "2"]);
  assert.deepEqual(ids(sortMatters(rows, "bench", "desc")), ["3", "1", "2"]);
});

test("status follows the workflow, not the alphabet", () => {
  // Alphabetically this would read Active, Closed, Decided, Pending, Submitted
  // — finished matters sitting in the middle of live ones.
  const rows = [m("1", { status: "Closed" }), m("2", { status: "Active" }), m("3", { status: "Decided" }), m("4", { status: "Pending" })];
  assert.deepEqual(ids(sortMatters(rows, "status", "asc")), ["2", "4", "3", "1"]);
});

test("an unrecognised status sorts after every known one", () => {
  const rows = [m("1", { status: "Remanded" }), m("2", { status: "Closed" }), m("3", { status: "Active" })];
  assert.deepEqual(ids(sortMatters(rows, "status", "asc")), ["3", "2", "1"]);
});

test("assessment years compare as years, however they were typed", () => {
  const rows = [m("1", { ay: "2022-23" }), m("2", { ay: "2019-2020" }), m("3", { ay: "2021-22" })];
  assert.deepEqual(ids(sortMatters(rows, "ay", "asc")), ["2", "3", "1"]);
  assert.deepEqual(ids(sortMatters(rows, "ay", "desc")), ["1", "3", "2"]);
});

test("sections compare as numbers and sub-clauses, not as text", () => {
  // As strings this is exactly backwards: "143(2)" < "148" < "90".
  const rows = [m("1", { section: "148" }), m("2", { section: "90" }), m("3", { section: "143(2)" }), m("4", { section: "143(1)" })];
  assert.deepEqual(ids(sortMatters(rows, "section", "asc")), ["2", "4", "3", "1"]);
});

test("the next hearing sorts by date, with matters that have none at the bottom", () => {
  const hearing = { 1: "2026-09-01", 2: "", 3: "2026-08-14" };
  const ctx = { hearingDate: (x) => hearing[x.id] };
  const rows = [m("1"), m("2"), m("3")];
  assert.deepEqual(ids(sortMatters(rows, "hearing", "asc", ctx)), ["3", "1", "2"]);
  assert.deepEqual(ids(sortMatters(rows, "hearing", "desc", ctx)), ["1", "3", "2"]);
});

test("the matter column groups by proceeding type, up the appellate chain", () => {
  const rows = [m("1", { type: "ITAT" }), m("2", { type: "Scrutiny" }), m("3", { type: "CIT(A)" })];
  assert.deepEqual(ids(sortMatters(rows, "matter", "asc")), ["2", "3", "1"]);
});

test("ties resolve the same way every time", () => {
  // Two matters identical in the sorted column must not swap between renders.
  const rows = [
    m("b", { status: "Active", assessee: "Shah", ay: "2021-22" }),
    m("a", { status: "Active", assessee: "Shah", ay: "2021-22" }),
    m("c", { status: "Active", assessee: "Mehta", ay: "2022-23" }),
  ];
  const once = ids(sortMatters(rows, "status", "asc"));
  assert.deepEqual(once, ["c", "a", "b"]);
  assert.deepEqual(ids(sortMatters([...rows].reverse(), "status", "asc")), once);
});

test("sorting never mutates the list it was given", () => {
  const rows = [m("1", { assessee: "b" }), m("2", { assessee: "a" })];
  sortMatters(rows, "assessee", "asc");
  assert.deepEqual(ids(rows), ["1", "2"]);
});

test("an unknown sort key leaves the order alone rather than blanking it", () => {
  const rows = [m("1"), m("2")];
  assert.deepEqual(ids(sortMatters(rows, "nonsense", "asc")), ["1", "2"]);
  assert.deepEqual(sortMatters(undefined, "assessee"), []);
});

test("clicking the sorted column flips it; a new column starts ascending", () => {
  assert.deepEqual(nextSort({ key: "ay", dir: "asc" }, "ay"), { key: "ay", dir: "desc" });
  assert.deepEqual(nextSort({ key: "ay", dir: "desc" }, "ay"), { key: "ay", dir: "asc" });
  assert.deepEqual(nextSort({ key: "ay", dir: "desc" }, "staff"), { key: "staff", dir: "asc" });
});

test("every sortable column says what its two directions mean", () => {
  // The header tooltip reads off these; a column with no hint would sort with
  // nothing to tell the user what it just did.
  for (const key of Object.keys(MATTER_SORT_COLUMNS)) {
    assert.ok(Array.isArray(MATTER_SORT_HINT[key]) && MATTER_SORT_HINT[key].length === 2, `${key} has no direction hints`);
    // And it must actually sort — a header cannot look clickable and do nothing.
    assert.doesNotThrow(() => sortMatters([m("1"), m("2")], key, "asc", { hearingDate: () => "" }));
  }
});
