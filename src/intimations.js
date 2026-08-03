/* ProHippo — the intimations & rectification orders worth looking at, and what
 * they did to the assessee (pure, deterministic, no network).
 *
 * The arithmetic is NOT here. Each order arrives from the sync with its variance
 * already computed and stored on it by functions/returnVariance.js, because that
 * is where the ITR JSON can be read. This module only SELECTS and SUMMARISES:
 * which orders fall in the window, which have been dealt with, and what the
 * practice's overall position is. Keeping it that way means the number on the
 * dashboard and the number on the Returns tab cannot disagree — there is one
 * calculation, done once, at ingest.
 *
 * Sign convention throughout (set in itrTaxPosition.js and never varied):
 * POSITIVE IS MONEY COMING BACK TO THE ASSESSEE. So variance.amount < 0 means
 * CPC left them worse off than the baseline — red — and > 0 means better —
 * green.
 */

const DAY = 86400000;
const parseISO = (s) => { const d = new Date(s + "T00:00:00"); d.setHours(0, 0, 0, 0); return d; };
const toISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

/* How far back the card looks.
 *
 * Six months, anchored on the CPC ORDER DATE and measured from today — not from
 * the last sync. Anchoring on the sync would make the same order appear and
 * disappear depending on how often the practice syncs, and would make the list
 * untestable; anchoring on today means the window is a plain statement about
 * the orders themselves. */
export const DEFAULT_WINDOW_MONTHS = 6;

export const windowStart = (months = DEFAULT_WINDOW_MONTHS, today = todayStart()) => {
  const d = new Date(today);
  d.setMonth(d.getMonth() - months);
  return toISO(d);
};

export const daysSince = (iso) => (iso ? Math.round((todayStart() - parseISO(iso)) / DAY) : null);

/* Which orders count as an intimation for this purpose.
 *
 * Both sections, deliberately. A s.154 rectification changes the assessee's
 * liability exactly as a s.143(1) intimation does, and the case a practitioner
 * most needs to catch — a rectification that made things WORSE than the
 * intimation it replaced — only exists on the 154 side. */
export const INTIMATION_SECTIONS = ["143(1)", "154"];

export const SECTION_LABEL = {
  "143(1)": "Intimation u/s 143(1)",
  "154": "Rectification order u/s 154",
};

/* What the difference was measured against. Shown on every row: a variance
   without its baseline is a number with no meaning, and the two baselines lead
   to different conversations with the client. */
export const BASELINE_LABEL = {
  return: "vs the return as filed",
  order: "vs the previous order",
};

/** One line of plain English for a variance. Used on the card, the popup and
 *  the Returns tab, so the three cannot describe the same order differently. */
export function describeVariance(v) {
  if (!v || v.flag === "unknown") return v?.note || "Could not be compared.";
  const base = BASELINE_LABEL[v.baseline?.kind] || "";
  if (v.flag === "neutral") return `Agrees with ${v.baseline?.kind === "order" ? "the previous order" : "the return"}.`;
  const amount = Math.abs(v.amount || 0);
  return v.flag === "red"
    ? `₹${inr(amount)} worse ${base}.`
    : `₹${inr(amount)} better ${base}.`;
}

/* Indian digit grouping, local to this module so it stays importable by a plain
   node test run. shared.jsx's fmtINR does the same for the UI at large. */
export function inr(n) {
  const s = Math.round(Math.abs(Number(n) || 0)).toString();
  if (s.length <= 3) return s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${rest},${last3}`;
}

/**
 * Every intimation / rectification order in the practice from the last N months,
 * newest first, each carrying the assessee and year it belongs to.
 *
 * opts.months     window length (default 6; null = everything on file)
 * opts.today      "YYYY-MM-DD", for tests
 * opts.includeReviewed  keep orders already ticked off (default false)
 * opts.flags      which flags to keep (default: all of them)
 *
 * Orders WITHOUT a date are kept. An order the portal dated badly is exactly the
 * kind a practitioner should see, and silently dropping it would make the count
 * quietly wrong.
 */
export function intimationVariances(data, opts = {}) {
  const months = opts.months === undefined ? DEFAULT_WINDOW_MONTHS : opts.months;
  const today = opts.today ? parseISO(opts.today) : todayStart();
  const from = months === null ? null : windowStart(months, today);
  const flags = opts.flags || null;

  const rows = [];
  for (const r of data.returns || []) {
    const reviewed = r.varianceReviewed || {};
    for (const o of r.orders || []) {
      if (!o || !o.commRefNo) continue;
      if (!INTIMATION_SECTIONS.includes(String(o.section || ""))) continue;
      if (from && o.orderDate && o.orderDate < from) continue;
      const isReviewed = Boolean(reviewed[o.commRefNo]);
      if (isReviewed && !opts.includeReviewed) continue;
      const variance = o.variance || null;
      if (flags && !flags.includes(variance?.flag || "unknown")) continue;
      rows.push({
        key: `${r.id}:${o.commRefNo}`,
        returnId: r.id,
        assesseeId: r.assesseeId || "",
        assessee: r.assessee || "",
        pan: r.pan || "",
        ay: r.ay || "",
        form: r.form || "",
        commRefNo: o.commRefNo,
        section: String(o.section || ""),
        statusDesc: o.statusDesc || "",
        orderDate: o.orderDate || "",
        storagePath: o.storagePath || null,
        locked: Boolean(o.locked),
        lockReason: o.lockReason || "",
        returnPosition: r.returnPosition || null,
        variance,
        reviewed: isReviewed,
      });
    }
  }

  /* Newest first. An undated order sorts to the top rather than the bottom:
     it needs a human to look at it, and the end of a list is where things go to
     be forgotten. */
  return rows.sort((a, b) => (b.orderDate || "9999-99-99").localeCompare(a.orderDate || "9999-99-99"));
}

/**
 * The practice-wide position across a set of rows.
 *
 * `additionalDemand` and `extraRefund` are kept APART and never netted. A
 * practice with ₹5L of new demand on one client and ₹5L of extra refund on
 * another has two urgent conversations to have, not a quiet afternoon — and a
 * single net figure of zero would say the opposite.
 */
export function varianceSummary(rows) {
  const out = { total: rows.length, red: 0, green: 0, neutral: 0, unknown: 0, adjusted: 0, additionalDemand: 0, extraRefund: 0, assessees: 0 };
  const names = new Set();
  for (const row of rows) {
    const v = row.variance;
    const flag = v?.flag || "unknown";
    if (flag === "red") { out.red += 1; out.additionalDemand += Math.abs(v.amount || 0); }
    else if (flag === "green") { out.green += 1; out.extraRefund += Math.abs(v.amount || 0); }
    else if (flag === "neutral") out.neutral += 1;
    else out.unknown += 1;
    if (v?.adjusted) out.adjusted += 1;
    if (flag === "red" || flag === "green") names.add(row.assesseeId || row.assessee);
  }
  out.assessees = names.size;
  return out;
}

/** True when the practice holds orders that have never been through the
 *  variance engine — the one-shot backfill trigger reads this. */
export function needsVarianceBackfill(data) {
  return (data.returns || []).some(
    (r) => (r.orders || []).some((o) => o && INTIMATION_SECTIONS.includes(String(o.section || "")) && !o.variance)
  );
}
