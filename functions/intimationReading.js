/*
 * Turning an AI read of an intimation PDF into something a practitioner can
 * rely on — or into an honest "this did not reconcile".
 *
 * WHAT THE MODEL IS FOR, AND WHAT IT IS NOT FOR.
 *
 * The flag on an intimation — red, green, how much — is settled before this
 * module ever runs, by arithmetic on the figures the portal itself stated
 * (functions/returnVariance.js). Nothing here can change it. The model's only
 * job is to say WHICH LINE moved: the intimation prints a side-by-side table,
 * "as provided by the taxpayer in the return of income" against "as computed
 * under section 143(1)", and reading that table is the one thing a PDF is the
 * sole source of.
 *
 * THE RECONCILIATION IS THE WHOLE SAFEGUARD.
 *
 * An extracted table that looks plausible and is wrong is worse than no table,
 * because a practitioner would advise a client off it. So the model is also
 * asked for the order's own bottom line — the demand raised or the refund
 * determined — and that has to equal the figure the PORTAL already gave us,
 * to the rupee. It is an independent check: the portal's number came from the
 * activity feed, the model's came from the printed document, and they only
 * agree if the read was faithful.
 *
 * When they disagree the breakdown is kept but marked as not reconciling, and
 * the UI says so rather than showing a confident table nobody checked. A
 * failure that announces itself is worth far more than one that does not.
 *
 * The suggested cause is a SUGGESTION and is stored as one. A practitioner
 * accepts it before it counts anywhere, because the by-cause grouping drives
 * real decisions about which clients share a legal position.
 */
"use strict";

/* Bump when the prompt, the schema or the reconciliation changes, so a stored
   reading written by an older engine can be spotted and re-read.

   2 — also reads the order's outstanding-demand annexures.
   3 — a printed 0 is read as zero rather than as a blank, and a read is never
       reconciled against a figure that came from a read.
   4 — reads the s.244A interest and the total refundable, so the figure the
       client actually receives can be shown. */
const READING_ENGINE = 4;

/* Rupees. The portal reports whole rupees and so does the order, so anything
   above this is a genuine disagreement rather than rounding. Deliberately
   tighter than the materiality floor used for the flag: there we were asking
   "is this worth a practitioner's attention", here we are asking "did the model
   read the same document the portal was describing". */
const RECONCILE_TOLERANCE = 1;

/* The cause vocabulary the model may choose from.
 *
 * MUST STAY IN STEP WITH `CAUSES` in src/intimations.js — the ids are what the
 * by-cause grouping keys on, and a value only one side knows about would be
 * silently dropped on the way to the screen. test/intimations.test.mjs pins the
 * two lists together so drift fails a test rather than a practice. */
const CAUSE_IDS = [
  "arithmetic",
  "incorrect-claim",
  "loss-late-return",
  "audit-report",
  "80ac",
  "form-26as",
  "tds-credit",
  "challan",
  "deduction-viA",
  "rebate-87a",
  "interest-234",
  "fee-234f",
  "exemption",
  "other",
];

/* A rupee figure out of the model. Absent and unreadable both mean "the order
   did not say", never zero — the same rule the rest of this feature follows. */
function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const text = (v, max = 160) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/* The order's closing position as the PDF states it, on the one sign convention
   used everywhere in this feature: POSITIVE IS MONEY COMING BACK.
   Both sides are read as separate non-negative amounts and netted here rather
   than asking the model for a signed number — models get signs wrong, and a
   sign error would invert a demand into a refund. */
function netOf(payable, receivable) {
  const pay = num(payable);
  const recv = num(receivable);
  if (pay === null && recv === null) return null;
  return (recv || 0) - (pay || 0);
}

/* WHAT THE CLIENT ACTUALLY RECEIVES, which is not what the portal reports.
 *
 * The order computes the refund by netting the tax against the taxes paid, and
 * THEN adds interest u/s 244A and restates the total. The portal's
 * `computedRefndAmt` is the FIRST of those figures; the taxpayer's bank receives
 * the second.
 *
 * A real A.Y. 2024-25 order: refund on the computation ₹2,28,838, interest u/s
 * 244A ₹3,432, total refundable ₹2,32,270. The app showed ₹2,28,838 and the
 * client had ₹2,32,270 in the bank, and nothing on the screen joined the two.
 *
 * THE VARIANCE DOES NOT MOVE, and must not. The return's own column against
 * s.244A is printed "N/A" — a return never claims interest on its own refund —
 * so measuring ₹2,32,270 against the ₹2,29,840 claimed would compare a refund
 * WITH interest against one WITHOUT, report ₹2,430 "in the assessee's favour",
 * and hide a real ₹1,002 disallowance behind statutory interest. Interest is
 * compensation for CPC's delay, not CPC agreeing with the return. So this is
 * carried alongside, for display, and never reaches returnVariance.js.
 *
 * The order prints all three figures, so the third is checked against the first
 * two rather than computed from them — a model that misread one of them says so
 * instead of producing a total that adds up because we made it add up.
 */
function refundLadder(r, netAsComputed) {
  const interest = num(r.interestOnRefund);
  const total = num(r.totalRefundable);

  // A demand order has neither, and a refund order printing no 244A row simply
  // earned no interest. Both are "nothing more to say", not a gap.
  if (interest === null && total === null) {
    return { interestOnRefund: null, receivable: null, ladderNote: "" };
  }

  const receivable = total !== null ? total : (netAsComputed || 0) + (interest || 0);
  const implied = (netAsComputed || 0) + (interest || 0);
  const adds = total === null || Math.abs(total - implied) <= RECONCILE_TOLERANCE;

  return {
    interestOnRefund: interest,
    receivable,
    ladderNote: adds
      ? ""
      : `The order's refund (${netAsComputed}) plus its s.244A interest (${interest || 0}) does not come to the total it states (${total}). One of the three was misread — check the order.`,
  };
}

/**
 * Normalise and check one model response.
 *
 * @param raw      what Gemini returned
 * @param context  { variance } — the order's already-settled variance, which is
 *                 what the read is checked against
 */
function normaliseReading(raw, context = {}) {
  const r = raw && typeof raw === "object" ? raw : {};
  const variance = context.variance || null;

  const lines = (Array.isArray(r.lines) ? r.lines : [])
    .map((l) => ({
      head: text(l && l.head, 120),
      asReturned: num(l && l.asReturned),
      asComputed: num(l && l.asComputed),
      remark: text(l && l.remark, 200),
    }))
    // A row naming nothing is noise from a mis-parsed table, not a finding.
    .filter((l) => l.head)
    .slice(0, 40);

  const netAsComputed = netOf(r.demandRaised, r.refundDetermined);
  const netAsReturned = netOf(r.taxPayableAsReturned, r.refundClaimedAsReturned);

  const cause = CAUSE_IDS.includes(r.cause) ? r.cause : "";

  /* The arrears of OTHER assessment years, printed in the order's own annexures.
   *
   * Worth reading because a s.245 set-off is only half a story without them. An
   * order can agree with the return to the rupee, determine a refund, and leave
   * the client with nothing — because the refund went against a demand from
   * years nobody is looking at. "Agrees" is true and incomplete; this is the
   * other half.
   *
   * It costs nothing extra: the annexure is in the PDF the read already sends.
   * And it is EXPLICITLY separated from this order's own position, because
   * confusing the two is precisely the mistake that put a ₹1,83,744 demand on an
   * order that raised none. Nothing here can reach the variance. */
  const outstanding = (Array.isArray(r.outstandingDemands) ? r.outstandingDemands : [])
    .map((d) => ({
      ay: text(d && d.ay, 12),
      demandReference: text(d && d.demandReference, 40),
      amount: num(d && d.amount),
      adjusted: Boolean(d && d.adjusted),
    }))
    .filter((d) => d.amount !== null && d.amount > 0)
    .slice(0, 30);

  const reading = {
    engine: READING_ENGINE,
    lines,
    netAsReturned,
    netAsComputed,
    ...refundLadder(r, netAsComputed),
    headline: text(r.headline, 200),
    outstandingDemands: outstanding,
    // Split, not summed together: money already taken from this refund is a
    // settled fact, money still owed is a live problem.
    arrearsAdjusted: outstanding.filter((d) => d.adjusted).reduce((t, d) => t + d.amount, 0),
    arrearsOutstanding: outstanding.filter((d) => !d.adjusted).reduce((t, d) => t + d.amount, 0),
    suggestedCause: cause,
    // Never applied on its own. The practitioner accepts it on screen, and only
    // then does it become the row's cause.
    causeAccepted: false,
    at: new Date().toISOString(),
    ...reconcile({ netAsComputed, netAsReturned }, variance),
  };
  return reading;
}

/* Does the read agree with what the portal already told us?
 *
 * Two checks, and the first is the one that matters:
 *
 *   1. the order's own bottom line against the portal's demand/refund figure —
 *      two independent sources for the same number
 *   2. where the variance was measured against the RETURN, the difference the
 *      table implies against the difference we computed
 *
 * Check 2 is skipped for a s.154 order measured against an earlier order: the
 * PDF's "as returned" column still shows the original return, not the
 * intimation being rectified, so the two are not comparable and asserting
 * otherwise would fail every rectification.
 */
function reconcile({ netAsComputed, netAsReturned }, variance) {
  if (!variance || variance.cpcNet === null || variance.cpcNet === undefined) {
    return { reconciles: null, reconcileNote: "There is no portal figure to check this read against." };
  }
  /* The figure on the variance came from a READ of this same document — the
     portal sent a status and no amount, so returnVariance.js took the order's
     own printed total. Checking a read against itself would return "reconciles"
     every time and mean nothing; worse, it would dress up a single unverified
     source as two agreeing ones. */
  if (variance.source === "document") {
    return {
      reconciles: null,
      reconcileNote: "The portal sent no figure for this order, so its position was taken from this read — there is nothing independent to check it against.",
    };
  }
  if (netAsComputed === null) {
    return { reconciles: null, reconcileNote: "The order's own demand or refund total could not be read, so this breakdown is unchecked." };
  }

  const drift = Math.abs(netAsComputed - variance.cpcNet);
  if (drift > RECONCILE_TOLERANCE) {
    return {
      reconciles: false,
      reconcileNote:
        `The total read from the order (${netAsComputed}) does not match the figure the portal recorded against it (${variance.cpcNet}). ` +
        "Treat the breakdown below as unverified and read the order itself.",
    };
  }

  if (
    variance.baseline && variance.baseline.kind === "return" &&
    netAsReturned !== null && variance.amount !== null && variance.amount !== undefined
  ) {
    const implied = netAsComputed - netAsReturned;
    if (Math.abs(implied - variance.amount) > RECONCILE_TOLERANCE) {
      return {
        reconciles: false,
        reconcileNote:
          `The order's own columns imply a difference of ${implied}, but the return on file gives ${variance.amount}. ` +
          "Usually this means the intimation relates to a different return from the one synced — a revised return, most often.",
      };
    }
  }

  return { reconciles: true, reconcileNote: "" };
}

/** Only the lines where the two columns actually differ — what to argue about. */
function changedLines(reading) {
  return (reading?.lines || []).filter(
    (l) => l.asReturned !== null && l.asComputed !== null && Math.abs(l.asComputed - l.asReturned) > RECONCILE_TOLERANCE
  );
}

module.exports = {
  normaliseReading,
  reconcile,
  refundLadder,
  changedLines,
  netOf,
  CAUSE_IDS,
  READING_ENGINE,
  RECONCILE_TOLERANCE,
};
