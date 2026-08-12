/* The decisions behind a WhatsApp message, checked without a Firebase project.
 *
 *   node --test test/whatsappCore.test.mjs
 *
 * Two things earn most of this file. The first is the guard that stops a
 * practitioner being WhatsApped four years of back-history on the morning they
 * sign up. The second is parity: the same reachability rules exist twice, once
 * in ESM for the browser and once in CommonJS for Cloud Functions, and a rule
 * changed on one side has to fail here rather than in somebody's practice.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const core = require("../functions/whatsappCore.js");

import * as browser from "../src/whatsappSettings.js";
import { noticeDeadline as browserNoticeDeadline } from "../src/noticeDates.js";
import { WHATSAPP_MESSAGES } from "../src/whatsappSettings.js";

/* ---------------- parity with the browser copy ---------------- */

test("both copies normalise the same numbers the same way", () => {
  const cases = [
    "9825011234", "98250 11234", "+91 98250 11234", "919825011234", "09825011234",
    "", null, undefined, "12345", "5825011234", "12345 9825011234", "00919825011234", "079 2630 1234",
  ];
  for (const c of cases) {
    assert.equal(
      core.normaliseMobile(c), browser.normaliseMobile(c),
      `drift on ${JSON.stringify(c)} — functions/whatsappCore.js and src/whatsappSettings.js disagree`
    );
  }
});

test("both copies know the same messages, with the same defaults", () => {
  const browserKeys = WHATSAPP_MESSAGES.map((m) => m.key).sort();
  assert.deepEqual(Object.keys(core.MESSAGE_DEFAULTS).sort(), browserKeys);
  for (const m of WHATSAPP_MESSAGES) {
    assert.equal(core.MESSAGE_DEFAULTS[m.key], m.fallback, `default for ${m.key} has drifted`);
  }
});

test("both copies agree on whether a message is switched on", () => {
  const profiles = [
    null, {}, { whatsapp: {} },
    { whatsapp: { enabled: true } },
    { whatsapp: { enabled: false, hearingReminder: true } },
    { whatsapp: { enabled: true, noticeAlertClient: true } },
    { whatsapp: { enabled: "yes" } },
  ];
  for (const p of profiles) {
    for (const key of Object.keys(core.MESSAGE_DEFAULTS)) {
      assert.equal(
        core.whatsAppEnabledFor(p, key), browser.whatsAppEnabledFor(p, key),
        `drift on ${key} for ${JSON.stringify(p)}`
      );
    }
  }
});

test("both copies agree on when the practitioner is reachable", () => {
  const profiles = [
    null, {}, { phone: "+919824000000" }, { phone: "+919824000000", phoneVerified: true },
    { phone: "12345", phoneVerified: true }, { phoneVerified: true },
  ];
  for (const p of profiles) {
    assert.equal(core.userReachability(p).ok, browser.userReachability(p).ok, `drift on ${JSON.stringify(p)}`);
  }
});

test("the deadline rule matches the one the screens use", () => {
  const notices = [
    { hearingDate: "2026-08-13", responseDueDate: "2026-08-27" }, // hearing wins
    { responseDueDate: "2026-08-27" },
    { hearingDate: "2026-08-13" },
    {}, null,
  ];
  for (const n of notices) {
    assert.equal(core.noticeDeadline(n), browserNoticeDeadline(n), `drift on ${JSON.stringify(n)}`);
  }
});

/* ---------------- which notices deserve an alert ---------------- */

const TODAY = "2026-08-12";
const notice = (over = {}) => ({
  source: "portal", isOrder: false,
  assessee: "Rajesh M. Shah", pan: "ABCPS1234F", ay: "2017-18",
  section: "142(1)", authority: "ITAT", date: "2026-08-12",
  din: "ITBA/AST/F/142(1)/2026-27/103412",
  hearingDate: "", responseDueDate: "2026-08-27",
  ...over,
});

test("a live notice alerts", () => {
  const v = core.shouldAlertNotice(notice(), { today: TODAY });
  assert.equal(v.alert, true);
  assert.equal(v.deadline, "2026-08-27");
});

test("four years of back-history alerts nobody", () => {
  /* THE CASE THIS WHOLE GUARD EXISTS FOR. Portal sync writes every historic
     notice it finds on the day a practice signs up. Every one of these is a
     real record that belongs in the app and a message that must not be sent. */
  const history = [
    notice({ date: "2022-04-01", responseDueDate: "2022-04-15" }),
    notice({ date: "2023-11-02", hearingDate: "2023-11-20", responseDueDate: "" }),
    notice({ date: "2024-06-06", responseDueDate: "2024-06-30" }),
  ];
  for (const n of history) {
    const v = core.shouldAlertNotice(n, { today: TODAY });
    assert.equal(v.alert, false);
    assert.equal(v.reason, "past");
  }
});

test("an old notice with a fresh hearing date still alerts", () => {
  /* Why the guard is not an age cut-off. This is a 2022 matter listed for next
     week, and it is precisely what a practitioner must hear about — "issued in
     the last 7 days" would drop it. */
  const v = core.shouldAlertNotice(
    notice({ date: "2022-04-01", hearingDate: "2026-08-20", responseDueDate: "" }),
    { today: TODAY }
  );
  assert.equal(v.alert, true);
});

test("a notice due today still alerts", () => {
  assert.equal(core.shouldAlertNotice(notice({ responseDueDate: TODAY }), { today: TODAY }).alert, true);
});

test("what the practitioner typed in themselves is not news to them", () => {
  const v = core.shouldAlertNotice(notice({ source: "" }), { today: TODAY });
  assert.equal(v.alert, false);
  assert.equal(v.reason, "not-portal");
});

test("orders are left to the appeal clock, not folded into this", () => {
  const v = core.shouldAlertNotice(notice({ isOrder: true }), { today: TODAY });
  assert.equal(v.alert, false);
  assert.equal(v.reason, "order");
});

test("a notice with no date at all alerts nobody", () => {
  const v = core.shouldAlertNotice(notice({ hearingDate: "", responseDueDate: "" }), { today: TODAY });
  assert.equal(v.alert, false);
  assert.equal(v.reason, "no-deadline");
});

/* ---------------- what the message says ---------------- */

test("the alert carries seven parameters and not one of them is empty", () => {
  const p = core.noticeAlertParams(notice());
  assert.equal(p.length, 7);
  // Meta rejects a send whose parameter is an empty string, so this holds even
  // for a notice with almost nothing on it.
  for (const v of core.noticeAlertParams({ source: "portal" })) {
    assert.ok(String(v).trim().length > 0, "an empty parameter would be rejected by Meta");
  }
});

test("the last line says which clock is running", () => {
  assert.equal(core.noticeDeadlineSentence(notice()), "Reply due 27 August 2026.");
  assert.equal(core.noticeDeadlineSentence(notice({ hearingDate: "2026-08-13" })), "Hearing on 13 August 2026.");
});

test("dates are spelt out the way they are read aloud", () => {
  assert.equal(core.fmtDateLong("2026-08-13"), "13 August 2026");
  assert.equal(core.fmtDateLong("2026-01-01"), "1 January 2026");
  assert.equal(core.fmtDateLong(""), "");
});

/* ---------------- hearings ---------------- */

const hearing = (over = {}) => ({
  assessee: "Rajesh M. Shah", ay: "2017-18", date: "2026-08-13", time: "11:30",
  bench: "ITAT, Ahmedabad 'A' Bench", mode: "Physical", ita: "ITA No. 1244/Ahd/2024",
  authority: "ITAT", status: "Upcoming", ...over,
});

test("an adjourned hearing is not reminded about", () => {
  // The app writes a NEW hearing at the new date when one is adjourned, so
  // reminding about the old row is reminding about a date that has moved.
  assert.equal(core.isHearingLive(hearing()), true);
  assert.equal(core.isHearingLive(hearing({ status: "Adjourned" })), false);
  assert.equal(core.isHearingLive(hearing({ date: "" })), false);
});

test("the reminder carries eight parameters and not one of them is empty", () => {
  const p = core.hearingReminderParams(hearing());
  assert.equal(p.length, 8);
  assert.equal(p[0], "tomorrow");
  assert.equal(p[3], "13 August 2026");
  for (const v of p) assert.ok(String(v).trim().length > 0);
});

test("a hearing created from a portal due date still produces a usable reminder", () => {
  /* These carry no bench and no ITA number — ingestPortalNotice writes them
     empty. An empty parameter is rejected outright, so "what we know instead"
     has to be good enough to send. */
  const p = core.hearingReminderParams(hearing({ bench: "", ita: "", section: "142(1)", authority: "Scrutiny" }));
  for (const v of p) assert.ok(String(v).trim().length > 0, `empty parameter in ${JSON.stringify(p)}`);
  assert.equal(p[5], "Scrutiny");        // the authority stands in for the bench
  assert.equal(p[7], "u/s 142(1)");      // the section stands in for the ITA number
});

test("a hearing with nothing but a date still produces a usable reminder", () => {
  for (const v of core.hearingReminderParams({ date: "2026-08-13" })) {
    assert.ok(String(v).trim().length > 0);
  }
});

/* ---------------- the burst guard ---------------- */

test("five alerts go out, the sixth says it has stopped, the rest are silent", () => {
  let state = null;
  const t0 = 1_760_000_000_000;
  const actions = [];
  for (let i = 0; i < 9; i += 1) {
    const d = core.burstDecision(state, t0 + i * 1000);
    state = d.next;
    actions.push(d.action);
  }
  assert.deepEqual(actions, [
    "send", "send", "send", "send", "send",
    "burst-notice",
    "suppress", "suppress", "suppress",
  ]);
});

test("the window is an hour, because a sync takes minutes", () => {
  /* A 60-second window was the first design and it guards nothing: a sync
     writes notices over several minutes, so the window resets mid-burst and
     lets five more through each time round. */
  assert.equal(core.BURST_WINDOW_MS, 60 * 60 * 1000);

  const t0 = 1_760_000_000_000;
  let state = null;
  for (let i = 0; i < 6; i += 1) state = core.burstDecision(state, t0 + i * 30_000).next;
  // Five minutes in, still inside the window and still suppressed.
  assert.equal(core.burstDecision(state, t0 + 5 * 60_000).action, "suppress");
  // An hour and a second later it is a new day's worth of headroom.
  assert.equal(core.burstDecision(state, t0 + 60 * 60_000 + 1000).action, "send");
});

test("a practice that gets one notice a day never meets the cap", () => {
  let state = null;
  const day = 24 * 60 * 60 * 1000;
  const t0 = 1_760_000_000_000;
  for (let i = 0; i < 30; i += 1) {
    const d = core.burstDecision(state, t0 + i * day);
    assert.equal(d.action, "send", `day ${i} was not sent`);
    state = d.next;
  }
});

/* ---------------- the clock ---------------- */

test("the Indian date is computed, not assumed from UTC", () => {
  /* 19:00 UTC on the 12th is already 00:30 on the 13th in India. A sweep that
     read the UTC date would look up the wrong day's hearings and report,
     truthfully and uselessly, that there were none. */
  assert.equal(core.istDate(new Date("2026-08-12T19:00:00Z")), "2026-08-13");
  assert.equal(core.istDate(new Date("2026-08-12T06:00:00Z")), "2026-08-12");
  // 11:30 IST, when the sweep actually runs.
  assert.equal(core.istDate(new Date("2026-08-12T06:00:00Z"), 1), "2026-08-13");
});
