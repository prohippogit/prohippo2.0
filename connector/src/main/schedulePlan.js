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

/* Quiet hours — a window each night when an unattended run waits.
 *
 * Randomised timing makes the RHYTHM human; it does not make 03:41 a plausible
 * hour for the practitioner whose account it is to be signing in. A firm works
 * days. Traffic at 3am is not suspicious because it is regular — it is
 * suspicious because nobody is awake.
 *
 * The deferral is itself randomised, and that is the whole trick: releasing
 * everything the moment the window ends would put a burst at exactly 06:00
 * every morning, which is the fingerprint this was supposed to remove, moved
 * six hours down the clock. A run held overnight starts somewhere in the first
 * three-quarters of an hour after the window, on a fresh draw.
 */
const QUIET_RELEASE_SPREAD_MS = 45 * MINUTE;

// Hours are LOCAL to the machine — the practitioner's own working day is the
// thing being modelled, not UTC.
const hourOf = (ms) => {
  const d = new Date(ms);
  return d.getHours() + d.getMinutes() / 60;
};

/* Is this moment inside the window? Windows that wrap midnight (22 → 6) are
   the normal case for an overnight pause, so both directions are handled. A
   window whose ends are equal is treated as no window at all: read literally it
   would be either zero hours or twenty-four, and one of those silences the
   schedule for ever. */
function inQuietHours(ms, { quietEnabled, quietFrom, quietTo } = {}) {
  if (!quietEnabled) return false;
  const from = Number(quietFrom), to = Number(quietTo);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return false;
  const h = hourOf(ms);
  return from < to ? (h >= from && h < to) : (h >= from || h < to);
}

/* Push a moment out of the window, to a randomised point just after it ends.
   Idempotent: a moment already outside comes back unchanged. */
function afterQuietHours(ms, cfg = {}, rand = Math.random) {
  if (!inQuietHours(ms, cfg)) return ms;
  const end = Number(cfg.quietTo);
  const d = new Date(ms);
  const release = new Date(d);
  release.setHours(Math.floor(end), Math.round((end % 1) * 60), 0, 0);
  // A window that wraps midnight ends on the following day when the moment
  // itself is before midnight.
  if (release.getTime() <= ms) release.setDate(release.getDate() + 1);
  return release.getTime() + Math.round(rand() * QUIET_RELEASE_SPREAD_MS);
}

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
function planNextRun(cfg = {}, now = Date.now(), rand = Math.random) {
  const base = intervalMs(cfg.intervalHours);
  const spread = base * clampJitter(cfg.jitterPct);
  // rand() in [0,1) → offset in [-spread, +spread]
  const offset = (rand() * 2 - 1) * spread;
  // Never sooner than a quarter of the interval, whatever the draw: a sync that
  // could follow the last one by minutes is the opposite of what this is for.
  const target = now + Math.max(base + offset, base / 4);
  return afterQuietHours(target, cfg, rand);
}

/* When the next run is due, using the plan already drawn if there is a usable
 * one.
 *
 * A stored target is distrusted in two cases, both of which are a clock rather
 * than a schedule: one in the past by more than a whole interval (the machine
 * was off), and one further ahead than two intervals (the clock was wrong when
 * it was written, or the settings file was hand-edited). Either way a fresh
 * draw is safer than honouring a number that cannot be right. */
function dueAt(cfg = {}, now = Date.now(), rand = Math.random) {
  const base = intervalMs(cfg.intervalHours);
  const planned = Date.parse(cfg.nextAutoRunAt || "");
  /* A stored target is honoured — it was already drawn clear of the quiet
     window — EXCEPT when it now falls inside one, which happens when somebody
     turns quiet hours on while a run is already scheduled for 3am. */
  if (Number.isFinite(planned) && planned <= now + 2 * base && planned >= now - base) {
    return afterQuietHours(Math.max(planned, now), cfg, rand);
  }

  const last = Date.parse(cfg.lastRunAt || "");
  // Never run, or the stored plan is unusable: due now if enough time has
  // passed since the last run, otherwise a fresh draw from that run.
  if (!Number.isFinite(last) || last > now) return afterQuietHours(now, cfg, rand);
  const fresh = planNextRun(cfg, last, rand);
  return fresh <= now ? afterQuietHours(now, cfg, rand) : fresh;
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
  inQuietHours, afterQuietHours, QUIET_RELEASE_SPREAD_MS,
  HOUR, MIN_WAIT_MS, MAX_WAIT_MS, DEFAULT_JITTER, MAX_JITTER,
  LAUNCH_DELAY_MIN_MS, LAUNCH_DELAY_MAX_MS,
};
