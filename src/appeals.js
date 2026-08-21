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
 * AN ASSESSMENT YEAR IS NOT AN APPEAL. A contested year holds as many orders as
 * the department passes in it — the assessment and its penalty, a set-aside and
 * the fresh assessment made in its place, a first-appeal order on the quantum
 * and another on the penalty — and every one of them carries its own limitation.
 * So an appeal already taken is attributed to ONE order, by date; a year's first
 * appellate step is never allowed to answer for every order in the year.
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

/* ---------------- which forum an order goes to ----------------
 *
 * Read from the DOCUMENT first, and only then from the proceeding it sits
 * under. `authority` is derived from the portal's proceeding NAME, and the
 * portal names a first-appeal proceeding a dozen ways; anything unrecognised
 * lands in "Other", which is not a key of APPEAL_ROUTE. An order the app itself
 * badges "CIT(A) order" then never reached this page at all — not because it
 * had been appealed, but because nobody could say where its appeal would go.
 */
const ROUTE_BY_DOCTYPE = { assessmentOrder: "CIT(A)", penaltyOrder: "CIT(A)", appealOrder: "ITAT" };

export function appealRoute(notice) {
  if (!notice) return null;
  // A Tribunal order is appealed to the High Court — out of scope here — and
  // its text quotes s.250 often enough to be misread as a first-appeal order.
  if (notice.authority === "ITAT") return null;
  return ROUTE_BY_DOCTYPE[orderDocType(notice)] || APPEAL_ROUTE[notice.authority] || null;
}

/* The date an order bears. `date` is what the portal sent (issued, else
   served); a PDF uploaded by hand may carry only what was read off it. */
export const orderDate = (n) => (n && (n.date || (n.parsed && n.parsed.orderDate) || n.servedOn)) || "";

// PAN + assessment year. The year is where two different orders MEET, never
// where they become one — see the attribution note below.
const partyKey = (r) => `${String((r && r.pan) || "").toUpperCase()}|${(r && r.ay) || ""}`;

const byOrderDate = (a, b) => String(orderDate(a)).localeCompare(String(orderDate(b)));

// Does a filed Form 35 NAME this order? Same PAN and AY to begin with, then the
// date of the order appealed against, corroborated where the form carries it by
// the order's DIN or section.
//
// A form that carries no order metadata at all names nothing — it used to be
// read as a match for every order in the year, which is exactly how a second
// order for the same year disappeared. Such a form is still evidence that an
// appeal was taken; which order it answers is settled by date, below.
export function form35Matches(order, form) {
  if ((form.pan || "").toUpperCase() !== (order.pan || "").toUpperCase()) return false;
  if ((form.ay || "") !== (order.ay || "")) return false;
  const meta = form.appeal || {};
  return namesOrder({ date: meta.dateOrder || "", din: meta.orderDin || "", section: meta.orderSection || "" }, order);
}

const namesOrder = (names, order) => Boolean(
  (names.date && orderDate(order) && names.date === orderDate(order))
  || (names.din && order.din && String(names.din) === String(order.din))
  || (names.section && order.section && String(names.section) === String(order.section))
);

/* ---------------- has this order already been appealed? ----------------
 *
 * The evidence that an appeal was taken — a Form 35 on file, a CIT(A) order
 * that decided one, an ITAT matter — is held against the PAN and the assessment
 * year, and for a long time that was all this asked. One year, one appeal.
 *
 * That is wrong whenever an assessment year carries MORE THAN ONE order, which
 * is the ordinary shape of a contested year: an assessment order and the
 * penalty that follows it; a set-aside and the fresh assessment made in its
 * place; a first-appeal order on the quantum and another on the penalty.
 * Matching on PAN + AY alone let the first appellate step in a year answer for
 * every order in it, so the newest order — the one whose limitation is actually
 * running — vanished behind a step taken a year earlier, with nothing on screen
 * to say it existed.
 *
 * So each piece of evidence is ATTRIBUTED to ONE order, never spread across a
 * year, and the date of the order is what tells them apart:
 *
 *   1. evidence that names its order (a Form 35 carrying the date / DIN /
 *      section of the order appealed against) takes that order;
 *   2. dated evidence takes the latest still-unanswered order passed ON OR
 *      BEFORE it — an appeal decided in July 2026 cannot be the answer to an
 *      order passed after it, and dated evidence with no order before it at all
 *      answers nothing on file;
 *   3. undated evidence — an ITAT matter typed in by hand carries no date —
 *      takes the earliest still-unanswered order, and only that one. One
 *      appeal silences one order.
 *
 * Where both sides say so, a penalty appeal is attributed to a penalty order
 * and a quantum appeal to a quantum order in preference to the date alone.
 */

// One appellate step: when it happened, which order it names (if any), and
// whether it was a penalty appeal (null when the evidence does not say).
//
// The evidence comes in two shapes — an appeal FILED (a Form 35 on file, an
// ITAT matter opened) and an appeal DECIDED (the appellate order itself) — and
// for a decided appeal both are usually on file. They are ONE appeal. Counted
// twice they would silence two orders: the one appealed and its neighbour in
// the same year. So each decision is paired with the latest filing that
// precedes it, and what survives is the filing's date and the order it names,
// which place the appeal more tightly than the decision does.
function appealSteps(route, pool, matters) {
  const filed = [];
  const decided = [];
  if (route === "CIT(A)") {
    for (const n of pool) {
      if (n.isAppealForm) {
        const meta = n.appeal || {};
        filed.push({
          on: meta.dateFiling || n.date || meta.ackDt || "",
          names: { date: meta.dateOrder || "", din: meta.orderDin || "", section: meta.orderSection || "" },
          penalty: PENALTY_RE.test(String(meta.orderSection || "")) || null,
        });
      } else if (isAppealableOrder(n) && orderDocType(n) === "appealOrder") {
        decided.push({ on: orderDate(n), names: null, penalty: isPenaltyAppeal(n) });
      }
    }
  } else if (route === "ITAT") {
    for (const n of pool) {
      if (n.authority === "ITAT" && isAppealableOrder(n)) {
        decided.push({ on: orderDate(n), names: null, penalty: isPenaltyAppeal(n) });
      }
    }
    for (const m of matters) {
      if (m.type !== "ITAT") continue;
      // A matter carries no filing date unless somebody typed one; an undated
      // matter is still one appeal, and is attributed as one.
      filed.push({
        on: m.filedOn || m.dateFiling || m.date || "",
        names: null,
        penalty: PENALTY_RE.test(String(m.section || "")) || null,
      });
    }
  }
  return pairFilingsWithDecisions(filed, decided);
}

const byOn = (a, b) => String(a.on).localeCompare(String(b.on));

// Each decision takes the latest filing that could have started it — one filed
// before it was passed, and about the same kind of order where both say. What
// is left on either side is an appeal in its own right: a filing not yet
// decided, or a decision whose paperwork never reached the app.
function pairFilingsWithDecisions(filed, decided) {
  const open = filed.map((_, i) => i);
  const steps = [];
  for (const d of [...decided].sort(byOn)) {
    const cands = open.filter((i) => !filed[i].on || !d.on || filed[i].on <= d.on);
    const fit = cands.filter((i) => filed[i].penalty == null || d.penalty == null || filed[i].penalty === d.penalty);
    const field = fit.length ? fit : cands;
    if (!field.length) { steps.push(d); continue; }
    const i = field[field.length - 1];
    open.splice(open.indexOf(i), 1);
    const f = filed[i];
    steps.push({ on: f.on || d.on, names: f.names, penalty: f.penalty == null ? d.penalty : f.penalty });
  }
  for (const i of open) steps.push(filed[i]);
  return steps;
}

/* Attribute the steps to the orders, one to one. `orders` is one party's
   appealable orders on one route, oldest first (undated first: an order with no
   date on it cannot be placed in the sequence, so it is never allowed to
   displace one that can). Returns the orders that are answered. */
function attribute(orders, steps) {
  const open = orders.map((_, i) => i);
  const answered = [];
  const claim = (i) => { answered.push(orders[i]); open.splice(open.indexOf(i), 1); };

  // Prefer a candidate whose penalty/quantum character matches the step's,
  // when both are known; otherwise take the whole field.
  const pick = (cands, step, end) => {
    if (!cands.length) return undefined;
    const fit = step.penalty == null ? cands : cands.filter((i) => isPenaltyAppeal(orders[i]) === step.penalty);
    const field = fit.length ? fit : cands;
    return end === "last" ? field[field.length - 1] : field[0];
  };

  // 1) evidence that names its order.
  const unnamed = [];
  for (const s of steps) {
    if (!s.names) { unnamed.push(s); continue; }
    const i = open.find((j) => namesOrder(s.names, orders[j]));
    if (i === undefined) unnamed.push({ ...s, names: null });
    else claim(i);
  }

  // 2) dated evidence, earliest first so each takes the order nearest below it.
  for (const s of unnamed.filter((x) => x.on).sort((a, b) => a.on.localeCompare(b.on))) {
    const i = pick(open.filter((j) => !orderDate(orders[j]) || orderDate(orders[j]) <= s.on), s, "last");
    // No order on file that this step could be about — it answers nothing here.
    if (i !== undefined) claim(i);
  }

  // 3) undated evidence takes the earliest order still unanswered.
  for (const s of unnamed.filter((x) => !x.on)) {
    const i = pick(open, s, "first");
    if (i !== undefined) claim(i);
  }
  return answered;
}

/* Every appealable order in `data` that already has its appeal. A Set of the
   very notice objects passed in — records reach this engine before they have an
   id of their own, and identity invented from PAN + AY is the bug this fixes. */
export function appealedOrders(data) {
  const notices = (data && data.notices) || [];
  const matters = (data && data.matters) || [];
  const answered = new Set();
  // Bucketed once. This runs on every render of the dashboard, the sidebar
  // count and this page, over every notice in the practice.
  const groups = new Map();
  const byParty = new Map();
  const mattersByParty = new Map();
  const push = (map, key, v) => { const l = map.get(key); if (l) l.push(v); else map.set(key, [v]); };
  for (const m of matters) push(mattersByParty, partyKey(m), m);
  for (const n of notices) {
    const party = partyKey(n);
    push(byParty, party, n);
    const route = isAppealableOrder(n) ? appealRoute(n) : null;
    if (!route) continue;
    // The practitioner's own word beats anything inferred, either way.
    if (n.appealStatus === "filed" || n.appealStatus === "dismissed") answered.add(n);
    const key = `${party}|${route}`;
    if (!groups.has(key)) groups.set(key, { route, party, orders: [] });
    groups.get(key).orders.push(n);
  }
  for (const g of groups.values()) {
    const pool = byParty.get(g.party) || [];
    const mine = mattersByParty.get(g.party) || [];
    g.orders.sort(byOrderDate);
    for (const o of attribute(g.orders, appealSteps(g.route, pool, mine))) answered.add(o);
  }
  return answered;
}

// Has this one order already been appealed? Kept for callers that hold a single
// order; the answer is still worked out over the whole set, because which order
// a year's appeal belongs to cannot be decided one order at a time.
export function isAppealed(notice, allNotices, matters) {
  if (notice.appealStatus === "filed" || notice.appealStatus === "dismissed") return true;
  return appealedOrders({ notices: allNotices || [notice], matters }).has(notice);
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
  const route = appealRoute(notice);
  if (!route) return null;
  const served = notice.appealServedDate || orderDate(notice);
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

/* Every appealable order in the practice, nearest deadline first.
 * opts.withinDays: date-of-order cutoff (default 365; null = no cutoff).
 *
 * Each row also carries where its order stands among the orders the same
 * assessee holds for the same assessment year (`ayIndex` of `ayCount`,
 * `ayLatest`). Two orders in one year are two appeals with two deadlines, and
 * on a list keyed by assessee and year they read as duplicates unless the page
 * says which is which. */
export function appealableOrders(data, opts = {}) {
  const withinDays = opts.withinDays === undefined ? DEFAULT_WINDOW_DAYS : opts.withinDays;
  const notices = data.notices || [];
  const appealed = appealedOrders(data);

  // Every appealable order of the year, appealed or not — the sequence a
  // practitioner sees on the assessee's page, which is what the position on the
  // card has to agree with.
  const inYear = new Map();
  for (const n of notices) {
    if (!isAppealableOrder(n) || !appealRoute(n)) continue;
    const k = partyKey(n);
    if (!inYear.has(k)) inYear.set(k, []);
    inYear.get(k).push(n);
  }
  for (const list of inYear.values()) list.sort(byOrderDate);

  return notices
    .filter((n) => isAppealableOrder(n) && appealRoute(n) && !appealed.has(n) && withinWindow(orderDate(n), withinDays))
    .map((n) => {
      const siblings = inYear.get(partyKey(n)) || [n];
      return {
        notice: n,
        ...appealFor(n),
        ayCount: siblings.length,
        ayIndex: siblings.indexOf(n) + 1,
        ayLatest: siblings[siblings.length - 1] === n,
      };
    })
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

/* ---------------- documents that belong to ONE order ----------------
 *
 * The enclosures of a year are not interchangeable either. A demand notice
 * belongs to the order it arrived with, and where a year holds two assessments
 * the underlying order of a CIT(A) order is the one that CIT(A) actually
 * decided — the last one passed before it, not whichever the year happens to
 * hold. Ticking the checklist off the wrong document tells a practitioner they
 * have a paper they have never seen.
 */

// An enclosure travels with its order: same portal proceeding, failing that the
// same date, failing that the year holds only one and there is nothing to
// confuse it with.
function companionOf(order, allNotices, docType) {
  const pool = (allNotices || []).filter((m) => partyKey(m) === partyKey(order) && orderDocType(m) === docType);
  if (!pool.length) return null;
  const mine = pool.filter((m) => order.proceedingReqId && m.proceedingReqId === order.proceedingReqId);
  if (mine.length) return mine[0];
  // The order's own proceeding is known and none of these came from it.
  const stray = pool.filter((m) => !(order.proceedingReqId && m.proceedingReqId && m.proceedingReqId !== order.proceedingReqId));
  const sameDay = stray.filter((m) => orderDate(m) && orderDate(m) === orderDate(order));
  if (sameDay.length) return sameDay[0];
  // Nothing left to tell them apart by: accept one, refuse a choice between two.
  const open = stray.filter((m) => !orderDate(m) || !orderDate(order));
  return open.length === 1 ? open[0] : null;
}

// The order an appellate order was passed ON: the latest one of its kind in the
// year that predates it.
function underlyingOrderFor(order, allNotices, docType) {
  const on = orderDate(order);
  const pool = (allNotices || [])
    .filter((m) => partyKey(m) === partyKey(order) && orderDocType(m) === docType)
    .sort(byOrderDate);
  const before = pool.filter((m) => !on || !orderDate(m) || orderDate(m) <= on);
  const field = before.length ? before : pool;
  return field.length ? field[field.length - 1] : null;
}

// Items marked auto:true are already satisfied from records on file.
export function checklistFor(x, allNotices) {
  const n = x.notice;
  const hasOrderPdf = Boolean(n.storagePath);
  const items = [];
  if (x.route === "CIT(A)") {
    items.push({ key: "order", label: "Certified copy of the order appealed against", auto: hasOrderPdf });
    const demand = Boolean(companionOf(n, allNotices, "demandNotice"));
    items.push({ key: "demand", label: "Notice of demand u/s 156", auto: demand });
    items.push({ key: "gof", label: "Grounds of Appeal & Statement of Facts" });
    items.push({ key: "challan", label: "Appeal fee challan (Major Head 0021)" });
    items.push({ key: "dsc", label: "Digital Signature Certificate (DSC) — valid" });
    if (x.reg.newAct) items.push({ key: "predeposit", label: "Proof of pre-deposit of tax on returned income" });
  } else {
    items.push({ key: "citorder", label: "Certified copy of CIT(A) / NFAC order u/s 250", auto: hasOrderPdf });
    const asmt = underlyingOrderFor(n, allNotices, "assessmentOrder");
    items.push({ key: "asmt", label: "Copy of the underlying assessment order", auto: Boolean(asmt && asmt.storagePath) });
    items.push({ key: "gof", label: "Grounds of Appeal & Statement of Facts" });
    items.push({ key: "challan", label: "Tribunal fee challan" });
    items.push({ key: "dsc", label: "Digital Signature Certificate (DSC) — valid" });
  }
  if (x.urgency === "lapsed") items.push({ key: "condonation", label: "Application for condonation of delay + affidavit" });
  return items;
}
