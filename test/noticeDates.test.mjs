/* The dates on a notice, and what became of the reply.
 *
 *   node --test test/noticeDates.test.mjs
 *
 * Two things are being pinned. First, that a due date is said as loudly as it
 * deserves and no louder — a card where every date is red is a card whose
 * colours mean nothing. Second, that a date claimed to be "viewed by AO" really
 * looks like a date: a practitioner may ring a client off the back of it, so a
 * wrong one is worse than none at all.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  daysUntilDate, dueTone, dueLabel,
  viewedByOfficer, unnamedFields, looksLikeDate, fmtPortalDate,
} from "../src/noticeDates.js";

const TODAY = new Date("2026-06-10T09:30:00");

/* ---------------- how far away it is ---------------- */

test("days are counted whole, from midnight, whatever the time of day", () => {
  assert.equal(daysUntilDate("2026-06-10", TODAY), 0, "later the same day is still today");
  assert.equal(daysUntilDate("2026-06-11", TODAY), 1);
  assert.equal(daysUntilDate("2026-06-01", TODAY), -9);
  assert.equal(daysUntilDate("", TODAY), null);
  assert.equal(daysUntilDate("not a date", TODAY), null);
});

test("only a date worth shouting about is loud", () => {
  assert.equal(dueTone("2026-06-01", TODAY).state, "overdue");
  assert.equal(dueTone("2026-06-10", TODAY).state, "today");
  assert.equal(dueTone("2026-06-12", TODAY).state, "urgent");
  assert.equal(dueTone("2026-06-18", TODAY).state, "soon");
  assert.equal(dueTone("2026-08-01", TODAY).state, "open");

  // The whole point of the scale: a date seven weeks out is stated in grey.
  assert.equal(dueTone("2026-08-01", TODAY).loud, false);
  assert.equal(dueTone("2026-06-01", TODAY).loud, true);
});

test("overdue is red, closing is amber, and nothing else is coloured", () => {
  assert.equal(dueTone("2026-06-01", TODAY).colour, "#B23B3B");
  assert.equal(dueTone("2026-06-18", TODAY).colour, "#B07512");
  assert.equal(dueTone("2026-08-01", TODAY).colour, "var(--p-text-3)");
});

test("the label says the thing a practitioner would say out loud", () => {
  assert.equal(dueLabel("2026-06-06", TODAY), "overdue by 4 days");
  assert.equal(dueLabel("2026-06-09", TODAY), "overdue by 1 day");
  assert.equal(dueLabel("2026-06-10", TODAY), "due today");
  assert.equal(dueLabel("2026-06-11", TODAY), "1 day left");
  assert.equal(dueLabel("2026-06-20", TODAY), "10 days left");
  assert.equal(dueLabel("", TODAY), "");
});

/* ---------------- did the officer open it ---------------- */

const reply = (extra) => ({ responseId: "R1", submittedOn: "1749513600000", extra });

test("the viewed date is found whatever the portal calls the field", () => {
  /* ITBA is not consistent across its own services, so the name is matched
     rather than assumed: case and separators are ignored. */
  for (const key of ["viewedOn", "viewed_on", "VIEWED_DATE", "viewedDt", "aoViewedOn", "responseViewedOn", "seenOn"]) {
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
  assert.deepEqual(unnamedFields({ responseId: "R1" }), []);
});

test("fields we have no name for are surfaced, minus the one we do", () => {
  /* This is the discovery hatch: the real name of the viewed field gets read
     off a live reply instead of guessed at again. */
  const r = reply({ viewedOn: "12/06/2026", ackNo: "ACK9", someFlag: true, respStatus: "Submitted" });
  assert.equal(viewedByOfficer(r).key, "viewedOn");
  assert.deepEqual(
    unnamedFields(r).map((f) => f.key).sort(),
    ["ackNo", "respStatus", "someFlag"],
    "the recognised field is not repeated in the raw list"
  );
});

test("with nothing recognised, every field is offered for identification", () => {
  const r = reply({ someUnknownDate: "12/06/2026", respStatus: "Submitted" });
  assert.equal(viewedByOfficer(r), null);
  assert.equal(unnamedFields(r).length, 2, "including the one that is probably it");
});

/* ---------------- rendering what the portal sent ---------------- */

test("both date shapes the portal uses come out readable", () => {
  assert.match(fmtPortalDate(1781308800000), /2026/);
  assert.equal(fmtPortalDate("12/06/2026"), "12/06/2026", "printed text is left as printed");
  assert.equal(fmtPortalDate(""), "");
  assert.equal(fmtPortalDate(null), "");
});
