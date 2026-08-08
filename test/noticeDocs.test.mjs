/*
 * A notice is a SET of files, not a file.
 *
 *   node --test test/noticeDocs.test.mjs
 *
 * The payload below is verbatim from the portal, off the s.148 reassessment
 * that exposed the bug: `noticeletterpdf` named ONE document at the top level
 * and listed all four under `docMap`, and the sync read the first and stopped —
 * taking, on this notice, an 11 MB internal approval rather than the notice the
 * assessee has to answer.
 *
 * Both halves are tested from the one fixture: what the connector pulls out of
 * the portal's JSON, and what the card then lists.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { noticeDocuments, noticeDocumentCount, hasDocumentList } from "../src/noticeDocs.js";

// The connector is CommonJS and deliberately shares no bundle with the web app;
// this is the one place the two halves are checked against the same fixture.
const require = createRequire(import.meta.url);
const { noticeDocuments: portalDocs, pickPrimaryDocument } = require("../connector/src/main/portalApi.js");

/* Real noticeletterpdf response — DIN 100111894544, AY 2022-23, s.148.
   Trimmed to the fields that decide anything. */
const NOTICE_LETTER_PDF = {
  noticeSection: "148",
  noticeId: "100111894544",
  satDocId: 442426058,
  docNam: "70000000145843515_186446267_2025_AST_APPROVAL TO JAO.pdf.gz",
  docMap: {
    "442426058": "70000000145843515_186446267_2025_AST_APPROVAL TO JAO.pdf.gz",
    "442426042": "70000000145843513_186446265_2025_AST_SET NOTE APPROVAL.pdf.gz",
    "442426059": "70000000145843545_186446841_2025_AST_AXIPP8954H_Notice us 148_1087936850(1)_26032026.pdf.gz",
    "442426040": "70000000145843512_186446264_2025_AST_AXIPP8954H_Print Approval Search_1087855481(1)_24032026.pdf.gz",
  },
};

test("every document behind the notice is found, not just the one named at the top", () => {
  const docs = portalDocs(NOTICE_LETTER_PDF);
  assert.equal(docs.length, 4);
  // Ascending satDocId — the order the portal's own screen lists them in. The
  // docMap's key order is NOT that order, so this is a real assertion.
  assert.deepEqual(docs.map((d) => d.satDocId), ["442426040", "442426042", "442426058", "442426059"]);
});

test("the primary is the notice itself, not whatever satDocId happened to point at", () => {
  const docs = portalDocs(NOTICE_LETTER_PDF);
  const i = pickPrimaryDocument(docs, { section: "148", declaredSatDocId: 442426058 });
  assert.match(docs[i].docNam, /Notice us 148/);
  // Specifically NOT the portal's own pick, which is the approval letter.
  assert.notEqual(docs[i].satDocId, "442426058");
});

test("a single-document response still works, map or no map", () => {
  const one = { satDocId: 442426058, docNam: "notice.pdf.gz" };
  assert.deepEqual(portalDocs(one), [{ satDocId: "442426058", docNam: "notice.pdf.gz" }]);
  assert.equal(pickPrimaryDocument(portalDocs(one), { section: "148", declaredSatDocId: 442426058 }), 0);
  assert.deepEqual(portalDocs({}), []);
  assert.deepEqual(portalDocs(null), []);
});

test("a set with nothing to go on falls back to the portal's own pick", () => {
  // No section in any filename, no "notice"/"approval" words: the tie-break is
  // the satDocId the portal declared, not the first row of the map.
  const json = { satDocId: 200, docNam: "b.pdf", docMap: { 100: "a.pdf", 200: "b.pdf" } };
  const docs = portalDocs(json);
  assert.equal(pickPrimaryDocument(docs, { section: "143(2)", declaredSatDocId: 200 }), 1);
});

test("the card lists the notice's own PDF first, then the rest of the set", () => {
  const notice = {
    storagePath: "users/u/assessees/a/notices/din_x.pdf",
    fileName: "70000000145843545_186446841_2025_AST_AXIPP8954H_Notice us 148_1087936850(1)_26032026.pdf",
    attachments: [
      { storagePath: "p1", filename: "70000000145843513_186446265_2025_AST_SET NOTE APPROVAL.pdf", kind: "pdf", bytes: 824848 },
      { storagePath: "p2", filename: "Annexures.zip", kind: "zip", bytes: 91234 },
    ],
  };
  const docs = noticeDocuments(notice);
  assert.equal(docs.length, 3);
  assert.equal(docs[0].primary, true);
  assert.equal(docs[1].primary, false);
  assert.equal(docs[2].kind, "zip");
  assert.equal(noticeDocumentCount(notice), 3);
});

test("an attachment with no Storage object is not offered as a download", () => {
  // The fetch records what it could not retrieve; a button that resolves to
  // nothing is worse than no button.
  const notice = { storagePath: "p0", fileName: "notice.pdf", attachments: [{ filename: "missing.pdf", storagePath: null }] };
  assert.equal(noticeDocumentCount(notice), 1);
});

test("a lone plain PDF needs no list; a lone ZIP does", () => {
  assert.equal(hasDocumentList({ storagePath: "p", fileName: "notice.pdf" }), false);
  // "Download the PDF" is a lie about a compressed folder — say so even alone.
  assert.equal(hasDocumentList({ storagePath: "p", fileName: "bundle.zip" }), true);
  assert.equal(hasDocumentList({ storagePath: "p", fileName: "notice.pdf", attachments: [{ storagePath: "q", filename: "b.pdf" }] }), true);
  // A notice with no document at all has nothing to list.
  assert.equal(hasDocumentList({}), false);
});
