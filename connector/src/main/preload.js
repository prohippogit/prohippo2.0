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

  // --- add an assessee (no Chrome extension involved) ---
  // Signs in to the portal as this PAN and returns { record, filled } for
  // review. Saves nothing.
  fetchAssesseeMaster: (input) => ipcRenderer.invoke("assessee:fetchMaster", input),
  // Writes the reviewed record, then stores the portal login against it.
  createAssessee: (input) => ipcRenderer.invoke("assessee:create", input),
  // Progress while the fetch above logs in — same shape as a sync event.
  onAssesseeEvent: (cb) => {
    const handler = (_e, evt) => cb(evt);
    ipcRenderer.on("assessee:event", handler);
    return () => ipcRenderer.removeListener("assessee:event", handler);
  },
  runSync: (jobs, scope, headless) => ipcRenderer.invoke("sync:run", { jobs, scope, headless }),

  // --- automatic syncing (start with the computer, then every N hours) ---
  getAutoSync: () => ipcRenderer.invoke("auto:get"),
  setAutoSync: (patch) => ipcRenderer.invoke("auto:set", patch),
  // Sync every PAN now, from the automatic panel rather than the selection.
  runAllNow: () => ipcRenderer.invoke("auto:runNow"),
  // { enabled, intervalHours, scope, lastRunAt, nextRunAt, running, lastResult }
  onAutoState: (cb) => {
    const handler = (_e, evt) => cb(evt);
    ipcRenderer.on("auto:state", handler);
    return () => ipcRenderer.removeListener("auto:state", handler);
  },
  /* A sync started or finished — including one this window did not ask for.
     Without it an unattended run would paint progress into a UI whose buttons
     still looked idle. */
  onSyncBusy: (cb) => {
    const handler = (_e, evt) => cb(evt);
    ipcRenderer.on("sync:busy", handler);
    return () => ipcRenderer.removeListener("sync:busy", handler);
  },
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
