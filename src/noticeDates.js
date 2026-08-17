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

/* NO COUNTDOWN, DELIBERATELY.
 *
 * This screen used to print "overdue by 695 days" beside a hearing notice from
 * 2024. It was arithmetically right and completely wrong: an appeal runs on a
 * series of hearing notices, the assessee answers the current one, and every
 * superseded notice in the list then reads as a two-year-old emergency. A row
 * that shouts on a matter nobody is worried about is how a screen teaches
 * people to stop reading it.
 *
 * So the due date is stated and nothing is inferred from it. The dashboard and
 * the calendar are where a live deadline belongs; this card is the file.
 */

/* The date a notice is actually working towards. A hearing beats a compliance
   deadline when both are set — that's the one that can't be moved.

   Lives here rather than in store.jsx, where it used to, because it is a rule
   about a notice's dates and nothing about it needs React or Firestore. store
   re-exports it, so every existing call site reads the same one. */
export const noticeDeadline = (n) => n?.hearingDate || n?.responseDueDate || "";

/* ---------------- what became of the reply ---------------- */

/* Field names the portal might use for "Response viewed by AO on".
 *
 * The portal prints that label on the NOTICE block of "View Notices for
 * e-Proceedings", directly under "Response Due Date" — not on the reply. What
 * it calls the field in the JSON behind that label is another matter, and ITBA
 * is not consistent across its own services.
 *
 * So the connector forwards every unmapped scalar from both rows
 * (portalFetch.js `extraFields`) and this list is checked against them. The
 * moment the real name is among these, the date appears with no further deploy;
 * where it is not, the raw fields are shown on the card so the name can be read
 * off a live notice and added here.
 *
 * Matching is case-insensitive and ignores separators, so `viewedOn`,
 * `viewed_on`, `VIEWED_DATE` and `viewedDt` are all the same key. */
const VIEWED_KEYS = [
  // Closest to the portal's own words, so tried first.
  "responseviewedbyaoon", "responseviewedbyao", "respviewedbyaoon", "respviewedbyao",
  "viewedbyaoon", "viewedbyao", "aoviewedon", "aovieweddate", "aoviewdate", "aoviewdt",
  "responseviewedon", "responseviewdate", "responseviewdt", "respviewedon", "respviewdt",
  "officerviewedon", "viewedbyofficeron",
  "viewedon", "vieweddate", "vieweddt", "viewdate", "viewdt", "viewedts",
  "seenon", "seendate", "seendt", "readon", "readdate", "readdt",
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
  const s = String(v);
  // All digits: 21/07/2026, 2026-07-21, 21.07.2026.
  if (/\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/.test(s)) return true;
  // With a month NAME — which is what the portal actually prints on this very
  // field: "Response viewed by AO on : 21-Jul-2026". A digits-only rule missed
  // the one format this was written for.
  return /\d{1,2}[-\s/](jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-\s/]\d{2,4}/i.test(s);
}

/**
 * When the officer opened the reply, if the portal said so.
 *
 * Takes anything carrying an `extra` map — a NOTICE first, since that is where
 * the portal prints it, and a response as a fallback in case the JSON puts it
 * there too. Several may be passed; the first that answers wins.
 *
 * @returns { key, value } — the field it came from and its raw value, so the
 *          screen can say where a date it is asserting actually came from.
 *          null when nothing in the rows looks like one.
 */
export function viewedByOfficer(...records) {
  for (const rec of records) {
    const extra = rec?.extra;
    if (!extra || typeof extra !== "object") continue;
    const byNorm = new Map(Object.keys(extra).map((k) => [norm(k), k]));
    for (const want of VIEWED_KEYS) {
      const key = byNorm.get(want);
      if (key && looksLikeDate(extra[key])) return { key, value: extra[key] };
    }
  }
  return null;
}

/* WHAT ELSE THE PORTAL SENT is no longer shown, and there is no helper for it.
 *
 * There used to be `unnamedFields()`, feeding a disclosure on the notice card
 * that listed every portal field we had no name for. It existed to identify the
 * real name of the field above — `responseViewedByAoOn` — off a live reply
 * rather than by guessing, and having done that it was printing JSON keys and
 * epoch numbers on a card practitioners show their clients.
 *
 * The fields are still carried by the connector and still stored in `extra` on
 * the notice: that is where the date above is read from, and where the next
 * unnamed field can be read when one is wanted. Nothing renders them, and a
 * helper whose only purpose was to render them would be an invitation to. */

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
