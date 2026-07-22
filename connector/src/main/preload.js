// Preload bridge — the ONLY surface the renderer can touch. contextIsolation is
// on and nodeIntegration is off, so the UI gets exactly these calls and nothing
// from Node/Electron/Firebase directly.
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("connector", {
  signIn: (email, password) => ipcRenderer.invoke("auth:signIn", { email, password }),
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
});
