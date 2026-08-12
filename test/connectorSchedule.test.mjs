/* When the connector syncs by itself.
 *
 * These rules run on a machine nobody is watching — a firm's server left on in
 * the corner — so both failure modes are silent: a schedule that never fires
 * looks identical to one with nothing to do, and one that fires constantly is
 * only noticed by the income-tax portal. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { nextRunAt, isDue, armDelay, HOUR, MIN_WAIT_MS, MAX_WAIT_MS } =
  require("../connector/src/main/schedulePlan.js");

const NOW = Date.parse("2026-08-12T09:00:00.000Z");
const at = (hoursAgo) => new Date(NOW - hoursAgo * HOUR).toISOString();

test("a schedule that has never run is due immediately", () => {
  // Switching it on at 9am on a machine that was off all week should sync now,
  // not at 3pm.
  assert.equal(nextRunAt({ intervalHours: 6 }, NOW), NOW);
  assert.equal(nextRunAt({ lastRunAt: "", intervalHours: 6 }, NOW), NOW);
  assert.equal(isDue({ intervalHours: 6 }, NOW), true);
});

test("the next run is counted from the last one, not from launch", () => {
  // A server rebooted every hour must still sync every six.
  assert.equal(nextRunAt({ lastRunAt: at(2), intervalHours: 6 }, NOW), NOW + 4 * HOUR);
  assert.equal(isDue({ lastRunAt: at(2), intervalHours: 6 }, NOW), false);
  assert.equal(isDue({ lastRunAt: at(6), intervalHours: 6 }, NOW), true);
});

test("a machine asleep through several intervals syncs once, not four times", () => {
  // 30 hours later the run is overdue by a day; it is still one run.
  const due = nextRunAt({ lastRunAt: at(30), intervalHours: 6 }, NOW);
  assert.ok(due < NOW, "should be overdue");
  assert.equal(isDue({ lastRunAt: at(30), intervalHours: 6 }, NOW), true);
  // And the delay before that single run is the floor, not a negative sleep.
  assert.equal(armDelay(due, NOW), MIN_WAIT_MS);
});

test("a last-run stamp from the future does not park the schedule for ever", () => {
  /* A server whose clock is wrong at boot and corrects a minute later writes a
     timestamp days ahead. Trusting it would mean nothing ever runs again. */
  const ahead = new Date(NOW + 48 * HOUR).toISOString();
  assert.equal(nextRunAt({ lastRunAt: ahead, intervalHours: 6 }, NOW), NOW);
  assert.equal(isDue({ lastRunAt: ahead, intervalHours: 6 }, NOW), true);
});

test("a nonsense interval falls back to six hours rather than to zero", () => {
  // Zero or NaN would be a sync loop pointed at the income-tax portal.
  for (const bad of [0, -3, NaN, undefined, "soon"]) {
    assert.equal(nextRunAt({ lastRunAt: at(1), intervalHours: bad }, NOW), NOW + 5 * HOUR, `interval ${bad}`);
  }
});

test("the wait never exceeds half an hour, however far away the run is", () => {
  /* The ceiling is what makes a clock correction, a VM restore or a timezone
     change recover on their own: the timer wakes, re-reads the wall clock and
     re-arms, instead of sitting parked at a moment that no longer means
     anything. */
  assert.equal(armDelay(NOW + 6 * HOUR, NOW), MAX_WAIT_MS);
  assert.equal(armDelay(NOW + 10 * 60 * 1000, NOW), 10 * 60 * 1000);
  assert.equal(armDelay(NOW - HOUR, NOW), MIN_WAIT_MS, "an overdue run still waits a beat");
  assert.equal(armDelay(undefined, NOW), MAX_WAIT_MS, "a broken due time waits rather than spins");
});

test("the interval is honoured across the range the UI offers", () => {
  for (const hours of [3, 6, 12, 24]) {
    assert.equal(nextRunAt({ lastRunAt: at(0), intervalHours: hours }, NOW), NOW + hours * HOUR);
  }
});
