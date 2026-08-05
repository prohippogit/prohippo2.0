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
const { computeVariances, summariseVariances, cpcNet, cpcPosition, directionFor, VARIANCE_ENGINE } = require("./returnVariance.js");

/* Default status is 61 — "processed, demand determined" — so a fixture carrying
   a demand is self-consistent. Fixtures carrying a refund set activityCd: "62". */
const order = (o) => ({ commRefNo: "REF1", section: "143(1)", activityCd: "61", orderDate: "2025-06-10", demand: "", refund: "", ...o });
const position = (netPayable) => ({ netPayable, balTaxPayable: netPayable < 0 ? -netPayable : 0, refundDue: netPayable > 0 ? netPayable : 0 });
const only = (orders, pos, at = 0) => computeVariances(orders, pos)[at].variance;

/* ---------------- the net position ---------------- */

test("a demand is negative and a refund positive", () => {
  assert.equal(cpcNet({ activityCd: "61", demand: "50000", refund: "" }), -50000);
  assert.equal(cpcNet({ activityCd: "62", demand: "", refund: "50000" }), 50000);
  assert.equal(cpcNet({ activityCd: "63", demand: "0", refund: "0" }), 0);
});

test("an order stating neither figure is null, not zero", () => {
  assert.equal(cpcNet({ activityCd: "62", demand: "", refund: "null" }), null);
  assert.equal(cpcNet({}), null);
});

/* ---------------- the status decides, not the arithmetic ---------------- */

test("a refund set off u/s 245 is a refund, not a demand", () => {
  /* THE BUG THIS RULE EXISTS FOR, from a real A.Y. 2022-23 order.
   *
   * CPC agreed with the return line for line, determined a ₹180 refund, and
   * adjusted it in full against an A.Y. 2017 demand. The portal's row carries
   * BOTH the ₹180 and the ₹1,83,744 outstanding across 2017-2019. Netting them
   * reported "₹1,83,744 worse vs the return as filed", in red, on an order whose
   * own words are "There is no payment due." */
  const order = { activityCd: "64", section: "143(1)", demand: "183744", refund: "180" };
  assert.equal(cpcNet(order), 180, "the ₹1,83,744 belongs to other years, not to this order");

  const v = only([order], position(180));
  assert.equal(v.flag, "neutral", "the return claimed ₹180 and CPC allowed ₹180 — they agree");
  assert.equal(v.amount, 0);
  assert.equal(v.adjusted, true, "and the set-off is still labelled");
});

test("every CPC status maps to the figure that belongs to this order", () => {
  const both = { demand: "90000", refund: "500" };
  assert.equal(cpcNet({ ...both, activityCd: "61" }), -90000, "61 demand determined");
  assert.equal(cpcNet({ ...both, activityCd: "62" }), 500, "62 refund determined");
  assert.equal(cpcNet({ ...both, activityCd: "63" }), 0, "63 no demand no refund");
  assert.equal(cpcNet({ ...both, activityCd: "64" }), 500, "64 refund fully adjusted");
  assert.equal(cpcNet({ ...both, activityCd: "65" }), 500, "65 refund partly adjusted");
  assert.equal(cpcNet({ ...both, activityCd: "71" }), -90000, "71 rectification demand due");
  assert.equal(cpcNet({ ...both, activityCd: "72" }), 500, "72 rectification refund due");
  assert.equal(cpcNet({ ...both, activityCd: "73" }), 0, "73 no refund due");
  assert.equal(cpcNet({ ...both, activityCd: "74" }), 500, "74 refund fully adjusted");
  assert.equal(cpcNet({ ...both, activityCd: "75" }), 500, "75 refund partly adjusted");
  assert.equal(cpcNet({ ...both, activityCd: "613" }), 500, "613 later variant of 75");
});

test("'no demand no refund' is a stated nil, not a silence", () => {
  // Engine 1 called these "not compared" — but CPC has said, in terms, that
  // neither side arises. Against a return that also closed nil, they agree.
  const v = only([order({ activityCd: "63", demand: "", refund: "", statusDesc: "ITR processed no demand no refund" })], position(0));
  assert.equal(v.flag, "neutral");
  assert.equal(v.cpcNet, 0);
});

test("an unknown status with both figures refuses to guess", () => {
  const v = only([order({ activityCd: "999", demand: "183744", refund: "180" })], position(180));
  assert.equal(v.flag, "unknown");
  assert.match(v.note, /cannot be told apart/);
});

test("an unknown status with one figure is unambiguous and used", () => {
  assert.equal(cpcNet({ activityCd: "999", demand: "70000", refund: "" }), -70000);
  assert.equal(cpcNet({ activityCd: "999", demand: "", refund: "70000" }), 70000);
  assert.equal(cpcNet({ activityCd: "999", demand: "0", refund: "0" }), 0);
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
  // The fixture's status is 61, so the note names the demand it says was
  // determined; what matters here is that no COMPARISON was invented from it.
  assert.match(v.note, /did not send the amount/);
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

/* ---------------- the order's own printed figure ----------------
 *
 * A real A.Y. 2024-25 intimation arrived under status 61 — "processed, demand
 * determined" — with both amount fields empty. The status said a demand
 * existed; the ₹6,540 was printed only in the PDF. The row read "not compared"
 * beside a document stating the figure in bold on page one.
 */

const read = (netAsComputed, over = {}) => ({ engine: 3, netAsComputed, reconciles: null, ...over });

test("where the portal sent no amount, the order's own total is used", () => {
  const v = only([order({ demand: "", refund: "", reading: read(-6540) })], position(0));
  assert.equal(v.cpcNet, -6540);
  assert.equal(v.source, "document", "and it says where it got that from");
  assert.equal(v.flag, "red");
  assert.equal(v.amount, -6540);
});

test("a portal figure is never overridden by a read", () => {
  /* The department's own systems against a model reading a page. There is no
     contest, and averaging them or preferring the later one would be worse than
     either. */
  const v = only([order({ demand: "10000", reading: read(-99999) })], position(0));
  assert.equal(v.cpcNet, -10000);
  assert.equal(v.source, "portal");
});

test("a read that failed its reconciliation is not evidence", () => {
  const v = only([order({ demand: "", reading: read(-6540, { reconciles: false }) })], position(0));
  assert.equal(v.cpcNet, null);
  assert.equal(v.flag, "unknown");
});

test("a read with no bottom line supplies nothing", () => {
  const v = only([order({ demand: "", reading: read(null) })], position(0));
  assert.equal(v.cpcNet, null);
  assert.equal(v.flag, "unknown");
});

test("a nil order still reads as nil, not as whatever the PDF said", () => {
  // Status 63 is CPC stating "no demand, no refund". That IS a figure.
  const v = only([order({ activityCd: "63", reading: read(-6540) })], position(0));
  assert.equal(v.cpcNet, 0);
  assert.equal(v.source, "portal");
});

test("a document-sourced figure can serve as a s.154 baseline", () => {
  const v = only(
    [
      order({ commRefNo: "A", demand: "", reading: read(-200000) }),
      order({ commRefNo: "B", section: "154", orderDate: "2025-09-01", refund: "40000", activityCd: "72" }),
    ],
    position(40000),
    1
  );
  assert.equal(v.baseline.kind, "order");
  assert.equal(v.amount, 240000, "the rectification put right a demand we only knew from the PDF");
});

test("cpcPosition reports the figure and its provenance together", () => {
  assert.deepEqual(cpcPosition(order({ demand: "500" })), { net: -500, source: "portal" });
  assert.deepEqual(cpcPosition(order({ demand: "", reading: read(700) })), { net: 700, source: "document" });
  assert.deepEqual(cpcPosition(order({ demand: "" })), { net: null, source: "" });
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

test("code 613 counts as an adjustment — it is the later variant of 75", () => {
  // Listed in ORDER_ACTIVITIES but missed from the set when it was first
  // written, so a 613 order announced a refund that had already been set off.
  const v = only([order({ refund: "50000", activityCd: "613", section: "154" })], position(0));
  assert.equal(v.adjusted, true);
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
  assert.equal(out[0].variance.engine, VARIANCE_ENGINE);
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

/* ---------------- uncomparable is not the same as unknown ----------------
 *
 * A real A.Y. 2024-25 order arrived under status 61 — "ITR processed, demand
 * determined" — with both amount fields empty. That a demand EXISTS is stated
 * by the department in structured data; only the amount is missing. The card
 * showed "Not compared" over a dash and threw the fact away.
 */

test("the status sets the direction even when no amount came with it", () => {
  const v = only([order({ activityCd: "61", demand: "", refund: "" })], position(0));
  assert.equal(v.flag, "unknown", "still not comparable — there is no figure");
  assert.equal(v.cpcNet, null);
  assert.equal(v.direction, "demand", "but which way it went is known");
  assert.match(v.note, /determined a demand/);
});

test("an amountless refund status says refund, not demand", () => {
  const v = only([order({ activityCd: "62", demand: "", refund: "" })], position(0));
  assert.equal(v.direction, "refund");
  assert.match(v.note, /determined a refund/);
});

test("a status we do not recognise claims no direction", () => {
  const v = only([order({ activityCd: "999", demand: "", refund: "" })], position(0));
  assert.equal(v.direction, "unknown");
  assert.match(v.note, /without a demand or refund figure/);
});

test("both figures under an unknown status still refuses to guess a direction", () => {
  const v = only([order({ activityCd: "999", demand: "5000", refund: "9000" })], position(0));
  assert.equal(v.direction, "unknown");
  assert.match(v.note, /cannot be told apart/);
});

test("directionFor reads the status alone, never the amounts", () => {
  assert.equal(directionFor({ activityCd: "61" }), "demand");
  assert.equal(directionFor({ activityCd: "72" }), "refund");
  assert.equal(directionFor({ activityCd: "63" }), "nil");
  assert.equal(directionFor({ activityCd: "" }), "unknown");
  assert.equal(directionFor(null), "unknown");
});
