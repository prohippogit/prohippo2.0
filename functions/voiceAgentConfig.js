/*
 * ProHippo — the Sarvam ids the outbound "Call me" button needs.
 *
 * These are identifiers, not secrets: they sit in a URL path and a request body,
 * and knowing them buys nothing without SARVAM_API_KEY (which IS a secret, held
 * by Firebase and never in this repository). So they live in code, versioned and
 * reviewable, rather than in deploy-time parameters nobody can read back.
 *
 * FILL THESE IN once the agent exists on platform.sarvam.ai/samvaad. Until then
 * the callable returns a clear "not configured" error instead of posting a
 * half-formed request at Sarvam — see isConfigured() below.
 *
 * Where each value comes from:
 *   orgId, workspaceId   the trigger-call URL shown on the agent's page:
 *                        .../orgs/{org_id}/workspaces/{workspace_id}/outbounds
 *   agentId              the agent's id ("app_id" in the trigger-call body)
 *   agentVersion         optional; pin it to stop a console edit changing
 *                        behaviour under a live feature. Empty = latest.
 *   connectionId         Connection dropdown on the trigger-call page
 *   agentPhoneNumber     the ProHippo number calls are placed FROM
 *   webhookUrl           this project's deployed sarvamVoiceWebhook
 *
 * Setup: docs/VOICE_AGENT_SETUP.md
 */
"use strict";

const VOICE_AGENT_CONFIG = {
  orgId: "019edd8a-986b-7a82-bed5-8b69117dd61c",
  workspaceId: "019edd8a-9871-742d-97a0-7af9770aa41d",
  agentId: "prohippo-he-b17b4513-91d8",

  /* A NUMBER, not a string — the trigger-call snippet sends `"app_version": 3`
     unquoted, and pinning it is deliberate: an edit committed in the console
     must not change what a live feature does until someone raises this.

     The pin is also load-bearing in a way that cost us a live failure. Sarvam
     validates `agent_variables` against the pinned version, not the draft: with
     this on 2, a call carrying `session_token` came back
     "(422) Invalid Parameter … Agent variables '{'session_token'}' not found",
     because v2 predated the variable. So whenever a console commit adds or
     renames a variable, this number has to move with it. */
  agentVersion: 3,
  connectionId: "3849bc9b-e5-51c864d5-6102",

  // The number ProHippo owns and calls from. Confirmed purchased; it is also
  // the number the inbound line answers on.
  agentPhoneNumber: "+918071582778",

  webhookUrl: "https://asia-south1-prohippo2.cloudfunctions.net/sarvamVoiceWebhook",
};

/* Every field except agentVersion has to be present before a call can be
   placed. Checked in one place so the callable's error can name what's missing
   rather than surfacing whatever Sarvam says about a malformed body. */
const REQUIRED = ["orgId", "workspaceId", "agentId", "connectionId", "agentPhoneNumber", "webhookUrl"];

const missingConfig = (config = VOICE_AGENT_CONFIG) => REQUIRED.filter((k) => !String(config[k] || "").trim());
const isConfigured = (config = VOICE_AGENT_CONFIG) => missingConfig(config).length === 0;

module.exports = { VOICE_AGENT_CONFIG, REQUIRED, missingConfig, isConfigured };
