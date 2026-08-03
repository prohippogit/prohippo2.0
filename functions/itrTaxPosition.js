/*
 * The taxpayer's own closing tax position, read out of a filed ITR JSON.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A COMPUTATION MAPPER. src/computation/
 * turns an ITR JSON into a full Computation of Total Income, head by head. That
 * machinery is deliberately per-form and per-year (docs/computation-spec.md §2)
 * and exists for ITR-2/3/5 only — but the bulk of any practice files ITR-1 and
 * ITR-4, and the s.143(1) variance has to work for those too.
 *
 * So this reads FOUR LEAF FIGURES and nothing else. It never adds anything up,
 * never applies a rate, and never decides what income is. Every number it
 * returns is printed in the return exactly as returned here. That is what makes
 * it safe to run against a form nobody has written a mapper for: there is no
 * arithmetic to get wrong, only a field to find or not find.
 *
 * WHAT IS COMPARABLE, AND WHAT IS NOT. CPC's side of the comparison arrives
 * from the portal as a net demand or a net refund and nothing else (see
 * connector/src/main/portalReturns.js — `computedDemndAmt` / `computedRefndAmt`).
 * The only quantity that exists on BOTH sides is therefore the NET closing
 * position: refund due, or tax still payable, after credit for taxes paid.
 * `netPayable` below is that quantity, and it is the one the flag turns on.
 *
 * `taxAndInterest` — the gross liability before credit for taxes paid — is
 * captured because it is what a practitioner means by "tax liability" in
 * conversation, and it is worth showing. It is NOT used for the flag, because
 * there is no CPC-side counterpart to compare it against without reading the
 * intimation PDF. Comparing a gross figure to a net one would produce a
 * confident number that is wrong by the whole of the TDS credit.
 *
 * SIGN CONVENTION, used everywhere downstream: positive is money coming BACK to
 * the assessee. A refund of ₹40,000 is +40000; tax still payable of ₹40,000 is
 * −40000. One convention, chosen once, so no consumer has to remember which way
 * round a "difference" runs.
 */
"use strict";

// The form is the sole key under ITR — the same read src/computation/detect.js
// makes, for the same reason: the wrapper key is what every schedule hangs off.
const FORMS = ["ITR1", "ITR2", "ITR3", "ITR4", "ITR5", "ITR6", "ITR7"];

/* A rupee figure out of a portal JSON.
 *
 * Absent, blank, and the string "null" all mean "the return does not say", and
 * that is NOT the same as nil — a return closing at zero and a field the portal
 * omitted lead to different conclusions downstream, so they stay different here.
 * Mirrors portalAmount() in src/Assessees.jsx, which does this for display. */
function num(v) {
  if (v === null || v === undefined || v === "" || v === "null") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function at(obj, path) {
  let cur = obj;
  for (const key of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[key];
  }
  return cur;
}

// First container that actually carries the figure wins; the search order is
// the point, not a fallback chain — see readTaxPosition.
function pick(containers, path) {
  for (const c of containers) {
    const v = num(at(c, path));
    if (v !== null) return v;
  }
  return null;
}

/* Last resort: find a named leaf anywhere in the document.
 *
 * Reached only when a form puts `BalTaxPayable` somewhere neither ITR-1's root
 * nor PartB_TTI covers — a new form, or a schema revision that moved it. A
 * bounded walk returning the first numeric match is worth more than a null,
 * because the alternative is telling the practitioner "no comparison possible"
 * for a return that plainly states the figure. The source is recorded as "scan"
 * so a position found this way is identifiable later.
 *
 * Depth-limited and breadth-first-ish by construction: real ITR JSONs nest
 * about six deep, so 8 reaches everything without walking a pathological
 * document for ever. */
function scan(root, key, depth = 8) {
  if (!root || typeof root !== "object" || depth < 0) return null;
  const direct = num(root[key]);
  if (direct !== null) return direct;
  for (const v of Object.values(root)) {
    if (v && typeof v === "object") {
      const found = scan(v, key, depth - 1);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * → { form, ay, balTaxPayable, refundDue, totalTaxesPaid, taxAndInterest,
 *     netPayable, source }
 * or null when the input is not a portal ITR JSON at all.
 *
 * `source` says WHERE the figures were found — "PartB_TTI" (ITR-2/3/5/6/7),
 * "form-root" (ITR-1/4), or "scan" (the fallback walk). It is stored with the
 * position so a wrong-looking variance can be traced to the read that produced
 * it without re-downloading the return.
 */
function readTaxPosition(itrJson) {
  const root = itrJson && itrJson.ITR;
  if (!root || typeof root !== "object") return null;

  const form = FORMS.find((f) => root[f] && typeof root[f] === "object") || "";
  if (!form) return null;
  const body = root[form];

  const formBlock = body[`Form_${form}`] || {};
  const startYear = Number(formBlock.AssessmentYear || 0);
  const ay = startYear >= 1900 ? `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}` : "";

  /* PartB_TTI first, then the form's own root.
   *
   * ITR-2/3/5/6/7 carry the closing position under PartB_TTI; ITR-1 and ITR-4
   * carry the same field names at the form's root. Trying PartB_TTI first
   * matters for the forms that have BOTH — the root of an ITR-3 holds schedule
   * data, and the authoritative total is the one in Part B-TTI. */
  const partB = body.PartB_TTI;
  const containers = [partB, body].filter((c) => c && typeof c === "object");

  let source = "";
  let balTaxPayable = pick(containers, "TaxPaid.BalTaxPayable");
  let refundDue = pick(containers, "Refund.RefundDue");
  if (balTaxPayable !== null || refundDue !== null) {
    source = partB && (num(at(partB, "TaxPaid.BalTaxPayable")) !== null || num(at(partB, "Refund.RefundDue")) !== null)
      ? "PartB_TTI"
      : "form-root";
  } else {
    balTaxPayable = scan(body, "BalTaxPayable");
    refundDue = scan(body, "RefundDue");
    if (balTaxPayable !== null || refundDue !== null) source = "scan";
  }

  const totalTaxesPaid =
    pick(containers, "TaxPaid.TaxesPaid.TotalTaxesPaid") ?? scan(body, "TotalTaxesPaid");

  /* The gross liability, for display only (see the header note).
   *
   * TotalTaxPlusIntrstPay is the figure a practitioner reads as "the tax
   * liability" — tax on total income, less rebate and relief, plus 234A/B/C
   * interest and fee, BEFORE credit for TDS and advance tax. ITR-1 and ITR-4
   * print it inside their own *_TaxComputation block under a different name, so
   * both are tried before giving up. */
  const taxAndInterest =
    pick(containers, "ComputationOfTaxLiability.TotalTaxPlusIntrstPay") ??
    pick(containers, "ComputationOfTaxLiability.NetTaxLiability") ??
    scan(body, "TotalTaxPlusIntrstPay");

  /* The net closing position, on the one sign convention (header note).
   *
   * A return states one side or the other, never both, and states the unused
   * side as 0 — so treating an absent field as 0 HERE is reading the return
   * correctly, not guessing. But if BOTH are absent the return told us nothing
   * and the answer is null, not zero: a nil position and an unreadable one lead
   * to opposite conclusions about an intimation. */
  const netPayable =
    balTaxPayable === null && refundDue === null ? null : (refundDue || 0) - (balTaxPayable || 0);

  return { form, ay, balTaxPayable, refundDue, totalTaxesPaid, taxAndInterest, netPayable, source };
}

module.exports = { readTaxPosition, num };
