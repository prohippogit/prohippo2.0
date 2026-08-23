/*
 * Themes — spec §14.
 *
 *   node --test test/computation/themes.test.mjs
 *
 * A theme is a STYLESHEET. That is the whole claim this file exists to keep,
 * and it is the same rule §2 keeps for forms: when the document needs to look
 * different, the renderer gains a stylesheet, not a branch. The moment one
 * theme's markup differs from another's, there are two renderers to keep in
 * step and a bug fixed in one of them stays broken in the other.
 *
 * Three things can go wrong here and none of them is visible in a diff:
 *
 *   the markup forks, so a fix lands in one look and not the other;
 *   a stylesheet is missing a rule the template emits, so an element is
 *   unstyled in one theme and nobody notices until a client is holding it;
 *   the typeface is named on the client and missing on the server, and the PDF
 *   comes back set in nothing at all — headless Chromium has no system fonts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";

import { buildComputation } from "../../src/computation/index.js";
import { THEMES, THEME_IDS, DEFAULT_THEME, resolveTheme } from "../../src/computation/render/themes/index.js";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "..", "fixtures", "itr3-landsale-54b-ay2024-25.json");
const json = JSON.parse(readFileSync(FIXTURE, "utf8"));
const CTX = { generatedAt: "2026-01-01T00:00:00.000Z" };

const build = (ctx) => buildComputation(json, { ...CTX, ...ctx });
const ids = Object.keys(THEMES);

/* ---------------- the registry ---------------- */

test("every theme is complete, and the default is one of them", () => {
  assert.ok(ids.length >= 2, "a theme setting with one theme in it is not a setting");
  for (const id of ids) {
    const t = THEMES[id];
    assert.equal(t.id, id, `${id}: the key and the id must agree`);
    assert.ok(t.name && t.name.length <= 24, `${id}: needs a short name for the settings card`);
    assert.ok(t.description && t.description.length > 30, `${id}: needs a description a practitioner can choose from`);
    assert.equal(typeof t.stylesheet, "function");
    assert.ok(t.font, `${id}: must name the typeface it is set in`);
  }
  assert.ok(THEMES[DEFAULT_THEME], "the default must exist");
  assert.equal(DEFAULT_THEME, "curvy", "the curvy theme is the default — see §14");
  assert.equal(THEME_IDS[0], DEFAULT_THEME, "Settings offers the default first");
  assert.deepEqual([...THEME_IDS].sort(), [...ids].sort(), "every theme is offered");
});

test("an unknown, empty or mistyped theme resolves to the default rather than failing", () => {
  /* A settings value that has been hand-edited, or a client older than a theme
     that has since been renamed, must not stop a practitioner getting their
     document. Falling back is recoverable; throwing is not. */
  for (const bad of [undefined, null, "", "  ", "CURVY", "navy", 7, {}]) {
    assert.equal(resolveTheme(bad).id, DEFAULT_THEME, `resolveTheme(${JSON.stringify(bad)})`);
  }
  assert.equal(resolveTheme("classic").id, "classic");
  assert.equal(resolveTheme(" curvy ").id, "curvy", "a stray space is not a different theme");
});

/* ---------------- a theme is a stylesheet and nothing else ---------------- */

test("every theme prints the SAME markup — only the <style> and the body class differ", () => {
  /* THE LOAD-BEARING TEST. Strip the stylesheet and the theme's own class off
     both documents and what is left has to be identical, character for
     character. If it is not, a theme has started to be a second renderer. */
  const strip = (html) => html
    .replace(/<style>[\s\S]*?<\/style>/g, "<style/>")
    .replace(/<body class="t-[a-z-]+">/, "<body>");

  const [first, ...rest] = ids.map((id) => build({ theme: id }));
  for (const other of rest) {
    assert.equal(strip(other.html), strip(first.html),
      "two themes produced different markup — a theme is a stylesheet (§14)");
  }
  // …and the body still says which theme it is, so a stylesheet can hang a rule
  // off it and a saved page can be told apart from another.
  for (const id of ids) assert.match(build({ theme: id }).html, new RegExp(`<body class="t-${id}">`));
});

test("each stylesheet is self-contained — no URL of any kind but a data: one", () => {
  /* §13: the page renders with the network cut off. An external stylesheet, a
     webfont or a background image is a silent blank on the practitioner's
     document, and silent is the problem. */
  for (const id of ids) {
    const css = THEMES[id].stylesheet({});
    assert.ok(!/@import/.test(css), `${id}: @import cannot be reached`);
    for (const m of css.matchAll(/url\(([^)]*)\)/g)) {
      assert.match(m[1], /^["']?data:/, `${id}: ${m[1]} is not reachable from the render`);
    }
  }
});

test("every class the template emits is styled by every theme", () => {
  /* A rule missing from one theme is an element that renders unstyled in that
     one alone — a table with no rules round it, or a chip that is just a
     letter. It cannot be seen in a diff of either file, only by comparing the
     two, which is what this does. */
  const html = build({}).html.replace(/<style>[\s\S]*?<\/style>/g, "");
  const used = new Set();
  for (const m of html.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].trim().split(/\s+/)) if (c && !/^t-/.test(c)) used.add(c);
  }
  assert.ok(used.size > 25, `expected the document to use many classes, saw ${used.size}`);

  for (const id of ids) {
    const css = THEMES[id].stylesheet({});
    const missing = [...used].filter((c) => !new RegExp(`\\.${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(css));
    assert.deepEqual(missing, [], `the ${id} theme has no rule for: ${missing.join(", ")}`);
  }
});

/* ---------------- the practice's accent ---------------- */

test("the curvy theme is coloured by the practice's accent, and the classic one is not", () => {
  /* The accent is `profile.invoiceSettings.accent` — the same setting that
     colours the invoices and the ITR-B. A practice that has chosen crimson
     should not get one violet document. */
  const crimson = THEMES.curvy.stylesheet({ accent: "#E11D48" });
  assert.ok(crimson.includes("#e11d48") || crimson.includes("#E11D48"), "the accent must reach the stylesheet");
  assert.ok(!/#6c5ce7/i.test(crimson), "…and nothing may stay violet behind it");

  // Every tint is derived, so they move with it: a crimson document has no
  // violet wash anywhere in it.
  assert.ok(!/#[0-9a-f]*(5ce7|6c5c)/i.test(crimson));

  // The classic theme is a fixed house style (§6) and ignores the accent — its
  // navy and gold are shared with the appellate templates.
  assert.equal(THEMES.classic.stylesheet({ accent: "#E11D48" }), THEMES.classic.stylesheet({}));
});

test("a nonsense accent falls back rather than emitting broken CSS", () => {
  for (const bad of ["", "red", "#12", "not a colour", undefined, null, "#000000"]) {
    const css = THEMES.curvy.stylesheet({ accent: bad });
    if (bad !== "#000000") {
      assert.match(css, /--accent: #6c5ce7;/i, `accent ${JSON.stringify(bad)} should fall back to the default`);
    }
    assert.ok(!/NaN|undefined|null/.test(css), `accent ${JSON.stringify(bad)} leaked into the CSS`);
    /* Every colour the stylesheet derives has to be a colour. The masthead
       darkens the accent for its gradient, and a black accent darkened past
       zero used to emit "#-2e…", which Chromium drops silently — an unpainted
       masthead, on the practice that picked the darkest colour offered. */
    for (const m of css.matchAll(/#[0-9a-fA-F-]+/g)) {
      assert.match(m[0], /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/,
        `accent ${JSON.stringify(bad)} produced ${m[0]}`);
    }
  }
});

/* ---------------- the typeface, which is half server-side ---------------- */

test("every family a theme asks for is one the render function actually embeds", () => {
  /* THE FAULT THIS REPLACED A MAPPING TO PREVENT.
   *
   * The server used to inline ONE family, chosen from the theme id. Client and
   * server deploy separately, so the first curvy document went out to a
   * function that had never heard of the curvy theme: the page asked for
   * Poppins, the @font-face block held Montserrat, and Chromium — which has no
   * system fonts in the render container — set the whole PDF in Liberation
   * Sans. Nothing errored. The practitioner just got the wrong document.
   *
   * So the server sends every face it has, and the only thing left to check is
   * that a theme cannot ask for one nobody embedded. */
  const { fontFaceFor, FAMILIES } = require("../../functions/fonts");
  const css = fontFaceFor("anything at all");

  for (const id of ids) {
    const family = THEMES[id].font;
    assert.ok(FAMILIES[family], `${id}: no embedded face for ${family}`);
    assert.match(css, new RegExp(`font-family: '${family}'`, "i"),
      `${id}: ${family} is not in what the render function inlines`);
  }

  // Every face travels as base64 in the page; a URL would be a blank (§13).
  for (const [family, block] of Object.entries(FAMILIES)) {
    for (const m of block.matchAll(/url\(([^)]*)\)/g)) assert.match(m[1], /^data:font\/woff2;base64,/);
  }

  /* The theme id changes nothing, deliberately: narrowing by theme is what
     broke, and a test that let it come back would be worth nothing. */
  for (const t of [undefined, "curvy", "classic", "a-theme-from-next-year"]) {
    assert.equal(fontFaceFor(t), css, `fontFaceFor(${JSON.stringify(t)}) must not narrow`);
  }
});

test("the rupee sign is declared at every weight the family is", () => {
  /* THE ₹ THAT CAME OUT IN A DIFFERENT TYPEFACE.
   *
   * Google's latin subset stops at U+20AC, so each family carries a second face
   * for U+20B9 alone. Poppins is not a variable font — it is five static faces
   * at 400…800 — and the rupee face was declared once, at `400 800`. Chromium
   * matched the WEIGHT first, picked the 800 latin face, found no ₹ in it and
   * fell through to DejaVu Sans: the refund banner's rupee sign set in a
   * different typeface from the figure beside it, on every document.
   *
   * The rule that fixes it is structural and can be checked without a browser:
   * whatever weights a family declares for latin, it declares for the rupee. */
  const { FAMILIES } = require("../../functions/fonts");

  for (const [family, css] of Object.entries(FAMILIES)) {
    const weights = { latin: new Set(), rupee: new Set() };
    for (const block of css.split("@font-face").slice(1)) {
      const w = /font-weight:\s*([^;]+);/.exec(block);
      const r = /unicode-range:\s*([^;]+);/s.exec(block);
      assert.ok(w && r, `${family}: a face with no weight or no range`);
      weights[/U\+20B9/i.test(r[1]) ? "rupee" : "latin"].add(w[1].trim());
    }
    assert.ok(weights.latin.size, `${family}: no latin face`);
    assert.deepEqual([...weights.rupee].sort(), [...weights.latin].sort(),
      `${family}: the rupee sign is not available at every weight the text is set in`);
  }
});

test("each theme names the family its stylesheet actually asks for", () => {
  for (const id of ids) {
    const css = THEMES[id].stylesheet({});
    const family = /font-family:\s*'([^']+)'/.exec(css);
    assert.ok(family, `${id}: the stylesheet sets no font-family`);
    assert.equal(family[1].toLowerCase(), THEMES[id].font.toLowerCase(),
      `${id}: the stylesheet asks for ${family[1]} and the registry embeds ${THEMES[id].font}`);
  }
});

/* ---------------- how the theme is chosen ---------------- */

test("the theme comes from the profile, an explicit argument overrides it, and neither touches a figure", () => {
  const fromProfile = build({ profile: { computationTheme: "classic" } });
  assert.equal(fromProfile.theme, "classic");

  const explicit = build({ profile: { computationTheme: "classic" }, theme: "curvy" });
  assert.equal(explicit.theme, "curvy", "an argument wins — it is how the preview renders both");

  assert.equal(build({}).theme, DEFAULT_THEME, "a practice that has never opened Settings gets the default");
  assert.equal(build({ profile: {} }).theme, DEFAULT_THEME);

  /* THE DOCUMENT IS THE SAME DOCUMENT. Nothing about a look may reach a figure,
     a label or the review block — the model is what validate() ties to the
     return, and a theme that could change it would be a tax engine with a
     colour picker. */
  assert.deepEqual(build({ theme: "classic" }).doc, build({ theme: "curvy" }).doc);
});

test("the accent reaches the page from the same profile setting the invoices use", () => {
  const { html } = build({ profile: { invoiceSettings: { accent: "#0D9488" } } });
  assert.match(html, /--accent: #0d9488;/i);
});
