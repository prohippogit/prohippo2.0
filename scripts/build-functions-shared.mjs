/*
 * Copies the PDF renderer into `functions/shared/` so Cloud Functions can draw
 * the same documents the browser draws.
 *
 * WHY THIS EXISTS. The weekly cause list is sent at 07:30 on a Saturday, when
 * nobody has a browser open — so unlike the invoice, which a practitioner
 * generates by pressing a button, it has to be rendered on the server. The
 * renderer already exists in `src/`, it is pure ESM with no DOM, and it runs
 * under Node unchanged. The only thing wrong with it is its address: Firebase
 * uploads the `functions/` directory and nothing outside it.
 *
 * WHY COPY RATHER THAN FORK. The alternative was a second cause-list renderer
 * written against the Chromium already in functions/computation.js. That is a
 * second design of the same document to keep in step with the first, and
 * pdfTheme.js exists precisely because "a second copy of a brand drifts from
 * the first the week after it is written". A copy made by a build step cannot
 * drift; a copy made by a person does.
 *
 * WHY NOT A WORKSPACE OR A SYMLINK. `firebase deploy` follows neither — it
 * uploads the directory, and a symlink out of it arrives broken. npm workspaces
 * would restructure the whole repo to solve one import.
 *
 * The output is git-ignored. It is a build artefact of src/, like dist/ and the
 * extension zip — committing it would create the second copy this exists to
 * avoid. Run automatically before every deploy (firebase.json `predeploy`) and
 * by `npm run build`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OUT_DIR = path.join(ROOT, "functions", "shared");

/*
 * The transitive closure of `causeListPdf.js`, listed by hand rather than
 * walked, because a list you can read is worth more here than one that is
 * clever: this is the whole set of files that must behave identically on both
 * sides, and it should be obvious when it grows.
 *
 *   causeListPdf.js → pdfTheme.js  → invoicePdf.js → fonts/invoiceFonts.js
 *                   → causeList.js
 *
 * If an import is added to any of them and not added here, verify() below fails
 * the build rather than letting a deploy discover it.
 */
export const FILES = [
  "causeList.js",
  "causeListPdf.js",
  "pdfTheme.js",
  "invoicePdf.js",
  "fonts/invoiceFonts.js",
];

const BANNER = `/* GENERATED — do not edit.
 * Copied from src/ by scripts/build-functions-shared.mjs so Cloud Functions can
 * render the same PDFs the browser renders. Edit the original in src/.
 */
`;

/* Every relative import in the copied files, so we can check the set is closed.
   Deliberately a regex over the source rather than a parser: these are five
   files whose import lines are all at the top and all plain. */
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g;

export function relativeImportsOf(source) {
  const out = [];
  let m;
  while ((m = IMPORT_RE.exec(source)) !== null) {
    if (m[1].startsWith(".")) out.push(m[1]);
  }
  return out;
}

/* Is every relative import of every copied file also being copied?
 *
 * The failure this catches is quiet and expensive: somebody adds
 * `import { fmtDate } from './formatters.js'` to pdfTheme.js, the app keeps
 * working, and the Saturday cause list starts throwing MODULE_NOT_FOUND inside
 * a scheduled function where nobody is watching. Better to fail the build. */
export function verify(sources) {
  const copied = new Set(FILES.map((f) => path.posix.normalize(f)));
  const missing = [];
  for (const [file, source] of Object.entries(sources)) {
    const dir = path.posix.dirname(file);
    for (const spec of relativeImportsOf(source)) {
      const resolved = path.posix.normalize(path.posix.join(dir, spec)).replace(/^\.\//, "");
      if (!copied.has(resolved)) missing.push({ file, spec, resolved });
    }
  }
  return missing;
}

export function build({ quiet = false } = {}) {
  const sources = {};
  for (const file of FILES) {
    sources[file] = fs.readFileSync(path.join(ROOT, "src", file), "utf8");
  }

  const missing = verify(sources);
  if (missing.length) {
    const lines = missing.map((m) => `  ${m.file} imports ${m.spec} (${m.resolved}), which is not copied`);
    throw new Error(
      `functions/shared is missing an import:\n${lines.join("\n")}\n` +
      `Add it to FILES in scripts/build-functions-shared.mjs, or the scheduled ` +
      `cause list will fail with MODULE_NOT_FOUND after deploy.`
    );
  }

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  let bytes = 0;
  for (const file of FILES) {
    const dest = path.join(OUT_DIR, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const body = BANNER + sources[file];
    fs.writeFileSync(dest, body);
    bytes += Buffer.byteLength(body);
  }

  /* functions/ has no "type": "module", so a bare .js there is CommonJS and
     these would fail to parse. The nearest package.json wins, so one here marks
     just this directory as ESM — the CommonJS around it is unaffected. */
  fs.writeFileSync(
    path.join(OUT_DIR, "package.json"),
    JSON.stringify({
      name: "prohippo-functions-shared",
      private: true,
      type: "module",
      _comment: "GENERATED by scripts/build-functions-shared.mjs. Marks this directory as ESM; functions/ itself is CommonJS.",
    }, null, 2) + "\n"
  );

  if (!quiet) {
    console.log(`functions/shared ← src (${FILES.length} files, ${Math.round(bytes / 1024)} KB)`);
  }
  return { files: FILES.length, bytes };
}

// Only when run directly, so the test can import verify() without writing files.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build();
}
