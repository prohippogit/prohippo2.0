/* ProHippo — the languages a client message can be sent in.
 *
 * MUST STAY IN STEP WITH `LANGUAGES` in functions/messageTranslation.js. One is
 * CommonJS in Cloud Functions, the other ESM in the browser bundle, so the list
 * is duplicated rather than shared. Duplication is fine; DRIFT is not — a code
 * only the server knows would be stored against an assessee and then render as
 * a blank in the dropdown. test/messageLanguages.test.mjs pins the two lists
 * together so drift fails a test rather than a practice.
 *
 * In the client's own script, with the English name beside it: a practitioner
 * picking one is picking what their client reads. Twelve, not all twenty-two of
 * the Eighth Schedule — a list nobody can scan is a list nobody uses.
 */

export const LANGUAGES = [
  // "en" is the ABSENCE of a translation rather than a language to translate
  // into. Selecting it clears any translation on the request.
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

export const languageFor = (code) => LANGUAGES.find((l) => l.code === String(code || "")) || null;

/** "ગુજરાતી · Gujarati", or just "English" where the two would repeat. */
export const languageName = (code) => {
  const l = languageFor(code);
  if (!l) return "";
  return l.native === l.label ? l.label : `${l.native} · ${l.label}`;
};

export const isEnglish = (code) => !code || code === "en";

/* Which language a request opens in, in the order a practice actually works.
 *
 * THE CLIENT'S OWN LANGUAGE WINS. One practice has Gujarati-speaking and
 * English-speaking clients on the same list, and the language belongs to the
 * person being written to, not to the firm writing. Set it once on an assessee
 * and every later request to them opens in it.
 *
 * The practice default is the fallback for a client nobody has set one on — for
 * a firm whose clients are mostly one language, that is the whole setting.
 * Neither is a lock: the dropdown overrides both for the message in hand.
 */
export function defaultLanguage({ request, assessee, profile } = {}) {
  const stored = request && request.language;
  if (stored) return stored;
  const onClient = assessee && assessee.messageLanguage;
  if (onClient) return onClient;
  const onPractice = profile && profile.messageLanguage;
  return onPractice || "en";
}

/* Does a stored translation still describe the message on screen?
 *
 * A practitioner who adds a document after translating and then sends would give
 * the client a Gujarati letter missing the item they just added, in a script
 * they may not read. So the translation carries the exact strings it was made
 * from, and anything that moves makes it stale.
 *
 * Stale WARNS rather than blocks: sometimes the edit was a comma, and a screen
 * that refuses to send is a screen somebody works around.
 */
export function translationStale(request) {
  const t = request && request.translation;
  if (!t) return false;
  const items = askableLabels(request);
  if ((t.source?.items || []).length !== items.length) return true;
  if (items.some((label, i) => label !== t.source.items[i])) return true;
  return (t.source?.note || "") !== ((request.note || "").trim());
}

/** The document names the client is actually being asked for, in order. */
export function askableLabels(request) {
  return (request?.items || [])
    .filter((i) => i.status !== "received" && i.status !== "waived")
    .map((i) => String(i.label || "").trim());
}
