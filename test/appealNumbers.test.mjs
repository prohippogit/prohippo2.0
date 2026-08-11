/* Matching one appeal number against another spelling of itself.
 *
 *   node --test test/appealNumbers.test.mjs
 *
 * This decides whether a proceeding finds its own hearings. It fails silently
 * when it is wrong — no error, just a card reading "0 hearings" with two of
 * them sitting on the assessee's page — which is exactly why it is pinned.
 *
 * The reduction has to agree with canonicalAppealNo in
 * functions/itatEmailParse.js, which is what the server uses to decide that an
 * incoming notice belongs to an appeal already on file. If the two disagree, a
 * hearing the server merged appears unlinked to the client that displays it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { appealKey, sameAppeal } from "../src/appeals.js";

test("one appeal, however it was written down", () => {
  const forms = [
    "ITA 1762/AHD/2026",
    "ITA No. 1762/Ahd/2026",
    "ITA no 1762 / ahd / 2026",
    "ITA Nos. 1762/AHD/2026",
    "ITA 01762/AHD/2026",
  ];
  for (const written of forms) {
    assert.ok(sameAppeal(written, "ITA 1762/AHD/2026"), `"${written}" is the same appeal`);
  }
});

test("the year keeps its own zeros", () => {
  // Stripping leading zeros everywhere would turn 2026 into 226 on some other
  // registry's numbering and quietly merge two unrelated appeals.
  assert.equal(appealKey("ITA 5/AHD/2026"), "ITA5AHD2026");
  assert.ok(!sameAppeal("ITA 1/AHD/2026", "ITA 1/AHD/226"));
});

test("different appeals stay different", () => {
  assert.ok(!sameAppeal("ITA 1762/AHD/2026", "ITA 1763/AHD/2026"), "one digit apart is another appeal");
  assert.ok(!sameAppeal("ITA 1762/AHD/2026", "ITA 1762/MUM/2026"), "another registry is another appeal");
  assert.ok(!sameAppeal("ITA 1762/AHD/2026", "ITA 1762/AHD/2025"), "another year is another appeal");
  assert.ok(!sameAppeal("CO 1762/AHD/2026", "ITA 1762/AHD/2026"), "a cross objection is not the appeal");
});

test("two blanks are not a match", () => {
  // A scrutiny matter has no appeal number and neither does its hearing.
  // Treating that as a link would attach every such hearing to every such
  // matter — the worst possible failure, and the easy one to write.
  assert.ok(!sameAppeal("", ""));
  assert.ok(!sameAppeal(undefined, undefined));
  assert.ok(!sameAppeal(null, ""));
  assert.ok(!sameAppeal("ITA 1/AHD/2026", ""));
  assert.equal(appealKey(undefined), "");
});
