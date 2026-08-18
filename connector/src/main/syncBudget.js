/* A slice of a sync's time, and the questions a pass asks of it.
 *
 * THE PROBLEM THIS EXISTS FOR. Every portal call already has a deadline
 * (portalApi.js) and the whole PAN has one (pool.js). Neither stops a pass from
 * eating the run. A dozen calls, each answering just inside its own ceiling, add
 * up to fifteen minutes without one of them being late — and the passes queued
 * behind that one never start. The user sees a sync that sits at the same
 * percentage and then reports success over the work it never got to.
 *
 * A budget is the missing middle: how long THIS pass, and THIS item within it,
 * may take before it stops and says what it did not reach.
 *
 * Two rules it is written to keep:
 *
 *   Nothing is cancelled here. A budget is asked before expensive work starts,
 *   never used to abort work in flight — a half-downloaded document thrown away
 *   is time spent for nothing, and the call deadlines already cover a stall.
 *
 *   Running out is not an error. It is a fact to report: the work is left for
 *   the next sync, which is told to come back for it.
 *
 * Pure, with the clock injected, so the rules can be tested without waiting for
 * real minutes to pass (test/syncBudget.test.mjs).
 */
"use strict";

/**
 * @param totalMs  how long this budget is worth
 * @param opts.now       clock, for tests. Defaults to Date.now.
 * @param opts.startedAt when the clock started. Defaults to now.
 * @param opts.notAfter  a wall this budget may not run past, whatever its size
 *                       — the per-PAN deadline, less whatever is reserved for
 *                       the passes after this one. A budget already past its
 *                       wall is simply born expired, which is the right answer:
 *                       do not start what cannot finish.
 */
function makeBudget(totalMs, opts = {}) {
  const now = opts.now || Date.now;
  const startedAt = Number.isFinite(opts.startedAt) ? opts.startedAt : now();
  const notAfter = Number.isFinite(opts.notAfter) ? opts.notAfter : Infinity;
  const endsAt = Math.min(startedAt + Math.max(0, Number(totalMs) || 0), notAfter);

  const budget = {
    endsAt,
    /** Time still to spend, never negative. */
    left: () => Math.max(0, endsAt - now()),
    /** Nothing more may be started. */
    expired: () => now() >= endsAt,
    /** Is there room for a step that could take this long? */
    enoughFor: (ms) => endsAt - now() >= (Number(ms) || 0),
    /**
     * A budget for ONE item out of many, never longer than what the parent has
     * left. This is what stops the first Form 35 in a list of four from
     * spending the whole pass on itself.
     */
    slice: (ms) => makeBudget(Math.min(Number(ms) || 0, Math.max(0, endsAt - now())), { now, startedAt: now() }),
  };
  return budget;
}

module.exports = { makeBudget };
