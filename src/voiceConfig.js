/*
 * ProHippo — the voice help line, as the app presents it.
 *
 * One number, one switch. Set VOICE_HELPLINE to the number Sarvam answers on
 * and the card in Settings starts telling people about it; leave it empty and
 * the card shows as not yet configured, which is exactly what you want while
 * the number is still being provisioned.
 *
 * Nothing secret lives here — this file ships to the browser. The webhook
 * secret and the agent configuration are server-side (functions/voiceAgent.js,
 * docs/VOICE_AGENT_SETUP.md).
 */

// e.g. "+91 79 4890 1234". Empty until the Sarvam number is live.
export const VOICE_HELPLINE = "";

// What the caller can dial straight from a phone. Kept separate from the
// display form so the pretty spacing above never breaks the tel: link.
export const VOICE_HELPLINE_TEL = VOICE_HELPLINE.replace(/[^\d+]/g, "");

export const VOICE_ENABLED = Boolean(VOICE_HELPLINE_TEL);

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
  "Recognise you from another number. Calls must come from your linked mobile.",
  "Give an opinion on a tax position — that stays with you.",
];
