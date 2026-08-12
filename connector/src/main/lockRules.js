/* Who is allowed to sync, when a practice runs the connector on more than one
 * machine.
 *
 * THE PROBLEM. A firm installs this on the partner's laptop and on the server in
 * the corner. Both are signed in to the same practice. Both have automatic
 * syncing on. Nothing stops them syncing the same PANs at the same time — and
 * that is not merely wasteful: it doubles the portal sessions attributable to
 * one practice, and two sessions logging into the SAME assessee at once is
 * exactly what the portal's Dual Login rule reacts to. The per-machine lock in
 * main.js cannot see across machines, so the coordination has to live where both
 * can see it: one document in Firestore.
 *
 * THE RULES ARE PURE AND HERE. Deciding whether a lock is still alive is the
 * part that must not be wrong in either direction — hold it too long and a
 * crashed laptop stops the server syncing for ever; release it too eagerly and
 * two machines sync at once, which is the thing being prevented.
 */
"use strict";

/* A held lock is refreshed while the sync runs. Three minutes without a beat
   means the holder is gone: crashed, closed, put to sleep, or off the network.
   Comfortably longer than the heartbeat, so an ordinary hiccup does not hand
   the lock to somebody else mid-run. */
const HEARTBEAT_MS = 45 * 1000;
const STALE_AFTER_MS = 3 * 60 * 1000;

/* Firestore hands back a Timestamp, our own writes may be an ISO string, and a
   hand-edited document could hold anything. One normaliser, so a shape nobody
   anticipated reads as "no heartbeat" — which expires the lock — rather than as
   NaN, which compares false against everything and would hold it for ever. */
function toMillis(v) {
  if (!v) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") { const t = Date.parse(v); return Number.isFinite(t) ? t : 0; }
  if (typeof v.toMillis === "function") { try { return v.toMillis() || 0; } catch { return 0; } }
  if (typeof v.seconds === "number") return v.seconds * 1000;
  return 0;
}

// No document, no holder, or a holder that has stopped beating.
function isStale(lock, now = Date.now(), staleAfterMs = STALE_AFTER_MS) {
  if (!lock || !lock.deviceId) return true;
  const beat = toMillis(lock.heartbeatAt) || toMillis(lock.startedAt);
  if (!beat) return true;
  // A beat from the future is a clock, not a liveness signal. Treat it as live
  // rather than steal the lock: two machines syncing at once is the worse
  // outcome of the two.
  if (beat > now) return false;
  return now - beat > staleAfterMs;
}

/* May this device start a sync? Its own lock is always reclaimable — the app
   restarting after a crash must not be locked out by its own stale record. */
function canAcquire(lock, deviceId, now = Date.now(), staleAfterMs = STALE_AFTER_MS) {
  if (!lock || !lock.deviceId) return true;
  if (lock.deviceId === deviceId) return true;
  return isStale(lock, now, staleAfterMs);
}

/* What to tell the user when another machine holds it. Names the machine and
   says how long it has been going, because "a sync is already running" with no
   idea where is a message that helps nobody. */
function holderText(lock, now = Date.now()) {
  if (!lock || !lock.deviceId) return "";
  const name = String(lock.deviceLabel || "another computer").trim() || "another computer";
  const started = toMillis(lock.startedAt) || toMillis(lock.heartbeatAt);
  if (!started || started > now) return `Syncing on ${name}`;
  const mins = Math.max(0, Math.round((now - started) / 60000));
  if (mins < 1) return `Syncing on ${name}, just started`;
  return `Syncing on ${name}, ${mins} min ago`;
}

module.exports = { isStale, canAcquire, holderText, toMillis, HEARTBEAT_MS, STALE_AFTER_MS };
