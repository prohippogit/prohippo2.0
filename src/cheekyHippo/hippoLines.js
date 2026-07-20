/*
 * ProHippo — Cheeky Hippo copy deck.
 *
 * All the mascot's status lines live here so they're easy to tweak without
 * touching component logic. Lines are raw templates: tokens in {curly braces}
 * are filled in at render time by `fillTemplate` from live props.
 *
 * Supported tokens:
 *   {current}        downloadedCount
 *   {total}          totalPdfs
 *   {remaining}      totalPdfs - downloadedCount
 *   {reassessment}   noticeCounts.reassessment (148 / 148A)
 *   {penalty}        noticeCounts.penalty
 *   {appeal}         noticeCounts.appeal
 *   {assessment}     noticeCounts.assessment
 *   {currentFileName} currentFileName (truncated for display in the component)
 *
 * Keep each line to one short sentence, and at most one emoji.
 */

/** @typedef {'authenticating'|'fetchingList'|'downloading'|'processing'|'done'|'error'|'empty'} FetchPhase */

/** Base lines keyed by phase. `downloading` here holds the GENERIC pool. */
export const hippoLines = {
  authenticating: [
    "Logging in… convincing the portal I'm a real Tax consultant 🦛",
    "Wrestling the e-Filing login. It's putting up a fight.",
    "Whispering your credentials to the portal, politely.",
    "Knock knock. It's me, your friendly neighbourhood hippo.",
  ],
  fetchingList: [
    "Sniffing out your notices in e-Proceedings…",
    "Asking the department what they've sent you *this* time.",
    "Rounding up the paperwork. There's always paperwork.",
    "Counting notices on my little hippo fingers…",
  ],
  downloading: [
    "Downloading PDF {current} of {total}… this one's a fat one 📄",
    "Hauling notice {current} of {total} out of the portal.",
    "Grabbing PDFs faster than the AO can issue them.",
    "{current} down, {remaining} to go. Keep the chai warm.",
  ],
  processing: [
    "Stacking everything neatly by AY and section…",
    "Filing your notices so you don't have to.",
    "Teaching a stubborn 143(2) to sit still.",
  ],
  done: [
    "Done! {total} notices, neatly stacked. You're welcome 🦛",
    "All caught up. Go be a litigation hero.",
    "Fetched, sorted, ready. That was almost fun.",
  ],
  empty: [
    "Nothing new from the department. Enjoy the silence 🧘",
    "Zero notices today. Suspicious… but I'll take it.",
  ],
  error: [
    "The portal ghosted me. Classic. Want me to try again?",
    "Something tripped up mid-fetch. Not my fault. Probably.",
  ],
};

/*
 * Contextual downloading lines. Each entry declares when it's eligible
 * (`applies`) given the live props, and the template to show. When any of
 * these apply we prefer them over the generic pool (see resolveLines).
 */
const downloadingContextual = [
  {
    id: "reassessment",
    applies: (p) => Number(p?.noticeCounts?.reassessment) > 0,
    line: "Ooh, {reassessment} reassessment notices. Someone's popular 👀",
  },
  {
    id: "penalty",
    applies: (p) => Number(p?.noticeCounts?.penalty) > 0,
    line: "{penalty} penalty notices spotted. Rude of them.",
  },
  {
    id: "filename",
    applies: (p) => Boolean(p?.currentFileName),
    line: "Fetching {currentFileName}… almost got it.",
  },
];

/**
 * A stable key describing which contextual lines currently apply. The rotation
 * effect keys its interval on this so it only resets when *applicability*
 * changes — not on every downloadedCount tick.
 *
 * @param {object} props CheekyHippoProgress props.
 * @returns {string}
 */
export function contextualKey(props) {
  return downloadingContextual
    .map((c) => (c.applies(props) ? c.id : "-"))
    .join("|");
}

/**
 * Resolve the pool of raw line templates for a phase given live props.
 *
 * For `downloading` we bias toward contextual lines when they're relevant by
 * including them twice, so the hippo leans on the smarter copy ("3 penalty
 * notices…") while still occasionally dropping a generic quip.
 *
 * @param {FetchPhase} phase
 * @param {object} props CheekyHippoProgress props.
 * @returns {string[]} Raw templates (not yet interpolated).
 */
export function resolveLines(phase, props) {
  if (phase !== "downloading") return hippoLines[phase] || [];

  const applicable = downloadingContextual
    .filter((c) => c.applies(props))
    .map((c) => c.line);

  if (applicable.length === 0) return hippoLines.downloading;
  // Contextual lines weighted 2× to be "preferred" without fully crowding out
  // the generic count-based lines.
  return [...applicable, ...applicable, ...hippoLines.downloading];
}

/**
 * Fill {tokens} in a template from a values map. Unknown tokens are left as-is.
 *
 * @param {string} template
 * @param {Record<string, string|number>} values
 * @returns {string}
 */
export function fillTemplate(template, values) {
  if (!template) return "";
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    values[key] == null ? match : String(values[key])
  );
}
