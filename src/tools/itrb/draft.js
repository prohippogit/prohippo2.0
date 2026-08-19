/*
 * The ITR-B draft — its shape, its defaults, and how it is filled from what the
 * practice already holds.
 *
 * A block return is seven years of figures behind one PAN, and nobody types
 * that in one sitting. So the draft is a plain JSON object from the start: it
 * is what the form edits, what Firestore stores under users/{uid}/itrbDrafts,
 * what the PDF is built from, and what "Export draft" hands back. One shape,
 * four consumers, no conversion step in between — a field added here reaches
 * all of them.
 *
 * Everything in this file is pure. The Firestore write lives in store.jsx and
 * the Storage read lives in the page; both hand their result here rather than
 * this module reaching for either, which is what lets the whole model be tested
 * with `node --test`.
 */
import { blockPeriod, dueDateFor } from "./blockPeriod.js";
import { UNDISCLOSED_HEADS } from "./compute.js";
import { HEADS, declaredTotal } from "./declared.js";

export const STATUSES = [
  "Individual", "HUF", "Firm", "LLP", "Company", "AOP", "BOI",
  "Trust", "Local authority", "Artificial juridical person",
];

/** How the block proceeding was initiated. */
export const SEARCH_SECTIONS = [
  { value: "132", label: "s.132 — search" },
  { value: "132A", label: "s.132A — requisition" },
];

/** Which limb of s.158BC the return is being furnished under. */
export const RETURN_SECTIONS = [
  { value: "158BC", label: "s.158BC — the searched person" },
  { value: "158BC/158BD", label: "s.158BC r.w.s. 158BD — the other person" },
];

const blankUndisclosed = () =>
  Object.fromEntries(UNDISCLOSED_HEADS.map((h) => [h.key, ""]));

const blankDeclared = () =>
  Object.fromEntries(HEADS.map((h) => [h.key, null]));

/** One year of the block period, with nothing entered against it yet. */
export function blankYear(period) {
  return {
    key: period.key,
    ay: period.ay,
    py: period.py,
    from: period.from,
    to: period.to,
    part: period.part,
    /* The income already disclosed for the year. `declared` holds the head
       figures exactly as the filed return states them; `declaredTotal` is the
       one number the computation uses, kept separate so a practitioner can
       override it for a year whose return was never filed or whose assessment
       has since determined something else. */
    declared: blankDeclared(),
    declaredTotal: "",
    declaredSource: "",   // "json" | "sync" | "manual" | ""
    declaredForm: "",
    ackNum: "",
    filedOn: "",
    returnFiled: true,
    undisclosed: blankUndisclosed(),
    manner: "",           // s.158BC(1)(a) — the manner in which the income was derived
    evidence: "",         // the seized material it is derived from
    credits: { tds: "", tcs: "", advance: "", selfAssessment: "" },
  };
}

/** A draft with nothing in it. */
export function blankDraft() {
  return {
    version: 1,
    name: "Untitled ITR-B",
    assesseeId: "",
    pan: "",
    assessee: "",
    status: "Individual",
    dob: "",
    address: "",
    mobile: "",
    email: "",
    aadhaar: "",
    residentialStatus: "Resident",

    searchSection: "132",
    searchDate: "",
    lastPanchnamaDate: "",
    returnSection: "158BC",
    noticeDate: "",
    noticeDin: "",
    serviceDate: "",
    dueDate: "",
    filedOn: "",
    auditUs44AB: false,
    booksFound: true,

    taxRate: "",          // blank means s.113's 60%
    surchargeRate: "",
    cessRate: "",
    interestRate: "",
    interestMonths: "",   // blank means "derive it from the dates"

    verifierName: "",
    verifierFather: "",
    verifierPan: "",
    verifierCapacity: "Self",
    verificationPlace: "",
    verificationDate: "",

    notes: "",
    years: [],
    updatedAt: "",
  };
}

/**
 * Re-cut the year rows for a search date, keeping anything already entered.
 *
 * Changing the search date moves the whole block period, and a practitioner who
 * corrects a typo in it should not lose the six years of figures they had
 * already keyed. Rows are matched by assessment year, so a date correction
 * inside the same financial year keeps everything, and a genuine change of year
 * keeps the overlap and blanks the rest.
 */
export function withBlockPeriod(draft, searchDate) {
  const period = blockPeriod(searchDate);
  const existing = new Map((draft.years || []).map((y) => [y.ay, y]));
  const years = period.ok
    ? period.years.map((p) => {
      const prev = existing.get(p.ay);
      return prev
        ? { ...blankYear(p), ...prev, key: p.key, py: p.py, from: p.from, to: p.to, part: p.part }
        : blankYear(p);
    })
    : [];
  return { ...draft, searchDate, years, blockFrom: period.from || "", blockTo: period.to || "" };
}

/**
 * Fill Part A from the assessee already on file — feature (i).
 *
 * The PAN, the name, the status and the contact details are things the practice
 * keyed once when the client was taken on, and re-keying them into a block
 * return is both wasted work and a chance to mistype a PAN into a document that
 * goes to the department. Only fields the assessee record actually carries are
 * written, so this never blanks something the practitioner typed by hand.
 */
export function fromAssessee(draft, a) {
  if (!a) return draft;
  const set = (cur, next) => (next ? next : cur);
  return {
    ...draft,
    assesseeId: a.id || draft.assesseeId,
    pan: (a.pan || draft.pan || "").toUpperCase(),
    assessee: set(draft.assessee, a.name),
    status: a.status || draft.status,
    address: set(draft.address, a.address),
    mobile: set(draft.mobile, a.mobile),
    email: set(draft.email, a.email),
    dob: set(draft.dob, a.dob),
    name: a.name ? `ITR-B — ${a.name}` : draft.name,
    verifierName: set(draft.verifierName, a.name),
    verifierPan: set(draft.verifierPan, (a.pan || "").toUpperCase()),
  };
}

/**
 * Write a year's declared income from a reading of that year's ITR JSON —
 * feature (ii).
 *
 * @param year     the row to fill
 * @param reading  readDeclared()'s output for that year's return
 * @param source   where the JSON came from: "json" (uploaded) or "sync" (the
 *                 copy the portal sync already holds in Storage)
 *
 * The head figures are stored as the return states them, and the total is taken
 * from the return's own Total Income rather than re-added — s.158BB reduces the
 * block income by what was DISCLOSED, and what was disclosed is the figure in
 * the return, not a figure this tool arrived at.
 */
export function withDeclared(year, reading, source = "json") {
  if (!reading) return year;
  const declared = {};
  for (const h of HEADS) declared[h.key] = reading[h.key];
  const total = declaredTotal(reading);
  return {
    ...year,
    declared,
    declaredTotal: total === null || total === undefined ? year.declaredTotal : total,
    declaredSource: source,
    declaredForm: reading.formLabel || year.declaredForm,
    ackNum: reading.ackNum || year.ackNum,
    filedOn: reading.filedOn || year.filedOn,
    returnFiled: true,
  };
}

/** Fill the s.158BC due date from the date the notice was served, if unset. */
export function withDueDate(draft) {
  if (draft.dueDate || !draft.serviceDate) return draft;
  return { ...draft, dueDate: dueDateFor(draft.serviceDate) };
}

/**
 * What still stands between this draft and a return that can be filed.
 *
 * Deliberately advisory: the tool produces a MOCK return to work from and to
 * carry into the portal, so it never refuses to build one. It says what a
 * reviewer would say, in the order they would say it.
 */
export function readiness(draft, result) {
  const gaps = [];
  const d = draft || {};
  if (!/^[A-Z]{5}\d{4}[A-Z]$/.test((d.pan || "").toUpperCase())) gaps.push("A valid PAN for the assessee.");
  if (!d.assessee) gaps.push("The assessee's name.");
  if (!d.searchDate) gaps.push("The date of the search or requisition — the block period follows from it.");
  if (!d.serviceDate) gaps.push("The date the s.158BC notice was served, which fixes the sixty-day due date.");
  if (!d.noticeDin) gaps.push("The DIN of the s.158BC notice.");
  if (result && !result.hasContent) gaps.push("Undisclosed income against at least one year of the block period.");
  const unexplained = (d.years || []).filter((y) => {
    const total = Object.values(y.undisclosed || {}).reduce((a, b) => a + (Number(b) || 0), 0);
    return total > 0 && !String(y.manner || "").trim();
  });
  if (unexplained.length) {
    gaps.push(`The manner in which the income was derived, for ${unexplained.map((y) => y.ay).join(", ")} — s.158BC(1)(a) asks for it.`);
  }
  if (!d.verifierName) gaps.push("The name of the person verifying the return.");
  return gaps;
}

/** A one-line description of a saved draft, for the drafts list. */
export function draftSummary(draft) {
  const years = (draft.years || []).length;
  return [
    draft.pan || "No PAN",
    years ? `${years}-year block period` : "Block period not set",
    draft.searchDate ? `search ${draft.searchDate}` : "",
  ].filter(Boolean).join(" · ");
}
