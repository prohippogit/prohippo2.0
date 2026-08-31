/* Connector preferences that survive a restart.
 *
 * Plain JSON in the app's userData directory. NOT the OS keychain: nothing in
 * here is a secret — it is which switches the practitioner left on. The device
 * key is the only credential this app keeps on disk and it lives in
 * deviceSession.js, encrypted.
 *
 * Every read is defensive. A settings file that has been hand-edited, truncated
 * by a power cut, or written by a newer build must never stop the app starting:
 * an unreadable value falls back to its default and the app carries on.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { SCOPES: ALL_SCOPES, DEFAULT_SCOPE } = require("./syncScope");

const FILE = () => path.join(app.getPath("userData"), "settings.json");

/* Automatic syncing is OFF until somebody turns it on.
 *
 * An app that installs itself into startup and begins signing in to clients'
 * income-tax portals unattended, because it was launched once, is not a
 * feature anybody asked for individually. The switches are one click away and
 * say exactly what they do; the choice stays the practitioner's. */
const DEFAULTS = {
  autoLaunch: false,      // start when the OS user signs in
  syncOnLaunch: false,    // and sync as soon as it has signed in
  autoSyncEnabled: false, // keep syncing on a timer while it runs
  intervalHours: 6,
  /* What an unattended run fetches. e-Proceedings only — see syncScope.js for
     why the thorough scope is the wrong default for a run nobody is watching,
     and how a never-synced assessee still gets its one full pass. */
  autoScope: DEFAULT_SCOPE,
  /* Whether the line above is the practitioner's choice or ours.
     The default MOVED, from "all" to "eproc", and every install that had ever
     saved a setting of any kind had "all" written into its file by the write
     below — settings.write() stores the whole object, not the changed key. So
     without this flag the new default would reach only new installs, and the
     practices actually complaining about noisy unattended runs would keep the
     old behaviour for ever. Until somebody picks a scope themselves, the stored
     value is ignored and the current default applies. */
  autoScopeChosen: false,
  /* How far either side of the interval a run may land, as a fraction. The
     point is that the portal never sees the same schedule twice; see
     schedulePlan.js. Configurable so it can be widened, not so it can be
     switched off — 0 is accepted but is a choice somebody has to make. */
  jitterPct: 0.15,
};

// Hours between unattended runs. The floor is deliberate: this traffic goes to
// the income-tax portal from a practitioner's own connection, and a tighter
// loop is the one change that could make it look like something it isn't.
const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 24;
/* Scopes an unattended run may be set to. "returnForm" is excluded on purpose:
   it fetches one named year's ITR form on demand and means nothing on a
   schedule. */
const SCOPES = ALL_SCOPES.filter((s) => s !== "returnForm");

const MAX_JITTER = 0.4;
const clampJitter = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return DEFAULTS.jitterPct;
  return Math.min(n, MAX_JITTER);
};

const clampInterval = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULTS.intervalHours;
  return Math.min(MAX_INTERVAL_HOURS, Math.max(MIN_INTERVAL_HOURS, Math.round(n)));
};

let cache = null;

function read() {
  if (cache) return cache;
  let stored;
  try {
    stored = JSON.parse(fs.readFileSync(FILE(), "utf8"));
  } catch {
    /* missing, unreadable or not JSON — the defaults below are the answer */
  }
  if (!stored || typeof stored !== "object") stored = {};
  cache = {
    autoLaunch: Boolean(stored.autoLaunch),
    syncOnLaunch: Boolean(stored.syncOnLaunch),
    autoSyncEnabled: Boolean(stored.autoSyncEnabled),
    intervalHours: clampInterval(stored.intervalHours),
    autoScopeChosen: Boolean(stored.autoScopeChosen),
    autoScope: stored.autoScopeChosen && SCOPES.includes(stored.autoScope) ? stored.autoScope : DEFAULTS.autoScope,
    jitterPct: clampJitter(stored.jitterPct),
    // This machine's id for the cross-machine sync lock. Not a secret and not a
    // credential — a random string whose only job is to tell two computers apart.
    deviceId: typeof stored.deviceId === "string" ? stored.deviceId : "",
    // Not preferences — the two timestamps that make the schedule survive a
    // restart. `lastAutoRunAt` stops a rebooted machine syncing on every boot;
    // `nextAutoRunAt` is the randomised target, drawn once per cycle so it does
    // not move every time the timer looks at it.
    lastAutoRunAt: typeof stored.lastAutoRunAt === "string" ? stored.lastAutoRunAt : "",
    nextAutoRunAt: typeof stored.nextAutoRunAt === "string" ? stored.nextAutoRunAt : "",
  };
  return cache;
}

function write(patch) {
  const next = { ...read(), ...patch };
  next.intervalHours = clampInterval(next.intervalHours);
  next.jitterPct = clampJitter(next.jitterPct);
  // Somebody setting a scope IS the choice — the flag goes up with the value,
  // so from here on the stored setting outranks whatever the default becomes.
  if ("autoScope" in patch) next.autoScopeChosen = true;
  if (!SCOPES.includes(next.autoScope)) next.autoScope = DEFAULTS.autoScope;
  cache = next;
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(next, null, 2), "utf8");
  } catch (err) {
    // A read-only profile directory must not break the running app. The switch
    // still applies for this session; it just will not be remembered.
    console.warn("[settings] couldn't save:", (err && err.message) || err);
  }
  return next;
}

module.exports = { read, write, DEFAULTS, MIN_INTERVAL_HOURS, MAX_INTERVAL_HOURS, MAX_JITTER, SCOPES };
