/* ProHippo — appeal limitation & preparation engine (pure, deterministic).
 *
 * No AI, no network. Given the orders the app already holds (notices with
 * isOrder = true), this works out:
 *   - which onward appeal each order attracts (CIT(A) or ITAT),
 *   - the filing deadline, with the exact date math shown (never a black box),
 *   - which statutory regime applies (1961 Act / Form 35-36 vs 2025 Act /
 *     Form 99-115), decided from the assessment year,
 *   - the appeal fee, the document checklist, and the fields for the mock form.
 *
 * Limitation law encoded here (verify against the Act before relying on it —
 * these are kept as data precisely so they can be updated in one place):
 *   - CIT(A), 1961 Act: 30 days from date of service of the order / demand notice.
 *   - CIT(A), 2025 Act: 1 month from the END OF THE MONTH of service.
 *   - ITAT, 1961 Act:   60 days from communication of the order.
 *   - ITAT, 2025 Act:   2 months from the END OF THE MONTH of communication.
 *
 * WHICH REGIME APPLIES is decided by WHEN THE ORDER WAS COMMUNICATED, not by
 * the assessment year. Limitation is procedural: an order communicated after
 * the 2025 Act commenced runs on that Act's clock even though the assessment it
 * decides may relate to AY 2017-18. This engine used to key the choice off the
 * AY, which left a June-2026 order counting 60 days from the date of service.
 *
 * BOTH computations are always returned, never just the operative one. A
 * limitation date shown LATER than the true one is the error that costs an
 * appeal, so the UI presents the pair, marks which is being relied on, and lets
 * the practitioner override the communicated date to force either.
 */

const DAY = 86400000;
const parseISO = (s) => { const d = new Date(s + "T00:00:00"); d.setHours(0, 0, 0, 0); return d; };
const toISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const todayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
export const daysUntil = (iso) => (iso ? Math.round((parseISO(iso) - todayStart()) / DAY) : null);

/* Last day of the month that falls `months` after the given date's month —
   i.e. the clock starts on the first day AFTER the month of communication.
   24 Jun 2026 + 2 months → 31 Aug 2026. Exported so the UI shows the same
   number the engine used; it used to keep a second copy of this arithmetic. */
export const endOfMonthPlus = (iso, months) => {
  const d = parseISO(iso);
  return toISO(new Date(d.getFullYear(), d.getMonth() + 1 + months, 0));
};

// The day the Income-tax Act, 2025 took effect. An order communicated on or
// after this date is appealed on its clock.
export const ACT_2025_FROM = "2026-04-01";

// Each order type's onward appeal forum. Orders whose authority isn't a key
// here (e.g. an ITAT order → High Court, out of scope) are not surfaced.
export const APPEAL_ROUTE = { Scrutiny: "CIT(A)", Penalty: "CIT(A)", "CIT(A)": "ITAT" };

/* ---------------- document classification ----------------
 * The portal's "Download Closure Order" returns the real order BUNDLED with its
 * enclosures — the computation sheet and the notice of demand u/s 156. Every
 * item arrives with isOrder = true, so the appealable order must be told apart
 * from its enclosures. Only the order itself (assessment / penalty / appellate)
 * attracts an appeal; the demand notice and computation sheet do NOT.
 *
 * A docType parsed from the PDF (n.docType, set by the backend on read) always
 * wins; otherwise it's inferred from the document's own name + section. */
const DEMAND_RE = /notice of demand|demand notice|\bu\/?s\s*156\b|\bitns\b/i;
const COMPUTATION_RE = /comput|tax\s*calculation|calculation sheet|\bitns[\s-]*\d/i;
const PENALTY_RE = /penalt|\b27(0a|1)\b/i;
const APPEAL_ORDER_RE = /appellate order|order\s*u\/?s\s*250|\b250\b|order of (the )?cit\s*\(a\)|nfac.*order/i;
const ASSESSMENT_RE = /assessment order|order\s*u\/?s\s*1(4[3479]|53)|\b14[3479]\b|\b144\b/i;

const nameOf = (n) => `${n.description || n.subject || ""} ${n.fileName || n.filename || ""}`;

// One of: assessmentOrder | penaltyOrder | appealOrder | demandNotice |
// computationSheet | order (generic) | other.
export function orderDocType(n) {
  const parsed = n.docType || (n.parsed && n.parsed.docType) || (n.aiSummary && n.aiSummary.docType);
  if (parsed) return parsed;
  const t = nameOf(n);
  const sec = String(n.section || "");
  if (DEMAND_RE.test(t)) return "demandNotice";
  if (COMPUTATION_RE.test(t)) return "computationSheet";
  if (n.authority === "CIT(A)" || sec === "250" || APPEAL_ORDER_RE.test(t)) return "appealOrder";
  if (n.authority === "Penalty" || PENALTY_RE.test(t)) return "penaltyOrder";
  if (n.authority === "Scrutiny" || ASSESSMENT_RE.test(t)) return "assessmentOrder";
  return n.isOrder ? "order" : "other";
}

const APPEALABLE_DOCTYPES = new Set(["assessmentOrder", "penaltyOrder", "appealOrder", "order"]);

// The document is an order that can actually be appealed — i.e. not a demand
// notice or computation sheet that merely travelled bundled with it.
export function isAppealableOrder(n) {
  return Boolean(n.isOrder) && APPEALABLE_DOCTYPES.has(orderDocType(n));
}

export const DOC_TYPE_LABEL = {
  assessmentOrder: "Assessment order",
  penaltyOrder: "Penalty order",
  appealOrder: "CIT(A) order",
  demandNotice: "Demand notice",
  computationSheet: "Computation sheet",
  order: "Order",
  other: "Notice",
};

/* ---------------- appeal numbers ----------------
 *
 * "ITA No. 1762/Ahd/2026", "ITA 1762/AHD/2026" and "ITA 01762/AHD/2026" are one
 * appeal, and all three turn up: the Tribunal writes one form, a practitioner
 * types another, and a matter opened from the Tribunal's email carries a third.
 * Comparing the raw strings finds nothing, which is how a proceeding ends up
 * reporting no hearings while two of them sit on the assessee's own page.
 *
 * Deliberately the same reduction as canonicalAppealNo in
 * functions/itatEmailParse.js, which decides whether an incoming notice belongs
 * to an appeal already on file. The two have to agree, or a hearing the server
 * merged would appear unlinked to the client that displays it.
 */
export const appealKey = (v) => String(v || "")
  .toUpperCase()
  .replace(/\bNOS?\b\.?/g, " ")
  .replace(/[^A-Z0-9]+/g, "")
  // Leading zeros on the serial only — "ITA 01762" is "ITA 1762", but the 2026
  // in the year must survive intact.
  .replace(/([A-Z])0+(\d)/, "$1$2");

// Empty matches nothing. A matter with no reference and a hearing with no
// appeal number are not "the same appeal", they are two blanks.
export const sameAppeal = (a, b) => Boolean(appealKey(a)) && appealKey(a) === appealKey(b);

export const ayStartYear = (ay) => { const m = /^(\d{4})/.exec(String(ay || "")); return m ? +m[1] : null; };

const ACT_1961 = { act: "Act 1961", newAct: false, citForm: "Form 35", itatForm: "Form 36" };
const ACT_2025 = { act: "Act 2025", newAct: true, citForm: "Form 99", itatForm: "Form 115" };

/* Which Act governs this appeal.
 *
 * Decided by the date the order was communicated — that is when the right of
 * appeal arises, and limitation is procedural. The assessment year is only a
 * fallback for orders with no date on file at all, and even then it is a weak
 * signal: an AY 2017-18 order can perfectly well be communicated in 2026.
 *
 * The old AY-only rule disagreed with itself — the engine switched at AY
 * 2027-28 while the on-screen note claimed AY 2026-27 — and neither matched
 * what a practitioner actually files. */
export function regimeFor({ ay, communicatedOn } = {}) {
  if (communicatedOn) return communicatedOn >= ACT_2025_FROM ? ACT_2025 : ACT_1961;
  const y = ayStartYear(ay);
  return y != null && y >= 2026 ? ACT_2025 : ACT_1961;
}

// Kept for callers that only hold an assessment year.
export function regimeForAy(ay) {
  return regimeFor({ ay });
}

// Does a filed Form 35 appeal correspond to this assessment/penalty order?
// Match the Form 35 metadata the way a practitioner would: assessment year
// first, then the date of the order appealed against (corroborated, where the
// form carries it, by the order's DIN or section). A Form 35 for the same
// PAN + AY that carries no order metadata at all is still treated as a match.
export function form35Matches(order, form) {
  if ((form.pan || "").toUpperCase() !== (order.pan || "").toUpperCase()) return false;
  if ((form.ay || "") !== (order.ay || "")) return false; // 1) assessment year
  const meta = form.appeal || {};
  const dateOrder = meta.dateOrder || "";
  const orderDin = meta.orderDin || "";
  const orderSection = meta.orderSection || "";
  if (dateOrder || orderDin || orderSection) {              // 2) date of order (or DIN/section)
    return (dateOrder && order.date && dateOrder === order.date)
      || (orderDin && order.din && String(orderDin) === String(order.din))
      || (orderSection && order.section && String(orderSection) === String(order.section));
  }
  return true; // PAN + AY match, no corroborating metadata on the form
}

// Has this order already been appealed? Manual flag wins; otherwise infer from
// a filed Form 35 (metadata-matched) or a later-stage order for the same PAN+AY.
export function isAppealed(notice, allNotices, matters) {
  if (notice.appealStatus === "filed" || notice.appealStatus === "dismissed") return true;
  const pan = (notice.pan || "").toUpperCase();
  const ay = notice.ay || "";
  const sameParty = (r) => (r.pan || "").toUpperCase() === pan && r.ay === ay;
  const route = APPEAL_ROUTE[notice.authority];
  if (route === "CIT(A)") {
    // A first appeal is filed if a matching Form 35 exists, or a CIT(A)
    // appellate order has already been passed for this PAN + AY (appeal done).
    return allNotices.some((n) => n.isAppealForm && form35Matches(notice, n))
      || allNotices.some((n) => sameParty(n) && orderDocType(n) === "appealOrder");
  }
  if (route === "ITAT") {
    return (matters || []).some((m) => m.type === "ITAT" && sameParty(m))
      || allNotices.some((n) => sameParty(n) && n.isOrder && n.authority === "ITAT" && isAppealableOrder(n));
  }
  return false;
}

/* The two ways the same order's limitation can be counted. Both are always
   worked out so the UI can show them together — see the header note on why a
   single unexplained date is not acceptable here. */
function limitationBases(route, served) {
  const noun = route === "CIT(A)" ? "service" : "communication";
  if (!served) return [];
  if (route === "CIT(A)") {
    return [
      { act: "Act 1961", newAct: false, date: toISO(addDays(parseISO(served), 30)), label: `30 days from date of ${noun}`, days: 30 },
      { act: "Act 2025", newAct: true, date: endOfMonthPlus(served, 1), label: `1 month from the end of the month of ${noun}`, days: null },
    ];
  }
  return [
    { act: "Act 1961", newAct: false, date: toISO(addDays(parseISO(served), 60)), label: `60 days from ${noun} of the order`, days: 60 },
    { act: "Act 2025", newAct: true, date: endOfMonthPlus(served, 2), label: `2 months from the end of the month of ${noun}`, days: null },
  ];
}

// Compute the appeal position for one order: forum, regime, deadline, urgency.
export function appealFor(notice) {
  const route = APPEAL_ROUTE[notice.authority];
  if (!route) return null;
  const served = notice.appealServedDate || notice.date || "";
  const reg = regimeFor({ ay: notice.ay, communicatedOn: served });

  const bases = limitationBases(route, served);
  const operative = bases.find((b) => b.newAct === reg.newAct) || null;
  const other = bases.find((b) => b.newAct !== reg.newAct) || null;
  const deadline = operative ? operative.date : "";

  const daysLeft = daysUntil(deadline);
  const urgency = daysLeft == null ? "none"
    : daysLeft < 0 ? "lapsed"
      : daysLeft <= 7 ? "red"
        : daysLeft <= 15 ? "amber" : "green";

  return {
    route, reg, served, deadline, daysLeft, urgency,
    penalty: isPenaltyAppeal(notice),
    limitLabel: operative ? operative.label : "",
    limitDays: operative ? operative.days : null,
    bases, operative, other,
    // True when the two Acts give different answers — worth showing loudly,
    // because that gap is exactly where an appeal gets filed a week too late.
    basesDiffer: Boolean(operative && other && operative.date !== other.date),
    form: route === "CIT(A)" ? reg.citForm : reg.itatForm,
    servedField: route === "CIT(A)" ? "served" : "communicated",
  };
}

// Orders older than this (by date of order) are hidden by default — an appeal
// that old is almost always already filed/decided and just clutters the list.
export const DEFAULT_WINDOW_DAYS = 365;

// Keep undated orders (they carry no date to judge), and any order whose date
// falls within the window. Pass withinDays = null to keep everything.
function withinWindow(dateISO, withinDays) {
  if (!withinDays || !dateISO) return true;
  return daysUntil(dateISO) >= -withinDays;
}

// Every appealable order in the practice, nearest deadline first.
// opts.withinDays: date-of-order cutoff (default 365; null = no cutoff).
export function appealableOrders(data, opts = {}) {
  const withinDays = opts.withinDays === undefined ? DEFAULT_WINDOW_DAYS : opts.withinDays;
  const notices = data.notices || [];
  const matters = data.matters || [];
  return notices
    .filter((n) => isAppealableOrder(n) && APPEAL_ROUTE[n.authority] && !isAppealed(n, notices, matters) && withinWindow(n.date, withinDays))
    .map((n) => ({ notice: n, ...appealFor(n) }))
    .filter((x) => x.route)
    .sort((a, b) => (a.daysLeft == null ? 1e9 : a.daysLeft) - (b.daysLeft == null ? 1e9 : b.daysLeft));
}

/* ---------------- fees (Section 249 / 253(6)) ---------------- */

export const citAppealFee = (inc) => inc == null ? null : inc <= 100000 ? 250 : inc <= 200000 ? 500 : 1000;
export const itatAppealFee = (inc) => inc == null ? null : inc <= 100000 ? 500 : inc <= 200000 ? 1500 : Math.min(10000, Math.round(inc * 0.01));

/* An appeal against a PENALTY order carries a FLAT fee. The income slabs above
   are for appeals against an assessment of total income; a penalty appeal is
   not one, so assessed income is irrelevant to what it costs. */
export const PENALTY_FEE = { "CIT(A)": 250, "ITAT": 500 };

/* Is this an appeal against a penalty?
 *
 * Two shapes qualify, and the second is easy to get wrong:
 *   - the order on file IS a penalty order → first appeal to CIT(A);
 *   - the order on file is a CIT(A) order that DECIDED a penalty appeal → the
 *     onward ITAT appeal is still a penalty appeal, but its own docType is
 *     "appealOrder", so a naive check quotes the 1%-of-income slab instead of
 *     ₹500. Detected from the order's own text and parsed section.
 *
 * `appealFeePenalty` on the notice overrides the detection either way: the
 * practitioner knows what the order decided, and a wrong fee makes the appeal
 * defective. */
export function isPenaltyAppeal(n) {
  if (typeof n.appealFeePenalty === "boolean") return n.appealFeePenalty;
  const dt = orderDocType(n);
  if (dt === "penaltyOrder") return true;
  if (dt === "appealOrder") {
    const parsedSection = String((n.parsed && n.parsed.orderSection) || "");
    return PENALTY_RE.test(nameOf(n)) || PENALTY_RE.test(parsedSection);
  }
  return false;
}

export const appealFee = (route, inc, opts = {}) =>
  (opts.penalty ? (PENALTY_FEE[route] ?? null)
    : route === "CIT(A)" ? citAppealFee(inc) : itatAppealFee(inc));

export const FEE_SLABS = {
  "CIT(A)": [["≤ ₹1,00,000", "₹250"], ["₹1L – ₹2L", "₹500"], ["> ₹2,00,000", "₹1,000"]],
  "ITAT": [["≤ ₹1,00,000", "₹500"], ["₹1L – ₹2L", "₹1,500"], ["> ₹2,00,000", "1% (max ₹10,000)"]],
};

/* ---------------- document checklist ---------------- */

// Items marked auto:true are already satisfied from records on file.
export function checklistFor(x, allNotices) {
  const n = x.notice;
  const pan = (n.pan || "").toUpperCase();
  const ay = n.ay || "";
  const hasOrderPdf = Boolean(n.storagePath);
  const items = [];
  const sameParty = (m) => (m.pan || "").toUpperCase() === pan && m.ay === ay;
  if (x.route === "CIT(A)") {
    items.push({ key: "order", label: "Certified copy of the order appealed against", auto: hasOrderPdf });
    const demand = (allNotices || []).some((m) => sameParty(m) && orderDocType(m) === "demandNotice");
    items.push({ key: "demand", label: "Notice of demand u/s 156", auto: demand });
    items.push({ key: "gof", label: "Grounds of Appeal & Statement of Facts" });
    items.push({ key: "challan", label: "Appeal fee challan (Major Head 0021)" });
    items.push({ key: "dsc", label: "Digital Signature Certificate (DSC) — valid" });
    if (x.reg.newAct) items.push({ key: "predeposit", label: "Proof of pre-deposit of tax on returned income" });
  } else {
    items.push({ key: "citorder", label: "Certified copy of CIT(A) / NFAC order u/s 250", auto: hasOrderPdf });
    const asmt = (allNotices || []).some((m) => sameParty(m) && orderDocType(m) === "assessmentOrder" && m.storagePath);
    items.push({ key: "asmt", label: "Copy of the underlying assessment order", auto: asmt });
    items.push({ key: "gof", label: "Grounds of Appeal & Statement of Facts" });
    items.push({ key: "challan", label: "Tribunal fee challan" });
    items.push({ key: "dsc", label: "Digital Signature Certificate (DSC) — valid" });
  }
  if (x.urgency === "lapsed") items.push({ key: "condonation", label: "Application for condonation of delay + affidavit" });
  return items;
}
