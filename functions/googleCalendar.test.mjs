/* Unit tests for the pure half of the calendar sync — the parts where a quiet
 * off-by-one shows up in someone's diary rather than in a stack trace.
 *
 * Run:  node functions/googleCalendar.test.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { eventIdFor, hashOf, endOf, hearingEvent, deadlineEvent, icsEscape, icsDateTime, fold } =
  require("./googleCalendar.js").helpers;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const HEARING = {
  assessee: "Rajesh M. Shah",
  pan: "ABCPS1234F",
  ay: "2017-18",
  authority: "ITAT",
  bench: "Ahmedabad 'A' Bench",
  section: "68",
  date: "2026-07-29",
  time: "11:30",
  mode: "Physical",
  status: "Upcoming",
  ita: "ITA No. 1244/Ahd/2024",
  staff: "Priya Mehta",
};

/* ---- idempotency ---- */

test("event IDs are stable, kind-scoped and legal for Google", () => {
  const id = eventIdFor("hearing", "abc123");
  assert.equal(id, eventIdFor("hearing", "abc123"), "same input must give the same ID");
  assert.notEqual(id, eventIdFor("deadline", "abc123"), "a hearing and a deadline must not collide");
  // Google accepts base32hex (a-v, 0-9), 5-1024 chars.
  assert.match(id, /^[a-v0-9]{5,1024}$/);
});

test("the hash only moves when the event does", () => {
  const a = hearingEvent(HEARING, { detailed: true });
  const b = hearingEvent({ ...HEARING }, { detailed: true });
  assert.equal(hashOf(a), hashOf(b), "an unchanged hearing must not trigger an API call");
  assert.notEqual(hashOf(a), hashOf(hearingEvent({ ...HEARING, time: "14:00" }, { detailed: true })));
  assert.notEqual(hashOf(a), hashOf(hearingEvent(HEARING, { detailed: false })), "the privacy switch must force a rewrite");
});

/* ---- time arithmetic ---- */

test("hearing end times add an hour", () => {
  assert.deepEqual(endOf("2026-07-29", "11:30", 60), { date: "2026-07-29", time: "12:30" });
  assert.deepEqual(endOf("2026-07-29", "09:05", 60), { date: "2026-07-29", time: "10:05" });
  assert.deepEqual(endOf("2026-07-29", "", 60), { date: "2026-07-29", time: "12:00" }, "a malformed time must not produce NaN:NaN");
});

test("a hearing running past midnight ends on the next day, not before it started", () => {
  // Wrapping the clock alone would give 00:30 on the SAME date — an end before
  // its own start, which Google rejects outright.
  assert.deepEqual(endOf("2026-07-29", "23:30", 60), { date: "2026-07-30", time: "00:30" });
  assert.deepEqual(endOf("2026-12-31", "23:45", 60), { date: "2027-01-01", time: "00:45" });

  const ev = hearingEvent({ ...HEARING, date: "2026-07-29", time: "23:30" }, { detailed: true });
  assert.ok(ev.end.dateTime > ev.start.dateTime, "the event must not end before it begins");
});

test("hearings carry an explicit IST offset", () => {
  const ev = hearingEvent(HEARING, { detailed: true });
  assert.equal(ev.start.dateTime, "2026-07-29T11:30:00+05:30");
  assert.equal(ev.end.dateTime, "2026-07-29T12:30:00+05:30");
  assert.equal(ev.start.timeZone, "Asia/Kolkata");
});

test("an all-day deadline ends the next morning, not the next evening", () => {
  // Google treats an all-day event's `end` as exclusive. Get this wrong and
  // every deadline reads as a two-day block.
  const ev = deadlineEvent({ kind: "appeal", title: "CIT(A) appeal — last date to file", date: "2026-08-31" }, { detailed: false });
  assert.equal(ev.start.date, "2026-08-31");
  assert.equal(ev.end.date, "2026-09-01");
});

test("month and year boundaries roll over correctly", () => {
  assert.equal(deadlineEvent({ title: "x", date: "2026-12-31" }, { detailed: false }).end.date, "2027-01-01");
  assert.equal(deadlineEvent({ title: "x", date: "2028-02-29" }, { detailed: false }).end.date, "2028-03-01");
});

/* ---- the privacy switch ---- */

test("client details appear only when the switch is on", () => {
  const on = hearingEvent(HEARING, { detailed: true });
  assert.match(on.summary, /Rajesh M\. Shah/);
  assert.match(on.description, /ABCPS1234F/);
  assert.match(on.description, /ITA No\. 1244/);
  assert.equal(on.location, "Ahmedabad 'A' Bench");

  const off = hearingEvent(HEARING, { detailed: false });
  assert.doesNotMatch(off.summary, /Shah/, "no client name may reach Google when the switch is off");
  assert.doesNotMatch(off.description, /ABCPS1234F/, "no PAN may reach Google when the switch is off");
  assert.doesNotMatch(off.description, /1244/, "no case number may reach Google when the switch is off");
  assert.equal(off.location, "", "the bench identifies the matter too");
  assert.match(off.summary, /AY 2017-18/, "it still has to be recognisable as something");
});

test("an adjourned hearing is marked, not deleted", () => {
  const ev = hearingEvent({ ...HEARING, status: "Adjourned" }, { detailed: true });
  assert.match(ev.summary, /^\[Adjourned\]/);
});

/* ---- ICS ---- */

test("ICS special characters are escaped", () => {
  assert.equal(icsEscape("Shah, Textiles; Pvt"), "Shah\\, Textiles\\; Pvt");
  assert.equal(icsEscape("line one\nline two"), "line one\\nline two");
});

test("ICS timestamps drop the separators", () => {
  assert.equal(icsDateTime("2026-07-29", "11:30"), "20260729T113000");
});

test("long ICS lines fold to 75 octets with a leading space", () => {
  const folded = fold("SUMMARY:" + "a".repeat(200));
  const parts = folded.split("\r\n");
  assert.ok(parts.length > 1, "a 208-character line must be folded");
  assert.ok(parts.every((p) => p.length <= 75), "no folded line may exceed 75 octets");
  parts.slice(1).forEach((p) => assert.ok(p.startsWith(" "), "continuation lines must start with a space"));
  // Unfolding — strip each CRLF and the space that follows it — must give the
  // original line back byte for byte.
  assert.equal(folded.replace(/\r\n /g, ""), "SUMMARY:" + "a".repeat(200));
  assert.equal(fold("SHORT:line"), "SHORT:line", "short lines are left alone");
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`FAIL  ${name}\n      ${e.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
