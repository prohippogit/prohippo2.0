/*
 * ProHippo — the voice help line, as the app presents it.
 *
 * Nothing secret lives here — this file ships to the browser. The webhook
 * secret and the agent configuration are server-side (functions/voiceAgent.js,
 * docs/VOICE_AGENT_SETUP.md).
 */

// The ProHippo number: the line users can ring, and the number "Call me"
// dials out from.
export const VOICE_HELPLINE = "+91 80715 82778";

// What the caller can dial straight from a phone. Kept separate from the
// display form so the pretty spacing above never breaks the tel: link.
export const VOICE_HELPLINE_TEL = VOICE_HELPLINE.replace(/[^\d+]/g, "");

/*
 * THE GO-LIVE SWITCH. Separate from the number on purpose.
 *
 * Hosting deploys on every merge to the default branch; Cloud Functions do not
 * — they go out by hand. So there is a window where this file is live in
 * production and `requestVoiceCallback` does not yet exist, and a "Call me"
 * button in that window is a button that throws. Knowing the number is not the
 * same as being ready to answer it.
 *
 * FLIP THIS TO TRUE only once all three are done:
 *   1. firebase deploy --only functions:sarvamVoiceWebhook,functions:requestVoiceCallback
 *   2. the agent exists on Sarvam with the number attached
 *   3. functions/voiceAgentConfig.js is filled in
 *
 * Until then the Settings card shows the feature as coming, which is true.
 */
export const VOICE_LIVE = true;

export const VOICE_ENABLED = VOICE_LIVE && Boolean(VOICE_HELPLINE_TEL);

/* What the line can and cannot do, in the user's words rather than ours. The
   second list matters as much as the first: someone who rings expecting to
   dictate a new hearing date and is told no has had a bad experience we could
   have prevented on this card. */
export const VOICE_CAN = [
  "Find anything in the app — “where do I raise a bill”, “how do I add a client”",
  "Read out your hearings, pending notices, open tasks and outstanding fees",
  "Summarise any one of your clients — open matters, next date, what's due",
  "Answer in English, Hindi or Gujarati — whichever you speak",
];

export const VOICE_CANNOT = [
  "Change anything — it can't add, edit, delete, send or file. It reads only.",
  "Give an opinion on a tax position — that stays with you.",
  "Tell you anything about ProHippo's own business, or any account but yours.",
];
