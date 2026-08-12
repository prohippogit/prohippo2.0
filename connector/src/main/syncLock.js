/* The cross-machine sync lock, in Firestore.
 *
 * One document per practice — users/{uid}/appState/syncLock — that every
 * machine running the connector can see. Taken in a TRANSACTION, because two
 * laptops switched on together will read it in the same instant and a
 * read-then-write would let both conclude they may go.
 *
 * It is held by heartbeat rather than by a promise to release it. A machine
 * that crashes, sleeps or loses its network mid-sync cannot release anything,
 * and a lock nobody can release is a practice that never syncs again. The
 * holder beats every 45 seconds; three minutes of silence and the next machine
 * to ask takes over (lockRules.js).
 *
 * The rules for that live in lockRules.js, where they are tested. This file is
 * only the plumbing.
 */
"use strict";

const os = require("os");
const crypto = require("crypto");
const rules = require("./lockRules");
const settings = require("./settings");

const PATH = (uid) => `users/${uid}/appState/syncLock`;

/* This machine's identity, made once and kept in settings.json.
 *
 * Deliberately NOT the device key from the keychain: that is a credential, and
 * a credential must not travel in a document other machines read. This is a
 * meaningless random string whose only job is to tell two machines apart. */
function deviceId() {
  const cur = settings.read().deviceId;
  if (cur) return cur;
  const id = crypto.randomBytes(8).toString("hex");
  settings.write({ deviceId: id });
  return id;
}

function deviceLabel() {
  try {
    const plat = process.platform === "darwin" ? "Mac" : process.platform === "win32" ? "Windows PC" : "computer";
    return `${os.hostname().replace(/\.local$/i, "")} (${plat})`;
  } catch {
    return "another computer";
  }
}

/* Take the lock, or report who has it.
 *
 * Returns { ok: true } | { ok: false, holder, message }. A failure to REACH
 * Firestore returns ok:true with a note: the lock is a coordination nicety
 * between a firm's own machines, and letting a network blip stop the only
 * machine in the practice from syncing would be a worse bug than the one this
 * prevents. */
async function acquire(fb) {
  const uid = fb.uid();
  if (!uid) return { ok: false, message: "Sign in first." };
  const me = deviceId();
  try {
    const held = await fb.transactLock(PATH(uid), (cur) => {
      if (!rules.canAcquire(cur, me)) return null; // somebody else is live
      return {
        deviceId: me,
        deviceLabel: deviceLabel(),
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      };
    });
    if (held) return { ok: true };
    const cur = await fb.readDoc(PATH(uid));
    return { ok: false, holder: cur, message: rules.holderText(cur) || "A sync is already running on another computer." };
  } catch (err) {
    console.warn("[syncLock] couldn't reach the lock, syncing anyway:", (err && err.message) || err);
    return { ok: true, degraded: true };
  }
}

/* Keep it alive while the sync runs. Returns a stop() to call in a finally.
   Best-effort: a missed beat is survivable, and three minutes of them is what
   correctly hands the lock on. */
function startHeartbeat(fb) {
  const uid = fb.uid();
  if (!uid) return async () => {};
  const timer = setInterval(() => {
    fb.mergeDoc(PATH(uid), { heartbeatAt: new Date().toISOString() })
      .catch((err) => console.warn("[syncLock] heartbeat missed:", (err && err.message) || err));
  }, rules.HEARTBEAT_MS);
  if (timer.unref) timer.unref();
  return async () => { clearInterval(timer); await release(fb); };
}

/* Put it down — but only if it is still ours. A lock that went stale and was
   taken over by the server must not be deleted by the laptop that woke up and
   finished its own run late. */
async function release(fb) {
  const uid = fb.uid();
  if (!uid) return;
  const me = deviceId();
  try {
    await fb.transactLock(PATH(uid), (cur) => {
      if (cur && cur.deviceId && cur.deviceId !== me) return null; // not ours any more
      return { deviceId: "", deviceLabel: "", startedAt: "", heartbeatAt: "", releasedAt: new Date().toISOString() };
    });
  } catch (err) {
    console.warn("[syncLock] couldn't release:", (err && err.message) || err);
  }
}

// What the UI shows: null when nobody holds it, or when we are the holder (the
// window already shows its own progress).
function foreignHolder(lock, now = Date.now()) {
  if (!lock || !lock.deviceId) return null;
  if (lock.deviceId === deviceId()) return null;
  if (rules.isStale(lock, now)) return null;
  return { label: lock.deviceLabel || "another computer", text: rules.holderText(lock, now) };
}

module.exports = { acquire, release, startHeartbeat, foreignHolder, deviceId, deviceLabel, PATH };
