/* ProHippo — the two notice queues the dashboard leads with.
 *
 * Pure, no React and no network, so the rules can be tested directly — the same
 * reason noticeDates.js and appeals.js are plain .js.
 *
 * WHAT THE PORTAL GIVES US, AND WHAT IT DOESN'T. A notice carries an ISSUE DATE
 * and no issue time: the e-Proceedings API dates a notice to the day. So "the
 * last 24 hours" cannot be computed to the hour from portal data, and pretending
 * otherwise would mean a notice issued at 11pm last night disappearing from the
 * card by breakfast. Both queues therefore work in whole days, and the screens
 * that show them say so rather than implying a precision that isn't there.
 */
import { noticeDeadline } from "./noticeDates.js";

// A date n days before `now`, as YYYY-MM-DD in the user's own timezone. Local,
// not UTC: a practitioner in India at 7am on the 3rd is on the 3rd, and toISOString()
// would still say the 2nd.
export function isoDaysAgo(n, now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* Notices issued in the last 24 hours — in practice, today and yesterday.
 *
 * A notice dated in the FUTURE is excluded. That is not hypothetical: the
 * portal occasionally carries a notice dated a day or two ahead, and one of
 * those sitting in a "last 24 hours" list is how a practitioner learns to
 * distrust the number.
 *
 * Orders are included. An assessment or penalty order landing overnight is
 * exactly what this card exists to surface — arguably more urgent than a
 * notice, since the appeal clock starts on it.
 */
export function noticesIssuedInLast24h(notices, now = new Date()) {
  const today = isoDaysAgo(0, now);
  const yesterday = isoDaysAgo(1, now);
  return (notices || [])
    .filter((n) => n.date && n.date >= yesterday && n.date <= today)
    .sort(byIssueDateDesc);
}

/* Notices issued in the last `days` days with no reply recorded against them.
 *
 * The queue answers one question — what is still open on my desk — so:
 *
 *   ORDERS ARE EXCLUDED. There is no reply to file against an assessment or
 *   penalty order; the answer to one is an appeal, which has its own card and
 *   its own clock (appeals.js). Counting orders here would pad the number with
 *   work this list cannot help anybody do.
 *
 *   "NO REPLY" MEANS NO REPLY ON RECORD. A reply reaches us from the portal
 *   sync (responses[] / hasResponse). A notice keyed in by hand, or answered
 *   outside ProHippo and never synced, therefore counts as unanswered — which
 *   is the honest reading of what we know, and why the screen says "no reply
 *   recorded" rather than "no reply filed".
 *
 * A notice already marked as closed or replied by the practitioner drops out:
 * `status` is theirs, and a queue that argues with the user is a queue they
 * stop opening.
 */
export function noticesAwaitingReply(notices, { days = 15, now = new Date() } = {}) {
  const today = isoDaysAgo(0, now);
  const from = isoDaysAgo(days, now);
  return (notices || [])
    .filter((n) => {
      if (n.isOrder) return false;
      if (!n.date || n.date < from || n.date > today) return false;
      if (hasReply(n)) return false;
      return !CLOSED_STATUSES.has(n.status || "");
    })
    .sort(byIssueDateDesc);
}

// Statuses the practitioner sets to mean "this one is dealt with". Anything
// else — including the ingest default, "Awaiting review" — leaves it open.
const CLOSED_STATUSES = new Set(["Replied", "Response filed", "Closed", "Disposed", "Dropped"]);

export function hasReply(n) {
  return Boolean(n.hasResponse) || (n.responses || []).length > 0;
}

// Newest first, then by assessee so two notices from the same day hold a stable
// order rather than shuffling on every render.
function byIssueDateDesc(a, b) {
  return (b.date || "").localeCompare(a.date || "") || (a.assessee || "").localeCompare(b.assessee || "");
}

/* How many of a 24-hour list landed today, for the card's second line. "3
   notices · 2 today" tells someone glancing at it whether this is news or
   yesterday's news, which the total alone cannot. */
export function countIssuedToday(rows, now = new Date()) {
  const today = isoDaysAgo(0, now);
  return (rows || []).filter((n) => n.date === today).length;
}

/* Of an unanswered list, how many are already past the date they were working
   to. This is the line that makes the card worth reading: fourteen open notices
   is a workload, but two of them past the due date is today's problem.

   Uses the same deadline rule as everything else — a hearing outranks a
   compliance date — so this card cannot disagree with the notice itself. */
export function countPastDue(rows, now = new Date()) {
  const today = isoDaysAgo(0, now);
  return (rows || []).filter((n) => {
    const due = noticeDeadline(n);
    return Boolean(due) && due < today;
  }).length;
}
