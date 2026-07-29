#!/usr/bin/env node
/*
 * Backfill `accounts/{uid}` for practices that already existed before the admin
 * console shipped.
 *
 * The mirror trigger in functions/admin.js only fires when `users/{uid}` is
 * written. Every profile created before the trigger was deployed has therefore
 * never produced an account row, so the console opens onto an empty table until
 * each of those users happens to open the app. This walks the existing profiles
 * and creates the rows directly.
 *
 * It also counts each practice's collections, which the nightly rollup would
 * otherwise not do until 02:30 IST — so the console has real numbers the moment
 * this finishes rather than tomorrow morning.
 *
 * Safe to re-run. It merges, and it will not overwrite a `plan`, `status`,
 * `trialEndsAt` or `referral` that has already been set — a re-run must never
 * knock a paying customer back onto a trial.
 *
 * Usage:
 *   node scripts/backfill-accounts.mjs --dry-run     # show what it would do
 *   node scripts/backfill-accounts.mjs
 *
 * Credentials: Application Default Credentials, same as grant-admin.mjs. In
 * Google Cloud Shell there is nothing to set up.
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
const dryRun = args.includes("--dry-run");
const projectId =
  args.find((a) => a.startsWith("--project="))?.split("=")[1] ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCLOUD_PROJECT ||
  "prohippo2";

// Kept in step with functions/admin.js — same list, same trial length.
const COUNTED = ["assessees", "matters", "hearings", "notices", "communications", "invoices"];
const TRIAL_DAYS = 14;

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
const nowISO = () => new Date().toISOString();

async function main() {
  console.log(`Project: ${projectId}${dryRun ? "  (dry run — nothing will be written)" : ""}\n`);

  // listDocuments() returns refs for every document id under users/, including
  // any that exist only as a parent for subcollections. get() sorts those out.
  const refs = await db.collection("users").listDocuments();
  if (!refs.length) {
    console.log("No user profiles found. Nothing to backfill.");
    return;
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const ref of refs) {
    const uid = ref.id;
    const snap = await ref.get();
    if (!snap.exists) {
      console.log(`  skip ${uid} — no profile document`);
      skipped++;
      continue;
    }
    const p = snap.data();

    const accountRef = db.doc(`accounts/${uid}`);
    const existing = await accountRef.get();
    const createdAt = p.createdAt || existing.data()?.createdAt || nowISO();

    const counters = {};
    for (const name of COUNTED) {
      counters[name] = (await db.collection(`users/${uid}/${name}`).count().get()).data().count;
    }

    const patch = {
      uid,
      ownerName: p.ownerName || "",
      firmName: p.firmName || "",
      email: p.email || "",
      phone: p.phone || "",
      phoneVerified: !!p.phoneVerified,
      createdAt,
      lastSeenAt: p.lastSeenAt || existing.data()?.lastSeenAt || null,
      counters,
      countersAt: nowISO(),
      backfilledAt: nowISO(),
    };

    // Billing state is only ever seeded, never rewritten. A second run must not
    // reset someone who has since been put on a plan.
    if (!existing.exists) {
      patch.plan = null;
      patch.status = "trial";
      patch.trialEndsAt = new Date(Date.parse(createdAt) + TRIAL_DAYS * 86400000).toISOString();
      patch.seats = 1;
      patch.signupSource = p.signupSource || "backfill";
      patch.flags = {};
    }

    const label = p.firmName || p.ownerName || p.email || uid;
    const totals = COUNTED.map((c) => `${c[0]}${counters[c]}`).join(" ");
    console.log(`  ${existing.exists ? "update" : "create"} ${label.padEnd(32)} ${totals}`);

    if (!dryRun) await accountRef.set(patch, { merge: true });
    existing.exists ? updated++ : created++;
  }

  console.log(
    `\n${created} created, ${updated} updated, ${skipped} skipped` +
    (dryRun ? "  (dry run — nothing was written)" : "")
  );
  if (!dryRun) console.log("Refresh /admin — the Customers table should now be populated.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
