/* The PDF renderer, copied into functions/ and run the way Cloud Functions runs it.
 *
 *   node --test test/functionsShared.test.mjs
 *
 * Two failures are worth a test here, because both are silent and both surface
 * at 07:30 on a Saturday inside a scheduled function nobody is watching:
 *
 *   1. Somebody adds an import to the renderer and forgets to copy it, so the
 *      function dies with MODULE_NOT_FOUND.
 *   2. Somebody reaches for a browser API — document, window, a canvas — and the
 *      renderer stops working outside a browser while the app keeps working
 *      perfectly.
 *
 * The second is checked by simply rendering a PDF under Node. If this file
 * passes, the Saturday job can draw the sheet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FILES, relativeImportsOf, verify, build, OUT_DIR } from "../scripts/build-functions-shared.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (f) => fs.readFileSync(path.join(ROOT, "src", f), "utf8");

/* ---------------- the copied set is closed ---------------- */

test("every file the renderer imports is one of the files that gets copied", () => {
  const sources = Object.fromEntries(FILES.map((f) => [f, readSrc(f)]));
  const missing = verify(sources);
  assert.deepEqual(
    missing, [],
    missing.map((m) => `${m.file} imports ${m.spec} — add "${m.resolved}" to FILES in scripts/build-functions-shared.mjs`).join("\n")
  );
});

test("an uncopied import is caught rather than deployed", () => {
  // The exact mistake this guard exists for: a new import in pdfTheme.js that
  // nobody remembers to add to the copy list.
  const sources = {
    "pdfTheme.js": `import { jsPDF } from "jspdf";\nimport { fmtDate } from "./formatters.js";\n`,
  };
  const missing = verify(sources);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].resolved, "formatters.js");
});

test("bare package imports are not mistaken for files to copy", () => {
  // jspdf is a dependency of functions/, not something to vendor.
  assert.deepEqual(relativeImportsOf(`import { jsPDF } from "jspdf";`), []);
  assert.deepEqual(relativeImportsOf(`import x from "./a.js";\nexport { y } from "../b/c.js";`), ["./a.js", "../b/c.js"]);
});

test("the copy is written, banner and all, with an ESM marker beside it", () => {
  build({ quiet: true });
  for (const f of FILES) {
    const copied = fs.readFileSync(path.join(OUT_DIR, f), "utf8");
    assert.ok(copied.startsWith("/* GENERATED"), `${f} lost its banner`);
    assert.ok(copied.includes(readSrc(f)), `${f} is not a faithful copy of src/${f}`);
  }
  /* functions/ is CommonJS, so without this the copied .js files are parsed as
     CommonJS and every `import` in them is a syntax error. */
  const pkg = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "package.json"), "utf8"));
  assert.equal(pkg.type, "module");
});

/* ---------------- it renders outside a browser ---------------- */

test("the cause list renders under Node, with no DOM anywhere", async () => {
  /* Imported from src/ rather than the copy, so this fails the moment a browser
     API enters the renderer — whether or not anyone has run the copy step. */
  const { buildCauseListPDF } = await import("../src/causeListPdf.js");

  const hearings = [
    { assessee: "Rajesh M. Shah", pan: "ABCPS1234F", ay: "2017-18", authority: "ITAT", bench: "Ahmedabad 'A' Bench", section: "", date: "2026-08-17", time: "11:30", mode: "Physical", status: "Upcoming", ita: "ITA No. 1244/Ahd/2024", staff: "Priya Mehta" },
    { assessee: "Shah Textiles Pvt. Ltd.", pan: "AABCS9821K", ay: "2021-22", authority: "Scrutiny", bench: "Circle 4(1), Ahmedabad", section: "142(1)", date: "2026-08-19", time: "14:00", mode: "e-Proceeding", status: "Upcoming", ita: "", staff: "Priya Mehta" },
    { assessee: "Mehul Patel & Sons HUF", pan: "AAFHM2210C", ay: "2019-20", authority: "CIT(A)", bench: "NFAC", section: "250", date: "2026-08-21", time: "10:30", mode: "Video Conference", status: "Upcoming", ita: "", staff: "Arjun Desai" },
  ];

  const doc = buildCauseListPDF({
    hearings, from: "2026-08-17", to: "2026-08-23",
    profile: { firmName: "Mehta & Co.", ownerName: "CA Priya Mehta" },
  });
  const buf = Buffer.from(doc.output("arraybuffer"));

  assert.equal(buf.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.ok(buf.length > 10_000, `a cause list with three hearings should not be ${buf.length} bytes`);
  assert.equal(doc.getNumberOfPages(), 1);
});

test("an empty range still produces a valid document rather than throwing", () => {
  // The sweep skips empty weeks, but a renderer that throws on one would take
  // the whole Saturday job down if that guard were ever moved.
  return import("../src/causeListPdf.js").then(({ buildCauseListPDF }) => {
    const doc = buildCauseListPDF({ hearings: [], from: "2026-08-17", to: "2026-08-23", profile: {} });
    const buf = Buffer.from(doc.output("arraybuffer"));
    assert.equal(buf.subarray(0, 5).toString("latin1"), "%PDF-");
  });
});
