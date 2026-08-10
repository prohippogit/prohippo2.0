/*
 * ProHippo — keeping Sarvam's known-callers list in step with who has signed up.
 *
 * WHY THIS EXISTS, AND WHY IT IS A LIST AT ALL
 *
 * An inbound caller cannot be identified from the request: Sarvam passes a tool
 * only the body fields declared on it, and the caller's number is not among
 * them. The obvious fix — an on-start hook that receives the number — turned
 * out not to be reachable from the dashboard's tool builder. Sarvam's own SDK
 * exposes the number as `user_identifier` on the tool context, but that is a
 * property of a self-hosted SDK tool, not something a console-configured API
 * tool can bind to. We tested it; the field arrives empty.
 *
 * What remains is the mechanism Sarvam documents for exactly this: a cohort.
 * Upload a CSV of numbers against the inbound deployment, and a call from one
 * of them starts with that row's values already in the agent's variables. We
 * put a signed token in the `session_token` column, which every account tool
 * already binds a body field to.
 *
 * A list is a snapshot, and a snapshot goes stale — that was the honest
 * complaint against it. This closes that: the roster is rebuilt and re-uploaded
 * on a schedule, so a practitioner who links their mobile today can ring the
 * line tomorrow without anybody running a script.
 *
 * TOKEN LIFETIME. Because this refreshes daily, the tokens do not need to live
 * for months — COHORT_TOKEN_DAYS is short enough that a leaked CSV expires
 * quickly and long enough that a few failed syncs cannot lock everybody out.
 *
 * ADDITIVE UPLOADS. Sarvam creates a new cohort per upload and does not
 * document a delete. We name ours with a known prefix, try to remove the
 * previous ones, and — this is the part that matters — skip the upload entirely
 * when the roster has not changed, so an unattended daily job does not
 * accumulate a cohort a day forever.
 */
"use strict";

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

const { VOICE_AGENT_CONFIG, isConfigured, missingConfig } = require("./voiceAgentConfig");

const sarvamWebhookSecret = defineSecret("SARVAM_WEBHOOK_SECRET");
const sarvamApiKey = defineSecret("SARVAM_API_KEY");

/* The decisions — CSV shape, what counts as a change, where the request goes —
   live next door with no Firebase or network in scope, so they can be tested
   with plain `node`. See functions/voiceCohortCore.test.mjs. */
const {
  COHORT_TOKEN_DAYS,
  COHORT_PREFIX,
  COHORT_TRANSFORMATION,
  cohortsUrl,
  cohortName,
  buildCohortCsv,
} = require("./voiceCohortCore");

module.exports.build = function build({ PRIMARY_REGION, db }) {
  const apiHeaders = () => ({ "X-API-Key": String(sarvamApiKey.value()).trim() });

  /* Everyone with a verified mobile, with the name and firm the agent greets
     them by. Auth is the source of truth for the number — it is the same lookup
     SMS login uses — and Firestore for the profile. */
  async function collectRoster() {
    const rows = [];
    let pageToken;
    do {
      const page = await admin.auth().listUsers(1000, pageToken);
      for (const u of page.users) {
        if (!u.phoneNumber) continue;
        let profile = {};
        try {
          const snap = await db.doc(`users/${u.uid}`).get();
          profile = snap.exists ? snap.data() || {} : {};
        } catch (e) {
          console.error("voice: roster profile read failed", u.uid.slice(0, 8), e.message || e);
        }
        rows.push({
          uid: u.uid,
          phone: u.phoneNumber,
          name: profile.ownerName || u.displayName || "",
          firm: profile.firmName || "",
        });
      }
      pageToken = page.pageToken;
    } while (pageToken);
    return rows;
  }

  async function listCohorts(config) {
    const res = await fetch(`${cohortsUrl(config)}?limit=100`, { headers: apiHeaders() });
    if (!res.ok) throw new Error(`list cohorts ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    // The shape is documented as a paged list; be forgiving about the wrapper.
    return Array.isArray(body) ? body : body.cohorts || body.items || body.data || [];
  }

  async function uploadCohort(config, name, csv) {
    const form = new FormData();
    form.append("name", name);
    form.append("cohort_file", new Blob([csv], { type: "text/csv" }), "known-callers.csv");
    form.append(
      "cohort_transformation_file",
      new Blob([JSON.stringify(COHORT_TRANSFORMATION)], { type: "application/json" }),
      "cohort_config.json"
    );
    const res = await fetch(`${cohortsUrl(config)}/upload`, {
      method: "POST",
      headers: apiHeaders(), // no content-type: fetch sets the multipart boundary
      body: form,
    });
    if (!res.ok) throw new Error(`upload cohort ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  /*
   * Sarvam's public reference documents upload/create/list/get/download and no
   * delete, though the console plainly removes a list. Try it; if the verb is
   * not there, say so once and carry on — a stale cohort is untidy, not unsafe,
   * because its tokens expire on their own.
   */
  async function deleteCohort(config, cohortId) {
    try {
      const res = await fetch(`${cohortsUrl(config)}/${encodeURIComponent(cohortId)}`, {
        method: "DELETE",
        headers: apiHeaders(),
      });
      if (res.ok) return true;
      console.info(`voice: cohort delete unavailable (${res.status}) — old lists will age out on token expiry`);
    } catch (e) {
      console.info("voice: cohort delete failed —", e.message || e);
    }
    return false;
  }

  async function syncOnce() {
    if (!isConfigured() || !String(VOICE_AGENT_CONFIG.deploymentId || "").trim()) {
      console.error("voice: known-caller sync skipped — config incomplete:", [
        ...missingConfig(),
        ...(VOICE_AGENT_CONFIG.deploymentId ? [] : ["deploymentId"]),
      ].join(", "));
      return { skipped: "not-configured" };
    }

    const rows = await collectRoster();
    if (!rows.length) {
      console.warn("voice: known-caller sync found no users with a verified mobile");
      return { skipped: "empty-roster" };
    }

    const name = cohortName(rows, Date.now());

    let existing = [];
    try {
      existing = await listCohorts(VOICE_AGENT_CONFIG);
    } catch (e) {
      // Don't upload blind: without the list we cannot tell a no-op from a
      // change, and uploading anyway is how you end up with a cohort a day.
      console.error("voice: known-caller sync could not list cohorts —", e.message || e);
      return { skipped: "list-failed" };
    }

    const ours = existing.filter((c) => String(c.name || "").startsWith(COHORT_PREFIX));
    const current = ours.find((c) => String(c.name || "") === name);
    /* The roster is unchanged AND the live cohort finished processing: nothing
       to do. Tokens are re-minted only when the list itself moves, which is
       what keeps a daily job from creating a cohort a day. */
    if (current && String(current.status || "").toLowerCase() !== "failed") {
      console.log(`voice: known-caller sync no change (${rows.length} callers, ${name})`);
      return { unchanged: true, callers: rows.length };
    }

    const csv = buildCohortCsv(rows, {
      secret: sarvamWebhookSecret.value(),
      ttlMs: COHORT_TOKEN_DAYS * 24 * 60 * 60 * 1000,
    });
    const created = await uploadCohort(VOICE_AGENT_CONFIG, name, csv);
    console.log(`voice: known-caller sync uploaded ${rows.length} callers as ${name} (${created.status || "queued"})`);

    // Only now that a replacement exists does removing the old ones make sense.
    for (const old of ours) {
      const id = old.cohort_id || old.id;
      if (id) await deleteCohort(VOICE_AGENT_CONFIG, id);
    }
    return { uploaded: true, callers: rows.length, cohort: name };
  }

  /*
   * 03:10 IST — after the day has turned in India and well outside the line's
   * 07:00–23:00 window, so a cohort is never swapped mid-call.
   */
  const syncVoiceKnownCallers = onSchedule(
    {
      schedule: "10 3 * * *",
      timeZone: "Asia/Kolkata",
      region: PRIMARY_REGION,
      timeoutSeconds: 300,
      secrets: [sarvamWebhookSecret, sarvamApiKey],
      maxInstances: 1,
    },
    async () => {
      try {
        await syncOnce();
      } catch (e) {
        // Loud, but not fatal: yesterday's cohort is still live and its tokens
        // outlast several missed runs by design.
        console.error("voice: known-caller sync failed —", e.message || e);
      }
    }
  );

  /* The same job on demand, for an admin who has just onboarded someone and
     does not want to wait for tonight. Admin-only: the roster is every user's
     number, and the reply says how many there are. */
  const syncVoiceKnownCallersNow = onCall(
    { region: PRIMARY_REGION, secrets: [sarvamWebhookSecret, sarvamApiKey], maxInstances: 1 },
    async (req) => {
      if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
      if (req.auth.token.admin !== true) throw new HttpsError("permission-denied", "Admins only.");
      try {
        return await syncOnce();
      } catch (e) {
        console.error("voice: manual known-caller sync failed —", e.message || e);
        throw new HttpsError("unavailable", "Couldn't update the caller list just now.");
      }
    }
  );

  return { syncVoiceKnownCallers, syncVoiceKnownCallersNow };
};
