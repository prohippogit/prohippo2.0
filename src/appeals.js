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
 *   - CIT(A): 30 days from date of service of the order / demand notice.
 *   - ITAT (1961 Act): 60 days from communication of the CIT(A) order.
 *   - ITAT (2025 Act, appeals for AY 2026-27 onward): 2 months from the END
 *     OF THE MONTH in which the CIT(A) order is communicated.
 */

const DAY = 86400000;
const parseISO = (s) => { const d = new Date(s + "T00:00:00"); d.setHours(0, 0, 0, 0); return d; };
const toISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const todayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
export const daysUntil = (iso) => (iso ? Math.round((parseISO(iso) - todayStart()) / DAY) : null);

// Last day of the month that falls `months` after the given date's month.
const endOfMonthPlus = (iso, months) => {
  const d = parseISO(iso);
  return toISO(new Date(d.getFullYear(), d.getMonth() + 1 + months, 0));
};

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

export const ayStartYear = (ay) => { const m = /^(\d{4})/.exec(String(ay || "")); return m ? +m[1] : null; };

// AY 2026-27 and earlier appeals stay under the 1961 Act (old forms); AY
// 2027-28 onward fall under the 2025 Act (new forms, new ITAT computation).
export function regimeForAy(ay) {
  const y = ayStartYear(ay);
  const newAct = y != null && y >= 2027;
  return newAct
    ? { act: "Act 2025", newAct: true, citForm: "Form 99", itatForm: "Form 115" }
    : { act: "Act 1961", newAct: false, citForm: "Form 35", itatForm: "Form 36" };
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

// Compute the appeal position for one order: forum, regime, deadline, urgency.
export function appealFor(notice) {
  const route = APPEAL_ROUTE[notice.authority];
  if (!route) return null;
  const reg = regimeForAy(notice.ay);
  const served = notice.appealServedDate || notice.date || "";

  let deadline = "";
  let limitLabel = "";
  let limitDays = null;
  if (served) {
    if (route === "CIT(A)") {
      limitDays = 30;
      deadline = toISO(addDays(parseISO(served), 30));
      limitLabel = "30 days from date of service";
    } else if (reg.newAct) {
      deadline = endOfMonthPlus(served, 2);
      limitLabel = "2 months from the end of the month of communication";
    } else {
      limitDays = 60;
      deadline = toISO(addDays(parseISO(served), 60));
      limitLabel = "60 days from communication of the order";
    }
  }

  const daysLeft = daysUntil(deadline);
  const urgency = daysLeft == null ? "none"
    : daysLeft < 0 ? "lapsed"
      : daysLeft <= 7 ? "red"
        : daysLeft <= 15 ? "amber" : "green";

  return {
    route, reg, served, deadline, daysLeft, urgency,
    limitLabel, limitDays,
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
export const appealFee = (route, inc) => (route === "CIT(A)" ? citAppealFee(inc) : itatAppealFee(inc));

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
