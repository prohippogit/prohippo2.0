/*
 * The block period — s.158B(b) of the Income-tax Act, 1961.
 *
 * A search or requisition on or after 1 September 2024 puts the assessee into
 * block assessment under Chapter XIV-B, and the return for it is Form ITR-B
 * (rule 12AE, notified by Notification No. 30/2025 dated 7 April 2025). The
 * block period is not a single assessment year, which is the whole reason this
 * file exists: it is
 *
 *   the previous years relevant to the SIX assessment years preceding the
 *   assessment year relevant to the previous year in which the search was
 *   INITIATED,
 *
 *   PLUS the period from 1 April of that previous year to the date on which the
 *   last of the authorisations for the search (or the requisition) was EXECUTED.
 *
 * TWO DATES, NOT ONE. That last limb runs to the date of EXECUTION of the last
 * authorisation, which is not always in the same previous year as the
 * initiation — and the shape of the block period changes when it is not:
 *
 *   Initiated 01-07-2025, concluded 31-07-2025 (same previous year)
 *     Y6…Y1  A.Y. 2020-21 … 2025-26
 *     Y0     01-04-2025 to 31-07-2025      ← one part period, seven rows
 *
 *   Initiated 15-03-2026, concluded 05-04-2026 (the next previous year)
 *     Y6…Y1  A.Y. 2020-21 … 2025-26
 *     Y0     A.Y. 2026-27, the WHOLE year  ← now a full year
 *     Y+1    01-04-2026 to 05-04-2026      ← and a part period after it
 *
 * The six preceding years are the same in both; what changes is the tail. Form
 * ITR-B is built around exactly this distinction — Part C carries two mutually
 * exclusive tables, one for each case — so a tool that models a single "search
 * date" cannot fill the form for the second one at all.
 *
 * The rows are labelled Y6 … Y1, Y0, Y+1 because that is what the form calls
 * them, and a practitioner keying the portal should not have to translate.
 *
 * Everything here is pure and date-only. No timezone arithmetic: an ISO date is
 * split on hyphens rather than parsed into a Date, because `new Date("2025-04-01")`
 * is midnight UTC and in India that is the previous evening.
 */

/** "2025-11-15" → { y: 2025, m: 11, d: 15 }, or null if it isn't an ISO date. */
export function parseISO(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "").trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

/** The financial year a date falls in, as its starting calendar year. */
export function fyStart(iso) {
  const p = parseISO(iso);
  if (!p) return null;
  return p.m >= 4 ? p.y : p.y - 1;
}

/** F.Y. starting year → "2024-25". */
export const pyLabel = (start) => `${start}-${String((start + 1) % 100).padStart(2, "0")}`;

/** F.Y. starting year → the assessment year relevant to it, "2025-26". */
export const ayOfPy = (start) => `${start + 1}-${String((start + 2) % 100).padStart(2, "0")}`;

/** A.Y. "2025-26" → the F.Y. starting year it is relevant to (2024). */
export const pyOfAy = (ay) => {
  const m = /^(\d{4})-/.exec(String(ay || "").trim());
  return m ? Number(m[1]) - 1 : null;
};

/* The earliest search date Chapter XIV-B block assessment applies to. A search
   before this is assessed under s.153A/153C and has no ITR-B at all, so the
   tool says so rather than quietly producing a block period that does not
   exist. */
export const BLOCK_REGIME_FROM = "2024-09-01";

/**
 * Build the block period.
 *
 * @param initiation  ISO date the search was initiated / the requisition made
 * @param lastAuth    ISO date the last of the authorisations was executed.
 *                    Blank means "the same day" — which is also what a draft
 *                    saved before this file knew about two dates carries, so an
 *                    existing draft keeps exactly the block period it had.
 * @returns { ok, reason, from, to, initiationPy, spansYears, years }
 *
 * `years` runs OLDEST FIRST — that is the order the form prints, and the order
 * a practitioner reads a block period in. Exactly one row carries `part: true`:
 * the last one, which ends on the date of execution rather than on 31 March.
 */
export function blockPeriod(initiation, lastAuth) {
  const parsed = parseISO(initiation);
  if (!parsed) return { ok: false, reason: "Enter the date the search was initiated or the requisition made.", years: [] };
  if (String(initiation) < BLOCK_REGIME_FROM) {
    return {
      ok: false,
      reason: "Chapter XIV-B block assessment applies to searches initiated on or after 01-09-2024. An earlier search is assessed under s.153A/153C, for which there is no ITR-B.",
      years: [],
    };
  }

  /* An absent execution date means the search began and ended the same day, so
     far as this calculation can tell. That is the ordinary case AND the safe
     one: it produces the shorter block period, never a longer one the facts do
     not support. */
  const end = parseISO(lastAuth) ? String(lastAuth) : String(initiation);
  if (end < String(initiation)) {
    return {
      ok: false,
      reason: "The last authorisation cannot have been executed before the search was initiated.",
      years: [],
    };
  }

  const initiationPy = fyStart(initiation);
  const endPy = fyStart(end);

  const years = [];
  // Y6 … Y1 — the previous years relevant to the six A.Y.s preceding the A.Y.
  // relevant to the previous year of INITIATION. Never affected by the tail.
  for (let i = 6; i >= 1; i--) {
    const start = initiationPy - i;
    years.push({
      key: pyLabel(start),
      slot: `Y${i}`,
      py: pyLabel(start),
      ay: ayOfPy(start),
      from: `${start}-04-01`,
      to: `${start + 1}-03-31`,
      part: false,
    });
  }

  /* Y0 onwards. One row per previous year from the initiation year through the
     year the last authorisation was executed in — normally just Y0. Only the
     final row is a part period; any year in between is complete and is carried
     whole, which is what makes the loop right rather than a special case for
     the one-year gap the form illustrates. */
  for (let start = initiationPy; start <= endPy; start++) {
    const last = start === endPy;
    const offset = start - initiationPy;
    years.push({
      key: last ? `${pyLabel(start)}-part` : pyLabel(start),
      slot: offset === 0 ? "Y0" : `Y+${offset}`,
      py: pyLabel(start),
      ay: ayOfPy(start),
      from: `${start}-04-01`,
      to: last ? end : `${start + 1}-03-31`,
      part: last,
    });
  }

  return {
    ok: true,
    reason: "",
    from: years[0].from,
    to: end,
    initiationPy: pyLabel(initiationPy),
    /* Whether the last authorisation was executed in a previous year AFTER the
       one the search began in. Part C of ITR-B has two mutually exclusive
       tables and this is the flag that chooses between them. */
    spansYears: endPy > initiationPy,
    years,
  };
}

/**
 * The last date for furnishing the return — s.158BC(1)(a) gives sixty days from
 * the date of service of the notice. Returned as an ISO date, or "" when the
 * service date is not yet known.
 */
export function dueDateFor(serviceDate, days = 60) {
  const p = parseISO(serviceDate);
  if (!p) return "";
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Whole months (and parts of a month) of delay between two ISO dates — the
 * measure s.158BFA(1) charges interest on, where "part of a month" counts as a
 * full one. Nil when the return is on or before the due date.
 */
export function monthsOfDelay(dueDate, filedOn) {
  const a = parseISO(dueDate), b = parseISO(filedOn);
  if (!a || !b) return 0;
  if (String(filedOn) <= String(dueDate)) return 0;
  const whole = (b.y - a.y) * 12 + (b.m - a.m);
  return b.d > a.d ? whole + 1 : whole;
}
