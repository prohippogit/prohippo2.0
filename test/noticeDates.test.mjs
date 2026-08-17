/* "Response viewed by AO on" — reading it out of whatever the portal calls it.
 *
 *   node --test test/noticeDates.test.mjs
 *
 * What is pinned here is that a date the card claims the officer opened a reply
 * on really is a date. A practitioner may ring a client off the back of it, so
 * a wrong one is worse than none at all.
 *
 * There is deliberately NO countdown to test. The card used to print "overdue
 * by 695 days" beside a 2024 hearing notice in an appeal the client had since
 * answered twice — arithmetically right, and the reason nobody would read the
 * card again.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { viewedByOfficer, looksLikeDate, fmtPortalDate } from "../src/noticeDates.js";

/* ---------------- did the officer open it ---------------- */

const reply = (extra) => ({ responseId: "R1", submittedOn: "1749513600000", extra });

test("the viewed date is found whatever the portal calls the field", () => {
  /* ITBA is not consistent across its own services, so the name is matched
     rather than assumed: case and separators are ignored. */
  for (const key of ["responseViewedByAoOn", "viewedByAO", "aoViewedOn", "viewedOn", "viewed_on", "VIEWED_DATE", "viewedDt", "responseViewedOn", "seenOn"]) {
    const out = viewedByOfficer(reply({ [key]: "12/06/2026" }));
    assert.ok(out, `${key} should have been recognised`);
    assert.equal(out.key, key, "and it reports which field it came from");
    assert.equal(out.value, "12/06/2026");
  }
});

test("a flag is not a date, however promising its name", () => {
  /* THE failure this guard exists for. "isViewed: 1" or "viewStatus: Y" says
     the officer looked but not when, and rendering either as "viewed by AO 1"
     would be worse than saying nothing. */
  assert.equal(viewedByOfficer(reply({ viewedOn: "Y" })), null);
  assert.equal(viewedByOfficer(reply({ viewedOn: 1 })), null);
  assert.equal(viewedByOfficer(reply({ viewedOn: true })), null);
  assert.equal(viewedByOfficer(reply({ viewedOn: "" })), null);
});

test("epoch millis are a date; a bare id is not", () => {
  assert.equal(looksLikeDate(1781308800000), true, "13 digits, inside living memory");
  assert.equal(looksLikeDate("2026-06-12"), true);
  assert.equal(looksLikeDate("12/06/2026"), true);
  assert.equal(looksLikeDate("12.06.2026"), true);
  // A 10-digit number is as likely to be a reference number as a timestamp,
  // and a DIN read as a date would be nonsense on the card.
  assert.equal(looksLikeDate(1749513600), false);
  assert.equal(looksLikeDate("100114013089"), false);
  assert.equal(looksLikeDate("Submitted"), false);
});

test("a reply the portal said nothing extra about reports nothing", () => {
  assert.equal(viewedByOfficer({ responseId: "R1" }), null);
  assert.equal(viewedByOfficer({ responseId: "R1", extra: {} }), null);
  assert.equal(viewedByOfficer(null), null);
});

test("the field the portal actually uses is the one that is read", () => {
  /* The name, confirmed from live traffic rather than matched by luck:
     eProceedingDetailsService states `responseViewedByAoOn` on the notice, in
     epoch milliseconds, beside `lastResponseSubmittedOn` and `respStatus`. */
  const notice = { extra: { responseViewedByAoOn: 1709683200000, respStatus: "S", readFlag: "Y", proceedingReqId: "32725557" } };
  const out = viewedByOfficer(notice);
  assert.equal(out.key, "responseViewedByAoOn");
  assert.match(fmtPortalDate(out.value), /2024/);
});

test("everything else in `extra` is carried but never rendered", async () => {
  /* The discovery hatch is closed. `extra` still holds what the portal sent —
     that is where the date above comes from — but there is no longer a helper
     that turns the leftovers into screen output, and the card that used to print
     them (`readFlag: Y`, `proceedingLimitationDate: 1711823400000`,
     `nameOfAssesse`) does not. A reply card shows the reply. */
  const mod = await import("../src/noticeDates.js");
  assert.equal(mod.unnamedFields, undefined, "no helper exists to list the raw fields");
});

/* ---------------- rendering what the portal sent ---------------- */

test("both date shapes the portal uses come out readable", () => {
  assert.match(fmtPortalDate(1781308800000), /2026/);
  assert.equal(fmtPortalDate("12/06/2026"), "12/06/2026", "printed text is left as printed");
  assert.equal(fmtPortalDate(""), "");
  assert.equal(fmtPortalDate(null), "");
});

/* ---------------- the notice is where the portal prints it ---------------- */

test("the notice is asked before the reply, because that is where the label is", () => {
  /* "View Notices for e-Proceedings" prints "Response viewed by AO on" on the
     NOTICE block, under the response due date — not on the reply. */
  const notice = { din: "100116461153", extra: { responseViewedByAoOn: "21-Jul-2026" } };
  const rsp = { responseId: "R1", extra: { viewedOn: "01-Jan-2026" } };
  assert.equal(viewedByOfficer(notice, rsp).value, "21-Jul-2026");
});

test("the reply still answers when the notice has nothing", () => {
  const notice = { din: "1", extra: { respStatus: "Submitted" } };
  const rsp = { responseId: "R1", extra: { viewedOn: "21-Jul-2026" } };
  assert.equal(viewedByOfficer(notice, rsp).value, "21-Jul-2026");
});

test("a record with no extra at all is skipped, not thrown on", () => {
  assert.equal(viewedByOfficer(null, undefined, {}), null);
  assert.equal(viewedByOfficer({ extra: { viewedOn: "21-Jul-2026" } }, null).value, "21-Jul-2026");
});

test("the format the portal actually prints is recognised", () => {
  /* "Response viewed by AO on : 21-Jul-2026" — a month NAME, not digits. The
     first version of this check was digits-only and rejected the one format it
     was written for. */
  assert.equal(looksLikeDate("21-Jul-2026"), true);
  assert.equal(looksLikeDate("21-JUL-2026"), true);
  assert.equal(looksLikeDate("1 Jul 26"), true);
  assert.equal(looksLikeDate("Jul"), false, "a month on its own is not a date");
  // And it survives verbatim: re-formatting would make the app and the portal
  // disagree over the same fact.
  assert.equal(fmtPortalDate("21-Jul-2026"), "21-Jul-2026");
});
