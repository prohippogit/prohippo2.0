/* Unattended syncing.
 *
 * TWO SITUATIONS, ONE MECHANISM.
 *
 *   A practitioner's own machine, switched on each morning. The app starts with
 *   the OS (autoStart.js), signs in from the device key already in the keychain,
 *   and syncs once. By the time they sit down, the morning's notices are in.
 *
 *   A machine left on — the firm's server in the corner. Nobody restarts it, so
 *   "sync at launch" would fire once and never again. It therefore keeps going
 *   on a timer, every six hours by default.
 *
 * WHY A RE-ARMED TIMEOUT AND NOT setInterval. An interval fires on a cadence
 * whatever else is happening: on a laptop that slept through three of them it
 * fires three times in a row, and it can start a run while the previous one is
 * still working. This re-arms after each attempt and computes the next moment
 * from the WALL CLOCK, so a machine that was asleep syncs once on waking and a
 * long run simply pushes the next one out.
 *
 * WHAT IT WILL NOT DO. It will not run while another sync is in flight — a
 * manual "Sync selected" holds the same lock. It will not run when nobody is
 * signed in; it waits and looks again, because a machine that has just booted
 * may still be restoring its session. And it never runs at all unless the
 * practitioner turned it on.
 */
"use strict";

const settings = require("./settings");
const plan = require("./schedulePlan");

const MINUTE = 60 * 1000;

// How soon to look again when a tick could not run. Signed out is the common
// case at boot: the device key redeems over the network, which may not be up
// the second the OS starts.
const RETRY_MS = 5 * MINUTE;

let timer = null;
let emit = () => {};
let deps = null;      // { isSignedIn, isBusy, runSync }
let running = false;  // an automatic run of ours is in flight
let lastResult = null; // { at, ok, failed, total, error }
let launchStartsAt = 0; // epoch ms while the launch sync is counting down

const nowISO = () => new Date().toISOString();

/* When the next unattended run is due.
 *
 * Not "the last run plus six hours": the target is DRAWN, once per cycle, from
 * a range around the interval, and stored — so the portal never sees the same
 * schedule two days running, and the countdown on screen does not jump about.
 * The arithmetic lives in schedulePlan.js, where it is tested. */
function nextRunAt(cfg = settings.read()) {
  if (!cfg.autoSyncEnabled) return null;
  const due = plan.dueAt({
    nextAutoRunAt: cfg.nextAutoRunAt,
    lastRunAt: cfg.lastAutoRunAt,
    intervalHours: cfg.intervalHours,
    jitterPct: cfg.jitterPct,
    ...plan.QUIET,
  });
  // A target that had to be re-drawn (nothing stored, or a nonsense clock) is
  // written back, so the next tick agrees with this one.
  if (due > Date.now() && cfg.nextAutoRunAt !== new Date(due).toISOString()) {
    settings.write({ nextAutoRunAt: new Date(due).toISOString() });
  }
  return due;
}

function state() {
  const cfg = settings.read();
  const next = nextRunAt(cfg);
  return {
    enabled: cfg.autoSyncEnabled,
    intervalHours: cfg.intervalHours,
    scope: cfg.autoScope,
    lastRunAt: cfg.lastAutoRunAt || "",
    nextRunAt: next ? new Date(Math.max(next, Date.now())).toISOString() : "",
    running,
    lastResult,
    // Set only while the launch sync is waiting out its randomised delay.
    launchStartsAt: launchStartsAt ? new Date(launchStartsAt).toISOString() : "",
    // The overnight pause is policy rather than preference, so the UI is told
    // only whether it is in force right now — not offered a switch for it.
    inQuietHours: plan.inQuietHours(Date.now(), plan.QUIET),
    quietTo: plan.QUIET_TO,
  };
}

function publish() { emit(state()); }

function disarm() {
  if (timer) clearTimeout(timer);
  timer = null;
}

/* Arm the next tick. Capped so a clock that jumps — a VM restored from a
   snapshot, a machine whose time was wrong at boot and got corrected — cannot
   park the timer days into the future with nothing checking in between. */
function arm(delayMs) {
  disarm();
  const wait = plan.armDelay(Date.now() + delayMs);
  timer = setTimeout(tick, wait);
  if (timer.unref) timer.unref(); // never hold the app open on its own account
}

async function tick() {
  const cfg = settings.read();
  if (!cfg.autoSyncEnabled) { disarm(); publish(); return; }

  const due = nextRunAt(cfg) - Date.now();
  if (due > 0) { arm(due); publish(); return; }

  if (!deps.isSignedIn()) { arm(RETRY_MS); publish(); return; }
  // A manual run is in progress: let it finish and look again shortly. Its
  // fetch covers the same ground ours would have.
  if (deps.isBusy()) { arm(RETRY_MS); publish(); return; }

  await runNow("schedule");
  arm(plan.armDelay(nextRunAt()));
}

/* Run every PAN that has a stored portal login.
 *
 * `trigger` is only for the log and the UI: "launch" | "schedule" | "manual".
 * The timestamp is written whether the run succeeded or failed — a portal that
 * is down at 6am must not turn into a retry every minute for the rest of the
 * day. */
async function runNow(trigger) {
  if (running) return;
  running = true;
  publish();
  const cfg = settings.read();
  try {
    const result = await deps.runSync({ scope: cfg.autoScope, trigger });
    const failed = (result || []).filter((r) => r && r.ok === false).length;
    lastResult = { at: nowISO(), ok: (result || []).length - failed, failed, total: (result || []).length, error: "" };
  } catch (err) {
    lastResult = { at: nowISO(), ok: 0, failed: 0, total: 0, error: String((err && err.message) || err) };
    console.warn(`[scheduler] ${trigger} sync failed:`, lastResult.error);
  } finally {
    running = false;
    const cfg2 = settings.read();
    settings.write({
      lastAutoRunAt: nowISO(),
      // Drawn now, for the next cycle — a fresh draw every time, so two
      // consecutive gaps are never the same length.
      nextAutoRunAt: new Date(plan.planNextRun({ ...cfg2, ...plan.QUIET })).toISOString(),
    });
    publish();
  }
}

/* Start the scheduler.
 *
 * `onState` receives the shape above whenever anything changes, so the window
 * can show when the last run was and when the next one is due. */
function start({ isSignedIn, isBusy, runSync, onState }) {
  deps = { isSignedIn, isBusy, runSync };
  emit = onState || (() => {});
  const cfg = settings.read();
  if (cfg.autoSyncEnabled) arm(0);
  publish();
}

/* Sync once because the app has just started, if that is what was asked for.
 *
 * Called after sign-in is settled rather than at launch: with nobody signed in
 * there is nothing to sync, and the device key is redeemed over the network. */
let launchTimer = null;

async function syncOnLaunchIfWanted() {
  const cfg = settings.read();
  if (!cfg.syncOnLaunch) return false;
  if (!deps || !deps.isSignedIn() || deps.isBusy()) return false;

  /* Not immediately. A machine switched on at 09:00 every weekday would
     otherwise reach the portal at 09:00 every weekday — the same fingerprint
     the interval jitter exists to avoid, by another route. A few minutes also
     lets the network settle on a machine that has just booted. */
  const wait = plan.launchDelayMs();
  launchStartsAt = Date.now() + wait;
  publish();
  await new Promise((resolve) => { launchTimer = setTimeout(resolve, wait); });
  launchTimer = null;
  launchStartsAt = 0;

  // Conditions are re-checked on the other side of the wait: somebody may have
  // signed out, or pressed Sync selected, while it counted down.
  if (!deps.isSignedIn() || deps.isBusy()) { publish(); return false; }

  /* A server restarted at 3am must not sync at 3am. The launch run defers to
     the same window as the schedule — and because it defers rather than skips,
     the machine still catches up as soon as the window lifts. */
  const cfg3 = settings.read();
  if (plan.inQuietHours(Date.now(), plan.QUIET)) {
    const release = plan.afterQuietHours(Date.now(), plan.QUIET);
    settings.write({ nextAutoRunAt: new Date(release).toISOString() });
    if (cfg3.autoSyncEnabled) arm(plan.armDelay(release));
    publish();
    return false;
  }
  await runNow("launch");
  if (settings.read().autoSyncEnabled) arm(plan.armDelay(nextRunAt()));
  return true;
}

// Settings changed from the UI: re-evaluate rather than wait for a timer that
// may be parked half an hour out.
function refresh() {
  const cfg = settings.read();
  if (!cfg.autoSyncEnabled) { disarm(); publish(); return; }
  arm(Math.max(nextRunAt(cfg) - Date.now(), 0));
  publish();
}

function stop() {
  disarm();
  if (launchTimer) { clearTimeout(launchTimer); launchTimer = null; }
}

module.exports = { start, stop, refresh, state, runNow, syncOnLaunchIfWanted, nextRunAt };
