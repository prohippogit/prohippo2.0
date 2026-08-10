#!/usr/bin/env node
/*
 * Build the "Known callers" CSV that Sarvam uploads against the inbound
 * deployment — the thing that lets the help line know who is ringing it.
 *
 * WHY THIS EXISTS
 *
 * Sarvam passes a tool only the body fields declared on that tool. It does not
 * pass the caller's number, under any field name — that is not a guess, it is
 * what the webhook logged on a live call:
 *
 *   voice: unidentified caller on upcoming_hearings — from=(none)
 *   phoneish=[none] keys=[days, assessee, session_token]
 *
 * So an inbound call cannot be identified from the request itself. What Sarvam
 * does offer is a known-callers list: upload a CSV of numbers, and when one of
 * them rings, the agent starts the call already holding the values from that
 * row. Bind those to a tool's body field — which `session_token` already is —
 * and identity reaches the webhook by the same path the "Call me" button uses.
 *
 * WHY A TOKEN AND NOT THE PHONE NUMBER
 *
 * The obvious CSV column would be the caller's own number, and it would work.
 * But a body field is one console edit away from being model-filled instead of
 * variable-bound, and the moment it is, anyone can *say* a number and be
 * believed. A signed token cannot be reached that way: a caller who reads
 * sixteen digits down the phone still cannot produce an HMAC. The security of
 * this path should not rest on a dropdown staying where we left it.
 *
 * These tokens are long-lived by necessity — nobody re-uploads a CSV every
 * fifteen minutes — so the file is a bearer credential. It is written to the
 * working directory, gitignored, and should be deleted once uploaded.
 *
 * Usage:
 *   export SARVAM_WEBHOOK_SECRET="$(firebase functions:secrets:access SARVAM_WEBHOOK_SECRET --project prohippo2)"
 *   node scripts/known-callers-csv.mjs                    # every user with a verified mobile
 *   node scripts/known-callers-csv.mjs +919879166912      # just these numbers
 *   node scripts/known-callers-csv.mjs --days=365         # a longer life (default 180)
 *   node scripts/known-callers-csv.mjs --out=known-callers.csv
 *
 * Credentials — Application Default Credentials, same as grant-admin.mjs:
 *   • Google Cloud Shell, or anywhere you have run
 *       gcloud auth application-default login
 *   • or GOOGLE_APPLICATION_CREDENTIALS pointing at a service account key.
 *
 * Requires firebase-admin: `npm --prefix functions install` if you haven't.
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import process from "node:process";

const require = createRequire(new URL("../functions/", import.meta.url));

let admin;
try {
  admin = require("firebase-admin");
} catch {
  console.error("firebase-admin not found. Run `npm --prefix functions install` first.");
  process.exit(1);
}

const { mintSessionToken, normalisePhone } = require("../functions/voiceAgentCore.js");

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const numbersAsked = args.filter((a) => !a.startsWith("--"));

const days = Number(flag("days") || 180);
const outPath = flag("out") || "known-callers.csv";
const projectId =
  flag("project") ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCLOUD_PROJECT ||
  process.env.FIREBASE_PROJECT ||
  "prohippo2";

/* Trimmed, always. A secret set with `openssl rand -base64 32 | firebase
   functions:secrets:set` carries a trailing newline that $( ) strips on the way
   out — so the two sides disagree by one invisible byte, and every token fails
   to verify. That cost us a day once. */
const secret = String(process.env.SARVAM_WEBHOOK_SECRET || "").trim();
if (!secret) {
  console.error(
    "SARVAM_WEBHOOK_SECRET is not set. Run:\n\n" +
    '  export SARVAM_WEBHOOK_SECRET="$(firebase functions:secrets:access SARVAM_WEBHOOK_SECRET --project prohippo2)"\n'
  );
  process.exit(1);
}
if (!Number.isFinite(days) || days < 1 || days > 730) {
  console.error(`--days must be between 1 and 730; got ${flag("days")}`);
  process.exit(1);
}

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
const db = admin.firestore();

/* Sarvam's own sample writes a bare ten-digit number, so match it for Indian
   mobiles and fall back to E.164 elsewhere. Getting this wrong is silent: the
   row simply never matches an incoming call. */
const csvNumber = (e164) => {
  const digits = String(e164 || "").replace(/[^\d]/g, "");
  return digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
};

const csvCell = (value) => {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function collectUsers() {
  const wanted = new Set(
    numbersAsked.map((n) => normalisePhone(n)).filter(Boolean)
  );
  if (numbersAsked.length && !wanted.size) {
    console.error(`None of those look like phone numbers: ${numbersAsked.join(", ")}`);
    process.exit(1);
  }

  const found = [];
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const u of page.users) {
      if (!u.phoneNumber) continue;
      if (wanted.size && !wanted.has(u.phoneNumber)) continue;
      found.push(u);
    }
    pageToken = page.pageToken;
  } while (pageToken);

  // Say which asked-for numbers matched nothing, rather than quietly shipping a
  // shorter file than the caller expected.
  for (const n of wanted) {
    if (!found.some((u) => u.phoneNumber === n)) {
      console.error(`  ! no account has ${n} as a verified mobile — skipped`);
    }
  }
  return found;
}

async function main() {
  console.error(`Project: ${projectId}`);
  const users = await collectUsers();
  if (!users.length) {
    console.error("No users with a verified mobile number. Nothing to write.");
    process.exit(1);
  }

  const ttlMs = days * 24 * 60 * 60 * 1000;
  const expires = new Date(Date.now() + ttlMs).toISOString().slice(0, 10);

  const rows = [];
  for (const u of users) {
    let profile = {};
    try {
      const snap = await db.doc(`users/${u.uid}`).get();
      profile = snap.exists ? snap.data() || {} : {};
    } catch (e) {
      console.error(`  ! could not read users/${u.uid}: ${e.message || e}`);
    }
    rows.push([
      csvNumber(u.phoneNumber),
      csvCell(profile.ownerName || u.displayName || ""),
      csvCell(profile.firmName || ""),
      "yes",
      mintSessionToken({ uid: u.uid, secret, ttlMs }),
    ].join(","));
  }

  const csv = ["phone_number,caller_name,caller_firm,caller_known,session_token", ...rows].join("\n") + "\n";
  writeFileSync(outPath, csv);

  console.error(`\nWrote ${rows.length} caller${rows.length === 1 ? "" : "s"} to ${outPath}`);
  console.error(`Tokens valid until ${expires}. Re-run and re-upload before then.`);
  console.error(
    "\nThis file grants read access to those accounts over the phone line.\n" +
    "Upload it to Sarvam (Deploy → Inbound calls → the deployment → Add known callers),\n" +
    "then delete it.\n"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
