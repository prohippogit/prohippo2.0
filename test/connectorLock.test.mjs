/* Who may sync, when a practice runs the connector on more than one machine.

   A firm installs this on the partner's laptop AND on the server in the corner.
   Both are signed in to the same practice; both have automatic syncing on.
   Getting this wrong goes badly in both directions: too eager, and two machines
   log into the same assessee at once, which is what the portal's Dual Login
   rule reacts to; too cautious, and one crashed laptop stops the whole practice
   syncing for ever. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isStale, canAcquire, holderText, toMillis, STALE_AFTER_MS, HEARTBEAT_MS } =
  require("../connector/src/main/lockRules.js");

const NOW = Date.parse("2026-08-12T12:00:00.000Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const lock = (extra = {}) => ({ deviceId: "server-1", deviceLabel: "office-server (Windows PC)", startedAt: ago(60000), heartbeatAt: ago(10000), ...extra });

test("a beating lock is live and belongs to whoever holds it", () => {
  assert.equal(isStale(lock(), NOW), false);
  assert.equal(canAcquire(lock(), "laptop-2", NOW), false, "the laptop must wait");
  assert.equal(canAcquire(lock(), "server-1", NOW), true, "the holder may carry on");
});

test("no lock at all, or an empty one, is free", () => {
  assert.equal(isStale(null, NOW), true);
  assert.equal(isStale({}, NOW), true);
  assert.equal(canAcquire(null, "laptop-2", NOW), true);
  assert.equal(canAcquire({ deviceId: "" }, "laptop-2", NOW), true);
});

test("a holder that stopped beating hands the lock on", () => {
  // The laptop was closed mid-sync. Nothing can release the lock on its behalf,
  // so silence has to be what expires it.
  assert.equal(isStale(lock({ heartbeatAt: ago(STALE_AFTER_MS + 1000) }), NOW), true);
  assert.equal(canAcquire(lock({ heartbeatAt: ago(STALE_AFTER_MS + 1000) }), "laptop-2", NOW), true);
  // ...but not one beat late.
  assert.equal(isStale(lock({ heartbeatAt: ago(HEARTBEAT_MS * 2) }), NOW), false);
});

test("the expiry is comfortably longer than the heartbeat", () => {
  // Otherwise one missed beat on a slow network hands the lock to another
  // machine while the first is still driving a browser.
  assert.ok(STALE_AFTER_MS >= HEARTBEAT_MS * 3, `${STALE_AFTER_MS}ms vs ${HEARTBEAT_MS}ms`);
});

test("a lock with no timestamps at all is treated as dead", () => {
  // A half-written document must not be able to block a practice for ever.
  assert.equal(isStale({ deviceId: "ghost" }, NOW), true);
  assert.equal(isStale({ deviceId: "ghost", heartbeatAt: "not-a-date" }, NOW), true);
  assert.equal(isStale({ deviceId: "ghost", heartbeatAt: {} }, NOW), true);
});

test("a heartbeat from the future is respected rather than stolen from", () => {
  /* That is a clock disagreement between two machines, not a liveness signal.
     Of the two possible mistakes, waiting is the safe one. */
  assert.equal(isStale(lock({ heartbeatAt: new Date(NOW + 60 * 60 * 1000).toISOString() }), NOW), false);
});

test("only the start time is missing → the heartbeat still decides", () => {
  assert.equal(isStale({ deviceId: "server-1", heartbeatAt: ago(5000) }, NOW), false);
  assert.equal(isStale({ deviceId: "server-1", startedAt: ago(5000) }, NOW), false, "a fresh start counts as a beat");
});

test("timestamps are read in every shape Firestore might return them", () => {
  assert.equal(toMillis(NOW), NOW);
  assert.equal(toMillis(new Date(NOW).toISOString()), NOW);
  assert.equal(toMillis({ toMillis: () => NOW }), NOW, "a Firestore Timestamp");
  assert.equal(toMillis({ seconds: Math.floor(NOW / 1000) }), Math.floor(NOW / 1000) * 1000, "a plain {seconds}");
  assert.equal(toMillis(undefined), 0);
  assert.equal(toMillis("rubbish"), 0);
  assert.equal(toMillis({ toMillis: () => { throw new Error("boom"); } }), 0, "a broken Timestamp must not throw");
});

test("the message names the machine and how long it has been going", () => {
  // "A sync is already running" with no idea where helps nobody.
  assert.match(holderText(lock({ startedAt: ago(4 * 60000) }), NOW), /office-server \(Windows PC\), 4 min ago/);
  assert.match(holderText(lock({ startedAt: ago(5000) }), NOW), /just started/);
  assert.match(holderText(lock({ deviceLabel: "" }), NOW), /another computer/);
  assert.equal(holderText(null, NOW), "");
});
