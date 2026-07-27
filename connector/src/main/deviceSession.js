// "Remember this device" — the local half.
//
// Stores one app-scoped device key so the practitioner isn't asked for an emailed
// code on every launch. The key is issued and validated server-side
// (issueDeviceKey / redeemDeviceKey in functions/index.js); this module only
// keeps it safe on disk.
//
// SAFETY: the key is encrypted with Electron's safeStorage, which is backed by
// the macOS Keychain, Windows DPAPI, or a Linux keyring. That ties it to the
// logged-in OS account — copying the file to another machine yields ciphertext
// nobody can open.
//
// If encryption is unavailable (mainly Linux with no keyring), we DO NOT fall
// back to writing the key in plaintext. We simply don't remember the device, and
// the user signs in with a code as before. A worse-but-working experience beats a
// credential sitting readable on disk — this app can reach clients' income-tax
// portals.
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { app, safeStorage } = require("electron");

const FILE = () => path.join(app.getPath("userData"), "device.key");

let warned = false;
function available() {
  try {
    if (safeStorage.isEncryptionAvailable()) return true;
  } catch { /* not ready, or no backend */ }
  if (!warned) {
    warned = true;
    console.warn(
      "[deviceSession] OS keychain unavailable — this device won't be remembered, " +
      "and a sign-in code will be needed each launch. Refusing to store the key unencrypted."
    );
  }
  return false;
}

// A human-readable name for the machine, so a future "signed-in devices" view has
// something to show. Never used for authorisation.
function deviceLabel() {
  try {
    return `${os.hostname()} (${process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : process.platform})`;
  } catch {
    return "";
  }
}

function load() {
  if (!available()) return null;
  try {
    const buf = fs.readFileSync(FILE());
    const key = safeStorage.decryptString(buf);
    return key && key.trim() ? key : null;
  } catch {
    // Missing (first run), or written by a different OS account / after a
    // keychain reset. Either way there's nothing usable — sign in normally.
    return null;
  }
}

function save(key) {
  if (!key || !available()) return false;
  try {
    fs.writeFileSync(FILE(), safeStorage.encryptString(key), { mode: 0o600 });
    return true;
  } catch (err) {
    console.warn("[deviceSession] could not save:", (err && err.message) || err);
    return false;
  }
}

function clear() {
  try {
    fs.rmSync(FILE(), { force: true });
  } catch { /* already gone */ }
}

module.exports = { load, save, clear, deviceLabel, available };
