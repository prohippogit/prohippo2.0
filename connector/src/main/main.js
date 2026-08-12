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
  return fb.verifyOtp(channel || "email", target, code);
});

ipcMain.handle("auth:google", async () => {
  const idToken = await googleAuth.getGoogleIdToken();
  return fb.signInWithGoogleIdToken(idToken);
});

/* Restore a remembered session, so a returning user isn't asked for a code.
   Returns null when there's nothing to restore — the UI then shows sign-in.

   The launch sync hangs off THIS, not off app-ready: with nobody signed in
   there is nothing to sync, and on a machine that has just booted the device
   key is still being redeemed over a network that may not be up yet. */
ipcMain.handle("auth:silent", async () => {
  const user = await fb.signInSilently();
  if (user) scheduler.syncOnLaunchIfWanted().catch((err) => console.warn("[launch sync]", (err && err.message) || err));
  return user;
});

ipcMain.handle("auth:signOut", async () => {
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

async function runSync({ jobs, scope, headless, trigger = "manual" }) {
  if (!fb.currentUser()) throw new Error("Sign in first.");
  if (syncInFlight) throw new Error("A sync is already running.");
  syncInFlight = true;
  send("sync:busy", { running: true, trigger });
  try {
    // An unattended run has no selection to work from: it takes every PAN that
    // has a stored portal login, which is exactly what the list shows.
    const list = jobs || (await fb.listPortalAssessees()).map((a) => ({
      assesseeId: a.id,
      pan: a.pan || a.portalUserId,
      label: a.name || a.pan,
      dob: a.dob || "",
    }));
    if (!list.length) return [];
    // Unattended runs are always hidden: a browser window taking the screen on
    // a machine somebody else is using is not acceptable.
    return await runPool(list, (evt) => send("sync:event", evt), {
      scope,
      headless: trigger === "manual" ? headless : true,
    });
  } finally {
    syncInFlight = false;
    send("sync:busy", { running: false, trigger });
  }
}

// jobs: [{ assesseeId, pan, label, scope, knowns }]
ipcMain.handle("sync:run", async (_e, { jobs, scope, headless }) => runSync({ jobs, scope, headless, trigger: "manual" }));

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
