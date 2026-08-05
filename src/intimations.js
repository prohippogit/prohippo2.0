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

/* The extension is explicit because this module is imported by a plain
   `node --test` run as well as by Vite. Vite resolves "./appeals" happily;
   Node does not, and the test dies on a module-not-found before a single
   assertion runs. */
import { regimeFor, endOfMonthPlus, daysUntil } from "./appeals.js";

const DAY = 86400000;
const parseISO = (s) => { const d = new Date(s + "T00:00:00"); d.setHours(0, 0, 0, 0); return d; };
const toISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

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
    const tracked = r.intimationTracking || {};
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
        activityCd: String(o.activityCd || ""),
        orderDate: o.orderDate || "",
        emailedOn: o.emailedOn || "",
        demand: o.demand ?? "",
        refund: o.refund ?? "",
        storagePath: o.storagePath || null,
        locked: Boolean(o.locked),
        lockReason: o.lockReason || "",
        returnPosition: r.returnPosition || null,
        variance,
        reviewed: isReviewed,
        /* Everything the practitioner has decided about this order, kept in a
           map on the RETURN keyed by CPC reference — never inside the orders
           array, which the sync owns and rewrites wholesale. */
        tracking: tracked[o.commRefNo] || null,
        decision: (tracked[o.commRefNo] || {}).decision || "pending",
        cause: (tracked[o.commRefNo] || {}).cause || "",
        /* The AI read of the order's own comparison table, when somebody has
           asked for one. Stored on the order beside its variance, because it
           describes the document rather than anything we decided. */
        reading: o.reading || null,
        /* Who in the practice is doing this one, and whether they have finished.
           Same map as every other decision — see `tracking` above. */
        assignedTo: (tracked[o.commRefNo] || {}).assignedTo || "",
        workDone: Boolean((tracked[o.commRefNo] || {}).workDone),
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

/* Must match VARIANCE_ENGINE in functions/returnVariance.js — the two are pinned
   together by a test. Raising it there and here is what makes every stored
   variance recompute on the next page load. */
export const VARIANCE_ENGINE = 4;

/* What the CPC status says the order did, even where no amount came with it.
   "Not compared" is about the COMPARISON; this is about the order, and the two
   are different questions. An order can be uncomparable and still be known to
   have raised a demand — which is what tells a practitioner to open it. */
export function statedDirection(v) {
  const d = v && v.direction;
  return d === "demand" || d === "refund" ? d : "";
}

/* Where CPC's figure came from. A practitioner acting on a number is entitled to
   know whether the department stated it or a model read it off a page.
   `""` is neither — there is no figure. */
export const SOURCE_LABEL = {
  portal: "as the portal recorded it",
  document: "read from the order itself — the portal sent no figure",
};

/** True when the practice holds orders that have never been through the variance
 *  engine, OR were computed by an older one — the one-shot backfill reads this.
 *
 *  The engine check matters as much as the missing check: engine 1 netted the
 *  demand and refund fields together and reported other years' arrears as this
 *  order's demand, so every figure it wrote has to be recomputed rather than
 *  left sitting on screen looking authoritative. */
export function needsVarianceBackfill(data) {
  return (data.returns || []).some(
    (r) => (r.orders || []).some(
      (o) => o && INTIMATION_SECTIONS.includes(String(o.section || "")) &&
        (!o.variance || (o.variance.engine || 0) < VARIANCE_ENGINE)
    )
  );
}

/* ============================================================================
   THE TWO CLOCKS
   ============================================================================

   An intimation u/s 143(1) starts two remedies whose windows differ by two
   orders of magnitude, and that difference is where practices lose money:

     appeal to CIT(A) u/s 246A   30 days from service    hard, easily missed
     rectification u/s 154        4 years from the end
                                  of the FY of the order  soft, feels infinite

   What happens in practice is that the appeal window lapses in silence while
   everyone assumes s.154 will fix it — and then CPC refuses the rectification
   because the point is not a "mistake apparent from the record", and there is
   no appeal left to file. So BOTH clocks are computed for every intimation and
   both are shown. Letting the appeal window go has to be a decision somebody
   took, not something that happened while nobody was looking.

   As in src/appeals.js, the law lives here as DATA so it can be corrected in
   one place. VERIFY AGAINST THE ACT BEFORE RELYING ON IT:

     s.154(7)  no amendment after four years from the end of the financial year
               in which the order sought to be amended was passed
     s.154(8)  an application by the assessee must be disposed of within six
               months from the end of the month in which it is received
     s.249(2)  appeal to CIT(A) within 30 days of service (1961 Act); the 2025
               Act counts one month from the end of the month of service, which
               is the switch src/appeals.js already encodes

   DELIBERATELY ABSENT: any projection of s.220(2) interest on an unpaid demand.
   It would be our arithmetic presented next to figures the department actually
   stated, and on this screen those must not be confusable.
   ============================================================================ */

/** 31 March that ends the financial year containing this date. */
export function endOfFinancialYear(iso) {
  if (!iso) return "";
  const d = parseISO(iso);
  // April (month index 3) starts a new FY; Jan-Mar still belong to the previous.
  const endYear = d.getMonth() >= 3 ? d.getFullYear() + 1 : d.getFullYear();
  return `${endYear}-03-31`;
}

/** s.154(7) — the last date a rectification of this order can be made. */
export function rectificationDeadline(orderDate) {
  const fyEnd = endOfFinancialYear(orderDate);
  if (!fyEnd) return "";
  return `${Number(fyEnd.slice(0, 4)) + 4}-03-31`;
}

/** s.154(8) — the date by which CPC must dispose of a rectification we filed. */
export function rectificationDisposalDue(filedOn) {
  return filedOn ? endOfMonthPlus(filedOn, 6) : "";
}

/* The appeal window against an intimation, on whichever Act governs it.
 *
 * Reuses the appeals engine's regime switch rather than restating it: an
 * intimation served after the 2025 Act commenced runs on that Act's clock even
 * though the assessment year may be much older. */
export function appealWindow({ orderDate, servedOn, ay } = {}) {
  const served = servedOn || orderDate || "";
  if (!served) return { deadline: "", label: "", act: "", daysLeft: null, urgency: "none" };
  const reg = regimeFor({ ay, communicatedOn: served });
  const deadline = reg.newAct
    ? endOfMonthPlus(served, 1)
    : toISO(addDays(parseISO(served), 30));
  const label = reg.newAct
    ? "1 month from the end of the month of service"
    : "30 days from the date of service";
  const daysLeft = daysUntil(deadline);
  return {
    deadline,
    label,
    act: reg.act,
    form: reg.citForm,
    daysLeft,
    urgency: daysLeft == null ? "none" : daysLeft < 0 ? "lapsed" : daysLeft <= 7 ? "urgent" : daysLeft <= 15 ? "soon" : "open",
  };
}

/** Both clocks for one intimation, plus the disposal clock once we have filed. */
export function clocksFor(row) {
  const track = row.tracking || {};
  const rect = rectificationDeadline(row.orderDate);
  const rectDays = daysUntil(rect);
  const disposal = rectificationDisposalDue(track.rectFiledOn);
  return {
    appeal: appealWindow({ orderDate: row.orderDate, servedOn: track.servedOn, ay: row.ay }),
    rectification: {
      deadline: rect,
      label: "4 years from the end of the financial year of the order",
      daysLeft: rectDays,
      urgency: rectDays == null ? "none" : rectDays < 0 ? "lapsed" : rectDays <= 90 ? "soon" : "open",
    },
    disposal: disposal
      ? { deadline: disposal, label: "6 months from the end of the month of the application", daysLeft: daysUntil(disposal), overdue: daysUntil(disposal) < 0 }
      : null,
  };
}

/* ---------------- what the practitioner decides ---------------- */

/* The whole job, in six states. Kept small on purpose: a status list nobody can
   hold in their head gets filled in at random and stops meaning anything. */
export const DECISIONS = [
  { id: "pending", label: "Needs a decision", tone: "amber", terminal: false },
  { id: "rectify", label: "Rectification u/s 154", tone: "violet", terminal: false },
  { id: "revise", label: "Revised return u/s 139(5)", tone: "violet", terminal: false },
  { id: "appeal", label: "Appeal to CIT(A)", tone: "violet", terminal: false },
  { id: "accept", label: "Accepted — client to pay", tone: "red", terminal: false },
  { id: "resolved", label: "Resolved", tone: "green", terminal: true },
  { id: "none", label: "No action needed", tone: "grey", terminal: true },
];
export const DECISION_LABEL = Object.fromEntries(DECISIONS.map((d) => [d.id, d.label]));
export const DECISION_TONE = Object.fromEntries(DECISIONS.map((d) => [d.id, d.tone]));

/* Why CPC's figure differs. The first six are the statutory grounds on which an
 * adjustment may be made at all (s.143(1)(a)(i)-(vi)); the rest are the ones a
 * practice actually meets week to week.
 *
 * THE POINT OF TAGGING. One cause across many clients is ONE legal position,
 * ONE piece of research and ONE template — not fourteen separate jobs. Nothing
 * else on this page pays for itself as quickly, and it needs no AI: the
 * practitioner picks from this list in two seconds while reading the order. */
export const CAUSES = [
  { id: "arithmetic", label: "Arithmetical error", statute: "143(1)(a)(i)" },
  { id: "incorrect-claim", label: "Incorrect claim apparent from the return", statute: "143(1)(a)(ii)" },
  { id: "loss-late-return", label: "Loss disallowed — return filed late", statute: "143(1)(a)(iii) r/w 139(3)" },
  { id: "audit-report", label: "Disallowance indicated in the audit report", statute: "143(1)(a)(iv)" },
  { id: "80ac", label: "Chapter VI-A deduction disallowed — late return", statute: "143(1)(a)(v) r/w 80AC" },
  { id: "form-26as", label: "Income in 26AS / AIS not returned", statute: "143(1)(a)(vi)" },
  { id: "tds-credit", label: "TDS / TCS credit mismatch" },
  { id: "challan", label: "Advance / self-assessment tax credit not given" },
  { id: "deduction-viA", label: "Chapter VI-A deduction disallowed — other" },
  { id: "rebate-87a", label: "Rebate u/s 87A denied" },
  { id: "interest-234", label: "Interest u/s 234A / 234B / 234C" },
  { id: "fee-234f", label: "Late filing fee u/s 234F" },
  { id: "exemption", label: "Exemption / relief disallowed" },
  { id: "other", label: "Other" },
];
export const CAUSE_LABEL = Object.fromEntries(CAUSES.map((c) => [c.id, c.label]));

/* ---------------- refunds determined but never received ---------------- */

/* CPC determining a refund and the client's bank actually receiving it are two
   different events, and only the first is on the portal. A refund determined
   months ago and still not credited almost always means a failed bank
   validation needing a re-issue request — invisible unless somebody is looking
   for it, which is what this exists to do. */
export const REFUND_CHASE_DAYS = 30;

/* Past this, a refund is no longer chased — it is simply not tracked.
 *
 * The app learns that CPC DETERMINED a refund; whether the bank ever credited
 * it is not on the portal. Defaulting every historical refund to "not received"
 * meant a practice's first look at this page showed ₹180 from 2021 in red at
 * 1,405 days, alongside every other refund it had ever had. That is the failure
 * this feature was built to avoid: a screen that is always red is a screen
 * nobody reads.
 *
 * A year is the line. Inside it, a missing refund is probably a failed bank
 * validation and worth chasing. Outside it, silence means nothing either way,
 * so the row says "not tracked" in grey and can be promoted by hand. */
export const REFUND_STALE_DAYS = 365;

// Fully adjusted u/s 245: the refund was set off against an earlier demand, so
// no money is coming and nothing is owed to the client. Partly adjusted leaves
// a balance that IS paid out, so those stay chaseable.
const FULLY_ADJUSTED_CODES = new Set(["64", "74"]);

export function refundPosition(row) {
  const amount = Number(row.refund);
  const determined = Number.isFinite(amount) && amount > 0;
  if (!determined) return { state: "none", amount: null, days: null };

  if (FULLY_ADJUSTED_CODES.has(String(row.activityCd || ""))) {
    return { state: "adjusted", amount, days: null };
  }
  const receivedOn = row.tracking?.refundReceivedOn || "";
  if (receivedOn) return { state: "received", amount, receivedOn, days: null };

  const days = daysSince(row.orderDate);
  if (days != null && days > REFUND_STALE_DAYS) return { state: "stale", amount, days };
  return {
    state: days != null && days > REFUND_CHASE_DAYS ? "overdue" : "awaited",
    amount,
    days,
  };
}

/* Refunds old enough that we cannot say either way, for the bulk "mark as
   received" that clears a practice's history in one go. */
export function staleRefunds(rows) {
  return rows.filter((r) => refundPosition(r).state === "stale");
}

/* ---------------- the page's own selectors ---------------- */

/* Every intimation and rectification order on file, whatever its age.
 *
 * The dashboard card asks a different question — "what landed recently that I
 * have not looked at" — so it keeps the six-month window and hides what has
 * been ticked off. This page is the ledger: a s.154 order from three years ago
 * is still rectifiable and still belongs here. */
export function allIntimations(data, opts = {}) {
  return intimationVariances(data, { months: null, includeReviewed: true, ...opts });
}

/* Grouped by client, which is how this work is actually done: you ring one
   assessee about all their years, not one year about all your clients.
   Clients needing a decision sort first, then by the largest sum at stake. */
export function groupByAssessee(rows) {
  const byId = new Map();
  for (const row of rows) {
    const key = row.assesseeId || row.pan || row.assessee || "—";
    if (!byId.has(key)) {
      byId.set(key, { key, assesseeId: row.assesseeId, assessee: row.assessee, pan: row.pan, rows: [] });
    }
    byId.get(key).rows.push(row);
  }
  const groups = [...byId.values()].map((g) => {
    const pending = g.rows.filter((r) => r.decision === "pending").length;
    const atStake = g.rows.reduce((sum, r) => sum + Math.abs(r.variance?.flag === "red" ? (r.variance.amount || 0) : 0), 0);
    const years = [...new Set(g.rows.map((r) => r.ay).filter(Boolean))].sort().reverse();
    // Who is carrying this client's orders — normally one name, which is the
    // point: allocation is by person, and a client split across three people is
    // worth seeing on the list rather than inside it.
    const staff = [...new Set(g.rows.map((r) => r.assignedTo).filter(Boolean))];
    const unallocated = g.rows.filter((r) => !r.assignedTo).length;
    return { ...g, pending, atStake, years, staff, unallocated, count: g.rows.length };
  });
  return groups.sort((a, b) =>
    (b.pending - a.pending) || (b.atStake - a.atStake) || String(a.assessee).localeCompare(String(b.assessee))
  );
}

/* The same rows grouped by why CPC differed.
 *
 * This is the view that turns fourteen jobs into one: every client hit by the
 * same adjustment, in one place, to be answered once. Untagged rows are their
 * own group rather than being hidden — an untagged intimation is work nobody
 * has looked at yet, which is worth seeing. */
export function groupByCause(rows) {
  const byCause = new Map();
  for (const row of rows) {
    const key = row.cause || "";
    if (!byCause.has(key)) byCause.set(key, { cause: key, label: CAUSE_LABEL[key] || "Not yet tagged", rows: [] });
    byCause.get(key).rows.push(row);
  }
  return [...byCause.values()]
    .map((g) => ({
      ...g,
      count: g.rows.length,
      assessees: new Set(g.rows.map((r) => r.assesseeId || r.assessee)).size,
      atStake: g.rows.reduce((s, r) => s + (r.variance?.flag === "red" ? Math.abs(r.variance.amount || 0) : 0), 0),
    }))
    // Biggest shared problem first; untagged always last, because it is a to-do
    // list rather than a finding.
    .sort((a, b) => (!a.cause) - (!b.cause) || b.assessees - a.assessees || b.count - a.count);
}

/* ---------------- who is doing it ---------------- */

/* The people this practice already puts work to.
 *
 * NOT A MANAGED LIST, deliberately. Staff is free text everywhere else in the
 * app — on the assessee, on a matter, on a hearing — and a practice of four
 * people should not have to set up a roster before it can allocate one
 * intimation. So the roster is DERIVED: every name already in use anywhere,
 * offered as suggestions, with a new name typed straight in. That is what makes
 * "he can even add the staff if it's not in the list" free rather than a
 * feature.
 *
 * The cost of free text is spelling: "Priya" and "priya" would be two people.
 * Names are matched case-insensitively and the FIRST spelling seen wins, so a
 * second entry of the same name folds into the first instead of splitting a
 * staff member's workload across two rows.
 */
export function staffRoster(data, rows = []) {
  const byKey = new Map();
  const add = (name) => {
    const n = String(name || "").trim();
    if (!n) return;
    const key = n.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, n);
  };
  // Names already carrying intimation work come first — this page's own history
  // is the best guess at who does this page's work.
  for (const r of rows) add(r.assignedTo);
  for (const a of data.assessees || []) add(a.staff);
  for (const m of data.matters || []) add(m.staff);
  for (const h of data.hearings || []) add(h.staff);
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}

/** The roster key a name folds onto, so two spellings are one person. */
export const staffKey = (name) => String(name || "").trim().toLowerCase();

/* The rows grouped by who is doing them.
 *
 * The question this answers is the one a principal actually asks — "what is
 * Priya sitting on, and has she finished it" — so each group carries how much is
 * still open, not just how much exists. Unassigned is a group of its own and
 * sorts last: it is a to-do list rather than somebody's workload.
 */
export function groupByStaff(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = staffKey(row.assignedTo);
    if (!byKey.has(key)) byKey.set(key, { key, staff: row.assignedTo || "", rows: [] });
    byKey.get(key).rows.push(row);
  }
  return [...byKey.values()]
    .map((g) => ({
      ...g,
      count: g.rows.length,
      done: g.rows.filter((r) => r.workDone).length,
      open: g.rows.filter((r) => !r.workDone).length,
      assessees: new Set(g.rows.map((r) => r.assesseeId || r.assessee)).size,
      atStake: g.rows.reduce((s, r) => s + (r.variance?.flag === "red" ? Math.abs(r.variance.amount || 0) : 0), 0),
    }))
    .sort((a, b) => (!a.key) - (!b.key) || b.open - a.open || b.count - a.count);
}

/** Practice-wide counts for the page header. */
export function practiceSummary(rows) {
  const out = {
    total: rows.length, pending: 0, assessees: 0,
    additionalDemand: 0, extraRefund: 0,
    appealOpen: 0, appealLapsing: 0,
    refundAwaited: 0, refundOverdue: 0, refundAwaitedAmount: 0, refundStale: 0,
    disposalOverdue: 0, untagged: 0,
    allocated: 0, unallocated: 0, workOpen: 0, workDone: 0,
  };
  const names = new Set();
  for (const row of rows) {
    names.add(row.assesseeId || row.assessee);
    if (row.decision === "pending") out.pending += 1;
    if (!row.cause) out.untagged += 1;
    if (row.assignedTo) {
      out.allocated += 1;
      if (row.workDone) out.workDone += 1; else out.workOpen += 1;
    } else {
      out.unallocated += 1;
    }

    const v = row.variance;
    if (v?.flag === "red") out.additionalDemand += Math.abs(v.amount || 0);
    if (v?.flag === "green") out.extraRefund += Math.abs(v.amount || 0);

    const clocks = clocksFor(row);
    // Only an undecided red intimation has an appeal worth counting: one already
    // accepted or resolved is not waiting on anybody.
    if (v?.flag === "red" && row.decision === "pending") {
      if (clocks.appeal.urgency === "open" || clocks.appeal.urgency === "soon") out.appealOpen += 1;
      if (clocks.appeal.urgency === "urgent") out.appealLapsing += 1;
    }
    if (clocks.disposal?.overdue) out.disposalOverdue += 1;

    const refund = refundPosition(row);
    if (refund.state === "awaited") { out.refundAwaited += 1; out.refundAwaitedAmount += refund.amount; }
    if (refund.state === "overdue") { out.refundOverdue += 1; out.refundAwaitedAmount += refund.amount; }
    if (refund.state === "stale") out.refundStale += 1;
  }
  out.assessees = names.size;
  return out;
}

/** Filter predicate shared by the page's chips, kept here so it is testable. */
export function matchesFilter(row, filter) {
  switch (filter) {
    case "All": return true;
    case "Needs a decision": return row.decision === "pending";
    case "More payable": return row.variance?.flag === "red";
    case "In the assessee's favour": return row.variance?.flag === "green";
    case "Refund awaited": { const s = refundPosition(row).state; return s === "awaited" || s === "overdue"; }
    case "Appeal window open": { const a = clocksFor(row).appeal; return a.urgency === "open" || a.urgency === "soon" || a.urgency === "urgent"; }
    case "Rectification filed": return row.decision === "rectify" && Boolean(row.tracking?.rectFiledOn);
    case "Not yet tagged": return !row.cause;
    case "Not allocated": return !row.assignedTo;
    /* Allocated and not yet finished. Distinct from "Needs a decision": that is
       work nobody has taken up, this is work somebody is holding. A principal
       chasing the second should not have the first mixed into it. */
    case "With staff": return Boolean(row.assignedTo) && !row.workDone;
    default: return true;
  }
}

export const FILTERS = [
  "All", "Needs a decision", "More payable", "In the assessee's favour",
  "Appeal window open", "Refund awaited", "Rectification filed", "Not yet tagged",
  "Not allocated", "With staff",
];

/* ---------------- the three figures, in one ladder ---------------- */

/* WHY THIS EXISTS.
 *
 * One real order put three different rupee figures in front of a practitioner
 * and joined none of them up:
 *
 *   ₹2,29,840  the refund the return claimed
 *   ₹2,28,838  the refund CPC computed — what the portal reports, so what the
 *              flag is measured on
 *   ₹2,32,270  what reached the client's bank, being the second plus ₹3,432 of
 *              interest u/s 244A
 *
 * Every one of them is correct. The screen showed the middle one under the
 * heading "CPC determined", flagged the ₹1,002 shortfall in red, and left the
 * user to work out why their client had been paid more than either number. That
 * is a page failing at its job even though every figure on it was right.
 *
 * So the ladder is stated in full, in order, and the last line is the one a
 * practitioner says out loud to a client. The middle line keeps the flag,
 * because that is the only pair of figures that is like for like: a return never
 * claims interest on its own refund, so measuring the last line against the
 * first would report money "in the assessee's favour" and bury a real
 * disallowance underneath statutory interest.
 *
 * Interest is only known once the order has been read — the portal never sends
 * it — so the ladder is two rungs before a read and four after. `final.fromRead`
 * says which, and the UI says so too rather than letting the headline figure
 * change silently under the same label.
 */
export function positionLadder(row) {
  const v = row.variance;
  if (!v || v.cpcNet === null || v.cpcNet === undefined) return null;

  const reading = row.reading || null;
  const interest = typeof reading?.interestOnRefund === "number" ? reading.interestOnRefund : null;
  const receivable = typeof reading?.receivable === "number" ? reading.receivable : null;

  /* A position of exactly nil is neither a refund nor a demand, and calling it
     either puts a ₹0 under a label that asserts something the figures do not.
     It gets its own wording rather than being rounded into one side. */
  const baselineLabel = (net, fromOrder) => {
    if (net === 0) return fromOrder ? "The previous order — nothing either way" : "The return as filed — nothing either way";
    if (fromOrder) return net > 0 ? "Refund per the previous order" : "Payable per the previous order";
    return net > 0 ? "Refund claimed in the return" : "Tax payable per the return";
  };

  const rungs = [];
  if (v.baseline && typeof v.baseline.net === "number") {
    rungs.push({
      id: "baseline",
      label: baselineLabel(v.baseline.net, v.baseline.kind === "order"),
      net: v.baseline.net,
    });
  }
  /* "Refund CPC computed" on its own gets read as the refund, full stop — and
     on an order carrying s.244A interest it is not, which is exactly the
     confusion this ladder is here to end. Where a line of interest follows it,
     the label says so. */
  rungs.push({
    id: "cpc",
    label: v.cpcNet === 0
      ? "CPC computed nothing either way"
      : v.cpcNet > 0
        ? (interest ? "Refund CPC computed, before interest" : "Refund CPC computed")
        : "Demand CPC raised",
    net: v.cpcNet,
    // The one comparison the flag rests on, so the row carries it.
    delta: typeof v.amount === "number" ? v.amount : null,
  });
  if (interest) {
    rungs.push({ id: "interest", label: "Interest u/s 244A on the refund", net: interest, addend: true });
  }

  const finalNet = receivable === null ? v.cpcNet : receivable;
  return {
    rungs,
    final: {
      label: finalNet === 0 ? "Nothing due either way" : finalNet > 0 ? "Refundable to the client" : "Payable by the client",
      net: finalNet,
      // True when the last line came off the PDF rather than out of the portal —
      // the same provenance rule variance.source follows.
      fromRead: receivable !== null && receivable !== v.cpcNet,
      interest,
    },
  };
}

/** The single figure to put in a "Demand / Refund" column: what the client ends
 *  up with, which is the portal's figure until a read finds interest on top. */
export function finalPosition(row) {
  const ladder = positionLadder(row);
  return ladder ? ladder.final : null;
}

/* ---------------- the AI read of the comparison table ---------------- */

/* Only the lines where the two columns actually moved — what there is to argue
   about. Mirrors changedLines() in functions/intimationReading.js; the client
   re-derives it rather than storing it twice. */
export function changedLines(reading) {
  return (reading?.lines || []).filter(
    (l) => l.asReturned !== null && l.asComputed !== null && Math.abs(l.asComputed - l.asReturned) > 1
  );
}

/* How much weight the screen may put on a read.
 *
 *   "ok"        the order's own total matched the portal's figure — two
 *               independent sources agreeing, so the table can be shown plainly
 *   "unchecked" no total could be read, so nothing contradicts it and nothing
 *               confirms it
 *   "broken"    the two disagree; show the table only under a warning
 *
 * There is deliberately no "probably fine". A practitioner advises clients off
 * this, and a maybe would be read as a yes. */
export function readingTrust(reading) {
  if (!reading) return null;
  if (reading.reconciles === true) return "ok";
  if (reading.reconciles === false) return "broken";
  return "unchecked";
}

/** A cause the model proposed and nobody has accepted yet. */
export function pendingCauseSuggestion(row) {
  const s = row.reading?.suggestedCause;
  if (!s || row.cause) return "";           // already tagged by hand — leave it
  return CAUSE_LABEL[s] ? s : "";
}

/* ---------------- clearing the backlog ---------------- */

/* Orders that can be settled without anybody reading them.
 *
 * On a practice's first visit every order says "needs a decision", including the
 * many where CPC simply agreed with the return. Working through those one at a
 * time is an afternoon nobody spends, and until they are gone the page cannot
 * show what is genuinely outstanding.
 *
 * ONLY THE AGREEING ONES. A red order is money at stake and an unknown one is a
 * gap in what we know; both need a human, and a bulk action that swept them up
 * would be worse than no bulk action at all. `neutral` means the arithmetic
 * found no material difference — that is the whole set this offers. */
export function bulkClearable(rows) {
  return rows.filter((r) => r.decision === "pending" && r.variance?.flag === "neutral");
}
