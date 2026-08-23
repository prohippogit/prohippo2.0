/*
 * Which typeface a computation's theme is set in — the server's half of §14.
 *
 * The client picks the theme and builds the HTML; this function inlines the
 * face, because 40 KB of woff2 per family has no business in the browser bundle
 * for a document most sessions never generate.
 *
 * THE MAPPING EXISTS TWICE and that is why there is a test for it. The client's
 * copy is `THEMES[id].font` in src/computation/render/themes/index.js;
 * test/computation/themes.test.mjs runs both and requires them to agree. A theme
 * missing from this table would print in whatever headless Chromium falls back
 * to — which is nothing at all, because the render runs with no system fonts —
 * so the failure is a blank page, and a blank page with no error is exactly the
 * kind of fault a test has to catch instead of a user.
 *
 * A theme id that is not in here does NOT throw. It falls back to the default
 * family: an unknown theme means a stale client or a mistyped setting, and a
 * document set in the wrong typeface is recoverable in a way a failed render is
 * not.
 */
"use strict";

const FAMILIES = {
  poppins: require("./poppins.js").FONT_FACE_CSS,
  montserrat: require("./montserrat.js").FONT_FACE_CSS,
};

// Keep in step with THEMES in src/computation/render/themes/index.js.
const FONT_FOR_THEME = {
  curvy: "poppins",
  classic: "montserrat",
};

const DEFAULT_FAMILY = "poppins";

/** The @font-face block for a theme id. Unknown ids get the default family. */
function fontFaceFor(theme) {
  const family = FONT_FOR_THEME[String(theme || "").trim()] || DEFAULT_FAMILY;
  return FAMILIES[family];
}

module.exports = { fontFaceFor, FONT_FOR_THEME, DEFAULT_FAMILY };
