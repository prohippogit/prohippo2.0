/*
 * Eyeball a Computation of Income without running the app or deploying anything.
 *
 *   npm run preview:computation                       # the default fixture
 *   npm run preview:computation -- path/to/itr.json   # any ITR JSON
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

import { buildComputation, UnsupportedFormError, ValidationError } from "../src/computation/index.js";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const input = process.argv[2] || path.join(root, "test", "fixtures", "itr5-firm-business-loss-ay2025-26.json");
const json = JSON.parse(readFileSync(input, "utf8"));

let built;
try {
  built = buildComputation(json, { generatedAt: new Date().toISOString() });
} catch (err) {
  if (err instanceof UnsupportedFormError || err instanceof ValidationError) {
    console.error(`\n${err.name}: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

// The fonts live with the render function, not the browser bundle. Inline them
// here too, or the preview falls back to a system face and stops being a preview.
const { FONT_FACE_CSS } = require("../functions/fonts/montserrat.js");
const html = built.html.replace("/*__COMPUTATION_FONT_FACE__*/", FONT_FACE_CSS);

const outDir = path.join(root, ".tmp");
mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, path.basename(input).replace(/\.json$/, "") + ".html");
writeFileSync(out, html);

const { doc } = built;
console.log(`${doc.meta.form} · A.Y. ${doc.meta.assessmentYear} · ${doc.assessee.name}`);
console.log(`sections: ${doc.sections.map((s) => `${s.letter}·${s.id}`).join(", ")}`);
console.log(doc.unmapped.length
  ? `unmapped: ${doc.unmapped.length} — ${doc.unmapped.slice(0, 5).map((u) => u.path).join(", ")}`
  : "unmapped: none");
console.log(`\nwrote ${path.relative(root, out)}`);
