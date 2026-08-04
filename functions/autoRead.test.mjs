/* The rule that decides which orders get read without anybody asking.
 *
 * This is the only thing in the intimation feature that spends money on its own,
 * so what it will and will not pay for is asserted directly. The guards are
 * re-implemented here rather than imported, because functions/index.js pulls in
 * firebase-admin and cannot be loaded in a bare test run — so this file is the
 * SPECIFICATION, and functions/index.js must match it. Both are short enough
 * that a divergence is visible in a diff.
 *
 * Run:  node --test functions/autoRead.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

const AUTO_READ_MIN_RUPEES = 1000;
const AUTO_READ_MAX_AGE_DAYS = 14 * 30;

function autoReadable(order, todayMs) {
  if (!order || !order.storagePath || order.locked) return false;
  if (order.reading || order.readingError) return false;
  const v = order.variance;
  if (!v || v.flag !== "red") return false;
  if (Math.abs(v.amount || 0) < AUTO_READ_MIN_RUPEES) return false;
  if (!order.orderDate) return false;
  const age = (todayMs - Date.parse(`${order.orderDate}T00:00:00Z`)) / 86400000;
  return Number.isFinite(age) && age <= AUTO_READ_MAX_AGE_DAYS;
}

const NOW = Date.parse("2026-08-04T00:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 10);

const order = (over = {}) => ({
  commRefNo: "REF1",
  storagePath: "p/a.pdf",
  locked: false,
  orderDate: daysAgo(30),
  variance: { flag: "red", amount: -50000 },
  ...over,
});

test("a recent, material, red order with a readable PDF is read", () => {
  assert.equal(autoReadable(order(), NOW), true);
});

/* ---------------- red only ---------------- */

test("nothing but a red flag is ever read automatically", () => {
  for (const flag of ["green", "neutral", "unknown"]) {
    assert.equal(autoReadable(order({ variance: { flag, amount: -50000 } }), NOW), false, flag);
  }
  assert.equal(autoReadable(order({ variance: null }), NOW), false, "and not an order with no variance yet");
});

/* ---------------- material only ---------------- */

test("below ₹1,000 the explanation is not worth buying", () => {
  assert.equal(autoReadable(order({ variance: { flag: "red", amount: -999 } }), NOW), false);
  assert.equal(autoReadable(order({ variance: { flag: "red", amount: -1000 } }), NOW), true, "the threshold itself qualifies");
});

/* ---------------- recent only ---------------- */

test("orders older than fourteen months are left to the button", () => {
  assert.equal(autoReadable(order({ orderDate: daysAgo(14 * 30) }), NOW), true, "exactly fourteen months still qualifies");
  assert.equal(autoReadable(order({ orderDate: daysAgo(14 * 30 + 1) }), NOW), false);
  assert.equal(autoReadable(order({ orderDate: daysAgo(1500) }), NOW), false, "a 2022 order is not read unasked");
});

test("an order with no date is not read", () => {
  // Age cannot be judged, and an unbounded window is how a back history gets
  // read all at once.
  assert.equal(autoReadable(order({ orderDate: "" }), NOW), false);
});

/* ---------------- once only ---------------- */

test("an order already read, or already failed, is not read again", () => {
  assert.equal(autoReadable(order({ reading: { engine: 2 } }), NOW), false);
  assert.equal(autoReadable(order({ readingError: "the PDF was unreadable" }), NOW), false);
});

/* ---------------- readable at all ---------------- */

test("an order with no usable PDF is skipped rather than attempted", () => {
  assert.equal(autoReadable(order({ storagePath: null }), NOW), false);
  assert.equal(autoReadable(order({ locked: true }), NOW), false);
});

/* ---------------- the shape of a bad day ---------------- */

test("a whole back history becoming red at once stays bounded", () => {
  /* Deploying an engine change rewrites every return document, so the trigger
     can see a practice's entire history at once. The age window is what turns
     that from hundreds of reads into a handful — the daily cap is the backstop
     behind it, not the first line of defence. */
  const history = Array.from({ length: 200 }, (_, i) =>
    order({ commRefNo: `R${i}`, orderDate: daysAgo(30 + i * 30) }));
  const eligible = history.filter((o) => autoReadable(o, NOW));
  assert.ok(
    eligible.length < history.length / 10,
    `the window should leave a small fraction of ${history.length} eligible, not ${eligible.length}`
  );
  // At a monthly cadence that is the fourteen months the window allows, and it
  // stays under the 50-a-day cap with room to spare.
  assert.equal(eligible.length, 14);
});
