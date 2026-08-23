/*
 * The typefaces a computation may be set in — the server's half of §14.
 *
 * The client picks the theme and builds the HTML; this inlines the faces,
 * because 40 KB of woff2 per family has no business in a browser bundle for a
 * document most sessions never generate.
 *
 * EVERY FAMILY, EVERY TIME — and that is a correction, not a shortcut.
 *
 * This used to map the theme id to one family and inline only that. It is the
 * obvious design and it has a failure mode with no error in it: the client and
 * the server deploy separately, so a browser running a theme the deployed
 * function has never heard of gets a page asking for Poppins and an @font-face
 * block containing Montserrat. Chromium renders it in neither — the render
 * container has no system fonts — and the PDF comes back set in Liberation
 * Sans with nothing anywhere saying why. That is exactly what happened the
 * first time the curvy theme went out ahead of the functions.
 *
 * Sending both families costs ~80 KB inside an HTML string that is thrown away
 * as soon as the PDF exists. It is not a page load and nobody downloads it. In
 * exchange, a theme can be added, renamed or re-fonted on the client alone, and
 * the two sides can be deployed in either order or months apart.
 *
 * So the rule is: this file knows what faces exist. It does not know what a
 * theme is, and it does not need to.
 */
"use strict";

const FAMILIES = {
  poppins: require("./poppins.js").FONT_FACE_CSS,
  montserrat: require("./montserrat.js").FONT_FACE_CSS,
};

/* The @font-face block for the template's FONT_SLOT: every embedded family,
   concatenated. Built once at module load — it is the same string on every
   request and re-joining it per render is pure waste. */
const ALL_FONT_FACE_CSS = Object.values(FAMILIES).join("\n");

/**
 * What to substitute for the template's font slot: every embedded family.
 *
 * It takes no argument on purpose. A `theme` parameter here would be an
 * invitation to narrow by it again, and narrowing is the thing that broke —
 * see the note above.
 */
function fontFaceFor() {
  return ALL_FONT_FACE_CSS;
}

module.exports = { fontFaceFor, ALL_FONT_FACE_CSS, FAMILIES };
