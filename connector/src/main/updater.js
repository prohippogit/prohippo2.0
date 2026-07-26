// Auto-update.
//
// electron-builder already publishes everything the updater needs: each
// `connector-v*` tag builds installers and attaches them — plus `latest.yml`,
// `latest-mac.yml` and the blockmaps — to the single `connector-latest` GitHub
// release (see .github/workflows/build-connector.yml). That release is marked
// `make_latest`, so electron-updater's GitHub provider finds the feed with no
// extra configuration.
//
// WHY THIS EXISTS: `electron-updater` sat in package.json unused, so every
// improvement shipped to a practitioner who had already installed the app...
// didn't. They had to notice, visit the site and reinstall. In practice that
// means most users run whatever build they first downloaded.
//
// PLATFORM DIFFERENCE — this is a real constraint, not an oversight:
//
//   Windows (NSIS)  full auto-update. Downloads in the background, installs on
//                   quit.
//   macOS           CANNOT self-update. Squirrel.Mac refuses to apply an update
//                   to an app without a valid code signature, and these builds
//                   are deliberately unsigned (CSC_IDENTITY_AUTO_DISCOVERY is
//                   "false" in CI — there's no Apple Developer ID yet). So on
//                   macOS we still CHECK, and tell the user a new version exists
//                   with a one-click link to the download. Checking is safe
//                   unsigned; only applying is blocked.
//
// Once an Apple Developer ID + notarization are in place, delete the platform
// branch below and macOS gets the same background flow as Windows.
//
// VERSION COMPARISON: the updater compares this build's package.json version
// against the version inside latest*.yml, so a release MUST bump the version or
// nothing is ever offered. CI derives it from the tag (connector-vX.Y.Z).
"use strict";

const { app, shell, ipcMain } = require("electron");

// Where a macOS user is sent to update by hand. Stable URLs — the release tag
// and the artifact names are both fixed (see electron-builder.yml).
const RELEASES = "https://github.com/prohippogit/prohippo2.0/releases/latest";
const MAC_DMG = RELEASES + "/download/ProHippo-Connector-mac.dmg";

// Give the window a moment to paint and the user a moment to start signing in
// before spending bandwidth on an update check.
const CHECK_DELAY_MS = 4000;

function initUpdater(win) {
  const send = (state, payload = {}) => {
    if (win && !win.isDestroyed()) win.webContents.send("update:state", { state, ...payload });
  };

  // Renderer actions. Registered even when updating is unavailable, so the UI
  // never invokes a missing channel.
  ipcMain.handle("update:openDownload", async () => {
    await shell.openExternal(process.platform === "darwin" ? MAC_DMG : RELEASES);
    return { ok: true };
  });

  // In dev there is no packaged app to replace and no embedded publish config;
  // electron-updater would just throw about a missing dev-app-update.yml.
  if (!app.isPackaged) return;

  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (err) {
    console.warn("[updater] electron-updater unavailable:", (err && err.message) || err);
    return;
  }

  const canSelfInstall = process.platform !== "darwin"; // see note above

  autoUpdater.autoDownload = false; // we decide, per platform
  autoUpdater.autoInstallOnAppQuit = canSelfInstall;
  autoUpdater.logger = null; // keep the console clean; we surface state to the UI

  ipcMain.handle("update:install", async () => {
    if (!canSelfInstall) {
      await shell.openExternal(MAC_DMG);
      return { ok: true, manual: true };
    }
    // Replaces the app and relaunches it.
    autoUpdater.quitAndInstall();
    return { ok: true };
  });

  autoUpdater.on("update-available", (info) => {
    const version = (info && info.version) || "";
    if (!canSelfInstall) {
      send("manual", { version });
      return;
    }
    send("downloading", { version, percent: 0 });
    autoUpdater.downloadUpdate().catch((err) => {
      // A failed download must never break the sync the user came here for.
      send("manual", { version, reason: String((err && err.message) || err) });
    });
  });

  autoUpdater.on("download-progress", (p) => {
    send("downloading", { percent: Math.round((p && p.percent) || 0) });
  });

  autoUpdater.on("update-downloaded", (info) => {
    send("ready", { version: (info && info.version) || "" });
  });

  // Silence is correct for "already current" — no UI, no noise.
  autoUpdater.on("update-not-available", () => send("idle"));

  autoUpdater.on("error", (err) => {
    // Never surface a scary banner for this: a broken update check is not the
    // user's problem and must not look like a sync failure.
    console.warn("[updater]", (err && err.message) || err);
    send("idle");
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.warn("[updater] check failed:", (err && err.message) || err);
    });
  }, CHECK_DELAY_MS);
}

module.exports = { initUpdater };
