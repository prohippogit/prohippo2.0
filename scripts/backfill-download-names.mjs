#!/usr/bin/env node
/*
 * Give every document already in Storage the filename a human would give it.
 *
 * THE PROBLEM. Objects are stored under machine paths — a notice is
 * `users/{uid}/assessees/{id}/notices/din_9c4a1f2e08b3d5a71c60.pdf`. The app's
 * own buttons never show that: they fetch the file and name it themselves
 * (src/downloadNames.js). But a browser told only `Content-Disposition:
 * attachment` derives the name from the URL, and produces
 * `users_ZsteBdLsEacc_..._returns_2025_acknowledgement.pdf`.
 *
 * So this writes the real name into the object's own metadata:
 *
 *     Content-Disposition: attachment; filename="Sample Foods - AY 2025-26 - ITR-V Acknowledgement.pdf"
 *
 * After this, the file downloads under a sensible name no matter what fetches
 * it — the app, a pasted URL, or an older cached build of the app.
 *
 * It reads the SAME naming module the app uses, so a document cannot end up with
 * one name here and a different one in the app.
 *
 * Safe to re-run: it only ever rewrites Content-Disposition, and skips objects
 * that already carry the name it would set.
 *
 * Usage:
 *   node scripts/backfill-download-names.mjs --dry-run    # list what it would do
 *   node scripts/backfill-download-names.mjs
 *   node scripts/backfill-download-names.mjs --uid=<uid>  # one practice only
 *
 * Credentials: Application Default Credentials, same as the other scripts. In
 * Google Cloud Shell there is nothing to set up.
 */
import { createRequire } from "node:module";
import process from "node:process";

import { noticeFilename, returnOrderFilename, returnDocFilename } from "../src/downloadNames.js";

const require = createRequire(new URL("../functions/", import.meta.url));

let admin;
try {
  admin = require("firebase-admin");
} catch {
  console.error("firebase-admin not found. Run `npm --prefix functions install` first.");
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const onlyUid = args.find((a) => a.startsWith("--uid="))?.split("=")[1] || "";
const projectId =
  args.find((a) => a.startsWith("--project="))?.split("=")[1] ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCLOUD_PROJECT ||
  "prohippo2";
const bucketName =
  args.find((a) => a.startsWith("--bucket="))?.split("=")[1] || "prohippo2.firebasestorage.app";

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

const db = admin.firestore();
const bucket = admin.storage().bucket(bucketName);

/* RFC 6266: a quoted filename cannot contain a bare double quote or backslash.
   Everything else our names contain — spaces, brackets, hyphens — is fine
   inside quotes. Non-ASCII would need filename*, but the names are ASCII by
   construction (safeFilename strips the rest). */
const disposition = (filename) =>
  `attachment; filename="${String(filename).replace(/["\\]/g, "")}"`;

const stats = { checked: 0, set: 0, alreadyRight: 0, missing: 0, failed: 0 };

async function setName(storagePath, filename) {
  if (!storagePath || !filename) return;
  stats.checked++;
  const file = bucket.file(storagePath);
  const want = disposition(filename);
  try {
    const [meta] = await file.getMetadata();
    if (meta.contentDisposition === want) { stats.alreadyRight++; return; }
    if (dryRun) {
      console.log(`  would set  ${filename}`);
      stats.set++;
      return;
    }
    await file.setMetadata({ contentDisposition: want });
    console.log(`  set        ${filename}`);
    stats.set++;
  } catch (e) {
    // A Firestore document can outlive its object — a sync that failed midway,
    // or a file deleted by hand. That is not a reason to stop.
    if (e.code === 404) { stats.missing++; return; }
    console.warn(`  FAILED     ${storagePath}: ${e.message || e}`);
    stats.failed++;
  }
}

async function backfillUser(uid) {
  console.log(`\nuser ${uid}`);

  // Assessee names, so a document can be named after its client. One read of the
  // collection beats one read per document.
  const assessees = new Map();
  const aSnap = await db.collection(`users/${uid}/assessees`).get();
  aSnap.forEach((d) => assessees.set(d.id, d.data() || {}));
  const nameForPan = new Map();
  for (const a of assessees.values()) if (a.pan) nameForPan.set(String(a.pan).toUpperCase(), a.name || "");

  // Notices and orders from e-Proceedings.
  const nSnap = await db.collection(`users/${uid}/notices`).get();
  for (const d of nSnap.docs) {
    const n = d.data() || {};
    const who = n.assessee || nameForPan.get(String(n.pan || "").toUpperCase()) || "";
    await setName(n.storagePath, noticeFilename(n, who));
    // Attachments a taxpayer filed in reply keep the portal's own filename —
    // it is already a human name ("Grounds of Appeal.pdf") and better than
    // anything we would synthesise.
    for (const r of n.responses || []) {
      for (const at of r.attachments || []) await setName(at.storagePath, at.filename);
    }
  }

  // Filed returns, their documents, and the CPC orders against them.
  const rSnap = await db.collection(`users/${uid}/returns`).get();
  for (const d of rSnap.docs) {
    const r = d.data() || {};
    const who = r.assessee || nameForPan.get(String(r.pan || "").toUpperCase()) || "";
    await setName(r.jsonPath, returnDocFilename("json", r, who));
    await setName(r.ackPdfPath, returnDocFilename("ack", r, who));
    await setName(r.formPdfPath, returnDocFilename("form", r, who));
    await setName(r.computationPdfPath, returnDocFilename("computation", r, who));
    for (const o of r.orders || []) await setName(o.storagePath, returnOrderFilename(o, r.ay, who));
  }
}

const uids = onlyUid
  ? [onlyUid]
  : (await db.collection("users").listDocuments()).map((d) => d.id);

console.log(`${dryRun ? "DRY RUN — " : ""}naming documents for ${uids.length} practice(s) in ${bucketName}`);
for (const uid of uids) {
  try {
    await backfillUser(uid);
  } catch (e) {
    console.warn(`user ${uid}: ${e.message || e}`);
  }
}

console.log(
  `\nchecked ${stats.checked} · ${dryRun ? "would set" : "set"} ${stats.set} · ` +
  `already correct ${stats.alreadyRight} · object missing ${stats.missing} · failed ${stats.failed}`
);
process.exit(stats.failed ? 1 : 0);
