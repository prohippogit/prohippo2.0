// Electron main process.
//
// Owns the window, the Firebase session, and the worker pool. The renderer is a
// thin UI that talks to this process over a locked-down preload bridge — it
// never sees credentials or Firebase internals directly.
"use strict";

const path = require("path");
const { app, BrowserWindow, ipcMain } = require("electron");
const fb = require("./firebaseClient");
const googleAuth = require("./googleAuth");
const { runPool } = require("./pool");
const { fetchMasterForPan, createAssessee } = require("./assessees");
const { initUpdater } = require("./updater");
const settings = require("./settings");
const autoStart = require("./autoStart");
const scheduler = require("./scheduler");
const { shuffle } = require("./schedulePlan");
const syncLock = require("./syncLock");

const isDev = process.argv.includes("--dev");
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    title: "ProHippo Connector",
    backgroundColor: "#0F0E1D",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  if (isDev) win.webContents.openDevTools({ mode: "detach" });
}

// Push a progress event to the renderer.
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---- IPC handlers ----------------------------------------------------------

// channel: "email" | "sms" — both already supported by the backend callables.
ipcMain.handle("auth:requestOtp", async (_e, { channel, target }) => {
  return fb.requestOtp(channel || "email", target);
});

ipcMain.handle("auth:verifyOtp", async (_e, { channel, target, code }) => {
  const user = await fb.verifyOtp(channel || "email", target, code);
  watchPractice();
  return user;
});

ipcMain.handle("auth:google", async () => {
  const idToken = await googleAuth.getGoogleIdToken();
  const user = await fb.signInWithGoogleIdToken(idToken);
  watchPractice();
  return user;
});

/* Restore a remembered session, so a returning user isn't asked for a code.
   Returns null when there's nothing to restore — the UI then shows sign-in.

   The launch sync hangs off THIS, not off app-ready: with nobody signed in
   there is nothing to sync, and on a machine that has just booted the device
   key is still being redeemed over a network that may not be up yet. */
ipcMain.handle("auth:silent", async () => {
  const user = await fb.signInSilently();
  if (user) {
    watchPractice();
    scheduler.syncOnLaunchIfWanted().catch((err) => console.warn("[launch sync]", (err && err.message) || err));
  }
  return user;
});

ipcMain.handle("auth:signOut", async () => {
  // Drop the subscriptions BEFORE the sign-out: a listener scoped to a uid that
  // no longer has a token spends the rest of the session logging permission
  // errors into the console.
  stopWatching();
  await fb.signOutUser();
  return { ok: true };
});

ipcMain.handle("auth:current", async () => fb.currentUser());

/* ONE sync at a time, whoever asked for it.
 *
 * The button and the scheduler go through here together. Two pools at once
 * would put twice the capped number of portal sessions on one residential IP —
 * the single thing the pacing everywhere else exists to prevent — and the two
 * runs would fetch the same PANs over each other. */
let syncInFlight = false;
const isBusy = () => syncInFlight;

/* The handle onto the run that is in flight, whoever started it.
 *
 * Held here rather than passed around because the window has to be able to
 * reach a run it did not start: the schedule fires unattended, and the person
 * watching a stuck sync at 9pm is the same person either way. Null between
 * runs, so a Stop pressed after one has ended says so instead of throwing. */
let syncControl = null;

async function runSync({ jobs, scope, headless, trigger = "manual" }) {
  if (!fb.currentUser()) throw new Error("Sign in first.");
  if (syncInFlight) throw new Error("A sync is already running.");

  /* ...and not on another of the practice's computers either. A firm runs this
     on a laptop and on the server; both signed in, both scheduled. Two machines
     syncing the same PANs at once doubles the portal sessions the practice is
     accountable for, and two sessions logging into the SAME assessee is what
     Dual Login reacts to. The lock lives in Firestore because that is the only
     place both machines can see. */
  const lock = await syncLock.acquire(fb);
  if (!lock.ok) throw new Error(lock.message || "A sync is already running on another computer.");
  const stopHeartbeat = syncLock.startHeartbeat(fb);

  syncInFlight = true;
  send("sync:busy", { running: true, trigger });
  try {
    // An unattended run has no selection to work from: it takes every PAN that
    // has a stored portal login, which is exactly what the list shows.
    let list = jobs;
    if (!list) {
      list = (await fb.listPortalAssessees()).map((a) => ({
        assesseeId: a.id,
        pan: a.pan || a.portalUserId,
        label: a.name || a.pan,
        dob: a.dob || "",
      }));
      /* Dealt in a different order every run. The same list worked top to
         bottom at roughly the same hour is a pattern in itself — one PAN always
         first, one always last, every day — and the whole point of the
         randomised schedule is that consecutive days do not look alike. A
         manual run keeps the user's own order: they chose it. */
      list = shuffle(list);
    }
    if (!list.length) return [];
    /* HIDDEN UNLESS SOMEBODY ASKED TO WATCH.
     *
     * This used to read `trigger === "manual" ? headless : true`, which looks
     * right and was the bug behind "it opened numbers of browsers": the
     * scheduler calls runSync({ scope, trigger }) with NO headless key, and
     * "Sync everything now" goes through the scheduler with trigger "manual".
     * So `headless` was undefined, `undefined === true` was false, and every
     * PAN opened a visible window — on macOS and on Windows alike.
     *
     * Stated the other way round now: a window appears only when the window's
     * own Sync-selected explicitly says so by unticking the box. Every other
     * path — the schedule, the launch sync, Sync everything now — is hidden,
     * and an absent flag can no longer mean "show it". */
    return await runPool(list, (evt) => send("sync:event", evt), {
      scope,
      headless: !(trigger === "manual" && headless === false),
      onControl: (control) => { syncControl = control; },
    });
  } finally {
    syncControl = null;
    syncInFlight = false;
    await stopHeartbeat();
    send("sync:busy", { running: false, trigger });
  }
}

// jobs: [{ assesseeId, pan, label, scope, knowns }]
ipcMain.handle("sync:run", async (_e, { jobs, scope, headless }) => runSync({ jobs, scope, headless, trigger: "manual" }));

/* Stop the run, and skip one PAN out of it.
 *
 * Both are answers to the same complaint: the portal stops answering part-way
 * through a document, and until the deadlines in config.js there was nothing
 * between "wait" and "kill the app". The deadlines end a stall on their own;
 * these are for the person who does not want to wait out even that.
 *
 * Neither throws when there is nothing to stop — a button pressed a second
 * after the run ended is not an error worth showing anybody. */
ipcMain.handle("sync:stop", async () => {
  if (!syncControl) return { ok: false, reason: "nothing-running" };
  syncControl.stop();
  return { ok: true };
});

ipcMain.handle("sync:skip", async (_e, { assesseeId }) => {
  if (!syncControl) return { ok: false, reason: "nothing-running" };
  return { ok: syncControl.skip(assesseeId) };
});

/* ---- automatic syncing ---------------------------------------------------
   Settings live in settings.json; the timer and the launch run live in
   scheduler.js. This process only wires them to the window. */
const autoPayload = () => ({
  ...settings.read(),
  autoLaunch: autoStart.isEnabled(),          // what the OS says, not what we stored
  autoLaunchSupported: autoStart.supported(),
  // The window is the app everywhere except macOS, so the UI can say whether
  // closing it would stop the schedule.
  platform: process.platform,
  ...scheduler.state(),
});

ipcMain.handle("auto:get", async () => autoPayload());

ipcMain.handle("auto:set", async (_e, patch = {}) => {
  const next = {};
  for (const k of ["syncOnLaunch", "autoSyncEnabled", "intervalHours", "autoScope"]) {
    if (k in patch) next[k] = patch[k];
  }
  if (Object.keys(next).length) settings.write(next);
  // The login item is the OS's, not ours: set it, then report what it says.
  if ("autoLaunch" in patch) {
    const on = autoStart.setEnabled(patch.autoLaunch);
    settings.write({ autoLaunch: on });
  }
  scheduler.refresh();
  return autoPayload();
});

// "Sync everything now", from the automatic panel rather than the selection.
ipcMain.handle("auto:runNow", async () => {
  if (!fb.currentUser()) throw new Error("Sign in first.");
  await scheduler.runNow("manual");
  return scheduler.state();
});

// List assessees that have a stored portal credential, for the UI pick-list.
// Reads Firestore with the signed-in user's token (firestore.rules scopes it).
ipcMain.handle("assessees:list", async () => {
  if (!fb.currentUser()) throw new Error("Sign in first.");
  return fb.listPortalAssessees();
});

/* Add an assessee from here, without the Chrome extension.
 *
 * Two steps on purpose, with the user in between: fetch reads the portal but
 * saves nothing, and create writes what they have reviewed. The password is
 * passed in per call and held only for the length of it — the renderer keeps it
 * in the open form's field, and neither side writes it anywhere. */
ipcMain.handle("assessee:fetchMaster", async (_e, { pan, portalUserId, portalPassword, headless }) => {
  if (!fb.currentUser()) throw new Error("Sign in first.");
  return fetchMasterForPan({
    pan,
    portalUserId,
    portalPassword,
    headless: headless !== false,
    emit: (phase, message, level) => send("assessee:event", { phase, message, level: level || "info" }),
  });
});

ipcMain.handle("assessee:create", async (_e, { form, portalPassword, saveLogin }) => {
  if (!fb.currentUser()) throw new Error("Sign in first.");
  return createAssessee({ form, portalPassword, saveLogin });
});

/* Watching the practice's OTHER machines. Both subscriptions are set up after
   sign-in and torn down on sign-out, because both are scoped to a uid. */
let unwatch = [];

function watchPractice() {
  stopWatching();
  const uid = fb.uid();
  if (!uid) return;
  try {
    unwatch.push(fb.watchDoc(syncLock.PATH(uid), (lock) => {
      send("sync:elsewhere", syncLock.foreignHolder(lock));
    }));
    // A sync finishing on the server shows on the partner's laptop without
    // anybody pressing Reload.
    unwatch.push(fb.watchPortalAssessees((rows) => send("assessees:synced", rows)));
  } catch (err) {
    console.warn("[watch] couldn't subscribe:", (err && err.message) || err);
  }
}

function stopWatching() {
  for (const off of unwatch) { try { off(); } catch { /* already gone */ } }
  unwatch = [];
}

app.whenReady().then(() => {
  fb.init();
  createWindow();
  scheduler.start({
    isSignedIn: () => Boolean(fb.currentUser()),
    isBusy,
    runSync: ({ scope, trigger }) => runSync({ scope, trigger }),
    onState: (st) => send("auto:state", { ...st, platform: process.platform, autoLaunch: autoStart.isEnabled(), autoLaunchSupported: autoStart.supported(), syncOnLaunch: settings.read().syncOnLaunch }),
  });
  // Check for a new build shortly after launch. Windows installs it on quit;
  // macOS can't self-update unsigned, so it offers a download link instead.
  initUpdater(win);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => scheduler.stop());
