/* The language a client message goes out in.
 *
 *   node --test test/messageLanguages.test.mjs
 *
 * Two things are pinned here. First, that the language list the browser renders
 * and the one Cloud Functions validates against are the same list — they are
 * duplicated because one is ESM and the other CommonJS, and a code only one side
 * knows would be stored against an assessee and then render as a blank.
 *
 * Second, the staleness rule. A practitioner who adds a document after
 * translating and then sends would give their client a letter missing the item
 * they just added, in a script they may not read. Nothing else on this page can
 * fail that quietly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import {
  LANGUAGES, languageFor, languageName, isEnglish,
  defaultLanguage, translationStale, askableLabels,
} from "../src/messageLanguages.js";

const requireCjs = createRequire(import.meta.url);
const { LANGUAGES: SERVER_LANGUAGES } = requireCjs("../functions/messageTranslation.js");

/* ---------------- the two lists ---------------- */

test("the browser and the server offer exactly the same languages", () => {
  assert.deepEqual(
    LANGUAGES.map((l) => `${l.code}:${l.label}:${l.native}`),
    SERVER_LANGUAGES.map((l) => `${l.code}:${l.label}:${l.native}`),
    "src/messageLanguages.js and functions/messageTranslation.js have drifted apart"
  );
});

test("a language reads as its own script first, then its English name", () => {
  assert.equal(languageName("gu"), "ગુજરાતી · Gujarati");
  assert.equal(languageName("en"), "English", "not 'English · English'");
  assert.equal(languageName("zz"), "");
});

test("English and 'nothing chosen' are the same thing", () => {
  assert.equal(isEnglish("en"), true);
  assert.equal(isEnglish(""), true);
  assert.equal(isEnglish(undefined), true);
  assert.equal(isEnglish("gu"), false);
});

/* ---------------- which language a request opens in ---------------- */

test("the client's own language beats the practice default", () => {
  /* The whole reason this is stored on the assessee: one practice writes to
     Gujarati-speaking and English-speaking clients off the same list, and the
     language belongs to the person being written to. */
  assert.equal(
    defaultLanguage({ assessee: { messageLanguage: "gu" }, profile: { messageLanguage: "hi" } }),
    "gu"
  );
});

test("the practice default covers a client nobody has set one on", () => {
  assert.equal(defaultLanguage({ assessee: { name: "Deepak" }, profile: { messageLanguage: "hi" } }), "hi");
});

test("with neither, it is English", () => {
  assert.equal(defaultLanguage({}), "en");
  assert.equal(defaultLanguage({ assessee: {}, profile: {} }), "en");
});

test("a request already written in a language reopens in it", () => {
  // Even if the client's default has since been changed to something else —
  // a draft is a draft in the language it was drafted in.
  assert.equal(
    defaultLanguage({ request: { language: "mr" }, assessee: { messageLanguage: "gu" }, profile: { messageLanguage: "hi" } }),
    "mr"
  );
});

/* ---------------- what the client is actually being asked for ---------------- */

const req = (over = {}) => ({
  items: [
    { label: "Bank statement", status: "pending" },
    { label: "Form 26AS", status: "pending" },
  ],
  note: "",
  ...over,
});

test("only the outstanding items are translated, in order", () => {
  const r = req({ items: [
    { label: "Bank statement", status: "pending" },
    { label: "Already sent", status: "received" },
    { label: "Not needed", status: "waived" },
    { label: "Form 26AS", status: "pending" },
  ] });
  assert.deepEqual(askableLabels(r), ["Bank statement", "Form 26AS"]);
});

test("labels are trimmed, because the translation is matched against them", () => {
  assert.deepEqual(askableLabels(req({ items: [{ label: "  Bank statement  ", status: "pending" }] })), ["Bank statement"]);
});

/* ---------------- staleness ---------------- */

const translated = (over = {}) => ({
  language: "gu", phrases: {}, items: ["બેંક સ્ટેટમેન્ટ", "Form 26AS"], note: "",
  source: { items: ["Bank statement", "Form 26AS"], note: "" },
  ...over,
});

test("a translation of the list as it stands is not stale", () => {
  assert.equal(translationStale({ ...req(), translation: translated() }), false);
});

test("adding a document makes it stale", () => {
  /* THE case this exists for. Without it the client receives a Gujarati letter
     missing the document just added, and the practitioner cannot see that by
     reading it. */
  const r = { ...req({ items: [...req().items, { label: "Rent agreement", status: "pending" }] }), translation: translated() };
  assert.equal(translationStale(r), true);
});

test("rewording a document makes it stale", () => {
  const r = { ...req({ items: [{ label: "Bank statement for 2024-25", status: "pending" }, { label: "Form 26AS", status: "pending" }] }), translation: translated() };
  assert.equal(translationStale(r), true);
});

test("reordering the list makes it stale, because the letter is numbered", () => {
  const r = { ...req({ items: [{ label: "Form 26AS", status: "pending" }, { label: "Bank statement", status: "pending" }] }), translation: translated() };
  assert.equal(translationStale(r), true);
});

test("ticking an item off as received makes it stale", () => {
  // It drops out of the letter, so the translated list no longer matches.
  const r = { ...req({ items: [{ label: "Bank statement", status: "received" }, { label: "Form 26AS", status: "pending" }] }), translation: translated() };
  assert.equal(translationStale(r), true);
});

test("changing the note makes it stale", () => {
  assert.equal(translationStale({ ...req({ note: "Urgent please" }), translation: translated() }), true);
  assert.equal(translationStale({ ...req({ note: "Urgent please" }), translation: translated({ source: { items: ["Bank statement", "Form 26AS"], note: "Urgent please" } }) }), false);
});

test("whitespace alone is not a change worth a paid call", () => {
  assert.equal(translationStale({ ...req({ note: "  " }), translation: translated() }), false);
});

test("an untranslated request is never stale", () => {
  assert.equal(translationStale(req()), false);
  assert.equal(translationStale({}), false);
  assert.equal(translationStale(null), false);
});
