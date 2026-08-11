/* ProHippo — what goes on a cause list, and for which days.
 *
 * A cause list is the sheet a practitioner carries into the week: every
 * hearing, in order, with enough on each line to walk into the room — who,
 * before whom, which year, under which section, and whether it is by video.
 *
 * Pure, no React and no jsPDF, so the selection rules are tested rather than
 * eyeballed against a live practice. causeListPdf.js draws what this returns.
 */

// Monday, as the week grid on the Hearings page reckons it (startOfWeek there).
// India's tribunals and assessment units work a Monday-to-Friday week; starting
// the list on Sunday would put the two quietest days at opposite ends of it.
export function startOfWeek(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

export const toISO = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return toISO(d);
}

// The Monday–Sunday the given day falls in.
export function weekRange(day = new Date()) {
  const from = toISO(startOfWeek(day instanceof Date ? day : new Date(day + "T00:00:00")));
  return { from, to: addDays(from, 6) };
}

// The calendar month the given day falls in.
export function monthRange(day = new Date()) {
  const d = day instanceof Date ? day : new Date(day + "T00:00:00");
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return { from: toISO(first), to: toISO(last) };
}

/* Every day in the range, inclusive of both ends. Capped, because the range is
   typed by hand: a fat-fingered year would otherwise ask the PDF to draw four
   hundred thousand day headers. */
export const MAX_RANGE_DAYS = 366;

export function rangeDays(from, to) {
  if (!from || !to || to < from) return [];
  const out = [];
  let cur = from;
  while (cur <= to && out.length < MAX_RANGE_DAYS) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

/* Days with nothing listed are SHOWN on a short list and dropped from a long
   one. On a week, "Thursday is clear" is half of what the sheet is for. Over a
   quarter, thirty empty rows are just paper. */
export const EMPTY_DAY_LIMIT = 21;

/* The hearings that belong on the list.
 *
 * ADJOURNED HEARINGS ARE OUT by default. An adjourned date is precisely the one
 * nobody should turn up on, and the new date is already its own record — a
 * cause list that carries both is worse than one that carries neither.
 *
 * Sorted by date then time then assessee: the order the day is actually worked
 * in, and stable for two hearings listed at the same hour.
 */
export function causeListRows(hearings, { from, to, authority = "All", includeAdjourned = false } = {}) {
  if (!from || !to) return [];
  return (hearings || [])
    .filter((h) => {
      const d = h && h.date;
      if (!d || d < from || d > to) return false;
      if (!includeAdjourned && h.status === "Adjourned") return false;
      if (authority && authority !== "All" && h.authority !== authority) return false;
      return true;
    })
    .sort((a, b) =>
      (a.date || "").localeCompare(b.date || "")
      || (a.time || "").localeCompare(b.time || "")
      || (a.assessee || "").localeCompare(b.assessee || ""));
}

/* Group the rows under one entry per day, in date order.
 *
 * `withEmptyDays` fills in the days nothing is listed on, so a week reads as a
 * week rather than as a list of three dates with the rest left to memory.
 *
 * Empty days at the ENDS are trimmed even then. A gap between two listed days
 * is worth printing — it is the free afternoon somebody is looking for. A quiet
 * Saturday and Sunday after the last hearing of the week are not: the period is
 * already stated at the top, and on a full sheet those two lines are what push
 * the whole thing onto a second page. */
export function groupByDay(rows, { from, to, withEmptyDays } = {}) {
  const byDay = new Map();
  for (const h of rows || []) {
    if (!byDay.has(h.date)) byDay.set(h.date, []);
    byDay.get(h.date).push(h);
  }
  if (!(from && to && withEmptyDays)) {
    return [...byDay.keys()].sort().map((iso) => ({ iso, hearings: byDay.get(iso) }));
  }
  const days = rangeDays(from, to).map((iso) => ({ iso, hearings: byDay.get(iso) || [] }));
  const first = days.findIndex((d) => d.hearings.length);
  if (first < 0) return [];
  let last = days.length - 1;
  while (last > first && !days[last].hearings.length) last--;
  return days.slice(first, last + 1);
}

// Whether a range is short enough to print its empty days.
export function shouldShowEmptyDays(from, to) {
  return rangeDays(from, to).length <= EMPTY_DAY_LIMIT;
}

/* The counts the sheet's header carries. Assessees are counted distinctly: a
   client with three years listed is one person to prepare for, and "12 hearings
   for 5 assessees" is a different day from "12 hearings for 12". */
export function causeListSummary(rows) {
  const list = rows || [];
  const uniq = (fn) => new Set(list.map(fn).filter(Boolean)).size;
  return {
    hearings: list.length,
    days: uniq((h) => h.date),
    assessees: uniq((h) => (h.pan || h.assessee || "").toString().toUpperCase()),
    authorities: uniq((h) => h.authority),
    videoConference: list.filter((h) => h.mode === "Video Conference").length,
  };
}
