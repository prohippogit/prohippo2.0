/* Unit tests for the AI read of an intimation PDF.
 *
 * The model is not on trial here — the CHECK on the model is. What these pin
 * down is that a bad read announces itself instead of arriving as a confident
 * table, and that nothing the model says can move the flag.
 *
 * Run:  node --test functions/intimationReading.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { normaliseReading, changedLines, netOf, CAUSE_IDS } = require("./intimationReading.js");

// A red variance: the return claimed a ₹40,000 refund, CPC raised ₹10,000.
const variance = (over = {}) => ({
  engine: 1, cpcNet: -10000, amount: -50000,
  baseline: { kind: "return", ref: "", net: 40000 },
  flag: "red", direction: "demand", adjusted: false, note: "", ...over,
});

// A faithful read of the same order.
const good = (over = {}) => ({
  lines: [
    { head: "Gross total income", asReturned: 1240000, asComputed: 1240000 },
    { head: "Deduction u/s 80C", asReturned: 150000, asComputed: 0, remark: "Not allowable" },
    { head: "Total income", asReturned: 1090000, asComputed: 1240000 },
  ],
  taxPayableAsReturned: 0,
  refundClaimedAsReturned: 40000,
  demandRaised: 10000,
  refundDetermined: 0,
  headline: "80C deduction of ₹1,50,000 disallowed",
  cause: "deduction-viA",
  ...over,
});

/* ---------------- the sign convention ---------------- */

test("positive is money coming back, on both sides of the table", () => {
  assert.equal(netOf(10000, 0), -10000, "a demand is negative");
  assert.equal(netOf(0, 40000), 40000, "a refund is positive");
  assert.equal(netOf(null, null), null, "neither stated is null, never zero");
  assert.equal(netOf(0, 0), 0, "a nil position is zero, not null");
});

/* ---------------- reconciliation ---------------- */

test("a faithful read reconciles", () => {
  const out = normaliseReading(good(), { variance: variance() });
  assert.equal(out.reconciles, true);
  assert.equal(out.reconcileNote, "");
  assert.equal(out.netAsComputed, -10000);
  assert.equal(out.netAsReturned, 40000);
});

test("a misread total fails loudly rather than arriving as a confident table", () => {
  /* THE case this module exists for. The model read ₹1,00,000 where the portal
     recorded ₹10,000 — a plausible digit slip — and every line below it would
     have looked perfectly reasonable. */
  const out = normaliseReading(good({ demandRaised: 100000 }), { variance: variance() });
  assert.equal(out.reconciles, false);
  assert.match(out.reconcileNote, /does not match the figure the portal recorded/);
  assert.ok(out.lines.length, "the breakdown is kept — flagged, not thrown away");
});

test("columns that disagree with the return on file point at a revised return", () => {
  // Bottom line matches the portal, but the "as returned" column belongs to a
  // different return from the one we hold.
  const out = normaliseReading(good({ refundClaimedAsReturned: 90000 }), { variance: variance() });
  assert.equal(out.reconciles, false);
  assert.match(out.reconcileNote, /revised return/);
});

test("a s.154 order is not checked against its own 'as returned' column", () => {
  /* A rectification is measured against the intimation it rectified, but the
     PDF still prints the ORIGINAL return in the left column. Comparing them
     would fail every single rectification. */
  const v = variance({ baseline: { kind: "order", ref: "INT1", net: -10000 }, amount: 10000, cpcNet: 0 });
  const out = normaliseReading(
    good({ demandRaised: 0, refundDetermined: 0, refundClaimedAsReturned: 40000, taxPayableAsReturned: 0 }),
    { variance: v }
  );
  assert.equal(out.reconciles, true, "the bottom line still has to match, and does");
});

test("an unreadable total is unchecked, not wrong", () => {
  const out = normaliseReading(good({ demandRaised: null, refundDetermined: null }), { variance: variance() });
  assert.equal(out.reconciles, null);
  assert.match(out.reconcileNote, /could not be read/);
});

test("with no portal figure there is nothing to check against", () => {
  const out = normaliseReading(good(), { variance: { cpcNet: null } });
  assert.equal(out.reconciles, null);
});

/* ---------------- the model cannot move the flag ---------------- */

test("nothing the model returns appears as a flag or an amount", () => {
  const out = normaliseReading(good({ flag: "green", amount: 999999, variance: "nonsense" }), { variance: variance() });
  assert.equal(out.flag, undefined, "a reading never carries a flag");
  assert.equal(out.amount, undefined, "nor an amount that could be mistaken for the variance");
  assert.equal(out.engine, 1);
});

/* ---------------- the suggested cause ---------------- */

test("a cause is only ever a suggestion until somebody accepts it", () => {
  const out = normaliseReading(good(), { variance: variance() });
  assert.equal(out.suggestedCause, "deduction-viA");
  assert.equal(out.causeAccepted, false, "it must not count anywhere until confirmed");
});

test("a cause the app does not know is dropped, not passed through", () => {
  // An id only the model knows would key a by-cause group nothing can render.
  const out = normaliseReading(good({ cause: "invented-by-the-model" }), { variance: variance() });
  assert.equal(out.suggestedCause, "");
});

/* ---------------- the table itself ---------------- */

test("only the lines that actually moved are the ones to argue about", () => {
  const out = normaliseReading(good(), { variance: variance() });
  const moved = changedLines(out);
  assert.deepEqual(moved.map((l) => l.head), ["Deduction u/s 80C", "Total income"]);
});

test("a nameless row is dropped as mis-parsed table noise", () => {
  const out = normaliseReading(good({ lines: [{ head: "", asReturned: 1, asComputed: 2 }, { head: "Real", asReturned: 1, asComputed: 2 }] }), { variance: variance() });
  assert.deepEqual(out.lines.map((l) => l.head), ["Real"]);
});

test("a blank figure stays blank rather than becoming nil", () => {
  const out = normaliseReading(good({ lines: [{ head: "Relief u/s 89", asReturned: null, asComputed: 5000 }] }), { variance: variance() });
  assert.equal(out.lines[0].asReturned, null);
  assert.equal(changedLines(out).length, 0, "a line with only one side cannot be said to have moved");
});

test("garbage in does not throw", () => {
  for (const input of [null, undefined, "a string", 42, { lines: "not an array" }]) {
    const out = normaliseReading(input, { variance: variance() });
    assert.deepEqual(out.lines, []);
    assert.equal(out.suggestedCause, "");
  }
});

test("an absurd number of rows is capped", () => {
  const lines = Array.from({ length: 200 }, (_, i) => ({ head: `Row ${i}`, asReturned: 1, asComputed: 1 }));
  assert.equal(normaliseReading(good({ lines }), { variance: variance() }).lines.length, 40);
});

/* ---------------- the vocabulary ---------------- */

test("every statutory ground has a cause id", () => {
  for (const id of ["arithmetic", "incorrect-claim", "loss-late-return", "audit-report", "80ac", "form-26as"]) {
    assert.ok(CAUSE_IDS.includes(id), `${id} is missing from the model's vocabulary`);
  }
  assert.ok(CAUSE_IDS.includes("other"));
});
