// Preload bridge — the ONLY surface the renderer can touch. contextIsolation is
// on and nodeIntegration is off, so the UI gets exactly these calls and nothing
// from Node/Electron/Firebase directly.
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("connector", {
  // channel: "email" | "sms"; target is the address or 10-digit mobile.
  requestOtp: (channel, target) => ipcRenderer.invoke("auth:requestOtp", { channel, target }),
  verifyOtp: (channel, target, code) => ipcRenderer.invoke("auth:verifyOtp", { channel, target, code }),
  signInWithGoogle: () => ipcRenderer.invoke("auth:google"),
  // Resolves to the user when this device is remembered, or null.
  trySilentSignIn: () => ipcRenderer.invoke("auth:silent"),
  signOut: () => ipcRenderer.invoke("auth:signOut"),
  currentUser: () => ipcRenderer.invoke("auth:current"),
  listAssessees: () => ipcRenderer.invoke("assessees:list"),
  runSync: (jobs, scope, headless) => ipcRenderer.invoke("sync:run", { jobs, scope, headless }),
  // subscribe to per-PAN progress events
  onSyncEvent: (cb) => {
    const handler = (_e, evt) => cb(evt);
    ipcRenderer.on("sync:event", handler);
    return () => ipcRenderer.removeListener("sync:event", handler);
  },

  // --- version + auto-update ---
  // { version, platform, packaged, canSelfInstall } — shown in the header so a
  // practitioner can say which build they are on without opening anything.
  appVersion: () => ipcRenderer.invoke("app:version"),
  // "Check for updates", pressed by the user. The answer arrives on the
  // update:state channel below, including "you are already current".
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  // States: "idle" | "checking" | "current" | "manual" | "downloading" |
  //         "ready" | "checkFailed" | "unavailable". See updater.js.
  onUpdateState: (cb) => {
    const handler = (_e, evt) => cb(evt);
    ipcRenderer.on("update:state", handler);
    return () => ipcRenderer.removeListener("update:state", handler);
  },
  // Windows: relaunch into the downloaded build. macOS: open the .dmg download.
  installUpdate: () => ipcRenderer.invoke("update:install"),
  openDownloadPage: () => ipcRenderer.invoke("update:openDownload"),
});
