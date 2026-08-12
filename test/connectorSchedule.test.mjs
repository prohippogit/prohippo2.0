/* When the connector syncs by itself, and why it never does so twice at the
   same moment.

   These rules run on a machine nobody is watching — a firm's server left on in
   the corner — so every failure here is silent. A schedule that never fires
   looks identical to one with nothing to do. One that fires constantly is
   noticed only by the income-tax portal. And one that fires at exactly 06:00
   every day, from one residential address, is the single easiest pattern for
   that portal to read as automation.

   Randomness is injected so each of those decisions can be pinned to a known
   draw rather than observed and hoped about. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  planNextRun, dueAt, isDue, armDelay, launchDelayMs, shuffle,
  HOUR, MIN_WAIT_MS, MAX_WAIT_MS, DEFAULT_JITTER, MAX_JITTER,
  LAUNCH_DELAY_MIN_MS, LAUNCH_DELAY_MAX_MS,
  inQuietHours, afterQuietHours,
} = require("../connector/src/main/schedulePlan.js");

const NOW = Date.parse("2026-08-12T09:00:00.000Z");
const at = (hoursAgo) => new Date(NOW - hoursAgo * HOUR).toISOString();
// A draw of 0.5 is the middle of the range — i.e. no offset at all.
const MID = () => 0.5;
const LOW = () => 0;
const HIGH = () => 0.999999;

/* ---------------- the interval is a range, not a cadence ---------------- */

test("the interval is drawn from a range, so no two gaps are alike", () => {
  const six = 6 * HOUR;
  // Middle of the draw is the nominal interval; the ends are ±15% of it.
  assert.equal(planNextRun({ intervalHours: 6 }, NOW, MID), NOW + six);
  assert.equal(planNextRun({ intervalHours: 6 }, NOW, LOW), NOW + six * (1 - DEFAULT_JITTER));
  assert.ok(Math.abs(planNextRun({ intervalHours: 6 }, NOW, HIGH) - (NOW + six * (1 + DEFAULT_JITTER))) < 1000);
});

test("across many draws the spread is wide and always inside its bounds", () => {
  // ~1h48m of spread at six hours: consecutive days share no pattern, and
  // "every six hours" is still an honest description of the switch.
  const six = 6 * HOUR;
  let lo = Infinity, hi = -Infinity;
  let seed = 1;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 2000; i++) {
    const gap = planNextRun({ intervalHours: 6 }, NOW, rand) - NOW;
    lo = Math.min(lo, gap); hi = Math.max(hi, gap);
  }
  assert.ok(lo >= six * (1 - DEFAULT_JITTER) - 1, "never earlier than the low bound");
  assert.ok(hi <= six * (1 + DEFAULT_JITTER) + 1, "never later than the high bound");
  assert.ok(hi - lo > 90 * 60 * 1000, `spread should be well over an hour, got ${(hi - lo) / 60000} min`);
});

test("no draw can put two runs on top of each other", () => {
  // Even at the widest configurable jitter, the gap keeps a floor of a quarter
  // of the interval — a sync minutes after the last one is the opposite of the
  // point.
  const gap = planNextRun({ intervalHours: 6, jitterPct: 5 }, NOW, LOW) - NOW;
  assert.ok(gap >= (6 * HOUR) / 4, `floor not held: ${gap / 60000} min`);
});

test("the jitter fraction is clamped, and a nonsense one falls back", () => {
  const six = 6 * HOUR;
  // 400% would make the schedule meaningless; 40% is the ceiling.
  assert.equal(planNextRun({ intervalHours: 6, jitterPct: 4 }, NOW, MID), NOW + six);
  assert.equal(planNextRun({ intervalHours: 6, jitterPct: 4 }, NOW, HIGH) - NOW <= six * (1 + MAX_JITTER) + 1, true);
  for (const bad of [NaN, -1, "soon", undefined]) {
    assert.equal(planNextRun({ intervalHours: 6, jitterPct: bad }, NOW, LOW), NOW + six * (1 - DEFAULT_JITTER), `jitter ${bad}`);
  }
  // Zero is a deliberate choice and is honoured — an exact cadence, if somebody
  // truly wants one.
  assert.equal(planNextRun({ intervalHours: 6, jitterPct: 0 }, NOW, LOW), NOW + six);
});

/* ---------------- the target is drawn once, not per tick ---------------- */

test("a stored target is honoured, so the countdown does not move under you", () => {
  // Re-drawing on every timer tick would mean a target that never arrives and a
  // countdown that jumps about.
  const planned = new Date(NOW + 90 * 60 * 1000).toISOString();
  assert.equal(dueAt({ nextAutoRunAt: planned, intervalHours: 6 }, NOW, LOW), Date.parse(planned));
  assert.equal(isDue({ nextAutoRunAt: planned, intervalHours: 6 }, NOW), false);
});

test("a target that has arrived is due", () => {
  const planned = new Date(NOW - 60 * 1000).toISOString();
  assert.equal(isDue({ nextAutoRunAt: planned, lastRunAt: at(6), intervalHours: 6 }, NOW), true);
});

test("a target from a broken clock is re-drawn rather than obeyed", () => {
  /* Two clock stories, not schedule stories: a machine that was off for days,
     and one whose clock was wrong when the target was written. Honouring either
     means never syncing again. */
  const stale = new Date(NOW - 40 * HOUR).toISOString();
  assert.equal(dueAt({ nextAutoRunAt: stale, lastRunAt: at(40), intervalHours: 6 }, NOW, MID), NOW, "long-past target → due now");

  const wild = new Date(NOW + 40 * HOUR).toISOString();
  const due = dueAt({ nextAutoRunAt: wild, lastRunAt: at(1), intervalHours: 6 }, NOW, MID);
  assert.ok(due <= NOW + 6 * HOUR, "far-future target should be re-drawn, not honoured");
});

test("a schedule that has never run is due immediately", () => {
  // Switching it on at 9am on a machine that was off all week should sync now,
  // not six hours from now.
  assert.equal(dueAt({ intervalHours: 6 }, NOW, MID), NOW);
  assert.equal(isDue({ intervalHours: 6 }, NOW), true);
});

test("with no stored target the gap is still counted from the last run", () => {
  // A server rebooted every hour must not sync on every boot.
  const due = dueAt({ lastRunAt: at(1), intervalHours: 6 }, NOW, MID);
  assert.equal(due, Date.parse(at(1)) + 6 * HOUR);
  assert.equal(isDue({ lastRunAt: at(1), intervalHours: 6 }, NOW, MID), false);
  assert.equal(isDue({ lastRunAt: at(7), intervalHours: 6 }, NOW, MID), true);
});

test("a machine asleep through several intervals syncs once, not four times", () => {
  assert.equal(dueAt({ lastRunAt: at(30), intervalHours: 6 }, NOW, MID), NOW);
  assert.equal(armDelay(dueAt({ lastRunAt: at(30), intervalHours: 6 }, NOW, MID), NOW), MIN_WAIT_MS);
});

/* ---------------- waking up, starting up, and the order of work --------- */

test("the wait never exceeds half an hour, however far away the run is", () => {
  /* The ceiling is what makes a clock correction, a VM restore or a timezone
     change recover on their own: the timer wakes, re-reads the wall clock and
     re-arms. */
  assert.equal(armDelay(NOW + 6 * HOUR, NOW), MAX_WAIT_MS);
  assert.equal(armDelay(NOW + 10 * 60 * 1000, NOW), 10 * 60 * 1000);
  assert.equal(armDelay(NOW - HOUR, NOW), MIN_WAIT_MS, "an overdue run still waits a beat");
  assert.equal(armDelay(undefined, NOW), MAX_WAIT_MS, "a broken due time waits rather than spins");
});

test("the launch sync waits a randomised few minutes before starting", () => {
  // A machine switched on at 09:00 every weekday would otherwise reach the
  // portal at 09:00 every weekday.
  assert.equal(launchDelayMs(LOW), LAUNCH_DELAY_MIN_MS);
  assert.equal(launchDelayMs(HIGH), LAUNCH_DELAY_MAX_MS);
  assert.ok(launchDelayMs(MID) > LAUNCH_DELAY_MIN_MS && launchDelayMs(MID) < LAUNCH_DELAY_MAX_MS);
  assert.ok(LAUNCH_DELAY_MIN_MS >= 60 * 1000, "at least a minute, or it is not a delay");
});

test("the PANs are dealt in a different order each run, without losing any", () => {
  // One PAN always first and one always last, every day, is a pattern too.
  const list = Array.from({ length: 8 }, (_, i) => ({ id: i }));
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const a = shuffle(list, rand).map((x) => x.id);
  const b = shuffle(list, rand).map((x) => x.id);
  assert.deepEqual([...a].sort((x, y) => x - y), [0, 1, 2, 3, 4, 5, 6, 7], "every PAN still there, exactly once");
  assert.notDeepEqual(a, b, "two runs should not deal the same order");
  assert.deepEqual(list.map((x) => x.id), [0, 1, 2, 3, 4, 5, 6, 7], "the caller's list is untouched");
  assert.deepEqual(shuffle(undefined), []);
});

test("the interval is honoured across the range the UI offers", () => {
  for (const hours of [3, 6, 12, 24]) {
    assert.equal(planNextRun({ intervalHours: hours }, NOW, MID), NOW + hours * HOUR);
  }
  // And a nonsense interval falls back to six hours rather than to zero, which
  // would be a sync loop pointed at the portal.
  for (const bad of [0, -3, NaN, undefined, "soon"]) {
    assert.equal(planNextRun({ intervalHours: bad }, NOW, MID), NOW + 6 * HOUR, `interval ${bad}`);
  }
});

/* ---------------- quiet hours ---------------- */

// Local hours throughout: the window models the practitioner's own working day,
// not UTC. Built with local constructors so the tests hold in any timezone.
const QUIET = { quietEnabled: true, quietFrom: 0, quietTo: 6, intervalHours: 6 };
const local = (h, m = 0, day = 12) => new Date(2026, 7, day, h, m).getTime();

test("the window covers midnight to six, and nothing either side of it", () => {
  assert.equal(inQuietHours(local(0, 1), QUIET), true);
  assert.equal(inQuietHours(local(3, 30), QUIET), true);
  assert.equal(inQuietHours(local(5, 59), QUIET), true);
  assert.equal(inQuietHours(local(6, 0), QUIET), false, "the end of the window is open");
  assert.equal(inQuietHours(local(23, 59), QUIET), false);
  assert.equal(inQuietHours(local(3), { ...QUIET, quietEnabled: false }), false, "off means off");
});

test("a window that wraps midnight works in both halves of the night", () => {
  const late = { quietEnabled: true, quietFrom: 22, quietTo: 6 };
  assert.equal(inQuietHours(local(23, 15), late), true);
  assert.equal(inQuietHours(local(2), late), true);
  assert.equal(inQuietHours(local(21, 59), late), false);
  assert.equal(inQuietHours(local(6, 30), late), false);
});

test("a window with equal ends is ignored rather than silencing the schedule", () => {
  // Read literally it is either zero hours or twenty-four; one of those means
  // this machine never syncs again.
  assert.equal(inQuietHours(local(3), { quietEnabled: true, quietFrom: 6, quietTo: 6 }), false);
});

test("a run due in the small hours is held until after the window", () => {
  const held = afterQuietHours(local(3, 30), QUIET, MID);
  const d = new Date(held);
  assert.equal(d.getDate(), 12, "same morning, not the next day");
  assert.ok(d.getHours() === 6, `released just after six, got ${d.getHours()}:${d.getMinutes()}`);
  assert.equal(inQuietHours(held, QUIET), false);
});

test("a wrapping window releases on the FOLLOWING morning when held before midnight", () => {
  const late = { quietEnabled: true, quietFrom: 22, quietTo: 6 };
  const held = afterQuietHours(local(23, 30), late, MID);
  const d = new Date(held);
  assert.equal(d.getDate(), 13, "held overnight into the next day");
  assert.equal(d.getHours(), 6);
});

test("held runs are released across a spread, not all at six o'clock sharp", () => {
  /* The point of the whole exercise. Releasing everything the moment the window
     lifts would put a burst at exactly 06:00 every morning — the fingerprint
     this was meant to remove, moved six hours down the clock. */
  assert.equal(new Date(afterQuietHours(local(2), QUIET, LOW)).getMinutes(), 0);
  const latest = new Date(afterQuietHours(local(2), QUIET, HIGH));
  assert.ok(latest.getMinutes() >= 44, `should spread across most of an hour, got :${latest.getMinutes()}`);

  let seed = 3;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const minutes = new Set();
  for (let i = 0; i < 200; i++) minutes.add(new Date(afterQuietHours(local(2), QUIET, rand)).getMinutes());
  assert.ok(minutes.size > 30, `release minute should vary widely, saw ${minutes.size} distinct`);
});

test("a moment outside the window is returned untouched", () => {
  // Idempotent, so it can be applied on every path without compounding.
  const noon = local(12);
  assert.equal(afterQuietHours(noon, QUIET, MID), noon);
  assert.equal(afterQuietHours(noon, { ...QUIET, quietEnabled: false }, MID), noon);
});

test("a planned run that lands in the window is moved out of it", () => {
  // 22:00 + 6h = 04:00, inside the pause.
  const due = planNextRun(QUIET, local(22), MID);
  assert.equal(inQuietHours(due, QUIET), false);
  assert.equal(new Date(due).getHours(), 6);
});

test("turning the pause on moves a run already scheduled for 3am", () => {
  // The stored target was drawn before the setting changed, so honouring it
  // as-is would sync at 3am once more.
  const planned = new Date(local(3)).toISOString();
  const due = dueAt({ ...QUIET, nextAutoRunAt: planned }, local(1), MID);
  assert.equal(inQuietHours(due, QUIET), false);
  assert.equal(new Date(due).getHours(), 6);
});

test("a machine that boots at 3am waits rather than syncing at 3am", () => {
  // "Due now" during the pause still defers — and defers rather than skips, so
  // the catch-up happens as soon as the window lifts.
  const due = dueAt({ ...QUIET, lastRunAt: new Date(local(21, 0, 11)).toISOString() }, local(3), MID);
  assert.ok(due > local(3), "should not be due during the pause");
  assert.equal(inQuietHours(due, QUIET), false);
});
