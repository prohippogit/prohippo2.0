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
const { normaliseReading, changedLines, netOf, CAUSE_IDS, READING_ENGINE } = require("./intimationReading.js");

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
  assert.equal(out.engine, READING_ENGINE);
});

/* A read may SUPPLY the figure where the portal sent none (returnVariance.js
   documentNet), and the moment it does, this reconciliation has nothing left to
   check: both numbers now come from the same read of the same page. Saying
   "reconciles" there would dress one unverified source up as two agreeing ones,
   which is the exact failure the whole check exists to prevent. */
test("a read is never reconciled against a figure that came from a read", () => {
  const out = normaliseReading(good(), { variance: variance({ source: "document", cpcNet: -10000 }) });
  assert.equal(out.reconciles, null, "not true, however well the numbers match");
  assert.match(out.reconcileNote, /nothing independent/);
});

test("a portal-sourced figure is still checked as before", () => {
  const out = normaliseReading(good(), { variance: variance({ source: "portal" }) });
  assert.equal(out.reconciles, true);
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


/* ---------------- earlier years' arrears ---------------- */

test("the adjustment annexure is read, and kept apart from this order", () => {
  /* From the real A.Y. 2022-23 order: a ₹180 refund set off against A.Y. 2017,
     with ₹1,43,720 still outstanding across 2017-2019. None of it may reach the
     order's own position — mixing the two is exactly what put a ₹1,83,744
     demand on an order that raised none. */
  const out = normaliseReading(good({
    outstandingDemands: [
      { ay: "2017", demandReference: "2019201737068445885T", amount: 180, adjusted: true },
      { ay: "2017", demandReference: "2019201737068445885T", amount: 76240, adjusted: false },
      { ay: "2019", demandReference: "2019201937111008795T", amount: 67470, adjusted: false },
      { ay: "2018", demandReference: "2019201837104829600T", amount: 10, adjusted: false },
    ],
  }), { variance: variance() });

  assert.equal(out.arrearsAdjusted, 180, "money taken from this refund");
  assert.equal(out.arrearsOutstanding, 143720, "money still owed for other years");
  assert.equal(out.outstandingDemands.length, 4);
  assert.equal(out.netAsComputed, -10000, "this order's own position is untouched by any of it");
});

test("no annexure is an empty list, not a missing field", () => {
  const out = normaliseReading(good(), { variance: variance() });
  assert.deepEqual(out.outstandingDemands, []);
  assert.equal(out.arrearsAdjusted, 0);
  assert.equal(out.arrearsOutstanding, 0);
});

test("a demand row with no amount is dropped rather than shown as nil", () => {
  const out = normaliseReading(good({
    outstandingDemands: [
      { ay: "2017", demandReference: "X", amount: null },
      { ay: "2018", demandReference: "Y", amount: 0 },
      { ay: "2019", demandReference: "Z", amount: 500 },
    ],
  }), { variance: variance() });
  assert.deepEqual(out.outstandingDemands.map((d) => d.ay), ["2019"]);
});

test("an absurd annexure is capped", () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ ay: String(2000 + i), demandReference: `R${i}`, amount: 100 }));
  assert.equal(normaliseReading(good({ outstandingDemands: many }), { variance: variance() }).outstandingDemands.length, 30);
});

/* Pinned so that changing the prompt, the schema or the reconciliation without
   bumping the engine fails here — a stored reading has to be findable by the
   rules it was written under. */
test("a stored reading carries the engine that wrote it", () => {
  assert.equal(normaliseReading(good(), { variance: variance() }).engine, READING_ENGINE);
});

/* ============================================================================
   What the client actually receives.

   Worked from a real A.Y. 2024-25 order (Keshav Associates, AASFK5239P). Three
   figures, all correct, that the screen showed as one:

     2,29,840   refund claimed in the return          (line 26, taxpayer column)
     2,28,838   refund CPC computed                   (line 26, CPC column)
     + 3,432    interest u/s 244A                     (line 28)
     2,32,270   total refundable                      (lines 30 and 32)

   The ₹1,002 shortfall is the ₹1,000 fee u/s 234F plus ₹2 of s.288B rounding,
   and it is real. So is the ₹2,32,270 in the client's bank.
   ============================================================================ */

const keshav = (over = {}) => ({
  lines: [{ head: "Fee u/s 234F", asReturned: 0, asComputed: 1000 }],
  refundClaimedAsReturned: 229840,
  taxPayableAsReturned: 0,
  refundDetermined: 228838,
  demandRaised: 0,
  interestOnRefund: 3432,
  totalRefundable: 232270,
  cause: "fee-234f",
  ...over,
});

test("the refund plus its s.244A interest is what the client receives", () => {
  const out = normaliseReading(keshav(), { variance: variance({ cpcNet: 228838, amount: -1002 }) });
  assert.equal(out.netAsComputed, 228838, "still the portal-comparable figure");
  assert.equal(out.interestOnRefund, 3432);
  assert.equal(out.receivable, 232270);
  assert.equal(out.ladderNote, "");
});

test("the flag is still measured on the refund, never on the receivable", () => {
  /* Measuring 2,32,270 against the 2,29,840 claimed would report ₹2,430 in the
     assessee's favour and bury a real ₹1,002 disallowance under statutory
     interest. A return never claims interest on its own refund — the order
     prints "N/A" in that column — so the two are not comparable. */
  const out = normaliseReading(keshav(), { variance: variance({ cpcNet: 228838, amount: -1002 }) });
  assert.equal(out.reconciles, true, "the read still checks against the portal's 2,28,838");
  assert.equal(out.flag, undefined);
  assert.equal(out.amount, undefined);
});

test("a total that does not equal refund plus interest says so", () => {
  // The order prints all three, so the third is CHECKED rather than computed —
  // a model misreading one of them must not produce a total that adds up
  // because we made it add up.
  const out = normaliseReading(keshav({ totalRefundable: 999999 }), { variance: variance({ cpcNet: 228838 }) });
  assert.match(out.ladderNote, /does not come to the total/);
  assert.equal(out.receivable, 999999, "the order's own figure is still what is reported");
});

test("a demand order has no ladder beyond its own figure", () => {
  const out = normaliseReading(good(), { variance: variance() });
  assert.equal(out.interestOnRefund, null);
  assert.equal(out.receivable, null);
  assert.equal(out.ladderNote, "");
});

test("a refund order with no s.244A row earns no interest, which is not a gap", () => {
  const out = normaliseReading(
    keshav({ interestOnRefund: null, totalRefundable: 228838 }),
    { variance: variance({ cpcNet: 228838 }) }
  );
  assert.equal(out.interestOnRefund, null);
  assert.equal(out.receivable, 228838);
  assert.equal(out.ladderNote, "");
});

test("the reading engine is 4 now that the receivable is read", () => {
  assert.equal(READING_ENGINE, 4);
});

/* ============================================================================
   The one way a refund read goes wrong.

   From a real A.Y. 2023-24 order (Himanshu Champakbhai Soni, AMDPS6177P). A
   refund order prints its refund TWICE and the two differ:

     line 40  Refund amount [40=(39e-38)]        6,85,336   <- portal reports it
     line 42  Interest on refund u/s 244A       +   41,118
     line 46  Total amount refundable            7,26,450   <- banner, summary

   An earlier prompt told the model to fall back to the banner, and the banner
   on a refund order is the AFTER-interest figure. It came back as the refund
   determined, the check failed, and the screen said only "does not match" —
   true, and no help at all to the practitioner reading it.
   ============================================================================ */

const soni = (over = {}) => ({
  lines: [{ head: "TDS", asReturned: 1947727, asComputed: 1944998 }],
  refundClaimedAsReturned: 688070,
  taxPayableAsReturned: 0,
  refundDetermined: 685332,
  demandRaised: 0,
  interestOnRefund: 41118,
  totalRefundable: 726450,
  cause: "tds-credit",
  ...over,
});

test("the refund before interest reconciles and the after-interest total is carried", () => {
  const out = normaliseReading(soni(), { variance: variance({ cpcNet: 685332, amount: -2738 }) });
  assert.equal(out.reconciles, true);
  assert.equal(out.netAsComputed, 685332);
  assert.equal(out.interestOnRefund, 41118);
  assert.equal(out.receivable, 726450);
  assert.equal(out.ladderNote, "", "685332 + 41118 = 726450, so the order's own three figures agree");
});

test("taking the after-interest figure as the refund is named, not just reported", () => {
  // What actually came back off this order before the prompt was fixed.
  const out = normaliseReading(
    soni({ refundDetermined: 726450, interestOnRefund: 41118 }),
    { variance: variance({ cpcNet: 685332, amount: -2738 }) }
  );
  assert.equal(out.reconciles, false);
  assert.match(out.reconcileNote, /41118/);
  assert.match(out.reconcileNote, /interest u\/s 244A/);
  assert.match(out.reconcileNote, /AFTER interest where the portal reports it before/);
});

test("a mismatch that is not the interest is not blamed on the interest", () => {
  // A plain digit slip must keep the plain message — a wrong diagnosis is
  // worse than none.
  const out = normaliseReading(
    soni({ refundDetermined: 985332, interestOnRefund: 41118, totalRefundable: 726450 }),
    { variance: variance({ cpcNet: 685332 }) }
  );
  assert.equal(out.reconciles, false);
  assert.doesNotMatch(out.reconcileNote, /interest u\/s 244A/);
});

test("a demand read too high is never blamed on refund interest", () => {
  const out = normaliseReading(good({ demandRaised: 100000 }), { variance: variance() });
  assert.equal(out.reconciles, false);
  assert.doesNotMatch(out.reconcileNote, /244A/);
});
