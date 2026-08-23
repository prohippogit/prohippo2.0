/*
 * Eyeball a Computation of Income without running the app or deploying anything.
 *
 *   npm run preview:computation                            # the default fixture
 *   npm run preview:computation -- path/to/itr.json        # any ITR JSON
 *   npm run preview:computation -- path/to/itr.json curvy  # in a named theme
 *   npm run preview:computation -- path/to/itr.json all    # one file per theme
 *
 * Writes .tmp/<name>.html — open it in a browser and it looks exactly as the
 * PDF will, because the render function does nothing to the markup except add
 * the embedded fonts and print it (docs/computation-spec.md §13).
 *
 * DO NOT point this at a real client's return and leave the output lying around
 * in the repo. .tmp/ is gitignored for that reason.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";

import { buildComputation, UnsupportedFormError, ValidationError, THEMES, THEME_IDS } from "../src/computation/index.js";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const input = process.argv[2] || path.join(root, "test", "fixtures", "itr5-firm-business-loss-ay2025-26.json");
/* Which theme (§14). A named one, "all" for one file per theme — which is how
   two looks are compared without regenerating between them — or nothing, which
   is whatever the default is today. */
const wanted = (process.argv[3] || "").trim();
const themes = wanted === "all" ? THEME_IDS : [THEMES[wanted] ? wanted : ""];
const json = JSON.parse(readFileSync(input, "utf8"));

/* The fonts live with the render function, not the browser bundle. Inline them
   here too, or the preview falls back to a system face and stops being a
   preview — and the face is the loudest thing a theme changes, so previewing
   without it shows the wrong document. */
const { fontFaceFor } = require("../functions/fonts");

const outDir = path.join(root, ".tmp");
mkdirSync(outDir, { recursive: true });
const base = path.basename(input).replace(/\.json$/, "");

let doc = null;
for (const theme of themes) {
  let built;
  try {
    built = buildComputation(json, { generatedAt: new Date().toISOString(), theme });
  } catch (err) {
    if (err instanceof UnsupportedFormError || err instanceof ValidationError) {
      console.error(`\n${err.name}: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  doc = built.doc;
  const out = path.join(outDir, `${base}${themes.length > 1 ? "." + built.theme : ""}.html`);
  writeFileSync(out, built.html.replace("/*__COMPUTATION_FONT_FACE__*/", fontFaceFor()));
  console.log(`wrote ${path.relative(root, out)}   (${THEMES[built.theme].name})`);
}

console.log(`\n${doc.meta.form} · A.Y. ${doc.meta.assessmentYear} · ${doc.assessee.name}`);
console.log(`sections: ${doc.sections.map((s) => `${s.letter}·${s.id}`).join(", ")}`);
console.log(doc.unmapped.length
  ? `unmapped: ${doc.unmapped.length} — ${doc.unmapped.slice(0, 5).map((u) => u.path).join(", ")}`
  : "unmapped: none");
