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
const { initUpdater } = require("./updater");

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

// Restore a remembered session, so a returning user isn't asked for a code.
// Returns null when there's nothing to restore — the UI then shows sign-in.
ipcMain.handle("auth:silent", async () => fb.signInSilently());

ipcMain.handle("auth:signOut", async () => {
  await fb.signOutUser();
  return { ok: true };
});

ipcMain.handle("auth:current", async () => fb.currentUser());

// jobs: [{ assesseeId, pan, label, scope, knowns }]
ipcMain.handle("sync:run", async (_e, { jobs, scope, headless }) => {
  if (!fb.currentUser()) throw new Error("Sign in first.");
  const onEvent = (evt) => send("sync:event", evt);
  const results = await runPool(jobs, onEvent, { scope, headless });
  return results;
});

// List assessees that have a stored portal credential, for the UI pick-list.
// Reads Firestore with the signed-in user's token (firestore.rules scopes it).
ipcMain.handle("assessees:list", async () => {
  if (!fb.currentUser()) throw new Error("Sign in first.");
  return fb.listPortalAssessees();
});

app.whenReady().then(() => {
  fb.init();
  createWindow();
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
