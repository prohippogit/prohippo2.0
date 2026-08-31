/* WHAT AN UNATTENDED RUN FETCHES, AND WHY IT IS NOT EVERYTHING.
 *
 * The thorough scope ("all") pulls the proceedings, then filed Form 35s, then
 * filed returns and the CPC orders behind them. The last two are the expensive
 * passes and they are also the flaky ones: the appeals pass renders a PDF the
 * portal builds on demand, the returns pass unlocks CPC documents with a
 * password derived from a date of birth the practice may not have recorded.
 * Either can come back empty-handed on a portal that is simply busy.
 *
 * On a run somebody pressed and is watching, that is a fair trade — they asked
 * for everything and the summary says which part did not arrive. On a run
 * nobody asked for, it is not: the practitioner opens the app to a list of
 * assessees marked "partly synced" with a reason they never wanted to think
 * about, decides something is broken, and syncs again. And again. The reported
 * behaviour was four and five re-runs of a sync that had already fetched every
 * notice there was.
 *
 * So an automatic run — on a schedule, at launch, or a bulk "sync all of these"
 * — asks for e-Proceedings ONLY. Notices, orders and replies: the things that
 * carry a deadline, and the whole reason the app checks the portal on its own.
 * Form 35s and filed returns do not change on their own; they are fetched when
 * somebody asks for them.
 *
 * THE ONE EXCEPTION IS THE FIRST SYNC. An assessee that has never been synced
 * has no baseline at all — no filed returns, no appeals, nothing to be
 * incremental against — and "e-Proceedings only" would leave that hole open for
 * as long as nobody noticed it. So a PAN with no last-sync time gets the
 * thorough scope once, whatever the run asked for, and every run after it gets
 * the fast one.
 *
 * There are two copies of this file — this one for the connector's CommonJS
 * main process, src/syncScope.js for the web app's ESM — because neither can
 * import the other. test/syncScope.test.mjs runs both over the same inputs and
 * fails if they ever disagree.
 */
"use strict";

/* Every scope the sync understands. "returnForm" is not a sync scope in the
   ordinary sense — it fetches one year's ITR form PDF on demand — but it is
   passed through this function by the same call path, so it is named here
   rather than silently rewritten to something else. */
const SCOPES = ["eproc", "all", "appeals", "returns", "returnForm"];

// What a run fetches when nobody said otherwise.
const DEFAULT_SCOPE = "eproc";

/* Never synced — so nothing on file to be incremental against.
 *
 * Deliberately forgiving about the shape: the connector holds an ISO string,
 * the web app may hold a Firestore Timestamp. Anything present at all counts as
 * "has been synced"; only absent, empty or blank is a first sync. */
function isFirstSync(lastSyncedAt) {
  if (!lastSyncedAt) return true;
  if (typeof lastSyncedAt === "string") return lastSyncedAt.trim() === "";
  return false;
}

/* The scope ONE assessee is actually synced with on this run.
 *
 * `requested` is what the run asked for — the schedule's setting, or the
 * dropdown. An explicit choice other than the default is honoured exactly as
 * given, including on a PAN that has never been synced: somebody who picked
 * "Form 35 only" asked for Form 35 only.
 *
 * An absent or unrecognised scope is the default, not "all". That direction
 * matters: a caller that forgets to pass the field gets the cheap, quiet run
 * rather than the expensive one, which is the failure mode this whole file
 * exists to prevent. */
function scopeForAssessee(requested, lastSyncedAt) {
  const want = SCOPES.includes(requested) ? requested : DEFAULT_SCOPE;
  if (want !== DEFAULT_SCOPE) return want;
  return isFirstSync(lastSyncedAt) ? "all" : DEFAULT_SCOPE;
}

module.exports = { SCOPES, DEFAULT_SCOPE, isFirstSync, scopeForAssessee };
