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
  portalDocLabel, documentKind, documentExt, noticeDocFilename,
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

/* ---------------- a notice's OTHER documents ----------------
 *
 * The names below are real, off the s.148 set that exposed the bug: the portal
 * served four files behind one notice and the app only ever saw one of them. */

test("a portal filename reduces to the one segment that says what it is", () => {
  assert.equal(
    portalDocLabel("70000000145843545_186446841_2025_AST_AXIPP8954H_Notice us 148_1087936850(1)_26032026.pdf"),
    "Notice us 148"
  );
  assert.equal(
    portalDocLabel("70000000145843512_186446264_2025_AST_AXIPP8954H_Print Approval Search_1087855481(1)_24032026.pdf"),
    "Print Approval Search"
  );
  assert.equal(portalDocLabel("70000000145843513_186446265_2025_AST_SET NOTE APPROVAL.pdf"), "SET NOTE APPROVAL");
  assert.equal(portalDocLabel("70000000145843515_186446267_2025_AST_APPROVAL TO JAO.pdf.gz"), "APPROVAL TO JAO");
});

test("a filename that isn't shaped like ITBA's keeps its own name", () => {
  // Falling through to the base name is worse than a label and better than "".
  assert.equal(portalDocLabel("Reply annexures.zip"), "Reply annexures");
  assert.equal(portalDocLabel("123456_7890.pdf"), "123456_7890");
});

test("a compressed bundle is told apart from a PDF", () => {
  assert.equal(documentKind("annexures.zip"), "zip");
  assert.equal(documentKind("annexures", "application/x-zip-compressed"), "zip");
  assert.equal(documentKind("notice.pdf"), "pdf");
  // The portal names its objects "*.pdf.gz" and serves them decompressed — that
  // trailing .gz is transport, not a bundle the practitioner has to unpack.
  assert.equal(documentKind("notice.pdf.gz", "application/pdf"), "pdf");
  assert.equal(documentKind("scan.tif", "image/tiff"), "other");
});

test("a download keeps the extension its content implies", () => {
  assert.equal(documentExt("annexures.zip"), "zip");
  assert.equal(documentExt("notice.pdf.gz"), "pdf");
  assert.equal(documentExt("unnamed", "application/zip"), "zip");
  assert.equal(documentExt("unnamed", "application/pdf"), "pdf");
});

test("an enclosure is named for itself, not for the notice it came with", () => {
  const notice = { ay: "2022-23", section: "148" };
  assert.equal(
    noticeDocFilename({ filename: "70000000145843513_186446265_2025_AST_SET NOTE APPROVAL.pdf" }, notice, "Virajkumar Patel"),
    "Virajkumar Patel - AY 2022-23 - SET NOTE APPROVAL.pdf"
  );
  assert.equal(
    noticeDocFilename({ filename: "annexures.zip", contentType: "application/zip" }, notice, "Virajkumar Patel"),
    "Virajkumar Patel - AY 2022-23 - annexures.zip"
  );
});
