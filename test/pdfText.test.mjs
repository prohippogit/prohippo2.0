/*
 * Aligning tracked text on a PDF page.
 *
 *   node --test test/pdfText.test.mjs
 *
 * Reported on the ITR-B letterhead: the strapline under the wordmark ran off
 * the right edge of the page. jsPDF's own right-alignment measures `charSpace`
 * differently from the way it draws it, and the error scales with the length of
 * the string, so the longest straplines overflowed worst — "OF UNDISCLOSED
 * INCOME" ended eight millimetres past the margin.
 *
 * The arithmetic is the whole fix, so the arithmetic is what is tested. The doc
 * is a stub: two characters to the millimetre, which makes every expected
 * figure below one that can be worked out by hand.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { trackedWidth, alignedX } from "../src/pdfText.js";

const doc = { getTextWidth: (s) => String(s).length * 2 };
const R = 196; // the right margin every document in this practice draws to

test("tracking widens a string by the gaps between its characters", () => {
  // Five characters, four gaps. PDF adds the tracking after the last glyph too,
  // but that trailing gap carries no ink and must not push the string left.
  assert.equal(trackedWidth(doc, "ABCDE", 0), 10);
  assert.equal(trackedWidth(doc, "ABCDE", 0.5), 12);
  assert.equal(trackedWidth(doc, "ABCDE", -0.25), 9);
  assert.equal(trackedWidth(doc, "A", 5), 2, "one character has no gaps");
  assert.equal(trackedWidth(doc, "", 5), 0);
});

test("a tracked string ends on the margin it was aligned to", () => {
  // The reported fault: this is what jsPDF got wrong, in the direction that
  // put the strapline off the page.
  assert.equal(alignedX(doc, "ABCDE", R, "right", 0.5), R - 12);
  assert.equal(alignedX(doc, "ABCDE", R, "center", 0.5), R - 6);
  // Negative tracking is the wordmark's case — it must not stop short.
  assert.equal(alignedX(doc, "ITR-B", R, "right", -0.2), R - (10 - 0.8));
});

test("untracked text is left to jsPDF, and says so", () => {
  // null, not the x passed in: a caller that treated it as an answer would
  // drop the `align` option and left-align every heading in the document.
  assert.equal(alignedX(doc, "ABCDE", R, "right", 0), null);
  assert.equal(alignedX(doc, "ABCDE", R, "right"), null);
  assert.equal(alignedX(doc, "ABCDE", R, "left", 0.5), null);
  assert.equal(alignedX(doc, "ABCDE", R, "justify", 0.5), null);
});
