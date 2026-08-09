#!/usr/bin/env node
/*
 * Show what the voice line sees when it looks at an account.
 *
 * The phone line can only say three things about a hearing: here it is, I have
 * none, or I can't verify you. When it says "I have none" and the app plainly
 * shows two, there is no way to tell from the outside which step lost them —
 * the identity, the read, the date window, or the status filter. The webhook
 * cannot log the answer either, because logging the practitioner's client data
 * to Cloud Logging is exactly what this feature is not allowed to do.
 *
 * So: run the same steps here, in the practitioner's own shell, and print where
 * the rows go. One run names the culprit.
 *
 * Usage:
 *   node scripts/voice-doctor.mjs +919879166912
 *   node scripts/voice-doctor.mjs +919879166912 --days=30 --show=8
 *
 * Credentials — Application Default Credentials, same as grant-admin.mjs.
 * Requires firebase-admin: `npm --prefix functions install` if you haven't.
 *
 * NOTE: the predicates below are copied from functions/voiceAgent.js rather
 * than imported, because those live inside build() with a live db handle. If
 * you change the filters there, change them here — a doctor that disagrees with
 * the patient is worse than no doctor.
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

const { normalisePhone, maskPan, istToday, addDays, matchAssessee } = require("../functions/voiceAgentCore.js");

const args = process.argv.slice(2);
const flag = (n) => args.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");
const asked = args.find((a) => !a.startsWith("--"));
const days = Number(flag("days") || 30);
const show = Number(flag("show") || 6);
const projectId =
  flag("project") || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || "prohippo2";

if (!asked) {
  console.error("Usage: node scripts/voice-doctor.mjs +919879166912");
  process.exit(1);
}
const phone = normalisePhone(asked);
if (!phone) {
  console.error(`"${asked}" doesn't look like a phone number.`);
  process.exit(1);
}

try {
  admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId });
} catch (e) {
  console.error(`Could not authenticate against ${projectId}: ${e.message || e}\n\n` +
    "Run\n  gcloud auth application-default login\n");
  process.exit(1);
}
const auth = admin.auth();
const db = admin.firestore();

/* --- copied from functions/voiceAgent.js --- */
const READ_CAP = 800;
const DEAD_STATUSES = ["disposed", "cancelled", "adjourned sine die", "closed", "decided"];
const isLive = (row) => !DEAD_STATUSES.includes(String(row.status || "").toLowerCase());
const readOwn = async (uid, name, cap = READ_CAP) => {
  const snap = await db.collection("users").doc(uid).collection(name).limit(cap).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
};
/* --- end copy --- */

const line = (s = "") => console.log(s);
const rule = (t) => { line(); line(`── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`); };

async function main() {
  line(`Project: ${projectId}`);

  rule("IDENTITY");
  let user;
  try {
    user = await auth.getUserByPhoneNumber(phone);
  } catch (e) {
    line(`  ✗ no account has ${phone} as a verified mobile (${e.code || e.message})`);
    line("    The known-callers CSV maps this number to a uid; if the number is");
    line("    not on an account, nothing downstream can work.");
    process.exit(1);
  }
  line(`  ✓ ${phone} → uid ${user.uid}`);
  line(`    email        ${user.email || "(none)"}`);
  line(`    displayName  ${user.displayName || "(none)"}`);

  const profileSnap = await db.doc(`users/${user.uid}`).get();
  if (!profileSnap.exists) {
    line(`  ! users/${user.uid} does not exist — this account has no ProHippo document.`);
  } else {
    const p = profileSnap.data() || {};
    line(`    ownerName    ${p.ownerName || "(none)"}`);
    line(`    firmName     ${p.firmName || "(none)"}`);
  }

  rule("WHAT IS UNDER THIS uid");
  const counts = {};
  for (const name of ["assessees", "matters", "hearings", "notices", "invoices", "todos"]) {
    counts[name] = (await readOwn(user.uid, name)).length;
    line(`  ${name.padEnd(12)} ${counts[name]}${counts[name] >= READ_CAP ? "  ← at the read cap, see below" : ""}`);
  }
  if (!counts.hearings && !counts.assessees) {
    line();
    line("  ✗ This uid owns no ProHippo data at all.");
    line("    The account you sign into the app with is not the account this");
    line("    phone number belongs to. Check Settings → the linked mobile.");
  }

  rule(`upcoming_hearings  (days=${days})`);
  const today = istToday();
  const until = addDays(today, days);
  const all = await readOwn(user.uid, "hearings");
  line(`  today (IST) ${today}   window ends ${until}`);
  line(`  ${all.length} hearing document${all.length === 1 ? "" : "s"} under users/${user.uid}/hearings`);

  const withDate = all.filter((h) => h.date);
  const notPast = withDate.filter((h) => h.date >= today);
  const inWindow = notPast.filter((h) => h.date <= until);
  const live = inWindow.filter(isLive);

  line();
  line(`  has a date field .......... ${withDate.length}/${all.length}`);
  line(`  date >= today ............. ${notPast.length}`);
  line(`  date <= ${until} ......... ${inWindow.length}`);
  line(`  status not dead ........... ${live.length}   ← what the caller hears`);

  const lost = (label, before, after) => {
    const dropped = before.filter((h) => !after.includes(h));
    if (!dropped.length) return;
    line();
    line(`  DROPPED BY "${label}" (${dropped.length}):`);
    for (const h of dropped.slice(0, show)) {
      line(`    ${String(h.assessee || "(no assessee)").slice(0, 34).padEnd(36)} ` +
        `date=${JSON.stringify(h.date)} status=${JSON.stringify(h.status || "")}`);
    }
  };
  lost("has a date field", all, withDate);
  lost("date >= today", withDate, notPast);
  lost(`date <= ${until}`, notPast, inWindow);
  lost("status not dead", inWindow, live);

  if (live.length) {
    line();
    line("  WOULD BE READ OUT:");
    for (const h of live.slice(0, show)) {
      line(`    ${h.date}  ${h.time || "--:--"}  ${h.assessee || "(no assessee)"}  ` +
        `${h.authority || ""} ${maskPan(h.pan)}`);
    }
  }

  // The raw shape of one document, which is what settles a date-format argument.
  if (all.length) {
    rule("ONE RAW HEARING DOCUMENT (field types)");
    const h = all[0];
    for (const [k, v] of Object.entries(h)) {
      line(`  ${k.padEnd(14)} ${typeof v === "object" ? v?.constructor?.name || "object" : typeof v}  ${JSON.stringify(v)?.slice(0, 60)}`);
    }
  }

  rule("find_assessee");
  const book = await readOwn(user.uid, "assessees");
  line(`  ${book.length} client${book.length === 1 ? "" : "s"} on the register`);
  for (const a of book.slice(0, show)) line(`    ${String(a.name || "(unnamed)").padEnd(40)} ${maskPan(a.pan)}`);
  for (const q of ["Monika", "मोनिका", "મોનિકા"]) {
    const r = matchAssessee(book, q);
    line(`  "${q}" → ${r.assessee ? r.assessee.name : "(no match)"}${r.assessee && !r.confident ? "  (ambiguous — would ask)" : ""}`);
  }

  line();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
