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

test("both copies agree on whether a client may be messaged", () => {
  const groups = [
    null, {}, { name: "Patel Family" },
    { head: { name: "Rajesh M. Shah", mobile: "+919825011234" } },
    { head: { name: "Rajesh M. Shah", mobile: "" }, headWhatsappOptIn: { optedIn: true } },
    { head: { name: "Rajesh M. Shah", mobile: "9825011234" }, headWhatsappOptIn: { optedIn: true } },
    { head: { name: "Rajesh M. Shah", mobile: "9825011234" }, headWhatsappOptIn: { optedIn: true, revokedAt: "2026-08-09T00:00:00Z" } },
    { head: { name: "", mobile: "" } },
  ];
  for (const g of groups) {
    const a = core.clientReachability(g);
    const b = browser.clientReachability(g);
    assert.equal(a.ok, b.ok, `drift on ok for ${JSON.stringify(g)}`);
    assert.equal(a.reason, b.reason, `drift on reason for ${JSON.stringify(g)}`);
    assert.equal(a.mobile, b.mobile, `drift on mobile for ${JSON.stringify(g)}`);
  }
});

test("the proceeding line matches the one on the letter", async () => {
  const { proceedingLine } = await import("../src/messageTemplates.js");
  const reqs = [
    { authority: "Scrutiny", section: "143(2)", ay: "2021-22" },
    { authority: "ITAT", section: "", ay: "2017-18" },
    { authority: "", section: "142(1)", ay: "" },
    { authority: "", section: "", ay: "2020-21" },
    {},
  ];
  for (const r of reqs) {
    assert.equal(core.proceedingLine(r), proceedingLine(r), `drift on ${JSON.stringify(r)}`);
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

/* ---------------- the client's copy of a notice ---------------- */

test("the client alert addresses the head and names the assessee separately", () => {
  /* Rajesh Shah is told about a notice issued to Shah Textiles Pvt. Ltd.
     Collapsing the two would greet a private limited company by name. */
  const p = core.noticeAlertClientParams(
    notice({ assessee: "Shah Textiles Pvt. Ltd.", pan: "AABCS9821K" }),
    { headName: "Rajesh M. Shah", firmName: "Mehta & Co." }
  );
  assert.equal(p.length, 7);
  assert.equal(p[0], "Rajesh M. Shah");
  assert.equal(p[2], "Shah Textiles Pvt. Ltd.");
  assert.equal(p[6], "Mehta & Co.");
  for (const v of p) assert.ok(String(v).trim().length > 0);
});

test("a client alert with almost nothing on file still sends", () => {
  for (const v of core.noticeAlertClientParams({}, {})) {
    assert.ok(String(v).trim().length > 0);
  }
});

/* ---------------- document requests ---------------- */

const request = (over = {}) => ({
  assessee: "Rajesh M. Shah", ay: "2017-18", authority: "ITAT", section: "",
  dueDate: "2026-08-20",
  items: [
    { label: "Audited financials", status: "pending" },
    { label: "Bank statements", status: "pending" },
    { label: "Ledger copies", status: "received" },
    { label: "Something waived", status: "waived" },
  ],
  ...over,
});

test("the count is what is still outstanding, not what was ever asked for", () => {
  /* The message and the attached list have to agree. The letter prints only
     askable items, so counting all four here would ask for two documents and
     attach a list of four. */
  const p = core.docRequestParams(request(), { headName: "Rajesh M. Shah", firmName: "Mehta & Co." });
  assert.equal(p[2], "2");
  assert.equal(core.askableItems(request()).length, 2);
});

test("the document request carries five parameters and not one of them is empty", () => {
  const p = core.docRequestParams(request(), { headName: "Rajesh M. Shah", firmName: "Mehta & Co." });
  assert.deepEqual(p, ["Rajesh M. Shah", "ITAT · AY 2017-18", "2", "20 August 2026", "Mehta & Co."]);
});

test("a request with no due date still makes a sentence", () => {
  /* The template reads "Please send these by {{4}}." — an empty parameter is
     rejected by Meta outright, and "by ." is not a sentence either way. */
  const p = core.docRequestParams(request({ dueDate: "" }), { headName: "Rajesh M. Shah" });
  assert.equal(p[3], "the earliest date you can");
  for (const v of p) assert.ok(String(v).trim().length > 0);
});

test("a bare request still produces five usable parameters", () => {
  for (const v of core.docRequestParams({}, {})) assert.ok(String(v).trim().length > 0);
});

/* ---------------- printing the letter ---------------- */

test("everything an English letter contains is printable", () => {
  const real = [
    "Bank statements of all accounts for FY 2016-17",
    "Amount: ₹1,32,000 — due 11 September 2026",
    "Rajesh M. Shah · Scrutiny u/s 142(1) · AY 2020-21",
    "photos can't be filed as they are — if you only have photos…",
    "Zoë Müller & Co.",   // Latin Extended, and a real client name shape
    "“Namaste”",          // curly quotes from the renderer
  ];
  for (const s of real) assert.equal(core.hasUnprintableScript(s), false, `flagged: ${s}`);
});

test("a translated letter is caught rather than printed as empty boxes", () => {
  /* The print font covers Latin. A Gujarati letter would render as tofu, which
     is worse than not sending — so it is refused and the caller falls back.
     When an Indic face is added beside Montserrat, this test is what changes. */
  assert.equal(core.hasUnprintableScript("બેંક સ્ટેટમેન્ટ"), true);
  assert.equal(core.hasUnprintableScript("बैंक स्टेटमेंट"), true);
  assert.equal(core.hasUnprintableScript("வங்கி அறிக்கை"), true);
});

test("the logo becomes a data URI, because the print page has no network", () => {
  const html = `<body><img src="https://prohippo.in/prohippo-logo.png" width="73"></body>`;
  const out = core.printableLetter(html, { logoDataUri: "data:image/png;base64,AAAA" });
  assert.ok(out.includes('src="data:image/png;base64,AAAA"'));
  assert.ok(!out.includes("https://prohippo.in/prohippo-logo.png"));
});

test("the older hosting URL for the logo is replaced too", () => {
  // LOGO_URL used to point at prohippo2.web.app; letters drafted then are still
  // in the database and still get sent.
  const html = `<body><img src="https://prohippo2.web.app/prohippo-logo.png"></body>`;
  const out = core.printableLetter(html, { logoDataUri: "data:image/png;base64,BBBB" });
  assert.ok(out.includes("data:image/png;base64,BBBB"));
  assert.ok(!out.includes("web.app"));
});

test("the font is attached wherever the letter's markup allows", () => {
  const face = "@font-face{font-family:'Montserrat';src:url(data:font/woff2;base64,XX)}";
  // The renderer emits <html><body> with no <head>.
  const noHead = core.printableLetter(`<!doctype html><html><body style="margin:0">hi</body></html>`, { fontFaceCss: face });
  assert.ok(noHead.includes(face));
  assert.ok(noHead.indexOf(face) > noHead.indexOf("<body"), "style must land inside body");
  // And it still works if a <head> ever appears.
  const withHead = core.printableLetter(`<html><head><title>x</title></head><body>hi</body></html>`, { fontFaceCss: face });
  assert.ok(withHead.includes(face));
  assert.ok(withHead.indexOf(face) < withHead.indexOf("</head>"));
});

test("printing changes nothing else about the letter", () => {
  /* The promise is that the attachment IS the email. Anything this function
     rewrites beyond the logo and the font is a second design creeping in. */
  const html = `<body><table><tr><td>1.</td><td>Audited financials</td></tr></table></body>`;
  const out = core.printableLetter(html, {});
  assert.ok(out.includes("<td>1.</td><td>Audited financials</td>"));
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

/* ---------------- the weekly cause list ---------------- */

test("Saturday's sweep sends the week that has not started yet", () => {
  // Saturday 15 Aug 2026 → Monday 17th to Sunday 23rd.
  assert.deepEqual(core.nextWeekRange("2026-08-15"), { from: "2026-08-17", to: "2026-08-23" });
});

test("every day of a week points at the same next week", () => {
  /* The sweep only runs on Saturdays, but the rule should not depend on that —
     a manual re-run on Monday morning must not produce a different sheet from
     the one already sent. Sunday is the trap: it is day 0, and the naive
     (dow + 6) % 7 that works everywhere else puts it in the week ahead. */
  const week = { from: "2026-08-17", to: "2026-08-23" };
  for (const day of ["2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14", "2026-08-15", "2026-08-16"]) {
    assert.deepEqual(core.nextWeekRange(day), week, `${day} pointed at the wrong week`);
  }
});

test("the week label says only as much as it needs to", () => {
  assert.equal(core.weekLabel("2026-08-17", "2026-08-23"), "17–23 August 2026");
  assert.equal(core.weekLabel("2026-08-31", "2026-09-06"), "31 August – 6 September 2026");
  assert.equal(core.weekLabel("2025-12-29", "2026-01-04"), "29 December 2025 – 4 January 2026");
});

test("the breakdown names the forums and always reads the same way", () => {
  const hearings = [
    { authority: "ITAT" }, { authority: "Scrutiny" }, { authority: "ITAT" },
    { authority: "CIT(A)" }, { authority: "Scrutiny" }, { authority: "Scrutiny" },
  ];
  assert.equal(core.causeListBreakdown(hearings), "3 Scrutiny, 2 ITAT, 1 CIT(A)");
  // Firestore hands documents back in its own order; the same week must not
  // read differently from one Saturday to the next.
  const shuffled = [...hearings].reverse();
  assert.equal(core.causeListBreakdown(shuffled), core.causeListBreakdown(hearings));
});

test("a hearing with no authority is still counted", () => {
  assert.equal(core.causeListBreakdown([{ authority: "" }, { authority: "ITAT" }]), "1 ITAT, 1 Other");
});

test("the cause list carries three parameters and not one of them is empty", () => {
  const p = core.causeListParams([{ authority: "ITAT" }], { from: "2026-08-17", to: "2026-08-23" });
  assert.deepEqual(p, ["17–23 August 2026", "1", "1 ITAT"]);
  for (const v of p) assert.ok(String(v).trim().length > 0);
});

test("the attachment is named something a phone can save", () => {
  const name = core.causeListFileName({ from: "2026-08-17", to: "2026-08-23" });
  assert.equal(name, "Cause list 17to23 August 2026.pdf");
  // No en dash, no double spaces — both travel badly as filenames.
  assert.ok(!name.includes("–"));
  assert.ok(!name.includes("  "));
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
