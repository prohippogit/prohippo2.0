// Portal credential access.
//
// Credentials are stored server-side, encrypted at rest (AES-256-GCM) by the
// Cloud Functions. The connector fetches the plaintext PAN password ONLY into a
// short-lived in-memory variable, uses it to log the Playwright context in, and
// drops the reference. It is NEVER written to disk, never logged, and never
// persisted in the connector's own state.
"use strict";

const { callable } = require("./firebaseClient");

// Returns { portalUserId, portalPassword } for one assessee, held in memory
// only. Shape matches the getPortalCredential Cloud Function exactly. The caller
// MUST NOT log the result or write it anywhere durable.
async function getPortalCredential(assesseeId) {
  const cred = await callable("getPortalCredential", { assesseeId });
  if (!cred || !cred.portalPassword) {
    throw new Error("No stored portal credential for this assessee.");
  }
  return cred;
}

// Convenience: run `fn(cred)` and best-effort scrub the plaintext afterwards.
// (JS can't truly zero a string, but we drop every reference we hold and never
// copy it into logs or state.)
async function withCredential(assesseeId, fn) {
  let cred = await getPortalCredential(assesseeId);
  try {
    return await fn(cred);
  } finally {
    // Deliberately dead-looking: dropping our reference is the whole point, so
    // the linter's "this assignment is never read" is exactly what we want here.
    // eslint-disable-next-line no-useless-assignment
    cred = null;
  }
}

module.exports = { getPortalCredential, withCredential };
