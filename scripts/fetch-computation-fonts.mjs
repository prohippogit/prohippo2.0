/*
 * Regenerate the embedded typefaces the Computation of Income renderer needs.
 *
 *   node scripts/fetch-computation-fonts.mjs
 *
 * The renderer runs headless Chromium with no system fonts and no network
 * access (docs/computation-spec.md §13), so every face travels inside the HTML
 * as base64 woff2. One module per family, under functions/fonts/.
 *
 * ONE MODULE PER FAMILY: the classic theme is set in Montserrat and the curvy
 * one in Poppins (§14). The render function inlines all of them on every
 * document — see functions/fonts/index.js for why narrowing by theme was tried
 * and abandoned.
 *
 * Run it when Google ships a new version of either family (the URLs carry a
 * version today), or when the design needs a character outside the latin
 * subset. It is not part of the build — the generated files are committed, so a
 * deploy never depends on Google being reachable.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Google serves different CSS to different clients; a browser UA is what gets
// us woff2 rather than a fallback format.
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const LATIN_RANGE =
  "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA,\n" +
  "                 U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122,\n" +
  "                 U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";

/* THE RUPEE SIGN IS NOT IN THE LATIN SUBSET of either family. Google's "latin"
   stops at U+20AC, so without a face for U+20B9 the ₹ in the refund banner
   falls back to a font Chromium does not have and renders as a blank box.
   `text=₹` asks Google for a subset containing exactly that one glyph — under
   a kilobyte, for the one character the whole document turns on.

   AND IT IS DECLARED AT EVERY WEIGHT THE FAMILY HAS, not once. Declared once at
   `400 800` beside five static faces at 400…800, Chromium matched the weight
   first and picked an 800 latin face that does not contain the glyph, then fell
   through to DejaVu Sans — so the refund banner's ₹ was set in a different
   typeface from the figure beside it. A variable family has one weight
   descriptor and therefore one rupee face; a static family has five of each.
   The file is the same 900 bytes either way. */
const RUPEE = "%E2%82%B9";

const FAMILIES = [
  {
    module: "montserrat",
    family: "Montserrat",
    /* A VARIABLE font: every weight resolves to the same file, so all five the
       design uses cost one 37 KB download. */
    weights: "400;500;600;700;800",
    variable: true,
    note: "the classic theme (docs/computation-spec.md §14)",
  },
  {
    module: "poppins",
    family: "Poppins",
    /* NOT a variable font on Google Fonts — Poppins ships one file per weight,
       so the five the curvy theme uses are five downloads and five faces. That
       is ~80 KB against Montserrat's 37, and it is what the design is drawn in;
       synthesising the weights from one face is visibly wrong on a document
       whose whole look is the weight contrast between a caption and a figure. */
    weights: [400, 500, 600, 700, 800],
    variable: false,
    note: "the curvy theme (docs/computation-spec.md §14)",
  },
];

async function get(url, asText) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return asText ? res.text() : Buffer.from(await res.arrayBuffer());
}

/* Pull the woff2 URL out of one @font-face block. `subset` names the comment
   Google puts above each block ("latin", "devanagari", …); a text= subset has
   no comments at all, so an empty name means "the first block there is". */
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

const face = (family, weight, constant, range) => `@font-face {
  font-family: '${family}';
  font-style: normal;
  font-weight: ${weight};
  src: url(data:font/woff2;base64,\${${constant}}) format('woff2');
  unicode-range: ${range};
}`;

async function build(spec) {
  const list = spec.variable ? [spec.weights] : spec.weights;
  const cssFor = (w) => `https://fonts.googleapis.com/css2?family=${spec.family}:wght@${w}&display=swap`;

  const latins = [];
  for (const w of list) {
    const css = await get(cssFor(spec.variable ? spec.weights : w), true);
    latins.push({ weight: w, data: await get(fontUrl(css, "latin")) });
  }
  const rupeeCss = await get(
    `https://fonts.googleapis.com/css2?family=${spec.family}:wght@${spec.variable ? "400..800" : 600}&text=${RUPEE}`, true);
  const rupee = await get(fontUrl(rupeeCss, ""));

  const upper = spec.family.toUpperCase();
  const consts = latins.map((l, i) => {
    const name = spec.variable ? `${upper}_LATIN` : `${upper}_${l.weight}`;
    return { name, decl: `const ${name} =\n${wrap(l.data.toString("base64"))};`, weight: l.weight, i };
  });

  const weights = spec.variable ? ["400 800"] : list;
  const faces = consts
    .map((c) => face(spec.family, spec.variable ? "400 800" : c.weight, c.name, LATIN_RANGE))
    .concat(weights.map((w) => face(spec.family, w, `${upper}_RUPEE`, "U+20B9")))
    .join("\n");

  const bytes = latins.reduce((a, l) => a + l.data.length, 0) + rupee.length;
  const out = `// ${spec.family}, embedded for the Computation of Income renderer — ${spec.note}.
//
// From Google Fonts, under the SIL Open Font License 1.1.
//
// The render function runs headless Chromium with no system fonts at all, and
// the page must not reach the network (docs/computation-spec.md §13), so the
// typeface travels inside the HTML as base64 woff2.
//
// ${spec.variable
    ? "One variable face covering weights 400-800, plus U+20B9 on its own:"
    : `One face per weight (${list.join(", ")}) — ${spec.family} is not a variable font — plus U+20B9 on its own:`}
// Google's "latin" subset stops at U+20AC and has no rupee sign, and the ₹ in
// the refund banner would otherwise render as a blank box.
//
// Regenerate with scripts/fetch-computation-fonts.mjs.
"use strict";

${consts.map((c) => c.decl).join("\n\n")}

const ${upper}_RUPEE =
${wrap(rupee.toString("base64"))};

// The @font-face block the template's <head> needs. unicode-range keeps the
// rupee face out of the way of every other character.
const FONT_FACE_CSS = \`
${faces}
\`;

module.exports = { FONT_FACE_CSS };
`;

  const target = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "functions", "fonts", `${spec.module}.js`);
  await writeFile(target, out);
  console.log(`wrote ${target} — ${latins.length} latin face(s) + rupee, ${Math.round(bytes / 1024)} KB`);
}

for (const spec of FAMILIES) await build(spec);
