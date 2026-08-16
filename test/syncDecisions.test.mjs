/* What the sync may skip — the rules that decide whether the portal is asked.
 *
 *   node --test test/syncDecisions.test.mjs
 *
 * These tests are written from a real failure. An A.Y. 2024-25 scrutiny under
 * s.143(3) carried four notices, three replies with 22 attachments between them,
 * and a closure order set — the assessment order, the computation sheet and a
 * demand notice u/s 156. The app showed the four notices and nothing else, and
 * told the practitioner four times that the assessee was up to date.
 *
 * Nothing had failed. The sync decided not to look, because "the notice count
 * has not changed and the proceeding is closed" — two true statements, neither
 * of which is evidence about a reply or an order. The payloads below are that
 * proceeding's, with the identifiers replaced; every field name and every shape
 * is the portal's own, taken from a HAR capture of the e-Proceedings screens.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { portalReplyState, shouldFetchReplies, proceedingSettled, shouldFetchClosureOrder } =
  require("../connector/src/main/syncDecisions.js");

/* One row of eProceedingsPaginatedService, "For your Information" tab: the
   closed scrutiny, with four notices, a reply filed on 07 Mar 2026 and a closure
   order the portal names outright. */
const CLOSED_ROW = {
  tab: "For your Information",
  proceedingReqId: "54139244",
  name: "Assessment Proceeding u/s 143(3)",
  ay: "2024",
  viewNoticeCount: 4,
  proceedingStatus: "C",
  closureSeqNo: "293849909",
  lastResponseSubmittedOn: 1772828433000,
};

/* One notice out of eProceedingDetailsService: the s.143(3) show-cause, replied
   to on 04 Sep 2025 and opened by the officer the next day. */
const REPLIED_NOTICE = {
  documentIdentificationNumber: "100100855319",
  headerSeqNo: "282101353",
  noticeSection: "143(3)",
  issuedOn: 1756697668000,
  responseDueDate: 1757475180000,
  lastResponseSubmittedOn: 1757009961549,
  responseViewedByAoOn: 1757085225000,
  respStatus: "S",
  isSubmitted: true,
  proceedingStatus: "O",
};

/* The fourth notice on the same proceeding: no reply, and the portal says so by
   carrying the fields empty rather than by omitting them. */
const UNREPLIED_NOTICE = {
  documentIdentificationNumber: "100097283891",
  headerSeqNo: "279062443",
  issuedOn: 1750653000000,
  lastResponseSubmittedOn: null,
  responseViewedByAoOn: null,
  respStatus: null,
};

/* ---------------- the reply the sync could never reach ---------------- */

test("a reply the portal reports and we do not hold is fetched, closed or not", () => {
  // THE BUG. Every one of these is a known notice on a closed proceeding, which
  // is precisely the combination the old rule refused to ask about.
  const d = shouldFetchReplies(REPLIED_NOTICE, { n: 0, last: 0 }, true);
  assert.equal(d.fetch, true);
  assert.match(d.why, /portal reports a reply, none on file/);
});

test("a reply filed after the one we hold is fetched", () => {
  const held = { n: 1, last: 1752016133078 }; // an earlier reply, on file
  assert.equal(shouldFetchReplies(REPLIED_NOTICE, held, true).fetch, true);
});

test("replies already on file are not fetched again", () => {
  const held = { n: 1, last: 1757009961549 }; // the same reply, to the millisecond
  const d = shouldFetchReplies(REPLIED_NOTICE, held, true);
  assert.equal(d.fetch, false);
  assert.match(d.why, /current/);
  // A reply we hold that is NEWER than the portal's figure is still current —
  // the two are the same event and the portal rounds its own timestamp.
  assert.equal(shouldFetchReplies(REPLIED_NOTICE, { n: 1, last: 1757009999999 }, true).fetch, false);
});

test("a notice the portal says has no reply costs no call at all", () => {
  // Worth having: this is most notices on most proceedings, and the old code
  // asked about every one of them on every open proceeding.
  const d = shouldFetchReplies(UNREPLIED_NOTICE, undefined, true);
  assert.equal(d.fetch, false);
  assert.match(d.why, /portal reports no reply/);
  // …but a notice we have never seen is still worth one call when the portal
  // has not addressed the question.
  assert.equal(shouldFetchReplies(UNREPLIED_NOTICE, undefined, false).fetch, false, "the portal DID address it here");
});

test("silence is not a no: a payload carrying none of the reply fields falls back", () => {
  /* The forward-compatibility case. If ITBA renames these fields, "no reply
     reported" must not be read out of a payload that never mentioned one —
     that would be the same silent-omission failure in a new disguise. */
  const silent = { documentIdentificationNumber: "1", headerSeqNo: "2", noticeSection: "143(2)" };
  assert.equal(portalReplyState(silent).spoke, false);
  assert.equal(shouldFetchReplies(silent, undefined, false).fetch, true, "a new notice is asked about");
  assert.equal(shouldFetchReplies(silent, undefined, true).fetch, false, "a known one keeps the old behaviour");
});

test("the reply signal is read from any of the fields the portal uses for it", () => {
  assert.equal(portalReplyState({ respStatus: "S" }).replied, true);
  assert.equal(portalReplyState({ isSubmitted: true }).replied, true);
  assert.equal(portalReplyState({ respId: 24430153 }).replied, true);
  assert.equal(portalReplyState({ lastResponseSubmittedOn: 1757009961549 }).last, 1757009961549);
  assert.equal(portalReplyState({ respStatus: null, lastResponseSubmittedOn: null }).replied, false);
});

/* ---------------- the proceeding that was skipped four times ---------------- */

test("a closed proceeding whose replies we do not hold is NOT settled", () => {
  // The exact state the reported assessee was in: four notices held, four
  // listed, and not one of the three replies on file.
  const d = proceedingSettled(CLOSED_ROW, { n: 4 }, { scope: "eproc" });
  assert.equal(d.skip, false);
  assert.match(d.why, /a reply was filed since we last looked/);
});

test("a closed proceeding whose closure order we do not hold is NOT settled", () => {
  // Replies all on file, so only the order is outstanding — the assessment
  // order, the computation sheet and the demand notice u/s 156.
  const d = proceedingSettled(CLOSED_ROW, { n: 4, r: 1772828433000 }, { scope: "all" });
  assert.equal(d.skip, false);
  assert.match(d.why, /closure order/);
});

test("a proceeding with nothing outstanding is settled, and stays cheap", () => {
  const d = proceedingSettled(CLOSED_ROW, { n: 4, r: 1772828433000, o: true }, { scope: "eproc" });
  assert.equal(d.skip, true);
  assert.match(d.why, /nothing the portal states has moved/);
});

test("a new notice is never skipped, whatever else is settled", () => {
  const d = proceedingSettled({ ...CLOSED_ROW, viewNoticeCount: 5 }, { n: 4, r: 1772828433000, o: true }, { scope: "eproc" });
  assert.equal(d.skip, false);
  assert.match(d.why, /more notices than we hold/);
});

test("the two repair lists still force a look", () => {
  const settled = { n: 4, r: 1772828433000, o: true };
  assert.equal(proceedingSettled(CLOSED_ROW, settled, { scope: "eproc", needsMeta: true }).skip, false);
  assert.equal(proceedingSettled(CLOSED_ROW, settled, { scope: "eproc", needsDocs: true }).skip, false);
});

test("an open proceeding is never skipped in the thorough scope", () => {
  const open = { ...CLOSED_ROW, tab: "For your Action", proceedingStatus: "O", closureSeqNo: "", lastResponseSubmittedOn: "" };
  assert.equal(proceedingSettled(open, { n: 4 }, { scope: "all" }).skip, false);
  // …and in the fast scope it is skipped only while nothing has moved.
  assert.equal(proceedingSettled(open, { n: 4 }, { scope: "eproc" }).skip, true);
  assert.equal(proceedingSettled({ ...open, lastResponseSubmittedOn: 1760265654000 }, { n: 4 }, { scope: "eproc" }).skip, false);
});

/* ---------------- the closure order ---------------- */

test("an order the portal names and we do not hold is always fetched", () => {
  for (const scope of ["all", "eproc"]) {
    const d = shouldFetchClosureOrder(CLOSED_ROW, { n: 4 }, { scope });
    assert.equal(d.fetch, true, scope);
  }
});

test("an order already on file is not fetched again", () => {
  assert.equal(shouldFetchClosureOrder(CLOSED_ROW, { n: 4, o: true }, { scope: "all" }).fetch, false);
});

test("a closed proceeding that names no order is still asked in the thorough scope", () => {
  // The portal's own screens show a Download Closure Order button on rows the
  // list does not flag, so the thorough scope keeps asking; the fast one does
  // not, which is what keeps a bulk sync over hundreds of closed years cheap.
  const quiet = { ...CLOSED_ROW, closureSeqNo: "" };
  assert.equal(shouldFetchClosureOrder(quiet, {}, { scope: "all" }).fetch, true);
  assert.equal(shouldFetchClosureOrder(quiet, {}, { scope: "eproc" }).fetch, false);
});

test("a proceeding that has just left the action list is asked, though its row says nothing", () => {
  // The synthetic row: no counts, no flags, only an id and the knowledge that we
  // held it as Active and the portal no longer lists it.
  const synthetic = { tab: "For your Information", proceedingStatus: "C", proceedingReqId: "54139244", viewNoticeCount: 0, closureSeqNo: "", justClosed: true };
  assert.equal(shouldFetchClosureOrder(synthetic, {}, { scope: "eproc" }).fetch, true);
});
