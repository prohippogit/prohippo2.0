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
 *   initiated,
 *
 *   PLUS the part of that previous year running from 1 April to the date of
 *   the last of the authorisations for the search (or the requisition).
 *
 * So a search on 15 November 2025 falls in P.Y. 2025-26 (A.Y. 2026-27); the six
 * preceding assessment years are A.Y. 2020-21 to A.Y. 2025-26, whose previous
 * years are 2019-20 to 2024-25; and the part period is 01-04-2025 to
 * 15-11-2025. Seven rows, and the last one is a stub of a year — which is why
 * every row carries `part` and its own from/to rather than only an A.Y.
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
 * Build the block period for a search or requisition date.
 *
 * @param searchDate  ISO date of the last authorisation / requisition
 * @returns { ok, reason, from, to, searchPy, years }
 *
 * `years` runs OLDEST FIRST — that is the order the form prints, and the order
 * a practitioner reads a block period in. The final entry is the part period
 * and carries `part: true`; it is the only row whose `to` is not 31 March.
 */
export function blockPeriod(searchDate) {
  const parsed = parseISO(searchDate);
  if (!parsed) return { ok: false, reason: "Enter the date of the search or requisition.", years: [] };
  if (String(searchDate) < BLOCK_REGIME_FROM) {
    return {
      ok: false,
      reason: "Chapter XIV-B block assessment applies to searches initiated on or after 01-09-2024. An earlier search is assessed under s.153A/153C, for which there is no ITR-B.",
      years: [],
    };
  }

  const searchPy = fyStart(searchDate);
  // The six previous years relevant to the six A.Y.s preceding the A.Y. of the
  // search year: P.Y. (search − 6) through P.Y. (search − 1).
  const years = [];
  for (let i = 6; i >= 1; i--) {
    const start = searchPy - i;
    years.push({
      key: pyLabel(start),
      py: pyLabel(start),
      ay: ayOfPy(start),
      from: `${start}-04-01`,
      to: `${start + 1}-03-31`,
      part: false,
    });
  }
  years.push({
    key: `${pyLabel(searchPy)}-part`,
    py: pyLabel(searchPy),
    ay: ayOfPy(searchPy),
    from: `${searchPy}-04-01`,
    to: searchDate,
    part: true,
  });

  return {
    ok: true,
    reason: "",
    from: years[0].from,
    to: searchDate,
    searchPy: pyLabel(searchPy),
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
