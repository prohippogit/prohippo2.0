/* ProHippo — what WhatsApp sends, to whom, and whether it may.
 *
 * Pure, no React and no network, so the rules can be tested directly — the same
 * reason noticeQueues.js, appeals.js and causeList.js are plain .js. The
 * Settings card renders MESSAGES rather than hard-coding its rows, and
 * functions/whatsapp.js enforces the same keys server-side.
 *
 * TWO AUDIENCES, TWO DIFFERENT PERMISSIONS, and conflating them is the mistake
 * this file exists to prevent:
 *
 *   audience "user"    the practitioner, on the mobile they verified for
 *                      sign-in. They asked for the account; the toggle in
 *                      Settings is the whole of the consent question.
 *
 *   audience "client"  a group head, who has never seen ProHippo. The toggle
 *                      says the PRACTICE is willing to send; it does not say
 *                      THIS PERSON agreed to receive. That second permission
 *                      lives on the group and is checked separately, every
 *                      time, by clientReachability() below.
 */

/* Every message the practice can switch on, in the order Settings shows them.
   `key` is the contract with functions/whatsapp.js and with profile.whatsapp —
   renaming one silently turns that message off for everyone who had it on. */
export const WHATSAPP_MESSAGES = [
  {
    key: "noticeAlertUser",
    audience: "user",
    fallback: true,
    name: "New notice on the portal",
    sub: "To you, within minutes of the sync finding it.",
  },
  {
    key: "hearingReminder",
    audience: "user",
    fallback: true,
    name: "Hearing reminder",
    sub: "To you at 11:30am, the day before each hearing.",
  },
  {
    key: "causeList",
    audience: "user",
    fallback: true,
    name: "Weekly cause list",
    sub: "To you, Saturday 7:30am, with the week ahead attached as a PDF.",
  },
  {
    key: "docRequest",
    audience: "client",
    fallback: true,
    name: "Document requests to clients",
    sub: "Sent to the group head's mobile alongside the email.",
  },
  {
    /* OFF by default, and deliberately the only client message that is.
       A practitioner who has not yet read an order does not necessarily want
       their client hearing about it first — that is a judgement about the
       relationship, so it is asked rather than assumed. */
    key: "noticeAlertClient",
    audience: "client",
    fallback: false,
    name: "Tell clients when a notice arrives",
    sub: "A short note to the group head that you have it and are reviewing it.",
  },
  {
    key: "invoice",
    audience: "client",
    fallback: true,
    name: "Invoices to clients",
    sub: "Sent to the group head. Comes back to you if they have no number on file.",
  },
];

export const MESSAGE_KEYS = WHATSAPP_MESSAGES.map((m) => m.key);

const messageFor = (key) => WHATSAPP_MESSAGES.find((m) => m.key === key) || null;

/* The practice's settings, with every key present.
 *
 * `enabled` is the master switch and defaults to FALSE. Nothing goes out on
 * WhatsApp until somebody turns it on: a message the practitioner did not ask
 * for, arriving at their client, is not a feature. */
export function resolveWhatsAppSettings(profile) {
  const stored = (profile && profile.whatsapp) || {};
  const out = { enabled: stored.enabled === true };
  WHATSAPP_MESSAGES.forEach((m) => {
    out[m.key] = stored[m.key] === undefined ? m.fallback : stored[m.key] === true;
  });
  return out;
}

/* Is this message switched on? The master switch wins over everything, so
   turning it off is one action rather than six. */
export function whatsAppEnabledFor(profile, key) {
  if (!messageFor(key)) return false;
  const s = resolveWhatsAppSettings(profile);
  return s.enabled && s[key] === true;
}

/* ---------------- mobile numbers ---------------- */

// 10-digit Indian mobile. The same shape functions/index.js uses for sign-in
// OTPs — this product is India-only and a number that isn't this shape is a
// typo, not an international client.
const TEN_RE = /^[6-9]\d{9}$/;

/* Anything a human might type — "98250 11234", "+91 98250-11234",
   "09825011234", "919825011234" — reduced to a single stored form, or "" when
   it is not a valid Indian mobile.
 *
 * ONE STORED FORM MATTERS MORE THAN IT LOOKS. The opt-out list, the delivery
 * index and the group head are keyed on this string; two spellings of the same
 * number would mean a client who said STOP still being messaged.
 *
 * THREE ACCEPTED SHAPES, AND NO SLIDING. The obvious implementation keeps the
 * last ten digits of whatever arrives, and it is wrong: a mistyped string of
 * thirteen digits then yields a real, sendable number belonging to somebody
 * else entirely. So the prefix must be one of the three forms below, or the
 * whole thing is refused.
 *
 * WHAT IT STILL CANNOT CATCH, because nothing can: an Ahmedabad landline
 * written "079 2630 1234" reduces to 7926301234, which is equally the shape of
 * a perfectly good mobile — STD codes 79 and 80 collide with mobile prefixes 7
 * and 8, and the string alone does not carry the answer. WhatsApp fails to
 * deliver to it and the send is logged Failed, which is where that one surfaces. */
export function normaliseMobile(input) {
  const digits = String(input ?? "").replace(/\D/g, "");
  let ten = "";
  if (digits.length === 10) ten = digits;                                          // 9825011234
  else if (digits.length === 11 && digits.startsWith("0")) ten = digits.slice(1);   // 09825011234
  else if (digits.length === 12 && digits.startsWith("91")) ten = digits.slice(2);  // +919825011234
  return TEN_RE.test(ten) ? `+91${ten}` : "";
}

export const isValidMobile = (input) => Boolean(normaliseMobile(input));

/** The ten digits alone, for a form field that shows +91 beside it. */
export const mobileTen = (input) => normaliseMobile(input).slice(-10);

/** WATI addresses a contact as "919825011234" — digits only, no plus. */
export const waDigits = (input) => normaliseMobile(input).replace(/\D/g, "");

/** "+91 98250 11234", for reading back to a person. */
export function displayMobile(input) {
  const ten = mobileTen(input);
  return ten ? `+91 ${ten.slice(0, 5)} ${ten.slice(5)}` : "";
}

/* ---------------- the group head ---------------- */

/* The person a client-facing message actually goes to.
 *
 * A group is a family or a business house — "Shah Group" — and its members are
 * assessees, several of which are companies and trusts. You do not WhatsApp
 * Shah Textiles Pvt. Ltd.; you WhatsApp Rajesh Shah, who answers for all of
 * them. That person is the group head. */
export function groupHead(group) {
  const h = (group && group.head) || null;
  if (!h) return null;
  const mobile = normaliseMobile(h.mobile);
  const name = String(h.name || "").trim();
  if (!name && !mobile) return null;
  return { name, mobile, assesseeId: h.assesseeId || "" };
}

/* Consent, as recorded by the practitioner on their client's behalf.
 *
 * The group head never sees ProHippo, so they cannot tick a box in it. The
 * practitioner — who has the relationship, and who is the one being asked —
 * attests that the client agreed, and we record WHO said so and WHEN rather
 * than a bare boolean. A STOP reply clears it through the webhook, which is
 * why `revokedAt` is checked as well as the flag. */
export function headConsent(group) {
  const c = (group && group.headWhatsappOptIn) || null;
  if (!c) return { optedIn: false, at: "", by: "", source: "", revokedAt: "" };
  return {
    optedIn: c.optedIn === true && !c.revokedAt,
    at: c.at || "",
    by: c.by || "",
    source: c.source || "",
    revokedAt: c.revokedAt || "",
  };
}

/* The one question every client-facing send asks: may this go, and if not, why?
 *
 * The reason is returned rather than a bare false because every caller needs to
 * say something useful — the composer disables a button with a tooltip, the
 * invoice falls back to the practitioner, the send log records why nothing
 * left. A boolean would make all three say "couldn't send". */
export function clientReachability(group) {
  const head = groupHead(group);
  if (!head) {
    return { ok: false, mobile: "", name: "", reason: "no-head", message: "No group head set for this group." };
  }
  if (!head.mobile) {
    return { ok: false, mobile: "", name: head.name, reason: "no-mobile", message: `No WhatsApp number on file for ${head.name || "the group head"}.` };
  }
  const consent = headConsent(group);
  if (!consent.optedIn) {
    return {
      ok: false,
      mobile: head.mobile,
      name: head.name,
      reason: consent.revokedAt ? "opted-out" : "no-consent",
      message: consent.revokedAt
        ? `${head.name || "The group head"} asked to stop receiving WhatsApp messages.`
        : `${head.name || "The group head"} hasn't agreed to WhatsApp updates yet — tick the box on the group.`,
    };
  }
  return { ok: true, mobile: head.mobile, name: head.name, reason: "", message: "" };
}

/* The practitioner's own number: the one they proved they own by OTP, never one
   typed into a form. Same rule the voice agent dials by — a number taken from a
   request is a free outbound dialler billed to us. */
export function userReachability(profile) {
  const verified = profile && profile.phoneVerified === true;
  const mobile = normaliseMobile(profile && profile.phone);
  if (!verified || !mobile) {
    return { ok: false, mobile: "", reason: "unverified", message: "Verify your mobile in Settings before WhatsApp updates can reach you." };
  }
  return { ok: true, mobile, reason: "", message: "" };
}
