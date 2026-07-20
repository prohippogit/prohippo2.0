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

// Has this order already been appealed? Manual flag wins; otherwise infer from
// the presence of a filed appeal form or a later-stage order for the same PAN+AY.
export function isAppealed(notice, allNotices, matters) {
  if (notice.appealStatus === "filed" || notice.appealStatus === "dismissed") return true;
  const pan = (notice.pan || "").toUpperCase();
  const ay = notice.ay || "";
  const sameParty = (r) => (r.pan || "").toUpperCase() === pan && r.ay === ay;
  const route = APPEAL_ROUTE[notice.authority];
  if (route === "CIT(A)") {
    return allNotices.some((n) => sameParty(n) && (n.isAppealForm || (n.isOrder && n.authority === "CIT(A)")));
  }
  if (route === "ITAT") {
    return (matters || []).some((m) => m.type === "ITAT" && sameParty(m))
      || allNotices.some((n) => sameParty(n) && n.isOrder && n.authority === "ITAT");
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

// Every appealable order in the practice, nearest deadline first.
export function appealableOrders(data) {
  const notices = data.notices || [];
  const matters = data.matters || [];
  return notices
    .filter((n) => n.isOrder && APPEAL_ROUTE[n.authority] && !isAppealed(n, notices, matters))
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
  if (x.route === "CIT(A)") {
    items.push({ key: "order", label: "Certified copy of the order appealed against", auto: hasOrderPdf });
    items.push({ key: "demand", label: "Notice of demand u/s 156" });
    items.push({ key: "gof", label: "Grounds of Appeal & Statement of Facts" });
    items.push({ key: "challan", label: "Appeal fee challan (Major Head 0021)" });
    items.push({ key: "dsc", label: "Digital Signature Certificate (DSC) — valid" });
    if (x.reg.newAct) items.push({ key: "predeposit", label: "Proof of pre-deposit of tax on returned income" });
  } else {
    items.push({ key: "citorder", label: "Certified copy of CIT(A) / NFAC order u/s 250", auto: hasOrderPdf });
    const asmt = (allNotices || []).some((m) => m.isOrder && m.authority === "Scrutiny"
      && (m.pan || "").toUpperCase() === pan && m.ay === ay && m.storagePath);
    items.push({ key: "asmt", label: "Copy of the underlying assessment order", auto: asmt });
    items.push({ key: "gof", label: "Grounds of Appeal & Statement of Facts" });
    items.push({ key: "challan", label: "Tribunal fee challan" });
    items.push({ key: "dsc", label: "Digital Signature Certificate (DSC) — valid" });
  }
  if (x.urgency === "lapsed") items.push({ key: "condonation", label: "Application for condonation of delay + affidavit" });
  return items;
}
