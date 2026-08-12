/* When the next unattended sync is due.
 *
 * Split out of scheduler.js because scheduler.js reaches Electron and this does
 * not: the arithmetic is the part that fails quietly. A wrong answer here does
 * not throw — it produces a server that looks configured and never syncs, or
 * one that syncs every minute. Neither announces itself.
 *
 * Everything takes `now` as a parameter so the rules can be tested at a fixed
 * moment rather than against the clock the tests happen to run on.
 */
"use strict";

const HOUR = 60 * 60 * 1000;

/* The moment the next run is due, in epoch ms.
 *
 * Never run before → due now. That is the point of switching it on: a machine
 * that has been off all week should not wait six more hours.
 *
 * An unparseable or FUTURE last-run time is treated as "now" too. A clock that
 * was wrong when the timestamp was written — a server whose time syncs a minute
 * after boot — would otherwise park the next run days out, and nothing would
 * ever run again. */
function nextRunAt({ lastRunAt, intervalHours } = {}, now = Date.now()) {
  const hours = Number(intervalHours);
  const every = (Number.isFinite(hours) && hours > 0 ? hours : 6) * HOUR;
  const last = Date.parse(lastRunAt || "");
  if (!Number.isFinite(last) || last > now) return now;
  return last + every;
}

const isDue = (cfg, now = Date.now()) => nextRunAt(cfg, now) <= now;

/* How long to sleep before looking again.
 *
 * Clamped at both ends, and the ceiling is the load-bearing one: a timer parked
 * six hours out survives a clock correction, a VM suspend/restore and a
 * timezone change, any of which can leave it firing at the wrong time or not at
 * all. Waking every half hour to ask "is it due yet" costs nothing and makes
 * every one of those recover on their own. */
const MIN_WAIT_MS = 60 * 1000;
const MAX_WAIT_MS = 30 * 60 * 1000;

function armDelay(dueAtMs, now = Date.now(), { min = MIN_WAIT_MS, max = MAX_WAIT_MS } = {}) {
  const wait = Number(dueAtMs) - now;
  if (!Number.isFinite(wait)) return max;
  return Math.min(Math.max(wait, min), max);
}

module.exports = { nextRunAt, isDue, armDelay, HOUR, MIN_WAIT_MS, MAX_WAIT_MS };
