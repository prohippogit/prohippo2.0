/*
 * ProHippo — the rules behind every WhatsApp message, with nothing plugged in.
 *
 * No firebase-functions, no firebase-admin, no network: this module is a pile
 * of pure functions so the decisions that matter — does this notice deserve an
 * alert, is this hearing still live, has the burst cap tripped — can be tested
 * from the repo root without a Firebase project. functions/whatsapp.js is the
 * wiring around it. Same split as voiceCohortCore.js.
 *
 * IT ALSO EXISTS BECAUSE OF A LANGUAGE BOUNDARY. src/whatsappSettings.js holds
 * the same reachability rules for the browser, in ESM; this is Cloud Functions,
 * in CommonJS. The two are duplicated rather than shared, exactly as
 * messageLanguages.js is duplicated against functions/messageTranslation.js.
 * Duplication is fine; DRIFT is not — test/whatsappCore.test.mjs pins the two
 * together so a rule changed on one side fails a test rather than a practice.
 */
"use strict";

/* ---------------- mobile numbers ---------------- */

const TEN_RE = /^[6-9]\d{9}$/;

/* Mirror of normaliseMobile in src/whatsappSettings.js — see the long comment
   there for why the last ten digits are not simply taken. */
function normaliseMobile(input) {
  const digits = String(input === undefined || input === null ? "" : input).replace(/\D/g, "");
  let ten = "";
  if (digits.length === 10) ten = digits;
  else if (digits.length === 11 && digits.startsWith("0")) ten = digits.slice(1);
  else if (digits.length === 12 && digits.startsWith("91")) ten = digits.slice(2);
  return TEN_RE.test(ten) ? `+91${ten}` : "";
}

/* ---------------- settings ---------------- */

// Mirror of WHATSAPP_MESSAGES in src/whatsappSettings.js. Only the key and the
// default travel — the labels are the Settings card's business, not the
// sender's.
const MESSAGE_DEFAULTS = {
  noticeAlertUser: true,
  hearingReminder: true,
  causeList: true,
  docRequest: true,
  noticeAlertClient: false,
  invoice: true,
};

function whatsAppEnabledFor(profile, key) {
  if (!Object.prototype.hasOwnProperty.call(MESSAGE_DEFAULTS, key)) return false;
  const stored = (profile && profile.whatsapp) || {};
  if (stored.enabled !== true) return false;
  return stored[key] === undefined ? MESSAGE_DEFAULTS[key] : stored[key] === true;
}

/* The practitioner's own number: the one they proved they own by OTP, never one
   typed into a form. Same rule the voice agent dials by. */
function userReachability(profile) {
  const verified = Boolean(profile && profile.phoneVerified === true);
  const mobile = normaliseMobile(profile && profile.phone);
  if (!verified || !mobile) return { ok: false, mobile: "", reason: "unverified" };
  return { ok: true, mobile, reason: "" };
}

/* ---------------- dates ---------------- */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/* "13 August 2026". Spelt out in full rather than "13 Aug 2026" because this is
   read on a phone, once, in passing — and because a client reading it may be
   taking the date to the department. */
function fmtDateLong(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return String(iso || "");
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/*
 * Today in India, as YYYY-MM-DD, from a UTC clock.
 *
 * The scheduler fires at the right IST moment, but the code inside it runs on a
 * UTC clock, and `new Date().toISOString()` at 11:30 IST on the 1st still says
 * the 1st only by luck of the offset. At 04:00 IST it would say the day before,
 * and a hearing sweep that reads the wrong day sends nothing and says nothing.
 * So the offset is applied explicitly rather than relied upon.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istDate(now = new Date(), addDays = 0) {
  const ms = now.getTime() + IST_OFFSET_MS + addDays * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

/* ---------------- notices ---------------- */

/* The date a notice is actually working towards. Mirror of noticeDeadline in
   src/noticeDates.js: a hearing beats a compliance deadline when both are set,
   because that is the one that cannot be moved. */
const noticeDeadline = (n) => (n && (n.hearingDate || n.responseDueDate)) || "";

/*
 * Does this notice deserve to interrupt somebody's day?
 *
 * FOUR GUARDS, AND THE FIRST IS THE ONE THAT MATTERS. Portal sync writes every
 * historic notice it finds, so the naive trigger WhatsApps a practitioner four
 * years of back-history in one minute on the day they sign up. The rule that
 * stops it is not an age cut-off but a simpler question: is there anything
 * still to do about this? A notice from 2022 has no hearing coming and no reply
 * due, and nothing about it needs saying at 7am.
 *
 * (An age cut-off was the first design. It fails the case it most needs to
 * handle: a genuinely old notice re-issued with a fresh hearing date is exactly
 * what a practitioner must hear about, and "issued in the last 7 days" would
 * drop it.)
 */
function shouldAlertNotice(notice, { today } = {}) {
  const n = notice || {};
  const day = today || istDate();

  // The practitioner typed it in themselves; they do not need telling.
  if (n.source !== "portal") return { alert: false, reason: "not-portal" };

  /* Orders are excluded. There is no reply to file against an assessment or
     penalty order — the answer to one is an appeal, which runs on its own clock
     and deserves its own message rather than being folded into this one. */
  if (n.isOrder) return { alert: false, reason: "order" };

  const deadline = noticeDeadline(n);
  if (!deadline) return { alert: false, reason: "no-deadline" };
  if (deadline < day) return { alert: false, reason: "past" };

  return { alert: true, reason: "", deadline };
}

/* The last line of the alert, which says what the clock is.
 *
 * Never empty: Meta rejects a send whose parameter is an empty string, and
 * shouldAlertNotice has already refused anything with no deadline, so by the
 * time this is called there is always something to say. */
function noticeDeadlineSentence(notice) {
  const n = notice || {};
  if (n.hearingDate) return `Hearing on ${fmtDateLong(n.hearingDate)}.`;
  if (n.responseDueDate) return `Reply due ${fmtDateLong(n.responseDueDate)}.`;
  return "No date on the notice.";
}

/* The seven variables of ph_notice_alert_user_v1, in order.
   Every one comes off the record; none is composed by a model. */
function noticeAlertParams(notice) {
  const n = notice || {};
  return [
    n.assessee || "An assessee",
    n.pan || "PAN not on file",
    n.section || n.authority || "unspecified",
    n.ay || "not stated",
    fmtDateLong(n.date) || "not stated",
    n.din || n.docKey || "not stated",
    noticeDeadlineSentence(n),
  ];
}

/* ---------------- hearings ---------------- */

/*
 * Still worth turning up for?
 *
 * "Adjourned" is the only status that takes a hearing out of the diary — when
 * one is adjourned the app writes a NEW hearing at the new date, so reminding
 * anyone about the old row would be reminding them about a date that has moved.
 * "Completed" is never stored: the list derives it from the date being in the
 * past, and this only ever looks at tomorrow.
 */
function isHearingLive(hearing) {
  const h = hearing || {};
  if (!h.date) return false;
  return h.status !== "Adjourned" && h.status !== "Cancelled";
}

/* The eight variables of ph_hearing_reminder_user_v1, in order.
 *
 * Three of these fall back, because a hearing created from a portal
 * response-due date carries no bench and no ITA number. An empty parameter is
 * rejected by Meta outright, so "what we know instead" beats "nothing" every
 * time — and a reminder that says "Scrutiny matter" is still a reminder. */
function hearingReminderParams(hearing, { when = "tomorrow" } = {}) {
  const h = hearing || {};
  const ref = h.ita
    || (h.section ? `u/s ${h.section}` : "")
    || (h.authority ? `${h.authority} matter` : "No reference on file");
  return [
    when,
    h.assessee || "An assessee",
    h.ay || "not stated",
    fmtDateLong(h.date),
    h.time || "time not stated",
    h.bench || h.authority || "not stated",
    h.mode || "not stated",
    ref,
  ];
}

/* ---------------- the weekly cause list ---------------- */

/*
 * The Monday-to-Sunday AFTER the one containing `todayIso`.
 *
 * The sweep runs on a Saturday morning, when the current week is spent — five
 * of its seven days are already behind the practitioner, and a sheet of them is
 * a record, not a plan. What they are about to need is the week starting Monday.
 *
 * Arithmetic in UTC over a bare date string, deliberately: `new Date(iso)` with
 * no zone is parsed as UTC anyway, India has no daylight saving, and the caller
 * has already resolved the Indian date with istDate(). Reaching for local time
 * here would reintroduce exactly the UTC/IST confusion istDate() exists to end.
 */
function nextWeekRange(todayIso) {
  const d = new Date(`${todayIso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return { from: "", to: "" };
  const backToMonday = (d.getUTCDay() + 6) % 7; // Sunday is 0, and belongs to the week before
  const monday = new Date(d.getTime() + (7 - backToMonday) * 86400000);
  const from = monday.toISOString().slice(0, 10);
  const to = new Date(monday.getTime() + 6 * 86400000).toISOString().slice(0, 10);
  return { from, to };
}

/* "17–23 August 2026", and the two cases where that is not enough: a week that
   crosses a month, and one that crosses a year. Said the way a person would say
   it rather than printing both dates in full every time. */
function weekLabel(from, to) {
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(from || ""));
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(to || ""));
  if (!a || !b) return `${from || ""}`.trim();
  const [, ay, am, ad] = a;
  const [, by, bm, bd] = b;
  const mon = (m) => MONTHS[Number(m) - 1];
  if (ay !== by) return `${Number(ad)} ${mon(am)} ${ay} – ${Number(bd)} ${mon(bm)} ${by}`;
  if (am !== bm) return `${Number(ad)} ${mon(am)} – ${Number(bd)} ${mon(bm)} ${by}`;
  return `${Number(ad)}–${Number(bd)} ${mon(am)} ${ay}`;
}

/* "2 ITAT, 1 CIT(A), 3 Scrutiny" — what the week is made of, in one line.
 *
 * causeListSummary() in causeList.js counts distinct authorities; this names
 * them. Ordered by count and then alphabetically, so the same week always reads
 * the same way rather than shuffling with Firestore's document order. */
function causeListBreakdown(hearings) {
  const counts = new Map();
  for (const h of hearings || []) {
    const key = (h && h.authority) || "Other";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .map(([name, n]) => `${n} ${name}`)
    .join(", ");
}

/* The three variables of ph_cause_list_weekly_v1, in order. */
function causeListParams(hearings, { from, to } = {}) {
  const n = (hearings || []).length;
  return [
    weekLabel(from, to),
    String(n),
    causeListBreakdown(hearings) || "no forums listed",
  ];
}

/* What the attachment is called on the recipient's phone. Spaces and the en
   dash are avoided: this becomes a filename on somebody's device, and the
   ones that travel badly are not worth the typography. */
function causeListFileName({ from, to } = {}) {
  const label = weekLabel(from, to).replace(/–/g, "to").replace(/\s+/g, " ").trim();
  return `Cause list ${label}.pdf`.replace(/\s{2,}/g, " ");
}

/* ---------------- the burst guard ---------------- */

/*
 * FIVE AN HOUR, THEN ONE MESSAGE SAYING SO.
 *
 * shouldAlertNotice already drops back-history, but it does not cover the case
 * it cannot see from a single document: a two-hundred-client practice
 * onboarding genuinely has twenty or thirty live notices, every one of them
 * passing every guard, all arriving within a few minutes of each other.
 *
 * THE WINDOW IS AN HOUR, NOT A MINUTE. A minute was the first design and it
 * guards nothing: a sync writes notices over several minutes, so the window
 * resets mid-burst and lets five more through each time. An hour is a window a
 * sync fits inside.
 *
 * On the sixth, one message says alerts are paused and points at the app, and
 * then nothing until the hour is out. It carries no count, deliberately — the
 * total is not knowable while notices are still arriving, and the dashboard's
 * "last 24 hours" card has the real number anyway. A WhatsApp message that
 * guesses at a figure the app can state exactly is worse than one that says
 * "go and look".
 */
const BURST_WINDOW_MS = 60 * 60 * 1000;
const BURST_MAX = 5;

function burstDecision(state, now = Date.now()) {
  const s = state || {};
  const fresh = !s.windowStart || now - s.windowStart >= BURST_WINDOW_MS;
  const windowStart = fresh ? now : s.windowStart;
  const count = (fresh ? 0 : s.count || 0) + 1;
  const next = { windowStart, count };

  if (count <= BURST_MAX) return { action: "send", next };
  // Exactly one notice that we have stopped talking, on the message that trips
  // the cap. After that, silence — a burst notice repeated thirty times is the
  // flood it was written to prevent.
  if (count === BURST_MAX + 1) return { action: "burst-notice", next };
  return { action: "suppress", next };
}

module.exports = {
  normaliseMobile,
  MESSAGE_DEFAULTS,
  whatsAppEnabledFor,
  userReachability,
  fmtDateLong,
  istDate,
  IST_OFFSET_MS,
  noticeDeadline,
  shouldAlertNotice,
  noticeDeadlineSentence,
  noticeAlertParams,
  isHearingLive,
  hearingReminderParams,
  nextWeekRange,
  weekLabel,
  causeListBreakdown,
  causeListParams,
  causeListFileName,
  BURST_WINDOW_MS,
  BURST_MAX,
  burstDecision,
};
