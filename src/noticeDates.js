/* ProHippo — the dates on a notice, and what became of the reply.
 *
 * Pure, no React, no network, so the rules can be tested directly.
 *
 * THREE DATES, THREE DIFFERENT JOBS, and the card used to show only the first:
 *
 *   issued      when the officer signed it. What every list is sorted by.
 *   served      when it reached the assessee. s.249(2) runs the appeal window
 *               from HERE, not from issue, and a notice issued on the 30th and
 *               served on the 3rd has three days of somebody's window already
 *               gone before anyone opened the app.
 *   reply due   the date the practice actually works to. The portal has always
 *               sent it and the dashboard has always used it; the proceeding
 *               card simply never printed it.
 *
 * And after a reply goes in, one more: the date the officer OPENED it. That is
 * the difference between "he hasn't looked yet" and "he's looked and said
 * nothing", which are two completely different conversations to have with a
 * client.
 */

const DAY = 86400000;

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const parseISO = (s) => startOfDay(new Date(`${s}T00:00:00`));

/** Whole days from today to an ISO date. Negative is in the past. */
export function daysUntilDate(iso, today = new Date()) {
  if (!iso) return null;
  const d = parseISO(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.round((d - startOfDay(today)) / DAY);
}

/* How loudly to say a due date.
 *
 * An OVERDUE reply is the loud one — the window has gone and somebody needs to
 * know today. A date comfortably ahead is stated in grey: a card where every
 * date is red is a card whose colours mean nothing. */
export function dueTone(iso, today = new Date()) {
  const days = daysUntilDate(iso, today);
  if (days === null) return null;
  if (days < 0) return { state: "overdue", days, colour: "#B23B3B", loud: true };
  if (days === 0) return { state: "today", days, colour: "#B23B3B", loud: true };
  if (days <= 3) return { state: "urgent", days, colour: "#B23B3B", loud: true };
  if (days <= 10) return { state: "soon", days, colour: "#B07512", loud: true };
  return { state: "open", days, colour: "var(--p-text-3)", loud: false };
}

/** "Overdue by 4 days" / "Due today" / "6 days left". */
export function dueLabel(iso, today = new Date()) {
  const days = daysUntilDate(iso, today);
  if (days === null) return "";
  if (days < 0) return `overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"}`;
  if (days === 0) return "due today";
  if (days === 1) return "1 day left";
  return `${days} days left`;
}

/* ---------------- what became of the reply ---------------- */

/* Field names the portal might use for "the officer opened this".
 *
 * ITBA is not consistent across its own services, and this one cannot be read
 * off a live row from here. So the connector forwards every unmapped scalar
 * (portalFetch.js `extraFields`) and this list is checked against it — the
 * moment the real name is among these, the date appears on screen with no
 * further deploy. Where it is NOT among them, the raw fields are shown on the
 * card so the name can be read off a real reply and added here.
 *
 * Matching is case-insensitive and ignores separators, so `viewedOn`,
 * `viewed_on`, `VIEWED_DATE` and `viewedDt` are all the same key. */
const VIEWED_KEYS = [
  "viewedon", "viewedby", "viewedbyao", "vieweddate", "vieweddt", "viewdate", "viewdt", "viewedts",
  "seenon", "seendate", "seendt",
  "readon", "readdate", "readdt",
  "aoviewedon", "aovieweddate", "officerviewedon",
  "responseviewedon", "responseviewdate", "respviewdt", "respviewedon",
];

const norm = (k) => String(k || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/* Does this value look like a date the portal would send?
 *
 * Two shapes only, both of which the portal actually uses: epoch milliseconds,
 * and a printed date. A bare "1" or "Y" is a flag, not a date, and must not be
 * rendered as one — an officer's view date is a thing a practitioner may act
 * on, so a wrong one is worse than none. */
export function looksLikeDate(v) {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return false;
  const n = Number(v);
  // Epoch millis, roughly 2001 to 2100. Seconds are excluded deliberately: a
  // 10-digit number is as likely to be an id as a timestamp.
  if (Number.isFinite(n) && String(v).replace(/\D/g, "").length >= 12 && n > 978307200000 && n < 4102444800000) return true;
  return /\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/.test(String(v));
}

/**
 * When the officer opened this reply, if the portal said so.
 *
 * @returns { key, value } — the field it came from and its raw value, so the
 *          screen can show where a date it is asserting actually came from.
 *          null when nothing in the row looks like one.
 */
export function viewedByOfficer(response) {
  const extra = response?.extra;
  if (!extra || typeof extra !== "object") return null;
  const byNorm = new Map(Object.keys(extra).map((k) => [norm(k), k]));
  for (const want of VIEWED_KEYS) {
    const key = byNorm.get(want);
    if (key && looksLikeDate(extra[key])) return { key, value: extra[key] };
  }
  return null;
}

/* Everything the portal sent about a reply that we have no name for.
 *
 * Shown on screen, quietly, behind a disclosure. It is how the real name of the
 * "viewed" field gets identified from one live reply instead of from guessing —
 * and it costs nothing, because the connector is already carrying these. */
export function unnamedFields(response) {
  const extra = response?.extra;
  if (!extra || typeof extra !== "object") return [];
  const known = viewedByOfficer(response);
  return Object.entries(extra)
    .filter(([k]) => k !== known?.key)
    .map(([key, value]) => ({ key, value }));
}

/** The portal sends dates as epoch millis or as printed text; render either. */
export function fmtPortalDate(v) {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  if (Number.isFinite(n) && String(v).replace(/\D/g, "").length >= 12) {
    try {
      return new Date(n).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
    } catch { return String(v); }
  }
  return String(v);
}
