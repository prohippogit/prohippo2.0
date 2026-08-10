/* Reading the Tribunal's two emails.
 *
 *   node --test test/itatEmail.test.mjs
 *
 * The fixtures below are the real messages — a Registration & Scrutiny Summary
 * and a Notice of Hearing, transcribed from copies received by a practitioner,
 * with the PANs and names left as they came so the patterns are exercised
 * against the shapes the Tribunal actually sends rather than tidied ones.
 *
 * What is pinned here is the date and the appeal number, above everything else.
 * A hearing written into somebody's diary on the wrong day is the failure this
 * feature exists to prevent, and a second appeal number that reads as a
 * different appeal is how one matter silently becomes two.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  toISODate, toISOTime, normaliseAy, findAppealNo, canonicalAppealNo, benchName,
  plainTextOf, findPan, findAy, senderDomain, isTribunalSender, gmailConfirmation,
  classify, parseItatEmail, originalSenderOf, forwardedByOf, messageKey,
  matterIdFor, hearingIdFor, fromJson, fromForm,
  emailAddressesIn, addressKey, normaliseAddress, isEmailAddress,
  tableRows, partiesOf, statusFromPan,
} = require("../functions/itatEmailParse.js");

const ALIAS = "a1b2c3d4e5f60718@prohippo.info";

const ITAT = "ITAT Online <no-reply@itat.nic.in>";

const REGISTRATION = {
  from: ITAT,
  subject: "Registration & Scrutiny Summary - ITA 2635/AHD/2026 - Assessment Year: 2014-15",
  html: `<div><table><tr><td><b>Income Tax Appellate Tribunal, Ahmedabad</b></td></tr></table>
    <p>Dear Assessee,</p>
    <p>The Appeal / Cross Objection / Stay Application / Miscellaneous Application filed by you in
    AAWPM8125C on 23-Jul-2026 for the Assessment Year 2014-15 has been registered as
    <b>ITA 2635/AHD/2026</b>. A Registration &amp; Scrutiny Summary is attached herewith for
    information and further necessary action.</p>
    <p>Team ITAT</p>
    <div>Contact Us: <a href="mailto:ahmedabad.bench@itat.nic.in">ahmedabad.bench@itat.nic.in</a></div></div>`,
  text: "",
  messageId: "<reg-2635@itat.nic.in>",
};

const HEARING = {
  from: ITAT,
  subject: "Notice of Hearing in ITA 2530/AHD/2026 (Date of Hearing: 2026-Sep-15)",
  html: `<table>
    <tr><td>आयकर अपीलीय अधिकरण, अहमदाबाद पीठें, अहमदाबाद</td>
        <td>INCOME TAX APPELLATE TRIBUNAL, AHMEDABAD</td></tr>
    <tr><td colspan="2">अपील संख्या / In Appeal No. <b>ITA 2530/AHD/2026</b> में<br>
        (निर्धारण वर्ष Assessment Year: 2016-17)<br>
        (स्थायी खाता संख्या Permanent Account Number: BLGPG1814C)<br>
        Hearing Bench: <b>D</b> , Case Type: <b>DBC</b></td></tr>
    <tr><td>JAPAN RAJNIKANT GANDHI</td><td>Ward 1, Internation Taxation, Ahmedabad</td></tr>
    <tr><td>Appellant</td><td>Respondent</td></tr>
    <tr><td colspan="2">Take notice that the above appeal has been fixed for hearing at 3rd &amp; 4th Floor,
        Abhinav Arcade, Near Bank of Baroda, Opp: Municipal School, Ellis Bridge, Ahmedabad - 380006,
        Gujarat at 10.30 a.m on 15-Sep-2026 (Tue).</td></tr>
    <tr><td>Last fixed for hearing on:</td><td></td></tr>
    <tr><td colspan="2">तारीख Date: 31-Jul-2026 (Fri)</td></tr>
  </table>`,
  text: "",
  messageId: "<hearing-2530@itat.nic.in>",
};

/* ---------------- the small pieces ---------------- */

test("a date is the same day whichever way the Tribunal writes it", () => {
  // The body writes 15-Sep-2026 and the subject writes 2026-Sep-15.
  assert.equal(toISODate("15-Sep-2026"), "2026-09-15");
  assert.equal(toISODate("2026-Sep-15"), "2026-09-15");
  assert.equal(toISODate("23-Jul-2026"), "2026-07-23");
  assert.equal(toISODate("2026-09-15"), "2026-09-15");
  assert.equal(toISODate("not a date"), "", "an unreadable date is empty, never today");
  assert.equal(toISODate(""), "");
});

test("10.30 a.m is half past ten in the morning, and 12 is not midnight", () => {
  assert.equal(toISOTime("10", "30", "a.m"), "10:30");
  assert.equal(toISOTime("2", "15", "p.m"), "14:15");
  assert.equal(toISOTime("12", "30", "p.m"), "12:30", "noon stays noon");
  assert.equal(toISOTime("12", "05", "a.m"), "00:05", "midnight is 00, not 12");
  assert.equal(toISOTime("25", "00", "a.m"), "", "nonsense is empty rather than wrong");
});

test("an assessment year is stored the one way the app writes it", () => {
  assert.equal(normaliseAy("2014-15"), "2014-15");
  assert.equal(normaliseAy("2014-2015"), "2014-15");
  assert.equal(normaliseAy("2016 – 17"), "2016-17");
  assert.equal(normaliseAy("nothing here"), "");
});

test("one appeal number, however it is written", () => {
  const canonical = "ITA 1244/AHD/2024";
  for (const written of [
    "ITA 1244/AHD/2024",
    "ITA No. 1244/Ahd/2024",
    "ITA no 1244 / ahd / 2024",
    "ITA Nos. 1244/AHD/2024",
    "in ITA 01244/AHD/2024 the",
  ]) {
    assert.equal(canonicalAppealNo(written), canonical, `"${written}" is the same appeal`);
  }
  assert.equal(findAppealNo("no appeal number here"), "");
  assert.equal(findAppealNo("CO 12/MUM/2025"), "CO 12/MUM/2025", "cross objections too");
});

test("two spellings of one appeal share a matter, two appeals do not", () => {
  assert.equal(
    matterIdFor("ITA No. 2635/Ahd/2026"), matterIdFor("ITA 2635/AHD/2026"),
    "a re-sent email must merge into the matter it already wrote, not add a second"
  );
  assert.notEqual(matterIdFor("ITA 2635/AHD/2026"), matterIdFor("ITA 2636/AHD/2026"));
});

test("a re-fixed hearing is a new record, not an overwrite of the old date", () => {
  const first = hearingIdFor("ITA 2530/AHD/2026", "2026-09-15");
  assert.equal(first, hearingIdFor("ITA No. 2530/Ahd/2026", "2026-09-15"));
  assert.notEqual(first, hearingIdFor("ITA 2530/AHD/2026", "2026-11-03"));
});

test("the bench reads the way the app writes benches", () => {
  assert.equal(benchName("ITA 2530/AHD/2026", "D"), "Ahmedabad 'D' Bench");
  assert.equal(benchName("ITA 2635/AHD/2026", ""), "Ahmedabad Bench");
  assert.equal(benchName("ITA 987/MUM/2024", "C"), "Mumbai 'C' Bench");
  // An unknown registry is shown as its own code rather than swallowed.
  assert.equal(benchName("ITA 1/ZZZ/2026", "A"), "ZZZ 'A' Bench");
});

test("flattening the notice keeps cells apart", () => {
  const flat = plainTextOf("<tr><td>Hearing Bench: D</td><td>Ward 1, Ahmedabad</td></tr>");
  assert.match(flat, /Hearing Bench: D\s+Ward 1/, "a cell must not run into the next one");
  assert.equal(plainTextOf("<p>a &amp; b</p>").trim(), "a & b");
});

/* ---------------- who sent it ---------------- */

test("only the Tribunal's own domain is accepted", () => {
  assert.equal(senderDomain(ITAT), "itat.nic.in");
  assert.ok(isTribunalSender(ITAT));
  assert.ok(isTribunalSender("no-reply@itat.nic.in"));
  assert.ok(!isTribunalSender("no-reply@itat.nic.in.example.com"), "a lookalike domain is not the Tribunal");
  assert.ok(!isTribunalSender("someone@gmail.com"));
  assert.ok(!isTribunalSender(""));
});

test("a client's inline forward is still recognised by what it quotes", () => {
  const forwarded = {
    from: "Kavita Joshi <kavita.j@example.com>",
    subject: "Fwd: Notice of Hearing in ITA 2530/AHD/2026",
    text: "Sir, please see below.\n\n---------- Forwarded message ---------\nFrom: ITAT Online <no-reply@itat.nic.in>\nDate: Fri, 31 Jul 2026\n\nfixed for hearing at 10.30 a.m on 15-Sep-2026 (Tue).",
    html: "",
  };
  assert.equal(originalSenderOf(forwarded), "no-reply@itat.nic.in");
  assert.equal(originalSenderOf({ from: "a@b.com", text: "From: spoof@evil.com\nhello", html: "" }), "",
    "a quoted sender that is not the Tribunal buys nothing");
});

test("a rule-based forward says which mailbox it came through", () => {
  assert.equal(
    forwardedByOf("Subject: x\nX-Forwarded-For: chavdagreen@gmail.com abc123@prohippo.info\nTo: y"),
    "chavdagreen@gmail.com"
  );
  assert.equal(forwardedByOf("Subject: x"), "");
});

test("the same message twice is the same message", () => {
  assert.equal(messageKey(REGISTRATION), messageKey({ ...REGISTRATION, subject: "Fwd: " + REGISTRATION.subject }),
    "a Message-ID identifies the mail whatever a forwarder does to the subject");
  assert.notEqual(messageKey(REGISTRATION), messageKey(HEARING));
});

/* ---------------- the two emails ---------------- */

test("the registration email is read", () => {
  const { kind, fields } = parseItatEmail(REGISTRATION);
  assert.equal(kind, "registration");
  assert.equal(fields.appealNo, "ITA 2635/AHD/2026");
  assert.equal(fields.pan, "AAWPM8125C");
  assert.equal(fields.ay, "2014-15");
  assert.equal(fields.filedOn, "2026-07-23");
  assert.equal(fields.bench, "Ahmedabad Bench");
});

test("the notice of hearing is read", () => {
  const { kind, fields } = parseItatEmail(HEARING);
  assert.equal(kind, "hearing");
  assert.equal(fields.appealNo, "ITA 2530/AHD/2026");
  assert.equal(fields.pan, "BLGPG1814C");
  assert.equal(fields.ay, "2016-17");
  assert.equal(fields.date, "2026-09-15", "the hearing date is the one thing that must never be wrong");
  assert.equal(fields.time, "10:30");
  assert.equal(fields.bench, "Ahmedabad 'D' Bench");
  assert.equal(fields.benchLetter, "D");
  assert.equal(fields.caseType, "DBC");
  assert.match(fields.venue, /Abhinav Arcade/);
  assert.equal(fields.lastFixedOn, "", "a first hearing has no earlier date, and must not invent one");
});

/* ---------------- who the appeal belongs to ----------------
 *
 * The name, the address and the PAN are what let the client's file be opened
 * from the email instead of typed, so they are pinned as hard as the date is.
 * The trap throughout is the second column: the respondent is the Department,
 * and filing an appeal under the Assessing Officer's name would be worse than
 * reading no name at all. */

test("a notice is read as a table, not as a line of run-together text", () => {
  const rows = tableRows("<table><tr><td>A</td><td>B</td></tr><tr><th>C</th></tr></table>");
  assert.deepEqual(rows, [["A", "B"], ["C"]]);
  assert.deepEqual(tableRows(""), [], "an email with no HTML part is no rows, not a crash");
});

test("the appellant is read from the column the word Appellant labels", () => {
  const { fields } = parseItatEmail(HEARING);
  assert.equal(fields.appellant, "JAPAN RAJNIKANT GANDHI");
  assert.equal(fields.appellantAddress, "", "this notice gives no address, and one is not invented");
  assert.ok(!/Ward 1/i.test(fields.appellant), "the respondent is the Department, never the client");
});

test("an address written under the name comes through as one line", () => {
  const withAddress = {
    ...HEARING,
    html: HEARING.html.replace(
      "<tr><td>JAPAN RAJNIKANT GANDHI</td>",
      "<tr><td>SANJAYKUMAR DEVCHANDBHAI PATEL<br>401, AVDHESH HOUSE, OPP. GURUDWARA<br>S. G. HIGH WAY, Ahmedabad, Gujarat, 380054</td>"
    ),
  };
  const { fields } = parseItatEmail(withAddress);
  assert.equal(fields.appellant, "SANJAYKUMAR DEVCHANDBHAI PATEL");
  assert.equal(
    fields.appellantAddress,
    "401, AVDHESH HOUSE, OPP. GURUDWARA, S. G. HIGH WAY, Ahmedabad, Gujarat, 380054"
  );
});

test("the appeal's own particulars are not mistaken for a party", () => {
  // The row above the label carries the appeal number and PAN when the party
  // block is short; opening a client's file named "In Appeal No. …" is the
  // failure this guards.
  assert.deepEqual(partiesOf("<table><tr><td>In Appeal No. ITA 1/AHD/2026</td></tr><tr><td>Appellant</td></tr></table>"), {});
  assert.deepEqual(partiesOf("<table><tr><td>Nobody here</td></tr></table>"), {}, "no label, no party");
  assert.deepEqual(partiesOf(""), {});
});

test("what a PAN says the assessee is", () => {
  // The fourth character, by the rule in the Act — so a trust is filed as a
  // trust rather than defaulting to Individual and being quietly wrong.
  assert.equal(statusFromPan("BLGPG1814C"), "Individual");
  assert.equal(statusFromPan("aawcm8125c"), "Company", "lower case is the same PAN");
  assert.equal(statusFromPan("AAAHM1234F"), "HUF");
  assert.equal(statusFromPan("AAAFM1234F"), "Firm");
  assert.equal(statusFromPan("AAATM1234F"), "Trust");
  assert.equal(statusFromPan("AAAAM1234F"), "AOP/BOI");
  // Blank, not a plausible wrong answer, for the letters the rule does not
  // cover and for anything that is not a PAN — the same as typing one in by
  // hand does (entityFromPan in src/AssesseeModal.jsx).
  assert.equal(statusFromPan("AAAGM1234F"), "", "a government PAN is not an individual");
  assert.equal(statusFromPan(""), "", "an unreadable PAN is left blank rather than throwing");
});

test("the hearing date survives a forward that keeps only the subject", () => {
  // An inline forward from a phone commonly drops the HTML part entirely.
  const stripped = { ...HEARING, html: "", text: "Please see the attached notice of hearing." };
  const { kind, fields } = parseItatEmail(stripped);
  assert.equal(kind, "hearing");
  assert.equal(fields.appealNo, "ITA 2530/AHD/2026", "the subject carries the appeal number");
  assert.equal(fields.date, "2026-09-15", "and the date, in the other format");
  assert.equal(fields.time, "", "what was not sent is left empty rather than guessed");
});

/* ---------------- what a forward does to the message ----------------
 *
 * A forward arrives as two alternatives: the Tribunal's HTML, and a plain-text
 * rendition the forwarding client made from it. The rendition is lossy — Gmail
 * drops table cells — and it carries a header of its own that looks a great
 * deal like the fields being searched for. Both facts have put wrong data on a
 * card, so both are pinned here. */

// Gmail's own preamble, above a rendition that lost the particulars cell.
const GMAIL_FORWARD_TEXT = `---------- Forwarded message ---------
From: ITAT Online <no-reply@itat.nic.in>
Date: Mon, 10 Aug 2026 at 5:24 PM
Subject: Notice of Hearing in ITA 2530/AHD/2026 (Date of Hearing: 2026-Sep-15)
To: <chavdagreen@gmail.com>

INCOME TAX APPELLATE TRIBUNAL, AHMEDABAD`;

test("a forward's own timestamp is never read as the hearing time", () => {
  // "Date: … at 5:24 PM" is when the email was sent. Writing that into a diary
  // as the hearing time is the worst thing this parser could do quietly.
  const forwarded = { ...HEARING, text: GMAIL_FORWARD_TEXT };
  const { fields } = parseItatEmail(forwarded);
  assert.equal(fields.time, "10:30", "the Tribunal's time, not the forwarder's clock");
  assert.equal(fields.date, "2026-09-15");
});

test("a time with nothing around it to anchor it is left blank", () => {
  const noNotice = { ...HEARING, html: "", text: GMAIL_FORWARD_TEXT };
  const { fields } = parseItatEmail(noNotice);
  assert.equal(fields.time, "", "blank is a visible gap; a wrong time is not");
  assert.equal(fields.date, "2026-09-15", "the quoted subject still carries the date");
});

test("a field the text rendition lost is still read out of the HTML", () => {
  // This is the reported failure: the card showed the appeal number and PAN but
  // no assessment year and a bench with no letter, because the text part won
  // outright and the Tribunal's own table was never looked at.
  const forwarded = { ...HEARING, text: GMAIL_FORWARD_TEXT };
  const { fields } = parseItatEmail(forwarded);
  assert.equal(fields.ay, "2016-17");
  assert.equal(fields.benchLetter, "D");
  assert.equal(fields.caseType, "DBC");
  assert.equal(fields.bench, "Ahmedabad 'D' Bench");
  assert.equal(fields.appellant, "JAPAN RAJNIKANT GANDHI", "the party table is in the HTML too");
});

test("emphasis left behind by a text rendition is not part of the value", () => {
  const asText = {
    ...HEARING,
    html: "",
    text: `In Appeal No. ITA 2530/AHD/2026
(Assessment Year: 2016-17)
(Permanent Account Number: BLGPG1814C)
Hearing Bench: *D* , Case Type: *DBC*
fixed for hearing at Abhinav Arcade, Ahmedabad at 10.30 a.m on 15-Sep-2026 (Tue).`,
  };
  const { fields } = parseItatEmail(asText);
  assert.equal(fields.benchLetter, "D", "*D* is bench D, not a bench called '*D*'");
  assert.equal(fields.caseType, "DBC");
  assert.equal(fields.time, "10:30");
});

test("an adjourned hearing carries the date it displaced", () => {
  const refixed = {
    ...HEARING,
    html: HEARING.html.replace("Last fixed for hearing on:</td><td></td>", "Last fixed for hearing on:</td><td>15-Sep-2026 (Tue)</td>"),
  };
  assert.equal(parseItatEmail(refixed).fields.lastFixedOn, "2026-09-15");
});

test("mail from anyone else is refused before it is read", () => {
  const spoof = { ...HEARING, from: "Someone <hello@example.com>", text: "", messageId: "<x@example.com>" };
  const out = parseItatEmail(spoof);
  assert.equal(out.kind, "unrecognised");
  assert.equal(out.reason, "sender-not-allowed");
  assert.deepEqual(out.fields, {}, "nothing is extracted from mail we do not accept");
});

test("a Tribunal email in an unknown shape is recorded, not guessed at", () => {
  const other = { from: ITAT, subject: "Office order", text: "The registry will be closed on Monday.", html: "" };
  const out = parseItatEmail(other);
  assert.equal(out.kind, "unrecognised");
  assert.equal(out.reason, "no-template-match");
});

test("classification survives a forward that mangles the subject line", () => {
  assert.equal(classify({ subject: "Fwd: (no subject)", body: "has been registered as ITA 1/AHD/2026" }), "registration");
  assert.equal(classify({ subject: "Fwd:", body: "the above appeal has been fixed for hearing at" }), "hearing");
  assert.equal(classify({ subject: "Hello", body: "nothing relevant" }), "unrecognised");
});

/* ---------------- finding the practice's address ----------------
 *
 * These are here because getting them wrong breaks the ONE case the feature is
 * built for, and breaks it silently: mail arrives, no alias is recognised, and
 * the practitioner sees an address that never receives anything.
 *
 * When Gmail forwards by a FILTER — which is what the setup instructions ask
 * for — it leaves the original To: header alone. The header still says the
 * practitioner's own mailbox, and our address appears only in the envelope. Any
 * lookup that reads To: and stops there finds nothing, every single time. */

test("a filter-forwarded email is found by its envelope, not its To: header", () => {
  const sendgrid = fromForm({
    envelope: JSON.stringify({ to: [ALIAS], from: "no-reply@itat.nic.in" }),
    to: "chavdagreen@gmail.com", // unchanged by the forward — this is the trap
    from: ITAT,
    subject: HEARING.subject,
    text: "fixed for hearing at 10.30 a.m on 15-Sep-2026 (Tue).",
  });
  assert.match(sendgrid.to, /a1b2c3d4e5f60718@prohippo\.info/, "the alias must survive into `to`");
  assert.match(sendgrid.to, /chavdagreen@gmail\.com/, "and the original recipient is kept beside it");

  const postmark = fromJson({
    OriginalRecipient: ALIAS,
    To: "chavdagreen@gmail.com",
    From: ITAT,
    Subject: HEARING.subject,
    TextBody: "fixed for hearing",
  });
  assert.match(postmark.to, /a1b2c3d4e5f60718@prohippo\.info/);
});

test("an address in Cc is still an address", () => {
  const f = fromForm({ to: "someone@example.com", cc: ALIAS, from: ITAT, subject: "x" });
  assert.match(f.to, /a1b2c3d4e5f60718/);
});

test("the provider's own field names all land in the same object", () => {
  const mailgun = fromForm({
    recipient: ALIAS,
    sender: "no-reply@itat.nic.in",
    subject: HEARING.subject,
    "body-plain": "fixed for hearing at 10.30 a.m on 15-Sep-2026 (Tue).",
    "body-html": "<p>x</p>",
    "message-headers": "Message-Id: <abc@itat.nic.in>\nDate: Fri, 31 Jul 2026 17:24:00 +0530",
  });
  assert.equal(mailgun.from, "no-reply@itat.nic.in");
  assert.equal(mailgun.messageId, "<abc@itat.nic.in>");
  assert.match(mailgun.text, /fixed for hearing/);
  assert.equal(parseItatEmail(mailgun).fields.date, "2026-09-15", "and it parses the same as any other");

  const postmark = fromJson({
    From: ITAT,
    Subject: REGISTRATION.subject,
    HtmlBody: REGISTRATION.html,
    Headers: [{ Name: "Message-ID", Value: "<reg@itat.nic.in>" }],
  });
  assert.equal(postmark.messageId, "<reg@itat.nic.in>");
  assert.equal(parseItatEmail(postmark).fields.appealNo, "ITA 2635/AHD/2026");
});

test("CloudMailin's envelope-and-headers shape reads the same as any other", () => {
  const cloudmailin = fromJson({
    envelope: { to: ALIAS, from: "no-reply@itat.nic.in", recipients: [ALIAS] },
    headers: {
      To: "chavdagreen@gmail.com", // the forward left this pointing at the practitioner
      From: ITAT,
      Subject: HEARING.subject,
      "Message-ID": "<cm-1@itat.nic.in>",
      Date: "Fri, 31 Jul 2026 17:24:00 +0530",
    },
    plain: "fixed for hearing at 10.30 a.m on 15-Sep-2026 (Tue).",
    html: "<p>x</p>",
  });
  assert.match(cloudmailin.to, /a1b2c3d4e5f60718@prohippo\.info/);
  assert.equal(cloudmailin.subject, HEARING.subject);
  assert.equal(cloudmailin.messageId, "<cm-1@itat.nic.in>");
  assert.equal(parseItatEmail(cloudmailin).fields.date, "2026-09-15");
});

test("and reads the same when CloudMailin lower-cases the header names", () => {
  // Their normalised JSON format writes message_id, not Message-ID.
  const normalised = fromJson({
    envelope: { to: ALIAS, from: "no-reply@itat.nic.in" },
    headers: { subject: REGISTRATION.subject, from: ITAT, message_id: "<cm-2@itat.nic.in>" },
    plain: "has been registered as ITA 2635/AHD/2026 filed by you in AAWPM8125C on 23-Jul-2026",
    html: "",
  });
  assert.equal(normalised.messageId, "<cm-2@itat.nic.in>", "message_id and Message-ID are one header");
  assert.equal(normalised.subject, REGISTRATION.subject);
  assert.equal(parseItatEmail(normalised).fields.appealNo, "ITA 2635/AHD/2026");
});

test("Mailgun's route delivery reads like any other", () => {
  /* A Mailgun route forwards as form fields, and posts message-headers as a
     JSON array of pairs rather than as a header block — so the Message-ID is
     only found if that array is understood. Losing it would not break ingest,
     but it would downgrade duplicate detection from "the sender said this is
     the same message" to a guess built out of subject and date. */
  const mailgun = fromForm({
    recipient: ALIAS,
    sender: "no-reply@itat.nic.in",
    from: ITAT,
    subject: HEARING.subject,
    "body-plain": "fixed for hearing at 10.30 a.m on 15-Sep-2026 (Tue).",
    "message-headers": JSON.stringify([
      ["From", ITAT],
      ["Subject", HEARING.subject],
      ["Message-Id", "<mg-1@itat.nic.in>"],
      ["Date", "Fri, 31 Jul 2026 17:24:00 +0530"],
    ]),
  });
  assert.match(mailgun.to, /a1b2c3d4e5f60718@prohippo\.info/, "`recipient` is the envelope address");
  assert.equal(mailgun.messageId, "<mg-1@itat.nic.in>", "read out of the JSON header array");
  assert.equal(parseItatEmail(mailgun).fields.date, "2026-09-15");
});

test("a header block that is not JSON is still read as one", () => {
  const sendgrid = fromForm({
    to: ALIAS,
    from: ITAT,
    subject: "x",
    headers: "Message-Id: <sg-1@itat.nic.in>\nDate: Fri, 31 Jul 2026 17:24:00 +0530",
  });
  assert.equal(sendgrid.messageId, "<sg-1@itat.nic.in>");
});

test("a payload with nothing in it does not throw", () => {
  for (const empty of [fromJson({}), fromForm({}), fromForm({ envelope: "not json" })]) {
    assert.equal(empty.from, "");
    assert.equal(empty.to, "");
    assert.equal(parseItatEmail(empty).kind, "unrecognised");
  }
});

/* ---------------- Gmail's verification code ---------------- */

test("Gmail's forwarding code is caught, with the account that asked for it", () => {
  const confirm = gmailConfirmation({
    from: "Gmail Team <forwarding-noreply@google.com>",
    subject: "(#429106883) Gmail Forwarding Confirmation - Receive Mail from chavdagreen@gmail.com",
    text: "chavdagreen@gmail.com has requested to automatically forward mail to your address. Confirmation code: 429106883",
    html: "",
  });
  assert.equal(confirm.code, "429106883");
  assert.equal(confirm.requester, "chavdagreen@gmail.com",
    "two clients setting up on one day must not be crossed");
});

test("the one-click confirmation link is caught too", () => {
  /* Gmail hides the box its code goes into behind a word that does not look
     like a button, so plenty of people never find it. The same email carries a
     link that finishes the handshake on its own — and it lives in an href, so
     it has to be read before the HTML is flattened. */
  const confirm = gmailConfirmation({
    from: "Gmail Team <forwarding-noreply@google.com>",
    subject: "(#429106883) Gmail Forwarding Confirmation - Receive Mail from chavdagreen@gmail.com",
    text: "",
    html: '<p>Confirmation code: 429106883</p><p><a href="https://mail.google.com/mail/vf-%5BANGjdJ8%5D-abc?a=1&amp;b=2">Confirm</a></p>',
  });
  assert.equal(confirm.code, "429106883");
  assert.equal(confirm.confirmUrl, "https://mail.google.com/mail/vf-%5BANGjdJ8%5D-abc?a=1&b=2",
    "entities decoded, and the whole query string kept");
});

test("a confirmation with only a link is still worth surfacing", () => {
  const confirm = gmailConfirmation({
    from: "forwarding-noreply@google.com",
    subject: "Gmail Forwarding Confirmation",
    text: "Please click https://mail-settings.google.com/mail/vf-xyz123 to confirm.",
    html: "",
  });
  assert.equal(confirm.code, "", "no code in this one");
  assert.equal(confirm.confirmUrl, "https://mail-settings.google.com/mail/vf-xyz123");
});

test("the code is only taken from Google", () => {
  assert.equal(gmailConfirmation({
    from: "attacker@example.com",
    subject: "(#000000001) Gmail Forwarding Confirmation - Receive Mail from victim@gmail.com",
    text: "Confirmation code: 000000001",
    html: "",
  }), null);
});

test("a confirmation is never mistaken for an appeal", () => {
  const { kind } = parseItatEmail({
    from: "forwarding-noreply@google.com",
    subject: "(#429106883) Gmail Forwarding Confirmation - Receive Mail from a@gmail.com",
    text: "Confirmation code: 429106883",
    html: "",
  });
  assert.equal(kind, "gmail-confirmation");
});

/* ---------------- the address a practice receives on ----------------
 *
 * ProHippo mints one on its own domain, but cannot insist on it: whether a
 * practice can have an address there at all is a decision its mail provider
 * makes, and CloudMailin's free tier issues one on cloudmailin.net. So the
 * lookup is keyed by the address rather than by a token parsed out of one. */

test("an address is found wherever in the recipients it appears", () => {
  const provider = "f6012235e360a493f857@cloudmailin.net";
  // Envelope first, header To: second — the order a filter forward produces.
  const blob = `${provider} chavdagreen@gmail.com no-reply@itat.nic.in`;
  assert.deepEqual(emailAddressesIn(blob), [provider, "chavdagreen@gmail.com", "no-reply@itat.nic.in"]);
  assert.ok(emailAddressesIn(blob).includes(provider));
});

test("the same address in any casing is the same address", () => {
  assert.equal(addressKey("F6012235E360A493F857@CloudMailin.net"), addressKey("f6012235e360a493f857@cloudmailin.net"));
  assert.notEqual(addressKey("a@cloudmailin.net"), addressKey("b@cloudmailin.net"));
  assert.equal(normaliseAddress("  A@B.com "), "a@b.com");
});

test("a recipients blob with no addresses yields none, and does not throw", () => {
  assert.deepEqual(emailAddressesIn(""), []);
  assert.deepEqual(emailAddressesIn(undefined), []);
  assert.deepEqual(emailAddressesIn("no addresses here"), []);
});

test("only something that looks like an address can be claimed", () => {
  assert.ok(isEmailAddress("f6012235e360a493f857@cloudmailin.net"));
  assert.ok(isEmailAddress("db321d575601cc66@prohippo.info"));
  assert.ok(!isEmailAddress("not an address"));
  assert.ok(!isEmailAddress("missing@tld"));
  assert.ok(!isEmailAddress(""));
});

test("one address is listed once however many fields carried it", () => {
  const a = "x@cloudmailin.net";
  assert.deepEqual(emailAddressesIn(`${a} ${a.toUpperCase()} ${a}`), [a],
    "duplicates across envelope, To and Delivered-To must not each cost a lookup");
});
