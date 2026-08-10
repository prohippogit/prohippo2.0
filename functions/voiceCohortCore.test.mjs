/* Unit tests for the known-callers cohort sync — the decisions, not the HTTP.
 *
 * Two failures this guards against, both of which would be invisible until
 * someone rang the line and was told they had no account:
 *
 *   • a CSV Sarvam cannot map — wrong column names, a comma inside a firm
 *     name, a number in a format the country_code doesn't expect
 *   • a daily job that uploads a new cohort every night because the
 *     fingerprint moved when nothing about the roster did
 *
 * Run:  node functions/voiceCohortCore.test.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  COHORT_PREFIX,
  COHORT_TOKEN_DAYS,
  COHORT_REFRESH_DAYS,
  COHORT_TRANSFORMATION,
  cohortsUrl,
  csvNumber,
  rosterFingerprint,
  cohortPeriod,
  cohortName,
  buildCohortCsv,
} = require("./voiceCohortCore.js");
const { verifySessionToken } = require("./voiceAgentCore.js");

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}

const SECRET = "test-secret-value";
const ROSTER = [
  { uid: "uid-1", phone: "+919879166912", name: "Vivek Chavda", firm: "Chavda & Associates" },
  { uid: "uid-2", phone: "+919824816753", name: "Nishit Jesur", firm: "N.B.Mohanlal & Co." },
];

test("the CSV header matches the transformation Sarvam is sent", () => {
  /* The column names are not inferred from the header row — the mapping is
     explicit — so the two have to be written the same way or every row is
     rejected with nothing to see in the console but "0 valid records". */
  const csv = buildCohortCsv(ROSTER, { secret: SECRET, ttlMs: 1000 });
  const header = csv.split("\n")[0].split(",");
  assert.equal(COHORT_TRANSFORMATION.phone_number.column_name, "phone_number");
  assert.ok(header.includes("phone_number"));
  for (const [variable, spec] of Object.entries(COHORT_TRANSFORMATION.app_variables)) {
    assert.ok(header.includes(spec.column_name), `${variable} maps to a column that isn't in the CSV`);
  }
});

test("every row carries a token that verifies back to its own uid", () => {
  const csv = buildCohortCsv(ROSTER, { secret: SECRET, ttlMs: 60_000 });
  const lines = csv.trim().split("\n").slice(1);
  assert.equal(lines.length, ROSTER.length);
  lines.forEach((line, i) => {
    const token = line.split(",").pop();
    const claim = verifySessionToken({ token, secret: SECRET });
    assert.ok(claim.ok, `row ${i} token did not verify: ${claim.reason}`);
    assert.equal(claim.uid, ROSTER[i].uid);
  });
});

test("an Indian mobile is written as ten digits, matching country_code IN", () => {
  assert.equal(csvNumber("+919879166912"), "9879166912");
  assert.equal(csvNumber("+91 98791 66912"), "9879166912");
  // Anything not Indian-shaped keeps its digits rather than losing a prefix.
  assert.equal(csvNumber("+14155550123"), "14155550123");
  assert.equal(csvNumber(""), "");
});

test("a firm name with a comma cannot break the row apart", () => {
  // "Shah, Patel & Co." is an ordinary firm name and an ordinary CSV hazard.
  const csv = buildCohortCsv(
    [{ uid: "u", phone: "+919879166912", name: 'Vivek "V" Chavda', firm: "Shah, Patel & Co." }],
    { secret: SECRET, ttlMs: 1000 }
  );
  const row = csv.trim().split("\n")[1];
  assert.ok(row.includes('"Shah, Patel & Co."'));
  assert.ok(row.includes('"Vivek ""V"" Chavda"'));
  // Header has five columns; the quoted ones must not add any.
  assert.equal(csv.split("\n")[0].split(",").length, 5);
});

test("the fingerprint tracks the roster, not the tokens", () => {
  /* The one that decides whether an unattended nightly job uploads a new
     cohort every night forever. Tokens carry an expiry, so they differ on
     every run; the fingerprint must not. */
  const a = rosterFingerprint(ROSTER);
  const b = rosterFingerprint([...ROSTER].reverse()); // order is not a change
  assert.equal(a, b);
  const added = rosterFingerprint([...ROSTER, { uid: "uid-3", phone: "+919999999999", name: "New", firm: "" }]);
  assert.notEqual(a, added, "a new sign-up must move the fingerprint");
  const renamed = rosterFingerprint([{ ...ROSTER[0], name: "V. Chavda" }, ROSTER[1]]);
  assert.notEqual(a, renamed, "a changed name must move the fingerprint — the agent greets with it");
});

test("the cohort URL is built from the deployment, not the agent", () => {
  const url = cohortsUrl({ orgId: "org 1", workspaceId: "ws/2", deploymentId: "dep-3" });
  assert.ok(url.startsWith("https://apps.sarvam.ai/api/scheduling/v1/orgs/"));
  assert.ok(url.endsWith("/deployments/dep-3/cohorts"));
  // Path segments are escaped, so an id with a slash cannot walk the URL.
  assert.ok(url.includes("org%201"));
  assert.ok(url.includes("ws%2F2"));
});

test("cohorts we create are recognisable, and tokens outlive a few failed runs", () => {
  // Cleanup deletes by prefix; without one it could remove a list someone
  // uploaded by hand in the console.
  assert.ok(COHORT_PREFIX.length > 4);
  assert.match(COHORT_PREFIX, /^[a-z0-9-]+$/);
  // Daily schedule: the tokens must survive more than one missed night.
  assert.ok(COHORT_TOKEN_DAYS >= 7, "too short — one bad night would lock everyone out");
  assert.ok(COHORT_TOKEN_DAYS <= 30, "too long — the CSV is a credential");
});

test("an unchanged roster still gets a fresh cohort before its tokens expire", () => {
  /* The trap in "skip the upload when nothing changed": nothing changing is
     the NORMAL case for a settled practice, and the tokens in the live cohort
     expire regardless. Without a period in the name, a firm whose client list
     was stable for a fortnight would stop being recognised on an ordinary
     Tuesday, with no failure anywhere to point at. */
  const day = 24 * 60 * 60 * 1000;
  const t0 = 1_800_000_000_000;
  assert.equal(cohortName(ROSTER, t0), cohortName(ROSTER, t0 + day), "a single day must not force a re-upload");
  assert.notEqual(
    cohortName(ROSTER, t0),
    cohortName(ROSTER, t0 + (COHORT_REFRESH_DAYS + 1) * day),
    "a settled roster must still refresh within the refresh window"
  );
  // And the refresh has to land comfortably inside the token's life.
  assert.ok(COHORT_REFRESH_DAYS * 2 <= COHORT_TOKEN_DAYS,
    "tokens must outlive at least two refresh periods, or one failed run locks everyone out");
  assert.ok(cohortPeriod(t0 + day) - cohortPeriod(t0) <= 1);
});

test("the cohort name still moves the moment the roster does", () => {
  const t0 = 1_800_000_000_000;
  const withNewUser = [...ROSTER, { uid: "uid-3", phone: "+919999999999", name: "New", firm: "" }];
  assert.notEqual(cohortName(ROSTER, t0), cohortName(withNewUser, t0));
  assert.ok(cohortName(ROSTER, t0).startsWith(COHORT_PREFIX));
});

test("an empty roster produces a header and nothing else", () => {
  const csv = buildCohortCsv([], { secret: SECRET, ttlMs: 1000 });
  assert.equal(csv.trim().split("\n").length, 1);
});

console.log(`\n${passed}/${passed + failures.length} passed`);
if (failures.length) process.exit(1);
