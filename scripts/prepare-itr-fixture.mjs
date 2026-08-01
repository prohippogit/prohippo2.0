#!/usr/bin/env node
/*
 * Turn a real synced return into an anonymised test fixture, and describe its
 * schema so a mapper can be planned from what the return actually contains.
 *
 * WHY THIS EXISTS. Two rules pull in opposite directions:
 *
 *   - CLAUDE.md rule 5: real client data never enters the repo.
 *   - CLAUDE.md, "how to work on this": read the fixture properly — dump the
 *     schedule keys and actual values first. Do NOT write the mapper from an
 *     assumed schema.
 *
 * Doing both by hand is tedious and, worse, error-prone in the direction that
 * matters: the first hand-written anonymisation for the ITR-5 house-property
 * fixture replaced seven of a firm's twenty-two partners by name and would have
 * left the other fifteen in a public repository. This anonymises by FIELD, which
 * cannot miss one, and verifies its own work before writing anything.
 *
 * Usage:
 *   node scripts/prepare-itr-fixture.mjs --list
 *   node scripts/prepare-itr-fixture.mjs --form=ITR3 --ay=2025-26
 *   node scripts/prepare-itr-fixture.mjs --form=ITR2 --ay=2025-26 --out=test/fixtures/itr2-salary-ay2025-26.json
 *   node scripts/prepare-itr-fixture.mjs --form=ITR3 --ay=2025-26 --summary-only
 *
 * Credentials: Application Default Credentials, same as the other scripts. In
 * Google Cloud Shell there is nothing to set up.
 */
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { anonymise, auditResidual, describe } from "./lib/itrFixture.mjs";
import path from "node:path";
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
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") || "";
const has = (name) => args.includes(`--${name}`);

const projectId = flag("project") || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || "prohippo2";
const bucketName = flag("bucket") || "prohippo2.firebasestorage.app";
const wantForm = flag("form").toUpperCase().replace("-", "");
const wantAy = flag("ay");
const onlyUid = flag("uid");

try {
  admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId });
} catch (e) {
  console.error(`Could not authenticate against ${projectId}: ${e.message || e}\n\nRun\n  gcloud auth application-default login\n`);
  process.exit(1);
}

const db = admin.firestore();
const bucket = admin.storage().bucket(bucketName);

/* ---------------- main ---------------- */

const uids = onlyUid ? [onlyUid] : (await db.collection("users").listDocuments()).map((d) => d.id);

const found = [];
for (const uid of uids) {
  const snap = await db.collection(`users/${uid}/returns`).get();
  snap.forEach((d) => {
    const r = d.data() || {};
    found.push({ uid, id: d.id, form: r.form || "", ay: r.ay || "", jsonPath: r.jsonPath || "", assessee: r.assessee || "" });
  });
}

if (has("list") || (!wantForm && !wantAy)) {
  console.log(`${found.length} return(s) on file\n`);
  const byForm = new Map();
  for (const f of found) {
    const key = `${f.form || "?"} · ${f.ay || "?"}`;
    byForm.set(key, (byForm.get(key) || 0) + (f.jsonPath ? 1 : 0));
  }
  for (const [key, n] of [...byForm].sort()) console.log(`  ${key.padEnd(20)} ${n} with JSON`);
  console.log(`\nPick one with e.g.  --form=ITR3 --ay=2025-26`);
  process.exit(0);
}

const candidates = found.filter((f) =>
  f.jsonPath &&
  (!wantForm || f.form.toUpperCase().replace("-", "") === wantForm) &&
  (!wantAy || f.ay === wantAy)
);
if (!candidates.length) {
  console.error(`No synced return matches form=${wantForm || "any"} ay=${wantAy || "any"}. Try --list.`);
  process.exit(1);
}

// Prefer the return with the most going on: a fixture that exercises one head
// teaches the mapper less than one that exercises five.
let best = null;
for (const c of candidates) {
  const [buf] = await bucket.file(c.jsonPath).download();
  const json = JSON.parse(buf.toString("utf8"));
  const size = JSON.stringify(json).length;
  if (!best || size > best.size) best = { ...c, json, size };
}

console.log(`chosen: ${best.form} · A.Y. ${best.ay} · ${best.jsonPath}  (${Math.round(best.size / 1024)} KB)\n`);

const formKey = Object.keys(best.json.ITR || {})[0];
const body = (best.json.ITR || {})[formKey] || {};
console.log(describe(body));

if (has("summary-only")) process.exit(0);

const { clean, counts, values } = anonymise(best.json);
const residual = auditResidual(values);

const out = flag("out") || `test/fixtures/${(best.form || formKey).toLowerCase().replace("-", "")}-ay${(best.ay || "").replace("-", "")}.json`;
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(clean, null, 1) + "\n");

console.log(`\nwrote ${out}`);
console.log(`anonymised: ${counts.ids} PAN/TAN · ${counts.people} names · ${counts.places} places`);
if (residual.length) {
  console.log(`\n⚠  ${residual.length} value(s) still look like names. Check each, and add its field to`);
  console.log(`   PERSON_KEYS / PLACE_KEYS in this script before using the fixture:\n`);
  residual.slice(0, 20).forEach((v) => console.log(`     ${v}`));
  process.exit(2);
}
console.log("no residual name-shaped values — safe to commit");
