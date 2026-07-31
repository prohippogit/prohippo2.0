/*
 * Regenerate functions/fonts/montserrat.js.
 *
 * The Computation of Income renderer runs headless Chromium with no system
 * fonts and no network access (docs/computation-spec.md §13), so Montserrat has
 * to travel inside the HTML as base64 woff2. This script fetches the two
 * subsets we need from Google Fonts and writes the module.
 *
 *   node scripts/fetch-computation-fonts.mjs
 *
 * Run it when Google ships a new Montserrat version (the URLs carry a `v31`
 * today) or when the design needs a character outside the latin subset. It is
 * not part of the build — the generated file is committed, so a deploy never
 * depends on Google being reachable.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Google serves different CSS to different clients; a browser UA is what gets
// us woff2 rather than a fallback format.
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const LATIN_CSS = "https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&display=swap";
// `text=₹` asks Google for a subset containing exactly that one glyph. The
// standard "latin" subset stops at U+20AC and has no rupee sign.
const RUPEE_CSS = "https://fonts.googleapis.com/css2?family=Montserrat:wght@400..800&text=%E2%82%B9";

const LATIN_RANGE =
  "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA,\n" +
  "                 U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122,\n" +
  "                 U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";

async function get(url, asText) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return asText ? res.text() : Buffer.from(await res.arrayBuffer());
}

// Pull the woff2 URL out of one @font-face block. `subset` names the comment
// Google puts above each block ("latin", "cyrillic", …); the rupee CSS has no
// comments at all, so an empty name means "the only block there is".
function fontUrl(css, subset) {
  const block = subset
    ? new RegExp(`/\\* ${subset} \\*/\\s*@font-face \\{(.*?)\\}`, "s").exec(css)
    : /@font-face \{(.*?)\}/s.exec(css);
  if (!block) throw new Error(`no @font-face for ${subset || "the requested text"}`);
  const url = /url\(([^)]+)\)/.exec(block[1]);
  if (!url) throw new Error(`no url() in the ${subset || "text"} block`);
  return url[1];
}

const wrap = (b64) =>
  (b64.match(/.{1,100}/g) || [])
    .map((line) => `  "${line}" +`)
    .join("\n")
    .replace(/ \+$/, "");

const [latinCss, rupeeCss] = await Promise.all([get(LATIN_CSS, true), get(RUPEE_CSS, true)]);
// Montserrat is a variable font, so every weight resolves to the same file —
// all five weights the design uses cost one 37 KB download.
const [latin, rupee] = await Promise.all([
  get(fontUrl(latinCss, "latin")),
  get(fontUrl(rupeeCss, "")),
]);

const out = `// Montserrat, embedded for the Computation of Income renderer.
//
// The render function runs headless Chromium with no system fonts at all, and
// the page must not reach the network (docs/computation-spec.md §13), so the
// typeface travels inside the HTML as base64 woff2.
//
// Two subsets, both from Google Fonts (SIL Open Font License 1.1):
//
//   LATIN  the variable face covering weights 400-800 in one file, so all five
//          weights the design uses cost 37 KB rather than five separate files.
//   RUPEE  U+20B9 only. Google's "latin" subset stops at U+20AC and does NOT
//          include the Indian rupee sign — without this the ₹ in the refund
//          banner would fall back to a font Chromium does not have, and render
//          as a blank box. 4 KB for one glyph is worth it.
//
// Regenerate with scripts/fetch-computation-fonts.mjs.
"use strict";

const MONTSERRAT_LATIN =
${wrap(latin.toString("base64"))};

const MONTSERRAT_RUPEE =
${wrap(rupee.toString("base64"))};

// The @font-face block the template's <head> needs. unicode-range keeps the
// rupee face out of the way of every other character.
const FONT_FACE_CSS = \`
@font-face {
  font-family: 'Montserrat';
  font-style: normal;
  font-weight: 400 800;
  src: url(data:font/woff2;base64,\${MONTSERRAT_LATIN}) format('woff2');
  unicode-range: ${LATIN_RANGE};
}
@font-face {
  font-family: 'Montserrat';
  font-style: normal;
  font-weight: 400 800;
  src: url(data:font/woff2;base64,\${MONTSERRAT_RUPEE}) format('woff2');
  unicode-range: U+20B9;
}
\`;

module.exports = { FONT_FACE_CSS };
`;

const target = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "functions", "fonts", "montserrat.js");
await writeFile(target, out);
console.log(`wrote ${target} — latin ${latin.length} B, rupee ${rupee.length} B`);
