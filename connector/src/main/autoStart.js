/* "Start when I sign in to this computer."
 *
 * Electron's own login-item API, which is the OS's supported way in on both
 * platforms this app ships to: a Launch Agent on macOS, a Run key on Windows.
 * Nothing is written by hand into either.
 *
 * The setting is READ BACK from the OS rather than trusted from our own file.
 * A user who removes the app from Login Items in System Settings, or from Task
 * Manager's Startup tab, has said something — and a switch still showing "on"
 * after that is a lie the app tells about itself every launch.
 */
"use strict";

const { app } = require("electron");

// Linux has no Electron login-item support; the toggle is hidden there rather
// than shown doing nothing.
const supported = () => process.platform === "darwin" || process.platform === "win32";

function isEnabled() {
  if (!supported()) return false;
  try {
    return Boolean(app.getLoginItemSettings().openAtLogin);
  } catch (err) {
    console.warn("[autoStart] couldn't read login item:", (err && err.message) || err);
    return false;
  }
}

/* Turn it on or off. Returns what the OS says afterwards, which is the only
   answer worth reporting — the call can be refused by policy on a managed
   machine, and the UI must show what is true rather than what we asked for. */
function setEnabled(on) {
  if (!supported()) return false;
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(on),
      // macOS: come up without stealing the screen from whatever the user is
      // doing at login. Ignored elsewhere.
      openAsHidden: true,
      args: ["--autostart"],
    });
  } catch (err) {
    console.warn("[autoStart] couldn't set login item:", (err && err.message) || err);
  }
  return isEnabled();
}

// True when this launch came from the OS at sign-in rather than from a person
// double-clicking the app.
const launchedByOS = () =>
  process.argv.includes("--autostart") ||
  (() => { try { return Boolean(app.getLoginItemSettings().wasOpenedAtLogin); } catch { return false; } })();

module.exports = { supported, isEnabled, setEnabled, launchedByOS };
