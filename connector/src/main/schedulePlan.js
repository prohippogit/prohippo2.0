/* When the next unattended sync happens — and why it is never the same time
 * twice.
 *
 * Split out of scheduler.js because scheduler.js reaches Electron and this does
 * not: the arithmetic is the part that fails quietly. A wrong answer here does
 * not throw. It produces a server that looks configured and never syncs, one
 * that syncs every minute, or — the reason this file has a jitter section — one
 * that knocks on the income-tax portal at 06:00:04, 12:00:11 and 18:00:07 every
 * single day from one address.
 *
 * THE FINGERPRINT PROBLEM. Everything INSIDE a run is already drawn from a
 * range (pacing.js: "there are no fixed intervals anywhere in the sync path").
 * The one fixed cadence left was the gap BETWEEN runs, and a six-hour schedule
 * is the easiest pattern in the world to spot: a human's own portal use is
 * ragged, clustered in office hours, and never lands on the same second twice.
 * So the interval is a range too, redrawn on every cycle, and the run's start is
 * de-correlated from the moment the machine boots.
 *
 * Randomness is injected rather than reached for, so the tests can pin every
 * one of these decisions to a known draw.
 */
"use strict";

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

// How far either side of the nominal interval a run may land, as a fraction.
// At six hours, 0.15 spreads the next run across a ~1h48m window — wide enough
// that consecutive days share no pattern, narrow enough that "every six hours"
// stays an honest description of what the switch does.
const DEFAULT_JITTER = 0.15;
const MAX_JITTER = 0.4;

// A launch sync waits a little first. A machine switched on at 09:00 every
// weekday would otherwise hit the portal at 09:00 every weekday, which is the
// same fingerprint by another route.
const LAUNCH_DELAY_MIN_MS = 60 * 1000;
const LAUNCH_DELAY_MAX_MS = 7 * MINUTE;

const clampJitter = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_JITTER;
  return Math.min(n, MAX_JITTER);
};

const intervalMs = (intervalHours) => {
  const hours = Number(intervalHours);
  return (Number.isFinite(hours) && hours > 0 ? hours : 6) * HOUR;
};

/* The moment the next run should happen, drawn ONCE per cycle.
 *
 * Drawn once and then stored, not recomputed on every timer tick: a target that
 * moves each time it is looked at is not a schedule, and the countdown on
 * screen would jump about. */
function planNextRun({ intervalHours, jitterPct } = {}, now = Date.now(), rand = Math.random) {
  const base = intervalMs(intervalHours);
  const spread = base * clampJitter(jitterPct);
  // rand() in [0,1) → offset in [-spread, +spread]
  const offset = (rand() * 2 - 1) * spread;
  // Never sooner than a quarter of the interval, whatever the draw: a sync that
  // could follow the last one by minutes is the opposite of what this is for.
  return now + Math.max(base + offset, base / 4);
}

/* When the next run is due, using the plan already drawn if there is a usable
 * one.
 *
 * A stored target is distrusted in two cases, both of which are a clock rather
 * than a schedule: one in the past by more than a whole interval (the machine
 * was off), and one further ahead than two intervals (the clock was wrong when
 * it was written, or the settings file was hand-edited). Either way a fresh
 * draw is safer than honouring a number that cannot be right. */
function dueAt({ nextAutoRunAt, lastRunAt, intervalHours, jitterPct } = {}, now = Date.now(), rand = Math.random) {
  const base = intervalMs(intervalHours);
  const planned = Date.parse(nextAutoRunAt || "");
  if (Number.isFinite(planned) && planned <= now + 2 * base && planned >= now - base) return planned;

  const last = Date.parse(lastRunAt || "");
  // Never run, or the stored plan is unusable: due now if enough time has
  // passed since the last run, otherwise a fresh draw from that run.
  if (!Number.isFinite(last) || last > now) return now;
  const fresh = planNextRun({ intervalHours, jitterPct }, last, rand);
  return fresh <= now ? now : fresh;
}

const isDue = (cfg, now = Date.now(), rand = Math.random) => dueAt(cfg, now, rand) <= now;

/* How long to sleep before looking again.
 *
 * Clamped at both ends, and the ceiling is the load-bearing one: a timer parked
 * six hours out survives a clock correction, a VM suspend/restore and a
 * timezone change badly. Waking every half hour to ask "is it due yet" costs
 * nothing and makes every one of those recover on their own. */
const MIN_WAIT_MS = MINUTE;
const MAX_WAIT_MS = 30 * MINUTE;

function armDelay(dueAtMs, now = Date.now(), { min = MIN_WAIT_MS, max = MAX_WAIT_MS } = {}) {
  const wait = Number(dueAtMs) - now;
  if (!Number.isFinite(wait)) return max;
  return Math.min(Math.max(wait, min), max);
}

// A few minutes between the machine coming up and the sync starting.
function launchDelayMs(rand = Math.random) {
  return Math.round(LAUNCH_DELAY_MIN_MS + rand() * (LAUNCH_DELAY_MAX_MS - LAUNCH_DELAY_MIN_MS));
}

/* Deal the PANs in a different order every run.
 *
 * The same list, worked top to bottom at the same times, is a pattern in itself
 * — one PAN always first, one always last, every day. Fisher-Yates over a copy;
 * the caller's list is not touched. */
function shuffle(list, rand = Math.random) {
  const out = [...(list || [])];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

module.exports = {
  planNextRun, dueAt, isDue, armDelay, launchDelayMs, shuffle,
  HOUR, MIN_WAIT_MS, MAX_WAIT_MS, DEFAULT_JITTER, MAX_JITTER,
  LAUNCH_DELAY_MIN_MS, LAUNCH_DELAY_MAX_MS,
};
