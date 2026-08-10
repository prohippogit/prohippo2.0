/*
 * ProHippo — the pure half of the known-callers cohort sync.
 *
 * Split out for the same reason voiceAgentCore is: everything here is a
 * decision (what the CSV looks like, what counts as a change, where the request
 * goes) and nothing here needs Firebase, Sarvam, or a network. That makes it
 * testable in a plain `node file.mjs`, which is what the guardrails around it
 * are worth having.
 *
 * The half that talks to anything lives in voiceKnownCallers.js.
 */
"use strict";

const crypto = require("node:crypto");
const { mintSessionToken } = require("./voiceAgentCore");

/* Long enough to survive a run of failed syncs, short enough that a copy of the
   CSV is worth little by the time anyone finds it. The schedule is daily, so
   this is roughly a fortnight of grace. */
const COHORT_TOKEN_DAYS = 14;

/* Every cohort we create carries this prefix, so the cleanup pass can tell ours
   from one uploaded by hand in the console and never delete somebody's. */
const COHORT_PREFIX = "prohippo-known-callers";

const SCHEDULING_BASE = "https://apps.sarvam.ai/api/scheduling/v1";

const cohortsUrl = ({ orgId, workspaceId, deploymentId }) =>
  `${SCHEDULING_BASE}/orgs/${encodeURIComponent(orgId)}` +
  `/workspaces/${encodeURIComponent(workspaceId)}` +
  `/deployments/${encodeURIComponent(deploymentId)}/cohorts`;

/*
 * The column→variable map Sarvam applies to the CSV. The console builds this
 * for you as cohort_config.json when you upload by hand; over the API you send
 * it yourself, and it is NOT inferred from the header row — so this object and
 * the header in buildCohortCsv have to agree, or every row is rejected and the
 * console shows nothing but "0 valid records".
 *
 * `country_code: "IN"` is what lets the file carry ten-digit numbers, which is
 * the form Sarvam's own sample uses.
 */
const COHORT_TRANSFORMATION = {
  phone_number: { column_name: "phone_number", country_code: "IN" },
  app_variables: {
    session_token: { column_name: "session_token" },
    caller_name: { column_name: "caller_name" },
    caller_firm: { column_name: "caller_firm" },
    caller_known: { column_name: "caller_known" },
  },
};

const CSV_HEADER = "phone_number,caller_name,caller_firm,caller_known,session_token";

const csvCell = (value) => {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/* Ten digits for an Indian mobile, matching Sarvam's sample and the
   country_code above; anything else keeps its full digit string. */
const csvNumber = (e164) => {
  const digits = String(e164 || "").replace(/\D/g, "");
  return digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
};

/*
 * What the roster IS, independent of the tokens in it.
 *
 * Tokens change on every run — they carry an expiry — so hashing the finished
 * CSV would make every run look like a change and upload a new cohort nightly,
 * forever, with no documented way to delete the old ones. Hash the part that
 * actually decides whether Sarvam's copy is stale: who is on the list, and what
 * the agent will say about them.
 */
function rosterFingerprint(rows) {
  const canonical = rows
    .map((r) => [r.phone, r.name, r.firm].join(" "))
    .sort()
    .join("");
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

/*
 * THE NAME IS THE DECISION. A cohort whose name already exists is a cohort we
 * do not need to upload again, so what goes into the name is exactly what
 * should trigger a refresh.
 *
 * Two things do. The roster, obviously. And time — which is the part that
 * nearly slipped through: skipping every unchanged night would have been
 * correct right up until the tokens in the live cohort expired, at which point
 * a practice with a stable client list would silently stop being recognised on
 * a day when nothing had changed and nothing had failed.
 *
 * So the name also carries a period counter that ticks every
 * COHORT_REFRESH_DAYS. With a 14-day token and a 7-day tick there are always
 * seven days of headroom, which is a week of failed nightly runs before anybody
 * notices anything.
 */
const COHORT_REFRESH_DAYS = 7;

const cohortPeriod = (nowMs) => Math.floor(nowMs / (COHORT_REFRESH_DAYS * 24 * 60 * 60 * 1000));

const cohortName = (rows, nowMs) => `${COHORT_PREFIX}-${rosterFingerprint(rows)}-p${cohortPeriod(nowMs)}`;

function buildCohortCsv(rows, { secret, ttlMs }) {
  const body = rows.map((r) =>
    [
      csvNumber(r.phone),
      csvCell(r.name),
      csvCell(r.firm),
      "yes",
      mintSessionToken({ uid: r.uid, secret, ttlMs }),
    ].join(",")
  );
  return `${[CSV_HEADER, ...body].join("\n")}\n`;
}

module.exports = {
  COHORT_TOKEN_DAYS,
  COHORT_REFRESH_DAYS,
  COHORT_PREFIX,
  COHORT_TRANSFORMATION,
  CSV_HEADER,
  cohortsUrl,
  csvCell,
  csvNumber,
  rosterFingerprint,
  cohortPeriod,
  cohortName,
  buildCohortCsv,
};
