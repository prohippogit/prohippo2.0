/*
 * What an intimation u/s 143(1) or a rectification order u/s 154 actually did to
 * the assessee's position — worked out in arithmetic, from figures the portal
 * already gave us. No AI, no PDF, no network.
 *
 * THE TWO SIDES OF THE COMPARISON.
 *
 *   CPC's side      the net demand or refund the order determined. Arrives in
 *                   the activity row's own detail blob and is stored on the
 *                   order as `demand` / `refund` (connector/src/main/
 *                   portalReturns.js → functions/index.js ingestPortalReturn).
 *   The assessee's  the net position the return itself closed at, read by
 *   side            functions/itrTaxPosition.js from the filed ITR JSON.
 *
 * Both are net of taxes paid, and both use the one sign convention: POSITIVE IS
 * MONEY COMING BACK. So the difference is a single subtraction, and its sign is
 * the flag — negative means CPC left the assessee worse off than the return
 * claimed, positive means better.
 *
 * WHY 154 IS NOT COMPARED AGAINST THE RETURN.
 *
 * A rectification order revises the 143(1) intimation that came before it, not
 * the return. Measured against the return, a s.154 order that CORRECTED a
 * ₹2,00,000 CPC error reads as a ₹2,00,000 variance and gets flagged — when
 * what actually happened is that the practitioner won. Measured against the
 * intimation it rectified, it reads as +₹2,00,000, green, which is the truth.
 *
 * So the baseline for a s.154 order is the most recent EARLIER order for the
 * same assessment year that carries a figure, and only when there is no such
 * order does it fall back to the return. `baseline.kind` records which was used,
 * and the UI says so — a difference is meaningless without the thing it is a
 * difference from.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO.
 *
 * It does not explain the difference. Whether ₹1,24,560 is a disallowed
 * deduction, a TDS credit mismatch or 234B interest is in the intimation PDF's
 * own comparison table, and reading that is Phase 2. Everything here is a
 * quantity the portal states in figures, so it can be trusted without a
 * practitioner checking it against the document — which is exactly the property
 * an automatic red flag has to have.
 */
"use strict";

/* Bump when the arithmetic or the baseline rule changes. Stored on every
   variance so a recompute can find the ones written by an older engine instead
   of trusting whatever is on the document.

   2 — the order's position is read from its CPC STATUS instead of by netting
       the demand and refund fields against each other. Engine 1 reported a
       ₹1,83,744 demand on an intimation that raised none. */
const VARIANCE_ENGINE = 2;

/* Differences at or below this are not reported.
 *
 * s.288A and s.288B round total income and tax to the nearest ₹10, and CPC and
 * the return's own software round at different points in the working, so small
 * differences are the norm and mean nothing. ₹100 is comfortably above that
 * noise and far below anything worth a practitioner's attention. Without it the
 * card flags ₹8 differences and is ignored inside a week. */
const MATERIALITY_RUPEES = 100;

/* CPC statuses where the refund determined was set off against an earlier
   demand u/s 245 (portalReturns.js ORDER_ACTIVITIES: refund fully / partly
   adjusted, on both the 143(1) and the 154 side).

   This does NOT change the flag. The refund CPC determined is still the refund
   it determined, and comparing it to the refund claimed is still valid — the
   set-off is a separate matter, the recovery of a past year's demand. But a
   practitioner reading "refund ₹80,000" needs to know none of it is arriving,
   so the fact is carried alongside and the UI says it. */
// 613 is the later variant of 75 (see ORDER_ACTIVITIES in portalReturns.js) and
// was missed when this set was first written — an order under it went unlabelled
// and a practitioner would have been told a refund was coming when it had in
// fact been set off.
const ADJUSTMENT_ACTIVITY_CODES = new Set(["64", "65", "74", "75", "613"]);

/* A rupee figure the portal sends as a string, which may be "", "null" or "0".
   Anything that is not a real number is "the portal did not say" — never zero.
   Same rule as portalAmount() in src/Assessees.jsx and num() in
   itrTaxPosition.js; a nil and a blank are different things in a tax record. */
function amount(v) {
  if (v === null || v === undefined || v === "" || v === "null") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* WHAT THIS ORDER DID, read from its CPC STATUS — not by netting.
 *
 * THE MISTAKE THIS REPLACES, because it produced confident, badly wrong figures
 * on real client files. Engine 1 computed `refund − demand` from the two fields
 * the portal sends. On an order where CPC determines a refund and sets it off
 * u/s 245, the portal populates BOTH: the refund it determined, and the
 * OUTSTANDING DEMAND OF EARLIER YEARS the refund went towards. Netting them
 * reported the other years' arrears as a demand raised by this intimation.
 *
 * A real case: an A.Y. 2022-23 intimation agreeing with the return line for
 * line, determining a ₹180 refund, fully adjusted against an A.Y. 2017 demand.
 * The order itself says "There is no payment due." Engine 1 called it
 * "₹1,83,744 worse vs the return as filed", in red, because ₹1,83,744 was the
 * balance outstanding across 2017, 2018 and 2019.
 *
 * The status already says which figure belongs to this order, so ask it. The
 * codes are ORDER_ACTIVITIES in connector/src/main/portalReturns.js.
 */
const OUTCOME_BY_ACTIVITY = {
  61: "demand", // 143(1) processed, demand determined
  62: "refund", // 143(1) processed, refund determined
  63: "nil",    // 143(1) processed, no demand no refund
  64: "refund", // refund determined and fully adjusted u/s 245
  65: "refund", // refund determined and partly adjusted u/s 245
  71: "demand", // rectification processed, demand due
  72: "refund", // rectification processed, refund due
  73: "nil",    // rectification processed, no refund due
  74: "refund", // rectification refund fully adjusted
  75: "refund", // rectification refund partly adjusted
  613: "refund", // later variant of 75
};

/* The order's position, on the sign convention used everywhere here: positive
   is money coming back. Null means the order did not tell us. */
function cpcNet(order) {
  const demand = amount(order && order.demand);
  const refund = amount(order && order.refund);
  const outcome = OUTCOME_BY_ACTIVITY[Number(order && order.activityCd)];

  if (outcome === "nil") return 0;              // CPC stated it: neither side
  if (outcome === "demand") return demand === null ? null : -demand;
  if (outcome === "refund") return refund === null ? null : refund;

  /* An activity code we do not recognise — a new CPC status, most likely.
   *
   * One figure alone is unambiguous and is used. BOTH figures with no status to
   * disambiguate them is exactly the situation that produced the bug above, so
   * it reports "could not be compared" instead of guessing. A gap a
   * practitioner can see beats a number they cannot check. */
  if (demand === null && refund === null) return null;
  if (!demand && !refund) return 0;             // both stated, both nil
  if (demand && refund) return null;            // ambiguous — do not guess
  return refund ? refund : -demand;
}

function unknown(note, cpc) {
  return {
    engine: VARIANCE_ENGINE,
    cpcNet: cpc === undefined ? null : cpc,
    amount: null,
    flag: "unknown",
    direction: "unknown",
    baseline: null,
    adjusted: false,
    note,
  };
}

/**
 * Variance for one order, given the orders that precede it and the return's own
 * position.
 *
 * @param entry    { order, net, date } for the order being judged
 * @param priors   the same shape for every order EARLIER in the year, oldest
 *                 first. Only read for s.154.
 * @param position the return's tax position (itrTaxPosition.readTaxPosition), or
 *                 null when the ITR JSON isn't on file
 */
function varianceFor(entry, priors, position) {
  const order = entry.order || {};
  const adjusted = ADJUSTMENT_ACTIVITY_CODES.has(String(order.activityCd || ""));

  if (entry.net === null) {
    return {
      ...unknown(
        amount(order.demand) && amount(order.refund)
          ? "The portal recorded both a demand and a refund against this order under a status we do not recognise, so which one belongs to this order cannot be told apart."
          : "The portal recorded this order without a demand or refund figure.",
        null
      ),
      adjusted,
    };
  }

  const direction = entry.net > 0 ? "refund" : entry.net < 0 ? "demand" : "nil";

  /* The baseline. For s.154, the order it rectified; otherwise the return.
     Walking priors backwards finds the most recent one first — the order a
     rectification actually revises is the one immediately before it, not the
     original 143(1) two rectifications ago. */
  let baseline = null;
  if (String(order.section || "") === "154") {
    for (let i = priors.length - 1; i >= 0; i--) {
      const p = priors[i];
      if (p.net === null) continue;
      // Same-day orders are not safely orderable, and a baseline picked from a
      // tie is a coin toss presented as a fact. Skip to a genuinely earlier one.
      if (entry.date && p.date && p.date >= entry.date) continue;
      baseline = {
        kind: "order",
        ref: String(p.order.commRefNo || ""),
        section: p.order.section || "",
        date: p.date || "",
        net: p.net,
      };
      break;
    }
  }

  if (!baseline) {
    const net = position && position.netPayable;
    if (net === null || net === undefined) {
      return {
        ...unknown(
          String(order.section || "") === "154"
            ? "No earlier order and no filed return on file to compare this rectification against."
            : "The filed return's own tax position could not be read, so there is nothing to compare against.",
          entry.net
        ),
        direction,
        adjusted,
      };
    }
    baseline = { kind: "return", ref: "", section: "", date: "", net };
  }

  const diff = entry.net - baseline.net;
  const flag =
    Math.abs(diff) <= MATERIALITY_RUPEES ? "neutral" : diff < 0 ? "red" : "green";

  return {
    engine: VARIANCE_ENGINE,
    cpcNet: entry.net,
    baseline,
    amount: diff,
    flag,
    direction,
    adjusted,
    note: "",
  };
}

/**
 * Attach a `variance` to every order of one assessment year.
 *
 * Returns a NEW array in the SAME order as the input — the caller's sort (newest
 * first, in ingestPortalReturn) is its own business and must survive this.
 *
 * @param orders   the year's orders, as stored on the return document
 * @param position the return's tax position, or null
 */
function computeVariances(orders, position) {
  const list = Array.isArray(orders) ? orders : [];

  /* Chronological, because "which order came before this one" is the whole
     question for s.154. Index breaks ties so the result is deterministic for
     orders sharing a date (or having none) — an unstable sort here would make
     the same input produce different baselines on different runs. */
  const seq = list
    .map((order, i) => ({ order: order || {}, i, net: cpcNet(order), date: String((order && order.orderDate) || "") }))
    .sort((a, b) => (a.date === b.date ? a.i - b.i : a.date < b.date ? -1 : 1));

  const byIndex = new Map();
  seq.forEach((entry, pos) => byIndex.set(entry.i, varianceFor(entry, seq.slice(0, pos), position)));

  return list.map((order, i) => ({ ...order, variance: byIndex.get(i) || unknown("Not computed.") }));
}

/** Counts and totals for a set of orders carrying variances. */
function summariseVariances(orders) {
  const out = { red: 0, green: 0, neutral: 0, unknown: 0, adjusted: 0, additionalDemand: 0, extraRefund: 0 };
  for (const o of orders || []) {
    const v = o && o.variance;
    if (!v) continue;
    if (v.flag === "red") { out.red += 1; out.additionalDemand += Math.abs(v.amount || 0); }
    else if (v.flag === "green") { out.green += 1; out.extraRefund += Math.abs(v.amount || 0); }
    else if (v.flag === "neutral") out.neutral += 1;
    else out.unknown += 1;
    if (v.adjusted) out.adjusted += 1;
  }
  return out;
}

module.exports = {
  computeVariances,
  OUTCOME_BY_ACTIVITY,
  summariseVariances,
  cpcNet,
  amount,
  VARIANCE_ENGINE,
  MATERIALITY_RUPEES,
  ADJUSTMENT_ACTIVITY_CODES,
};
