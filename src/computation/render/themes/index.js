/*
 * The themes a Computation of Income can be printed in — spec §14.
 *
 * A theme is a STYLESHEET and nothing else. The model does not know about them,
 * the mappers do not know about them, and the template emits the same markup
 * whichever is chosen — which is the same rule §2 keeps for forms, applied to
 * looks: when the document needs to appear differently, the renderer gains a
 * stylesheet, not a branch.
 *
 * Adding a theme is therefore: write the stylesheet, list it here, and name the
 * typeface it is set in. Nothing else in the feature changes.
 *
 * `font` is an id, not a file. The faces are embedded server-side
 * (functions/fonts/) because they are 40 KB each and nobody should download a
 * typeface for a document they may never generate; the id is what tells the
 * render function which one to inline. functions/fonts/index.js holds the same
 * mapping for the server, and test/computation/themes.test.mjs requires the two
 * to agree — a theme whose font is missing on one side prints in whatever
 * headless Chromium falls back to, which is nothing.
 */
import { stylesheet as classic } from "./classic.js";
import { stylesheet as curvy } from "./curvy.js";

export const THEMES = {
  curvy: {
    id: "curvy",
    name: "Curvy",
    /* Shown in Settings, so it says what the practitioner will see rather than
       what the CSS does. */
    description: "Soft violet panels in your practice's accent colour, set in Poppins — the same look as your invoices, ledgers and ITR-B working papers.",
    font: "poppins",
    stylesheet: curvy,
  },
  classic: {
    id: "classic",
    name: "Classic",
    description: "Navy and gold on white, set in Montserrat — the original computation look, unchanged.",
    font: "montserrat",
    stylesheet: classic,
  },
};

/* THE DEFAULT IS CURVY, and it is deliberate: a practice that has never opened
   this setting should get the document that matches everything else it sends
   out. A practice that prefers the original can say so once and keep it. */
export const DEFAULT_THEME = "curvy";

/** The chosen theme, or the default — never undefined, never a crash. */
export function resolveTheme(id) {
  return THEMES[String(id || "").trim()] || THEMES[DEFAULT_THEME];
}

/** Ids in the order Settings should offer them: the default first. */
export const THEME_IDS = [DEFAULT_THEME, ...Object.keys(THEMES).filter((k) => k !== DEFAULT_THEME)];
