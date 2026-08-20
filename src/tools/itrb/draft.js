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
import { DII_ITEMS } from "./form.js";
import { PART_C_COLUMNS } from "./partC.js";
import { PART_B_LEAVES } from "./partB.js";
export { STATUSES, EMPLOYMENT_NATURE, FILED_UNDER, PENDING_UNDER } from "./form.js";
import { UNDISCLOSED_HEADS } from "./compute.js";
import { HEADS, declaredTotal } from "./declared.js";

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
    // "Y6" … "Y1", "Y0", "Y+1" — the form's own names for the rows.
    slot: period.slot,
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
    /* Part C's context columns [B] to [H] — the income already determined,
       assessed or declared for the year. None of it is added to or taken off
       the undisclosed income in column [A]; the form states it so the officer
       can see what the block income sits on top of. Sections travel with the
       two columns that carry them. */
    partC: Object.fromEntries(PART_C_COLUMNS.flatMap((c) => (
      c.hasSection ? [[c.key, ""], [`${c.key}Section`, ""]] : [[c.key, ""]]
    ))),
    declaredSource: "",   // "json" | "sync" | "manual" | ""
    declaredForm: "",
    ackNum: "",
    filedOn: "",
    returnFiled: true,
    /* Part A's per-year questions that nothing else on the row answers. The
       rest of what A26-A34 ask for is already here — the date of filing, the
       acknowledgement, the form, the income declared, and (as Part C's column
       [B]) the income after processing u/s 143(1) — and is read from there
       rather than stored twice. */
    partA: {
      filedSection: "",      // (ii) — the section the return was furnished under
      pending: "",           // (iv) — "No", or the section an assessment was pending under
      dueDateExpired: "",    // (ix) — where no return was filed
      itrFormChosen: "",     // (x)  — and the due date has not expired
    },
    /* Part B — the break-up of a part period's income. Carried on every row so
       a change of search date cannot strand it, but only ever asked of the one
       row that IS the part period; see partBYear(). */
    partB: Object.fromEntries(PART_B_LEAVES.map((r) => [r.key, ""])),
    /* A31/A33 (vii) and (viii) for a full year, A32/A34 (ii) and (iii) for a
       part period: the aggregate VALUE of international and specified domestic
       transactions. One pair of fields, because it is one question asked of
       whatever period the row covers — only the form's numbering differs. */
    intlTxnValue: "",
    sdtValue: "",
    undisclosed: blankUndisclosed(),
    /* Part D-II — the same undisclosed income, broken up item-wise instead of
       head-wise. The form requires the two to agree; computeItrB() checks. */
    items: Object.fromEntries(DII_ITEMS.map((i) => [i.key, ""])),
    itemRemarks: {},
    manner: "",           // s.158BC(1)(a) — the manner in which the income was derived
    evidence: "",         // the seized material it is derived from
    /* Credits, split the way the form splits them:
         Part G — advance tax and self-assessment tax paid EARLIER
         Part H — TDS and TCS, and only where NOT CLAIMED EARLIER
       Kept as one object because they are keyed against one year, but never
       presented as one list: the "not claimed earlier" condition applies to
       H alone, and a practitioner who cannot see the split cannot apply it. */
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
    // The date the search was initiated / the requisition made. Together with
    // lastAuthDate it fixes the whole block period — see blockPeriod.js.
    searchDate: "",
    // The date the LAST of the authorisations was executed. Blank means the
    // same day, which is what every draft written before the form's two-date
    // shape was understood carries, so those keep the period they had.
    lastAuthDate: "",
    lastPanchnamaDate: "",
    returnSection: "158BC",
    noticeDate: "",
    noticeDin: "",
    serviceDate: "",
    /* s.158BC(1)(a) allows the AO to fix a period not exceeding sixty days.
       The fifth proviso, inserted by the Finance Act 2025 with retrospective
       effect from 01-09-2024, allows a further thirty on conditions — so the
       period is 60 or 90, and it is read off the notice rather than assumed. */
    dueDateDays: 60,
    dueDate: "",
    filedOn: "",
    auditUs44AB: false,
    booksFound: true,

    taxRate: "",          // blank means s.113's 60%
    surchargeRate: "",
    cessRate: "",
    interestRate: "",
    interestMonths: "",   // blank means "derive it from the dates"

    noticeId: "",
    proceedingReqId: "",

    verifierName: "",
    verifierFather: "",
    verifierPan: "",
    verifierCapacity: "Self",
    verificationPlace: "",
    verificationDate: "",

    /* Part F — tax actually paid on the undisclosed income of the block period,
       as challans. Distinct from Parts G and H, which claim credit for tax paid
       in earlier years; this is money paid against THIS return. */
    blockTaxPaid: [],
    notes: "",
    years: [],
    updatedAt: "",
  };
}

/**
 * Re-cut the year rows for the search dates, keeping anything already entered.
 *
 * Either date moves the whole block period, and a practitioner who corrects a
 * typo in one should not lose the six years of figures they had already keyed.
 * Rows are matched by assessment year, so a date correction inside the same
 * financial year keeps everything, and a genuine change of year keeps the
 * overlap and blanks the rest.
 *
 * `patch` carries whichever date changed; the other is taken from the draft.
 */
export function withBlockPeriod(draft, patch) {
  const next = typeof patch === "string" ? { searchDate: patch } : (patch || {});
  const searchDate = next.searchDate !== undefined ? next.searchDate : draft.searchDate;
  const lastAuthDate = next.lastAuthDate !== undefined ? next.lastAuthDate : draft.lastAuthDate;

  const period = blockPeriod(searchDate, lastAuthDate);
  const existing = new Map((draft.years || []).map((y) => [y.ay, y]));
  const years = period.ok
    ? period.years.map((p) => {
      const prev = existing.get(p.ay);
      // The period's own fields always win over the stored copy: a row that was
      // the part period yesterday may be a whole year today.
      return prev
        ? { ...blankYear(p), ...prev, key: p.key, slot: p.slot, py: p.py, from: p.from, to: p.to, part: p.part }
        : blankYear(p);
    })
    : [];
  return {
    ...draft,
    searchDate,
    lastAuthDate,
    years,
    blockFrom: period.from || "",
    blockTo: period.to || "",
    // Part C of the form has two mutually exclusive tables and this chooses.
    blockSpansYears: Boolean(period.spansYears),
  };
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
 * Is this notice the one that starts a block return?
 *
 * Matched on the section rather than on the subject line, because the section
 * is what the portal supplies and what a practitioner keys. Both limbs count:
 * s.158BC for the searched person, and s.158BC in pursuance of s.158BD for the
 * other person whose income turns up in someone else's search.
 */
export const isBlockNotice = (notice) =>
  /158\s*BC/i.test(`${notice?.section || ""} ${notice?.subject || ""}`);

/**
 * Start a draft from the s.158BC notice already on file.
 *
 * The notice that begins a block assessment is almost always in the app before
 * anyone opens this tool — the portal sync brings it in with its DIN, its date,
 * the date it was served and the date the AO has allowed. Re-keying those four
 * is both wasted work and four chances to mistype the one thing that fixes a
 * sixty-day statutory deadline.
 *
 * `responseDueDate` is preferred over deriving the due date from service: the
 * AO fixes the period under s.158BC(1)(a), it may be sixty days or ninety under
 * the fifth proviso, and the notice says which. Deriving it would be guessing at
 * a figure we have been told.
 */
export function fromNotice(draft, notice, assessee) {
  if (!notice) return draft;
  const base = assessee ? fromAssessee(draft, assessee) : draft;
  const under158BD = /158\s*BD/i.test(`${notice.section || ""} ${notice.subject || ""}`);
  return {
    ...base,
    noticeId: notice.id || base.noticeId || "",
    proceedingReqId: notice.proceedingReqId || base.proceedingReqId || "",
    returnSection: under158BD ? "158BC/158BD" : "158BC",
    noticeDin: notice.din || base.noticeDin,
    noticeDate: notice.date || base.noticeDate,
    serviceDate: notice.servedOn || base.serviceDate,
    dueDate: notice.responseDueDate || base.dueDate,
    name: assessee?.name ? `ITR-B — ${assessee.name}` : base.name,
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
    /* Column [C] is this same figure — "total income declared in the return
       filed u/s 139(1)". Filled alongside rather than derived at print time,
       because the form lets it differ: [C] is expressly "not covered in [B]",
       so a year whose income has since been assessed belongs in [B] and the
       practitioner takes it out of [C] by hand. */
    partC: {
      ...year.partC,
      returned: total === null || total === undefined ? year.partC?.returned : total,
      returnedSection: year.partC?.returnedSection || "139(1)",
    },
    declaredSource: source,
    declaredForm: reading.formLabel || year.declaredForm,
    ackNum: reading.ackNum || year.ackNum,
    filedOn: reading.filedOn || year.filedOn,
    returnFiled: true,
    /* A26-A31(ii). Read from the return's own filing-status code where that
       code is one we have evidence for, left blank where it is not — see
       partA.js. Never overwritten once the practitioner has set it. */
    partA: {
      ...year.partA,
      filedSection: year.partA?.filedSection || reading.filedSection || "",
    },
  };
}

/** Fill the s.158BC due date from the date the notice was served, if unset. */
export function withDueDate(draft) {
  if (draft.dueDate || !draft.serviceDate) return draft;
  return { ...draft, dueDate: dueDateFor(draft.serviceDate, Number(draft.dueDateDays) || 60) };
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
  if (result && result.misplaced158BB3 && result.misplaced158BB3.length) {
    gaps.push(
      `Undisclosed income is shown against International or Specified Domestic Transactions for ${result.misplaced158BB3.join(", ")}, `
      + "which is a part period. s.158BB(3) puts that income outside the block return — it is assessed under the ordinary "
      + "provisions instead, so it should come out of Part D-II here (Note 4 to the form)."
    );
  }
  if (result && result.misplacedPartC && result.misplacedPartC.length) {
    const named = result.misplacedPartC.map((m) => `[${m.letter}] against ${m.slot}`).join(", ");
    gaps.push(
      `Part C has figures in columns that do not belong to those rows — ${named}. Columns [E] to [H] each describe one period `
      + "of the block, and a figure against any other year has nowhere to go on the form."
    );
  }
  if (result && result.partBTie && result.partBTie.entered && !result.partBTie.ties) {
    gaps.push(
      `Part B's row 6 comes to ${result.partBTie.partBTotal.toLocaleString("en-IN")} against the `
      + `${result.partBTie.partCTotal.toLocaleString("en-IN")} Part C states for the same part period. The form requires the two to agree.`
    );
  }
  if (result && result.itemsEntered && !result.itemsTie) {
    gaps.push(
      `Part D-II totals ${result.totalByItem.toLocaleString("en-IN")} against Part D-I's ${result.totalUndisclosed.toLocaleString("en-IN")}. `
      + "The form requires the two to agree."
    );
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
