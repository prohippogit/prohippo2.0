/* Unit tests for the intimation / rectification variance engine.
 *
 * These are the sums a red flag on the dashboard rests on. The cases that
 * matter most are the ones where a naive implementation is confidently wrong:
 * a s.154 order measured against the return instead of the intimation it
 * rectified, and a missing figure treated as nil.
 *
 * Run:  node functions/returnVariance.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { computeVariances, summariseVariances, cpcNet } = require("./returnVariance.js");

const order = (o) => ({ commRefNo: "REF1", section: "143(1)", activityCd: "61", orderDate: "2025-06-10", demand: "", refund: "", ...o });
const position = (netPayable) => ({ netPayable, balTaxPayable: netPayable < 0 ? -netPayable : 0, refundDue: netPayable > 0 ? netPayable : 0 });
const only = (orders, pos) => computeVariances(orders, pos)[0].variance;

/* ---------------- the net position ---------------- */

test("a demand is negative and a refund positive", () => {
  assert.equal(cpcNet({ demand: "50000", refund: "" }), -50000);
  assert.equal(cpcNet({ demand: "", refund: "50000" }), 50000);
  assert.equal(cpcNet({ demand: "0", refund: "0" }), 0);
});

test("an order stating neither figure is null, not zero", () => {
  assert.equal(cpcNet({ demand: "", refund: "null" }), null);
  assert.equal(cpcNet({}), null);
});

/* ---------------- 143(1) against the return ---------------- */

test("CPC demanding more than the return claimed is red", () => {
  // Return claimed a ₹40,000 refund; CPC raised a ₹10,000 demand instead.
  const v = only([order({ demand: "10000" })], position(40000));
  assert.equal(v.flag, "red");
  assert.equal(v.amount, -50000);
  assert.equal(v.baseline.kind, "return");
  assert.equal(v.direction, "demand");
});

test("CPC allowing more refund than claimed is green", () => {
  const v = only([order({ refund: "65000", activityCd: "62" })], position(40000));
  assert.equal(v.flag, "green");
  assert.equal(v.amount, 25000);
});

test("agreement with the return is neutral, not green", () => {
  const v = only([order({ refund: "40000", activityCd: "62" })], position(40000));
  assert.equal(v.flag, "neutral");
  assert.equal(v.amount, 0);
});

test("a rounding-sized difference is neutral", () => {
  // s.288A/288B rounding. Flagging these trains people to ignore the card.
  const v = only([order({ refund: "40060", activityCd: "62" })], position(40000));
  assert.equal(v.amount, 60);
  assert.equal(v.flag, "neutral");
});

test("materiality is a floor, not a rounding of the amount itself", () => {
  const v = only([order({ refund: "40101", activityCd: "62" })], position(40000));
  assert.equal(v.flag, "green");
  assert.equal(v.amount, 101, "the reported figure is exact even when the threshold is crossed by ₹1");
});

/* ---------------- 154 against the order it rectified ---------------- */

test("a rectification is measured against the intimation before it, not the return", () => {
  /* The case this whole baseline rule exists for. The return claimed a ₹40,000
     refund, CPC's 143(1) wrongly raised a ₹2,00,000 demand, and the s.154
     rectification put it right. Against the RETURN the 154 still reads as a
     ₹40,000 shortfall; against the intimation it corrected it reads as the
     ₹2,00,000 win it actually was. */
  const orders = [
    order({ commRefNo: "INT1", section: "143(1)", activityCd: "61", orderDate: "2025-06-10", demand: "200000" }),
    order({ commRefNo: "RECT1", section: "154", activityCd: "73", orderDate: "2025-11-02", demand: "0", refund: "0" }),
  ];
  const out = computeVariances(orders, position(40000));
  const rect = out[1].variance;
  assert.equal(rect.baseline.kind, "order");
  assert.equal(rect.baseline.ref, "INT1");
  assert.equal(rect.amount, 200000);
  assert.equal(rect.flag, "green");
  // …while the intimation itself is still judged against the return.
  assert.equal(out[0].variance.baseline.kind, "return");
  assert.equal(out[0].variance.amount, -240000);
  assert.equal(out[0].variance.flag, "red");
});

test("a second rectification is measured against the first, not the original intimation", () => {
  const orders = [
    order({ commRefNo: "INT1", section: "143(1)", orderDate: "2025-01-05", demand: "300000" }),
    order({ commRefNo: "RECT1", section: "154", activityCd: "71", orderDate: "2025-05-05", demand: "100000" }),
    order({ commRefNo: "RECT2", section: "154", activityCd: "71", orderDate: "2025-09-05", demand: "160000" }),
  ];
  const out = computeVariances(orders, position(0));
  assert.equal(out[2].variance.baseline.ref, "RECT1");
  assert.equal(out[2].variance.amount, -60000, "the second rectification took ₹60,000 back off the first");
  assert.equal(out[2].variance.flag, "red");
});

test("a rectification with no earlier order falls back to the return", () => {
  // Happens when the 143(1) predates what the sync holds for the year.
  const v = only([order({ commRefNo: "RECT1", section: "154", activityCd: "71", demand: "5000" })], position(0));
  assert.equal(v.baseline.kind, "return");
  assert.equal(v.amount, -5000);
});

test("an order on the same day is not used as a baseline", () => {
  // Same-day orders cannot be reliably sequenced; a baseline picked from a tie
  // is a coin toss presented as a fact.
  const orders = [
    order({ commRefNo: "INT1", section: "143(1)", orderDate: "2025-06-10", demand: "70000" }),
    order({ commRefNo: "RECT1", section: "154", activityCd: "71", orderDate: "2025-06-10", demand: "20000" }),
  ];
  const out = computeVariances(orders, position(0));
  assert.equal(out[1].variance.baseline.kind, "return");
});

test("chronology decides the baseline, not the stored order of the array", () => {
  // ingestPortalReturn stores orders newest-first; the engine must not care.
  const orders = [
    order({ commRefNo: "RECT1", section: "154", activityCd: "71", orderDate: "2025-11-02", demand: "50000" }),
    order({ commRefNo: "INT1", section: "143(1)", orderDate: "2025-06-10", demand: "90000" }),
  ];
  const out = computeVariances(orders, position(0));
  assert.equal(out[0].commRefNo, "RECT1", "input order is preserved");
  assert.equal(out[0].variance.baseline.ref, "INT1");
  assert.equal(out[0].variance.amount, 40000);
});

/* ---------------- what cannot be judged ---------------- */

test("an order with no figure is unknown, never neutral", () => {
  const v = only([order({ demand: "", refund: "" })], position(40000));
  assert.equal(v.flag, "unknown");
  assert.equal(v.amount, null);
  assert.match(v.note, /without a demand or refund/);
});

test("no readable return position means unknown, not a zero baseline", () => {
  /* The failure that would matter most: treating an unreadable return as a nil
     position turns every intimation into a full-value red or green flag. */
  const v = only([order({ demand: "10000" })], null);
  assert.equal(v.flag, "unknown");
  assert.equal(v.cpcNet, -10000, "CPC's own figure is still reported");
  assert.match(v.note, /could not be read/);
});

test("a position with a null net is not treated as zero", () => {
  const v = only([order({ demand: "10000" })], { netPayable: null });
  assert.equal(v.flag, "unknown");
});

/* ---------------- refunds adjusted u/s 245 ---------------- */

test("an adjusted refund is marked, and still judged on its own figures", () => {
  /* Codes 64/65/74/75: CPC determined a refund and set it off against an earlier
     demand. The comparison against the return is still valid — the set-off is a
     different matter — but the practitioner has to be told none of it arrives. */
  const v = only([order({ refund: "80000", activityCd: "64" })], position(80000));
  assert.equal(v.adjusted, true);
  assert.equal(v.flag, "neutral", "the set-off does not change what CPC determined");
});

test("adjustment is recorded even on an order that cannot be judged", () => {
  const v = only([order({ activityCd: "75", demand: "", refund: "" })], position(0));
  assert.equal(v.flag, "unknown");
  assert.equal(v.adjusted, true);
});

/* ---------------- shape guarantees ---------------- */

test("input order and every original field survive", () => {
  const orders = [order({ commRefNo: "A", storagePath: "p/a.pdf", locked: true })];
  const out = computeVariances(orders, position(0));
  assert.equal(out[0].storagePath, "p/a.pdf");
  assert.equal(out[0].locked, true);
  assert.equal(out[0].commRefNo, "A");
  assert.equal(out[0].variance.engine, 1);
});

test("no orders is an empty array, not a throw", () => {
  assert.deepEqual(computeVariances([], position(0)), []);
  assert.deepEqual(computeVariances(null, null), []);
});

test("the summary totals red and green separately and counts what it could not judge", () => {
  const orders = computeVariances(
    [
      order({ commRefNo: "A", demand: "10000" }),                                  // red, −50000
      order({ commRefNo: "B", orderDate: "2025-07-01", refund: "90000", activityCd: "62" }), // green, +50000
      order({ commRefNo: "C", orderDate: "2025-08-01", refund: "40000", activityCd: "64" }), // neutral, adjusted
      order({ commRefNo: "D", orderDate: "2025-09-01" }),                           // unknown
    ],
    position(40000)
  );
  const s = summariseVariances(orders);
  assert.deepEqual(
    { red: s.red, green: s.green, neutral: s.neutral, unknown: s.unknown, adjusted: s.adjusted },
    { red: 1, green: 1, neutral: 1, unknown: 1, adjusted: 1 }
  );
  assert.equal(s.additionalDemand, 50000);
  assert.equal(s.extraRefund, 50000);
});
