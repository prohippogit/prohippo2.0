/* Rendering a client message, in English and in the client's own language.
 *
 *   node --test test/messageTemplates.test.mjs
 *
 * The point of these: a translated letter is the SAME RENDERER over a different
 * phrase bundle. So what has to hold is that swapping the bundle changes the
 * prose and nothing else — not the markup, not the escaping, not the numbering,
 * and above all not the figures.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { renderDocRequest, defaultTitle, proceedingLine, PHRASES, whatsappLink } from "../src/messageTemplates.js";

/* The real Komal Gor request from the screenshots. */
const request = (over = {}) => ({
  assessee: "Komal Manishkumar Gor",
  ay: "2020-21",
  authority: "Scrutiny",
  section: "142(1)",
  din: "100116990599",
  dueDate: "2026-07-30",
  note: "",
  items: [
    { label: "Accounts and documents called for as per annexure", status: "pending" },
    { label: "Requisite details as requested in the notice dated 08.07.2026", status: "pending" },
    { label: "Bank statement", status: "pending" },
  ],
  ...over,
});

const assessee = { name: "Komal Manishkumar Gor", email: "manishgor03@gmail.com", mobile: "9265551232" };
const profile = { ownerName: "Kaushal Shah", firmName: "Kaushal Shah & Co." };

/* A Gujarati bundle of exactly the phrases this request uses. */
const gujarati = (over = {}) => ({
  language: "gu",
  languageLabel: "Gujarati",
  phrases: {
    greeting: "નમસ્તે {name},",
    intro: "તમારા {proceeding} કેસમાં અમને નોટિસ મળી છે{din}.",
    needMany: "જવાબ તૈયાર કરવા માટે અમને નીચેના {count} દસ્તાવેજોની જરૂર છે:",
    dueBy: "કૃપા કરીને આ દસ્તાવેજો {date} સુધીમાં મોકલી આપો.",
    howToTitle: "કેવી રીતે મોકલશો",
    howToBody: "દરેક દસ્તાવેજ PDF ફાઇલ સ્વરૂપે, 5 MB થી ઓછી સાઇઝમાં મોકલો.",
    replyEmail: "આ ઈમેલનો જવાબ આપીને PDF જોડી મોકલી શકો છો.",
    replyWhatsApp: "આ સંદેશનો જવાબ આપીને PDF જોડી મોકલી શકો છો.",
    subject: "જરૂરી દસ્તાવેજો — {proceeding}",
    sentVia: "મોકલનાર",
    onBehalfOf: "{firm} વતી. તેમને સીધો સંપર્ક કરવા આ ઈમેલનો જવાબ આપો.",
  },
  items: [
    "પરિશિષ્ટ મુજબ માંગવામાં આવેલા હિસાબો અને દસ્તાવેજો",
    "તા. 08.07.2026 ની નોટિસમાં માંગ્યા મુજબની જરૂરી વિગતો",
    "બેંક સ્ટેટમેન્ટ",
  ],
  note: "",
  ...over,
});

const en = (over) => renderDocRequest({ request: request(over), assessee, profile });
const gu = (over, t) => renderDocRequest({ request: request(over), assessee, profile, translation: t || gujarati() });

/* ---------------- English is unchanged ---------------- */

test("the English letter still says what it always said", () => {
  const out = en();
  assert.match(out.emailText, /^Namaste Komal Manishkumar Gor,/);
  assert.match(out.emailText, /We have received a notice in your Scrutiny u\/s 142\(1\) · AY 2020-21 matter \(DIN 100116990599\)\./);
  assert.match(out.emailText, /To prepare the reply we need the following 3 documents:/);
  assert.match(out.emailText, /Please send these by 30 Jul 2026 so we have time to prepare and file the reply\./);
  assert.match(out.emailText, /Just reply to this email with the PDFs attached\./);
  assert.equal(out.language, "en");
});

test("the English email keeps its inline emphasis on the format and the size", () => {
  // The two things clients get wrong. Extracting the sentences to data must not
  // have cost the English letter its bolding.
  assert.match(en().emailHtml, /<b style="color:#2A1B4A;">PDF file, under 5&nbsp;MB<\/b>/);
  assert.match(en().emailHtml, /<b style="color:#2A1B4A;">Scan<\/b>/);
});

test("the subject is built from the phrase, not from a second copy of it", () => {
  assert.equal(defaultTitle(request()), "Documents required — Scrutiny u/s 142(1) · AY 2020-21");
  assert.equal(defaultTitle({}), "Documents required");
  assert.equal(PHRASES.subject, "Documents required — {proceeding}");
  assert.equal(proceedingLine(request()), "Scrutiny u/s 142(1) · AY 2020-21");
});

/* ---------------- the translated letter ---------------- */

test("the slots are filled with the untouched originals", () => {
  const out = gu();
  assert.match(out.emailText, /નમસ્તે Komal Manishkumar Gor,/);
  assert.match(out.emailText, /તમારા Scrutiny u\/s 142\(1\) · AY 2020-21 કેસમાં/);
  assert.match(out.emailText, /\(DIN 100116990599\)/);
  assert.match(out.emailText, /નીચેના 3 દસ્તાવેજોની/);
  assert.match(out.emailText, /30 Jul 2026 સુધીમાં/);
  assert.equal(out.language, "gu");
});

test("no slot name ever reaches a client", () => {
  /* The failure that would be visible to the client and invisible to us: a
     phrase rendering "Namaste {name}," verbatim. */
  for (const text of [gu().emailText, gu().whatsappText, gu().emailHtml, gu().subject]) {
    assert.doesNotMatch(text, /\{[a-zA-Z]+\}/, "an unfilled slot leaked into the message");
  }
});

test("every figure in the request survives into the translated letter", () => {
  const out = gu();
  for (const n of ["142", "2020-21", "100116990599", "08.07.2026", "30 Jul 2026", "3"]) {
    assert.ok(out.emailText.includes(n), `${n} is missing from the translated letter`);
    assert.ok(out.emailHtml.includes(n), `${n} is missing from the translated email`);
  }
});

test("the document names are the translated ones, still numbered in order", () => {
  const out = gu();
  assert.match(out.emailText, /1\. પરિશિષ્ટ મુજબ/);
  assert.match(out.emailText, /2\. તા\. 08\.07\.2026 ની નોટિસમાં/);
  assert.match(out.emailText, /3\. બેંક સ્ટેટમેન્ટ/);
});

test("the translated subject is used, and a typed one still wins", () => {
  assert.equal(gu().subject, "જરૂરી દસ્તાવેજો — Scrutiny u/s 142(1) · AY 2020-21");
  // A practitioner's own words are their own words, in whatever language they
  // chose to write them.
  assert.equal(gu({ title: "My own subject" }).subject, "My own subject");
});

test("WhatsApp bolding survives translation", () => {
  const out = gu().whatsappText;
  assert.match(out, /\*બેંક સ્ટેટમેન્ટ\*/);
  assert.match(out, /\*કેવી રીતે મોકલશો\*/);
  assert.match(out, /આ સંદેશનો જવાબ/, "and it uses the WhatsApp reply line, not the email one");
});

test("the sign-off is the practitioner's own name, never translated", () => {
  assert.match(gu().emailText, /Kaushal Shah\nKaushal Shah & Co\./);
});

test("the firm's name is escaped once and only once", () => {
  // "&" in "Kaushal Shah & Co." is the case that catches a double-escape.
  const html = gu().emailHtml;
  assert.ok(html.includes("Kaushal Shah &amp; Co."), "the firm name should be escaped");
  assert.ok(!html.includes("&amp;amp;"), "and not twice");
});

/* ---------------- the guards ---------------- */

test("a translation whose list no longer matches falls back to the real labels", () => {
  /* Belt and braces behind the composer's stale warning: if a translation with
     the wrong number of items ever reaches the renderer, it must print the
     practitioner's own labels rather than mismatch them. Sending a client the
     wrong document names would be worse than sending them English ones. */
  const out = gu({}, gujarati({ items: ["બેંક સ્ટેટમેન્ટ"] }));
  assert.match(out.emailText, /1\. Accounts and documents called for as per annexure/);
  assert.match(out.emailText, /નમસ્તે/, "the prose is still translated — only the list falls back");
});

test("a phrase the translation is missing falls back to English alone", () => {
  const t = gujarati();
  delete t.phrases.dueBy;
  const out = gu({}, t);
  assert.match(out.emailText, /Please send these by 30 Jul 2026/);
  assert.match(out.emailText, /નમસ્તે/, "the rest of the letter is unaffected");
});

test("an item marked received drops out of both languages alike", () => {
  const items = request().items.map((i, n) => (n === 0 ? { ...i, status: "received" } : i));
  assert.match(en({ items }).emailText, /following 2 documents/);
  assert.match(gu({ items }).emailText, /નીચેના 2 દસ્તાવેજોની/);
  assert.doesNotMatch(gu({ items }).emailText, /પરિશિષ્ટ મુજબ/);
});

test("a request with no proceeding and no DIN leaves no stray punctuation", () => {
  const bare = { assessee: "Someone", items: [{ label: "Bank statement", status: "pending" }] };
  const out = renderDocRequest({ request: bare, assessee: { name: "Someone" }, profile });
  assert.match(out.emailText, /We have received a notice in your matter\./);
  assert.equal(out.subject, "Documents required");
});

test("the wa.me link carries the translated text", () => {
  const link = whatsappLink(assessee, gu().whatsappText);
  assert.match(link, /^https:\/\/wa\.me\/9265551232\?text=/);
  assert.ok(decodeURIComponent(link).includes("બેંક સ્ટેટમેન્ટ"));
  assert.equal(whatsappLink({ name: "No mobile" }, "x"), null);
});
