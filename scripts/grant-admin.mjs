#!/usr/bin/env node
/*
 * Grant (or revoke) ProHippo admin console access.
 *
 * This exists as a script, run from a machine you control against a service
 * account key, rather than as a callable — because the FIRST admin has to come
 * from outside the system. An HTTP endpoint that can make its caller an admin
 * is a privilege-escalation hole no amount of validation redeems. Once you have
 * one admin, grant the rest from the console itself (Customers → Make admin).
 *
 * Usage:
 *   node scripts/grant-admin.mjs you@example.com
 *   node scripts/grant-admin.mjs you@example.com --revoke
 *   node scripts/grant-admin.mjs --list
 *   node scripts/grant-admin.mjs you@example.com --project=other-project
 *
 * Credentials — it uses Application Default Credentials, so either works:
 *   • Google Cloud Shell, or anywhere you have run
 *       gcloud auth application-default login
 *     Nothing to download; this is the safer option.
 *   • A service account key, if ADC isn't available:
 *       export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
 *     (Firebase console → Project settings → Service accounts → Generate new
 *     private key. Save it OUTSIDE the repo — it is a root credential.)
 *
 * Requires firebase-admin, which the functions directory already has, so run
 * `npm --prefix functions install` first if you haven't.
 */
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(new URL("../functions/", import.meta.url));

let admin;
try {
  admin = require("firebase-admin");
} catch {
  console.error("firebase-admin not found. Run `npm --prefix functions install` first.");
  process.exit(1);
}

const args = process.argv.slice(2);
const revoke = args.includes("--revoke");
const list = args.includes("--list");
const projectArg = args.find((a) => a.startsWith("--project="))?.split("=")[1];
const email = args.find((a) => !a.startsWith("--"));

// The Admin SDK can usually infer the project, but not from user-type ADC —
// so be explicit, and fail loudly rather than writing to the wrong project.
const projectId =
  projectArg ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCLOUD_PROJECT ||
  process.env.FIREBASE_PROJECT ||
  "prohippo2";

try {
  admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId });
} catch (e) {
  console.error(
    `Could not authenticate against ${projectId}: ${e.message || e}\n\n` +
    "Either run\n  gcloud auth application-default login\n" +
    "or point GOOGLE_APPLICATION_CREDENTIALS at a service account key.\n"
  );
  process.exit(1);
}
const auth = admin.auth();
console.log(`Project: ${projectId}`);

async function listAdmins() {
  const admins = [];
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const u of page.users) {
      if (u.customClaims?.admin === true) admins.push(u);
    }
    pageToken = page.pageToken;
  } while (pageToken);

  if (!admins.length) {
    console.log("No admins yet. Grant the first one:\n  node scripts/grant-admin.mjs you@example.com");
    return;
  }
  console.log(`${admins.length} admin${admins.length === 1 ? "" : "s"}:`);
  for (const u of admins) console.log(`  ${u.email || u.phoneNumber || "(no contact)"}  ${u.uid}`);
}

async function setAdmin(target, value) {
  const user = target.includes("@")
    ? await auth.getUserByEmail(target)
    : await auth.getUser(target);

  const claims = { ...(user.customClaims || {}) };
  if (value) claims.admin = true;
  else delete claims.admin;

  await auth.setCustomUserClaims(user.uid, claims);
  // A token already in the browser keeps its old claims for up to an hour.
  // Revoking forces a refresh, so removing access takes effect immediately —
  // and granting it means the user doesn't have to wait to sign back in.
  await auth.revokeRefreshTokens(user.uid);

  await admin.firestore().doc(`accounts/${user.uid}`).set({ isAdmin: value }, { merge: true }).catch(() => {});

  console.log(
    `${value ? "Granted" : "Revoked"} admin for ${user.email || user.uid}.\n` +
    `They must sign out and back in, then open ${value ? "/admin" : "the app"}.`
  );
}

try {
  if (list) await listAdmins();
  else if (!email) {
    console.error("Usage: node scripts/grant-admin.mjs <email|uid> [--revoke]\n       node scripts/grant-admin.mjs --list");
    process.exit(1);
  } else await setAdmin(email, !revoke);
  process.exit(0);
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
