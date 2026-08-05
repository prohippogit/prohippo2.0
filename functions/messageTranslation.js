/*
 * Turning a client message into the client's own language — and refusing to,
 * when the result cannot be trusted.
 *
 * WHY THE MODEL NEVER SEES THE MESSAGE.
 *
 * The email a client receives is a hand-built HTML table (src/messageTemplates.js).
 * Handing that to a model to translate would one day come back with a broken tag
 * and a letter rendering as source code in somebody's inbox. So the model is sent
 * about a dozen SHORT SENTENCES WITH SLOTS IN THEM — "Namaste {name}," — plus the
 * practitioner's own document names and note. The letter is then assembled from
 * those exactly as it is assembled today.
 *
 * The slots are the second reason. Word order moves between languages: English
 * puts the proceeding before the noun ("in your <b>Scrutiny u/s 142(1)</b>
 * matter"), Gujarati after it. Only the model can decide where the slot goes;
 * only the app may decide what goes in it. So the model places {proceeding} and
 * never learns what it contains.
 *
 * WHAT A TRANSLATOR MAY NEVER TOUCH.
 *
 * A mistranslated DIN is worse than an English letter. Everything below is
 * carried in a SLOT and is therefore never sent at all:
 *
 *   {name}        the client's name, spelt the way its owner spells it
 *   {proceeding}  "Scrutiny u/s 142(1) · AY 2020-21" — terms of art; a client
 *                 taking one to the department needs the department's words
 *   {din}         identifiers, where Devanagari numerals would be unusable
 *   {date}        reproduced exactly, so it matches the notice it came from
 *   {firm}        the practice's name
 *   {count}       a plain number
 *
 * Document names and the practitioner's note ARE translated — that is the part a
 * client has to understand in order to go and find the thing. They are free text
 * and can carry a date or a section reference inside them, so those are checked
 * on the way back rather than protected on the way in: every number in the
 * source must survive verbatim, or the whole translation is refused with a
 * reason. A refusal a practitioner can see beats a letter they cannot read.
 */
"use strict";

/* Bump when the phrase set, the prompt or the checks change, so a stored
   translation written by an older engine can be spotted and redone. */
const TRANSLATION_ENGINE = 1;

/* The languages offered, in the client's own script with the English name
 * beside it — a practitioner picking one is picking what their client reads.
 *
 * Twelve, not all twenty-two of the Eighth Schedule: a list nobody can scan is a
 * list nobody uses. `en` is the absence of a translation rather than a language
 * to translate into, and is handled before any of this runs.
 *
 * MUST STAY IN STEP WITH src/messageLanguages.js — one is CommonJS in Cloud
 * Functions, the other ESM in the browser bundle, and a code only one side knows
 * would be stored and then never render. test/messageLanguages.test.mjs pins
 * them together.
 */
const LANGUAGES = [
  { code: "en", label: "English", native: "English", english: true },
  { code: "hi", label: "Hindi", native: "हिन्दी" },
  { code: "gu", label: "Gujarati", native: "ગુજરાતી" },
  { code: "mr", label: "Marathi", native: "मराठी" },
  { code: "bn", label: "Bengali", native: "বাংলা" },
  { code: "ta", label: "Tamil", native: "தமிழ்" },
  { code: "te", label: "Telugu", native: "తెలుగు" },
  { code: "kn", label: "Kannada", native: "ಕನ್ನಡ" },
  { code: "ml", label: "Malayalam", native: "മലയാളം" },
  { code: "pa", label: "Punjabi", native: "ਪੰਜਾਬੀ" },
  { code: "or", label: "Odia", native: "ଓଡ଼ିଆ" },
  { code: "ur", label: "Urdu", native: "اردو" },
];

const LANGUAGE_CODES = LANGUAGES.map((l) => l.code);
const languageFor = (code) => LANGUAGES.find((l) => l.code === String(code || "")) || null;

/* Every number in a string, as it is printed.
 *
 * This is the check that catches the failures that matter: a date quietly
 * reformatted, a section number dropped from a document name, digits rendered in
 * another script. "08.07.2026" and "142(1)" both come out whole, so a
 * translation that mangles either is caught rather than sent.
 *
 * Deliberately NOT a check that the text changed: a document name that is
 * already a proper noun may legitimately come back identical. */
function numbersIn(text) {
  return String(text || "").match(/\d+(?:[.,/–-]\d+)*/g) || [];
}

/** The numbers present in the source but missing from the translation. */
function lostNumbers(source, translated) {
  const out = String(translated || "");
  const missing = [];
  for (const n of numbersIn(source)) {
    if (!out.includes(n) && !missing.includes(n)) missing.push(n);
  }
  return missing;
}

/* The slots a phrase is allowed to carry. A phrase that comes back having lost
   one would render with a hole where the client's name should be. */
function slotsIn(text) {
  return (String(text || "").match(/\{[a-zA-Z]+\}/g) || []).sort();
}

const str = (v, max = 1200) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * Normalise and check one model response.
 *
 * @param raw     what Gemini returned: { phrases: {...}, items: [...], note }
 * @param source  what was sent: { language, phrases: {...}, items: [...], note }
 * @returns { ok, translation } or { ok: false, reason }
 */
function normaliseTranslation(raw, source) {
  const r = raw && typeof raw === "object" ? raw : {};
  const src = source || {};
  const lang = languageFor(src.language);
  if (!lang || lang.english) return { ok: false, reason: "That is not a language this can translate into." };

  const srcPhrases = src.phrases && typeof src.phrases === "object" ? src.phrases : {};
  const outPhrases = r.phrases && typeof r.phrases === "object" ? r.phrases : {};

  const phrases = {};
  for (const key of Object.keys(srcPhrases)) {
    const from = String(srcPhrases[key] || "");
    const to = str(outPhrases[key]);
    if (!to) return { ok: false, reason: `The translation came back missing one of the sentences ("${key}").` };

    /* A phrase that lost a slot would render with a hole where the client's
       name or the assessment year should be. */
    const want = slotsIn(from);
    const got = slotsIn(to);
    if (want.join("|") !== got.join("|")) {
      return {
        ok: false,
        reason: `A sentence came back without the placeholders it went out with (${want.join(", ") || "none"} → ${got.join(", ") || "none"}), so the client's own details could not be filled in.`,
      };
    }
    phrases[key] = to;
  }

  const srcItems = Array.isArray(src.items) ? src.items : [];
  const outItems = Array.isArray(r.items) ? r.items : [];
  if (outItems.length !== srcItems.length) {
    return {
      ok: false,
      reason: `The translation came back with ${outItems.length} document names where the list has ${srcItems.length}.`,
    };
  }

  const items = [];
  for (let i = 0; i < srcItems.length; i++) {
    const from = String(srcItems[i] || "");
    const to = str(outItems[i], 300);
    if (!to) return { ok: false, reason: `Document ${i + 1} came back empty.` };
    const lost = lostNumbers(from, to);
    if (lost.length) {
      return {
        ok: false,
        reason: `Document ${i + 1} lost the figure ${lost.join(", ")} in translation — it would have gone to the client wrong.`,
      };
    }
    items.push(to);
  }

  let note = "";
  if (str(src.note)) {
    note = str(r.note, 2000);
    if (!note) return { ok: false, reason: "Your note to the client came back empty." };
    const lost = lostNumbers(src.note, note);
    if (lost.length) {
      return { ok: false, reason: `Your note lost the figure ${lost.join(", ")} in translation.` };
    }
  }

  return {
    ok: true,
    translation: {
      engine: TRANSLATION_ENGINE,
      language: lang.code,
      languageLabel: lang.label,
      phrases,
      items,
      note,
      at: new Date().toISOString(),
    },
  };
}

module.exports = {
  LANGUAGES,
  LANGUAGE_CODES,
  languageFor,
  normaliseTranslation,
  numbersIn,
  lostNumbers,
  slotsIn,
  TRANSLATION_ENGINE,
};
