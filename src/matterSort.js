/* ProHippo — how the Matters table is ordered.
 *
 * Pure, no React, so the ordering rules can be tested directly rather than
 * eyeballed against a live practice.
 *
 * The table used to render in whatever order Firestore handed the matters back,
 * which is no order at all: a practitioner looking for "whose hearing is next"
 * or "what is still Active" had to read every row. Each column now sorts.
 *
 * THREE RULES HOLD ACROSS EVERY COLUMN, because a sort that breaks them is
 * worse than none:
 *
 *   BLANKS ALWAYS SINK. A matter with no bench, no section or no hearing sorts
 *   to the bottom in BOTH directions. Reversing a sort to see the other end of
 *   the data, and getting a screenful of dashes instead, is how a table teaches
 *   someone to stop clicking its headers.
 *
 *   THE ORDER IS TOTAL. Every comparison falls through to assessee, then AY,
 *   then id, so two matters that tie never swap places between renders — a list
 *   that reshuffles under the cursor cannot be read.
 *
 *   STATUS SORTS BY WORKFLOW, NOT ALPHABET. "Active, Pending, Submitted,
 *   Decided, Closed" is the order the work actually runs in; alphabetically it
 *   reads Active, Closed, Decided, Pending, Submitted, which puts finished
 *   matters in the middle of live ones.
 */

// The workflow order, matching MATTER_STATUSES in Other.jsx. Anything unknown
// sorts after everything named rather than being silently treated as "Active".
const STATUS_ORDER = ["Active", "Pending", "Submitted", "Decided", "Closed"];

// Proceedings, roughly by how far up the appellate chain they sit — the order
// they are listed in on the page's own tabs.
const TYPE_ORDER = ["Scrutiny", "CIT(A)", "ITAT", "Penalty", "Rectification", "High Court"];

const rank = (list, v) => {
  const i = list.indexOf(String(v || "").trim());
  return i < 0 ? list.length : i;
};

const text = (v) => String(v == null ? "" : v).trim();

/* Assessment years compare as text ("2021-22" < "2022-23") once padded, but a
   year typed as "2021-2022" or "21-22" would not line up with one typed the
   usual way. Reduce to the opening year as a number, so every spelling of the
   same year sorts together. */
function ayKey(v) {
  const m = /(\d{4})/.exec(text(v));
  if (m) return Number(m[1]);
  const short = /^(\d{2})\b/.exec(text(v));
  return short ? 2000 + Number(short[1]) : null;
}

/* A section as a number plus its sub-clause, so 90 comes before 143(1) and
   143(1) before 143(2) — which sorting the strings gets wrong twice over
   ("143(2)" < "90" as text). */
function sectionKey(v) {
  const s = text(v);
  if (!s) return null;
  const m = /(\d+)\s*(?:\(\s*([^)]*)\s*\))?/.exec(s);
  if (!m) return null;
  return [Number(m[1]), text(m[2]).toLowerCase()];
}

/* One column's sort value. `null` means "this row has nothing here" and sinks,
   in either direction. ctx.hearingDate resolves a matter's next hearing, which
   the table computes once for every row rather than per comparison. */
const KEYS = {
  matter: (m) => [rank(TYPE_ORDER, m.type), text(m.ref).toLowerCase()],
  assessee: (m) => text(m.assessee).toLowerCase() || null,
  ay: (m) => ayKey(m.ay),
  section: (m) => sectionKey(m.section),
  bench: (m) => text(m.bench).toLowerCase() || null,
  status: (m) => rank(STATUS_ORDER, m.status),
  hearing: (m, ctx) => (ctx && ctx.hearingDate ? ctx.hearingDate(m) : m.hearingDate) || null,
  staff: (m) => text(m.staff).toLowerCase() || null,
};

// Which columns can be sorted, and what a click on each is described as. The
// table reads its headers off this, so a column cannot appear sortable and not
// be, or be sortable with no way to say what it did.
export const MATTER_SORT_COLUMNS = {
  matter: "Matter",
  assessee: "Assessee",
  ay: "AY",
  section: "Section",
  bench: "Bench / Officer",
  status: "Status",
  hearing: "Next hearing",
  staff: "Staff",
};

// What each column means by "ascending", in words, for the header's tooltip.
export const MATTER_SORT_HINT = {
  matter: ["Scrutiny first", "High Court first"],
  assessee: ["A → Z", "Z → A"],
  ay: ["oldest year first", "newest year first"],
  section: ["lowest section first", "highest section first"],
  bench: ["A → Z", "Z → A"],
  status: ["Active first", "Closed first"],
  hearing: ["soonest first", "furthest away first"],
  staff: ["A → Z", "Z → A"],
};

function cmpValue(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const c = cmpValue(a[i] == null ? null : a[i], b[i] == null ? null : b[i]);
      if (c) return c;
    }
    return 0;
  }
  // Within a tuple an empty part is just "nothing more to compare", not a blank
  // row, so it sorts first rather than sinking.
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

/* Sort a copy of `rows`. `dir` is "asc" | "desc"; an unknown key leaves the
   rows in the order they arrived, so a stale saved sort can never blank a
   table. */
export function sortMatters(rows, key, dir = "asc", ctx = {}) {
  const get = KEYS[key];
  if (!get) return [...(rows || [])];
  const sign = dir === "desc" ? -1 : 1;
  const tie = (m) => [text(m.assessee).toLowerCase(), ayKey(m.ay) ?? 0, text(m.id)];

  return [...(rows || [])].sort((x, y) => {
    const a = get(x, ctx);
    const b = get(y, ctx);
    // A row with nothing in this column sits at the bottom whichever way the
    // arrow points — see the header comment.
    const aEmpty = a == null;
    const bEmpty = b == null;
    if (aEmpty || bEmpty) {
      if (aEmpty && bEmpty) return cmpValue(tie(x), tie(y));
      return aEmpty ? 1 : -1;
    }
    return cmpValue(a, b) * sign || cmpValue(tie(x), tie(y));
  });
}

// Clicking the column already sorted flips it; clicking a different one starts
// it ascending, whatever "ascending" means for that column (MATTER_SORT_HINT
// spells each one out on the header itself).
export function nextSort(current, key) {
  if (current && current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: "asc" };
}
