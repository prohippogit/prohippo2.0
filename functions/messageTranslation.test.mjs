/* Unit tests for translating a client message.
 *
 * The model is not on trial here — the CHECKS on it are. A letter goes out under
 * a practitioner's own firm name, in a script they may not read, so what these
 * pin down is that a bad translation is REFUSED with a reason rather than
 * rendered and sent.
 *
 * Run:  node --test functions/messageTranslation.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  LANGUAGES, languageFor, normaliseTranslation, numbersIn, lostNumbers, slotsIn, TRANSLATION_ENGINE,
} = require("./messageTranslation.js");

/* The real Komal Gor request from the screenshots that prompted this. */
const source = (over = {}) => ({
  language: "gu",
  phrases: {
    greeting: "Namaste {name},",
    intro: "We have received a notice in your {proceeding} matter{din}.",
    needMany: "To prepare the reply we need the following {count} documents:",
    dueBy: "Please send these by {date} so we have time to prepare and file the reply.",
  },
  items: [
    "Accounts and documents called for as per annexure",
    "Requisite details as requested in the notice dated 08.07.2026",
    "Bank statement",
  ],
  note: "",
  ...over,
});

const good = (over = {}) => ({
  phrases: {
    greeting: "નમસ્તે {name},",
    intro: "તમારા {proceeding} કેસમાં અમને નોટિસ મળી છે{din}.",
    needMany: "જવાબ તૈયાર કરવા માટે અમને નીચેના {count} દસ્તાવેજોની જરૂર છે:",
    dueBy: "કૃપા કરીને આ દસ્તાવેજો {date} સુધીમાં મોકલી આપો.",
  },
  items: [
    "પરિશિષ્ટ મુજબ માંગવામાં આવેલા હિસાબો અને દસ્તાવેજો",
    "તા. 08.07.2026 ની નોટિસમાં માંગ્યા મુજબની જરૂરી વિગતો",
    "બેંક સ્ટેટમેન્ટ",
  ],
  note: "",
  ...over,
});

/* ---------------- the happy path ---------------- */

test("a faithful translation comes back whole", () => {
  const out = normaliseTranslation(good(), source());
  assert.equal(out.ok, true);
  assert.equal(out.translation.language, "gu");
  assert.equal(out.translation.languageLabel, "Gujarati");
  assert.equal(out.translation.engine, TRANSLATION_ENGINE);
  assert.equal(out.translation.items.length, 3);
  assert.match(out.translation.phrases.greeting, /નમસ્તે/);
});

test("word order may move as long as the slot survives", () => {
  /* THE reason phrases are translated with slots rather than as finished text.
     English puts the proceeding before the noun and Gujarati after it; only the
     model can decide where, and only the app may decide what goes in it. */
  const out = normaliseTranslation(good(), source());
  const en = source().phrases.intro.indexOf("{proceeding}") / source().phrases.intro.length;
  const gu = out.translation.phrases.intro.indexOf("{proceeding}") / out.translation.phrases.intro.length;
  assert.ok(gu < en, "the slot moved, and that is allowed");
  assert.ok(out.translation.phrases.intro.includes("{din}"));
});

/* ---------------- the checks that make it safe ---------------- */

test("a phrase that lost its placeholder is refused", () => {
  // It would render "Namaste ," at a client — a hole where their name should be.
  const out = normaliseTranslation(
    good({ phrases: { ...good().phrases, greeting: "નમસ્તે," } }),
    source()
  );
  assert.equal(out.ok, false);
  assert.match(out.reason, /placeholders/);
});

test("a placeholder the model invented is refused too", () => {
  const out = normaliseTranslation(
    good({ phrases: { ...good().phrases, greeting: "નમસ્તે {name} {clientName}," } }),
    source()
  );
  assert.equal(out.ok, false);
});

test("a document name that lost its date is refused, with the figure named", () => {
  /* The failure that matters most in free text: the item labels are the one part
     a model rewrites, and a date inside one is exactly as load-bearing as a DIN.
     "the notice dated 08.07.2026" arriving without the date sends the client
     looking for the wrong notice. */
  const out = normaliseTranslation(
    good({ items: [good().items[0], "નોટિસમાં માંગ્યા મુજબની જરૂરી વિગતો", good().items[2]] }),
    source()
  );
  assert.equal(out.ok, false);
  assert.match(out.reason, /08\.07\.2026/);
  assert.match(out.reason, /Document 2/);
});

test("digits converted to another script count as lost", () => {
  // Devanagari numerals in a date make it unreadable to the department and to
  // anyone typing it back in.
  const out = normaliseTranslation(
    good({ items: [good().items[0], "તા. ०८.०७.२०२६ ની નોટિસ", good().items[2]] }),
    source()
  );
  assert.equal(out.ok, false);
  assert.match(out.reason, /08\.07\.2026/);
});

test("a list that came back the wrong length is refused", () => {
  const out = normaliseTranslation(good({ items: good().items.slice(0, 2) }), source());
  assert.equal(out.ok, false);
  assert.match(out.reason, /2 document names where the list has 3/);
});

test("a missing sentence is refused rather than left in English", () => {
  const phrases = { ...good().phrases };
  delete phrases.dueBy;
  const out = normaliseTranslation(good({ phrases }), source());
  assert.equal(out.ok, false);
  assert.match(out.reason, /dueBy/);
});

test("the practitioner's own note is checked like everything else", () => {
  const src = source({ note: "Please prioritise the bank statement for 2024-25." });
  const ok = normaliseTranslation(good({ note: "કૃપા કરીને 2024-25 નું બેંક સ્ટેટમેન્ટ પહેલા મોકલો." }), src);
  assert.equal(ok.ok, true);
  assert.equal(ok.translation.note.includes("2024-25"), true);

  const bad = normaliseTranslation(good({ note: "કૃપા કરીને બેંક સ્ટેટમેન્ટ પહેલા મોકલો." }), src);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /2024-25/);
});

test("a note nobody wrote is not demanded back", () => {
  const out = normaliseTranslation(good({ note: "" }), source({ note: "" }));
  assert.equal(out.ok, true);
  assert.equal(out.translation.note, "");
});

test("garbage in is refused, not rendered", () => {
  for (const input of [null, undefined, "a string", 42, { phrases: "no" }]) {
    assert.equal(normaliseTranslation(input, source()).ok, false);
  }
});

test("English is not a language to translate into", () => {
  assert.equal(normaliseTranslation(good(), source({ language: "en" })).ok, false);
  assert.equal(normaliseTranslation(good(), source({ language: "xx" })).ok, false);
});

/* ---------------- the helpers ---------------- */

test("numbers are found the way a tax document prints them", () => {
  assert.deepEqual(numbersIn("the notice dated 08.07.2026"), ["08.07.2026"]);
  assert.deepEqual(numbersIn("u/s 142(1) for AY 2020-21"), ["142", "1", "2020-21"]);
  assert.deepEqual(numbersIn("Bank statement"), []);
});

test("lostNumbers reports only what actually went missing", () => {
  assert.deepEqual(lostNumbers("dated 08.07.2026", "તા. 08.07.2026 ની"), []);
  assert.deepEqual(lostNumbers("dated 08.07.2026", "તા. ની"), ["08.07.2026"]);
  // Reordering is fine — only presence is asserted, because word order is
  // exactly the thing a translation is allowed to change.
  assert.deepEqual(lostNumbers("142(1) and 2020-21", "2020-21 તથા 142(1)"), []);
});

test("slots are found and compared order-independently", () => {
  assert.deepEqual(slotsIn("Namaste {name}, your {proceeding}"), ["{name}", "{proceeding}"]);
  assert.deepEqual(slotsIn("{proceeding} માં {name}"), ["{name}", "{proceeding}"]);
  assert.deepEqual(slotsIn("no slots here"), []);
});

/* ---------------- the list itself ---------------- */

test("every language has a code, an English name and its own script", () => {
  for (const l of LANGUAGES) {
    assert.ok(l.code && l.label && l.native, `${l.code} is incomplete`);
  }
  assert.equal(new Set(LANGUAGES.map((l) => l.code)).size, LANGUAGES.length, "no duplicate codes");
});

test("English is present, and marked as the absence of a translation", () => {
  const en = languageFor("en");
  assert.equal(en.english, true);
  assert.equal(LANGUAGES[0].code, "en", "and it leads the list, because it is the default");
  assert.equal(LANGUAGES.filter((l) => l.english).length, 1);
});

test("an unknown code resolves to nothing rather than to English", () => {
  assert.equal(languageFor("zz"), null);
  assert.equal(languageFor(""), null);
});
