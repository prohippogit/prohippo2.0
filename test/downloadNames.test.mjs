/*
 * Filenames for downloaded documents.
 *
 *   node --test test/downloadFile.test.mjs
 *
 * These names end up in a practitioner's Downloads folder and get attached to
 * submissions, so they matter more than their size suggests. The module also
 * touches the DOM and Firebase Storage; only the pure naming half is tested
 * here, which is the half that can be wrong without anyone noticing.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  safeFilename, withExtension, noticeFilename, returnOrderFilename, returnDocFilename,
} from "../src/downloadNames.js";

test("statutory slashes survive as hyphens rather than vanishing", () => {
  // "u/s 143(1)" is how a practitioner writes it, and a filename cannot hold a
  // slash — but dropping it would give "us 143(1)", which reads as a typo.
  assert.equal(safeFilename("Order u/s 143(1)"), "Order u-s 143(1)");
});

test("characters no filesystem accepts are removed", () => {
  assert.equal(safeFilename('a:b*c?d"e<f>g|h'), "abcdefgh");
  assert.equal(safeFilename("tab\tand\nnewline"), "tab and newline");
});

test("spaces and hyphens are preserved", () => {
  // A regression guard: an earlier character class swept these up, which turned
  // every name into one unreadable run of words.
  assert.equal(safeFilename("Sample Foods - AY 2025-26"), "Sample Foods - AY 2025-26");
});

test("leading and trailing dots are stripped", () => {
  // A leading dot makes a hidden file on macOS and Linux; a trailing one is
  // silently dropped by Windows, which then mangles the extension.
  assert.equal(safeFilename("..hidden.."), "hidden");
});

test("an empty or unusable name falls back rather than producing nothing", () => {
  assert.equal(safeFilename(""), "document");
  assert.equal(safeFilename("///"), "document");
  assert.equal(safeFilename(null, "Notice"), "Notice");
});

test("names are capped so no filesystem rejects them", () => {
  assert.ok(safeFilename("x".repeat(400)).length <= 180);
});

test("an extension is added once, never twice", () => {
  assert.equal(withExtension("Report", "pdf"), "Report.pdf");
  assert.equal(withExtension("Report.pdf", "pdf"), "Report.pdf");
  assert.equal(withExtension("Report.PDF", "pdf"), "Report.PDF");
  assert.equal(withExtension("Report", ".pdf"), "Report.pdf");
});

test("a notice is named by assessee, year, section and DIN", () => {
  assert.equal(
    noticeFilename({ ay: "2025-26", section: "143(2)", din: "ITBA123456789" }, "Sample Foods"),
    "Sample Foods - AY 2025-26 - Notice - u-s 143(2) - ITBA123456789.pdf"
  );
});

test("an order says so instead of calling itself a notice", () => {
  assert.equal(
    noticeFilename({ ay: "2024-25", section: "147", isOrder: true }, "Sample Foods"),
    "Sample Foods - AY 2024-25 - Order - u-s 147.pdf"
  );
});

test("missing pieces of a notice name are dropped, not left as gaps", () => {
  assert.equal(noticeFilename({}, "Sample Foods"), "Sample Foods - Notice.pdf");
  assert.equal(noticeFilename({ ay: "2025-26" }, ""), "AY 2025-26 - Notice.pdf");
});

test("a CPC document is named for the section it was issued under", () => {
  assert.equal(
    returnOrderFilename({ section: "143(1)" }, "2025-26", "Sample Foods"),
    "Sample Foods - AY 2025-26 - Intimation u-s 143(1).pdf"
  );
  assert.equal(
    returnOrderFilename({ section: "154" }, "2025-26", "Sample Foods"),
    "Sample Foods - AY 2025-26 - Rectification Order u-s 154.pdf"
  );
});

test("each return document is named for what it is, with the right extension", () => {
  const ret = { ay: "2025-26", form: "ITR-5" };
  assert.equal(returnDocFilename("json", ret, "Sample Foods"), "Sample Foods - AY 2025-26 - ITR-5 JSON.json");
  assert.equal(returnDocFilename("ack", ret, "Sample Foods"), "Sample Foods - AY 2025-26 - ITR-V Acknowledgement.pdf");
  assert.equal(returnDocFilename("form", ret, "Sample Foods"), "Sample Foods - AY 2025-26 - ITR-5 Form.pdf");
  assert.equal(returnDocFilename("computation", ret, "Sample Foods"), "Sample Foods - AY 2025-26 - Computation of Income.pdf");
});

test("a return whose form we don't know still gets a usable name", () => {
  assert.equal(
    returnDocFilename("json", { ay: "2019-20" }, "Sample Foods"),
    "Sample Foods - AY 2019-20 - ITR JSON.json"
  );
});
