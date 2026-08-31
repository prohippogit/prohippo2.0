/* What an unattended run fetches — and the two copies of the rule that says so.
 *
 *   node --test test/syncScope.test.mjs
 *
 * The rule is one sentence long and the whole app now leans on it: a sync
 * nobody is watching asks for e-Proceedings, and an assessee that has never
 * been synced is fetched in full once regardless. It is worth pinning because
 * both halves fail silently in opposite directions — the wrong default turns a
 * routine check back into the noisy run practitioners were re-running four and
 * five times, and a missed first sync leaves a client with no filed returns and
 * nothing on screen to say so.
 *
 * Two implementations, as with syncKnowns: the web app's is ESM, the
 * connector's is CommonJS loaded by Electron's main process, and neither can
 * import the other. So every case below runs through both and they must agree.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import * as web from "../src/syncScope.js";

const require = createRequire(import.meta.url);
const connector = require("../connector/src/main/syncScope.js");

// Run a case through both copies, assert they agree, and hand back the answer.
function scope(requested, lastSyncedAt) {
  const a = web.scopeForAssessee(requested, lastSyncedAt);
  const b = connector.scopeForAssessee(requested, lastSyncedAt);
  assert.equal(a, b, `web and connector disagree for (${JSON.stringify(requested)}, ${JSON.stringify(lastSyncedAt)})`);
  return a;
}

test("the two copies expose the same scopes and the same default", () => {
  assert.deepEqual(web.SCOPES, connector.SCOPES);
  assert.equal(web.DEFAULT_SCOPE, connector.DEFAULT_SCOPE);
  // Not merely "some default": the point of the change is which one.
  assert.equal(web.DEFAULT_SCOPE, "eproc");
});

test("a routine run fetches e-Proceedings only", () => {
  assert.equal(scope("eproc", "2026-08-30T04:00:00.000Z"), "eproc");
});

test("a run that names no scope gets the fast one, never the thorough one", () => {
  // The direction that matters: a caller who forgets the field must not tip the
  // whole practice back into rendering Form 35s on every scheduled run.
  assert.equal(scope(undefined, "2026-08-30T04:00:00.000Z"), "eproc");
  assert.equal(scope(null, "2026-08-30T04:00:00.000Z"), "eproc");
  assert.equal(scope("", "2026-08-30T04:00:00.000Z"), "eproc");
  assert.equal(scope("nonsense", "2026-08-30T04:00:00.000Z"), "eproc");
});

test("an assessee that has never been synced is fetched in full, once", () => {
  for (const never of [undefined, null, "", "   "]) {
    assert.equal(scope("eproc", never), "all", `expected a full first sync for ${JSON.stringify(never)}`);
    assert.equal(scope(undefined, never), "all");
  }
  // ...and only once: the very next run is back to the fast scope.
  assert.equal(scope("eproc", "2026-08-31T06:30:00.000Z"), "eproc");
});

test("a Firestore Timestamp counts as synced, not as a first sync", () => {
  // The web app may hold the value as an object rather than an ISO string. If
  // that were read as "never synced", every scheduled run would be a full one.
  const stamp = { seconds: 1756600000, nanoseconds: 0 };
  assert.equal(scope("eproc", stamp), "eproc");
});

test("an explicit choice is honoured exactly, on any assessee", () => {
  for (const chosen of ["all", "appeals", "returns", "returnForm"]) {
    assert.equal(scope(chosen, "2026-08-30T04:00:00.000Z"), chosen);
    // Including on a never-synced one: somebody who asked for Form 35 only
    // asked for Form 35 only, and must not be handed a full portal sweep.
    assert.equal(scope(chosen, ""), chosen);
  }
});

test("isFirstSync agrees across both copies", () => {
  for (const v of [undefined, null, "", "  ", "2026-01-01T00:00:00.000Z", { seconds: 1 }, 0, 1756600000]) {
    assert.equal(
      web.isFirstSync(v), connector.isFirstSync(v),
      `web and connector disagree about ${JSON.stringify(v)}`
    );
  }
});
