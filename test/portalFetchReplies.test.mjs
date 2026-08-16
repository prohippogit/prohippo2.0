/* The reported sync, replayed end to end.
 *
 *   node --test test/portalFetchReplies.test.mjs
 *
 * An A.Y. 2024-25 scrutiny u/s 143(3), closed: four notices, three replies with
 * their attachments, and a closure order set — the assessment order, the
 * computation sheet, a demand notice u/s 156. The practitioner held the four
 * notices and nothing else, synced four times including a full sync, and was
 * told each time that the assessee was up to date.
 *
 * syncDecisions.test.mjs pins the rules. This one runs the real fetch loop over
 * the portal's real payload shapes — taken from a HAR capture of the screens,
 * identifiers replaced — with the portal and the ingest stubbed, and asserts
 * that what the practitioner was missing actually comes down.
 *
 * The stubs answer exactly what the portal answered. That is the point: a test
 * against payloads we invented would only prove we are consistent with
 * ourselves, which is what the code already was.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const P = (m) => require.resolve(`../connector/src/main/${m}`);

const PAN = "AAAPZ1000A";
const PROC = "54139244";

/* ---------------- the portal, as it answered ---------------- */

// eProceedingsPaginatedService, "For your Information": the closed scrutiny.
const FYI_ROW = {
  proceedingReqId: PROC,
  proceedingName: "Assessment Proceeding u/s 143(3)",
  pan: PAN,
  nameOfAssesse: "SAMPLE NAME 1",
  assessmentYear: "2024",
  financialYr: "2023",
  viewNoticeCount: 4,
  proceedingType: "I",
  lastResponseSubmittedOn: 1772828433000,
  proceedingClosureOrder: "293849909",
  proceedingStatus: "C",
};

// eProceedingDetailsService: four notices, three of them replied to.
const NOTICES = [
  { headerSeqNo: "282101353", documentIdentificationNumber: "100100855319", noticeSection: "143(3)", description: "[ITBA]Show Cause Notice for Proceedings u/s 143(3)of Income Tax Act 1961.", issuedOn: 1756697668000, responseDueDate: 1757475180000, lastResponseSubmittedOn: 1757009961549, responseViewedByAoOn: 1757085225000, respStatus: "S", ay: 2024, pan: PAN, proceedingStatus: "O" },
  { headerSeqNo: "281122143", documentIdentificationNumber: "100099900712", noticeSection: "142(1)", description: "[ITBA]Notice u/s 142(1)of Income Tax Act 1961.", issuedOn: 1754899200000, responseDueDate: 1756080000000, lastResponseSubmittedOn: 1755933127933, responseViewedByAoOn: 1756166400000, respStatus: "S", ay: 2024, pan: PAN, proceedingStatus: "O" },
  { headerSeqNo: "279160446", documentIdentificationNumber: "100097337990", noticeSection: "143(2)", description: "[ITBA]Intimation and Notice u/s 143(2) of the Income-tax Act, 1961.", issuedOn: 1750723200000, servedOn: 1750749916000, responseDueDate: 1752019200000, lastResponseSubmittedOn: 1752016133078, responseViewedByAoOn: 1752105600000, respStatus: "S", ay: 2024, pan: PAN, proceedingStatus: "O" },
  { headerSeqNo: "279062443", documentIdentificationNumber: "100097283891", description: "[ITBA]Intimation and Notice u/s 143(2) of the Income-tax Act, 1961.", issuedOn: 1750653000000, lastResponseSubmittedOn: null, responseViewedByAoOn: null, respStatus: null, ay: 2024, pan: PAN, proceedingStatus: "O" },
];

// itbaResponseService, by headerSeqNo. Note the shape: `respRemrkAttLst`, with
// the attachment's id under `docId`.
const REPLIES = {
  282101353: { respRemrkAttLst: [{ respType: "FR", remarks: "…reply to the show cause…", remarksHash: "613370fea2daa9e3", submittedOn: 1757009957123, responseId: 24430153, attachmentLst: [{ categorieName: "ALL 13 LAC RECEIPTS OF DONATIONS", attachmentName: "Receipts COPY.pdf", docId: 397379915 }, { categorieName: "RECEIPTS TRACTION DETAILS", attachmentName: "bank statement.pdf", docId: 397379959 }] }] },
  281122143: { respRemrkAttLst: [{ respType: "FR", remarks: "…reply to the 142(1)…", remarksHash: "698aa3d9576ac2eb", submittedOn: 1755933127933, responseId: 24304905, attachmentLst: [{ categorieName: "computation of income", attachmentName: "Computation of income.pdf", docId: 395252720 }] }] },
  279160446: { respRemrkAttLst: [{ respType: "FR", remarks: "…acknowledgement of the 143(2)…", remarksHash: "27a7f25c396aae8a", submittedOn: 1752016133078, responseId: 23814961, attachmentLst: [{ categorieName: "Others", attachmentName: "Acknowledgement.pdf", docId: 387748044 }] }] },
  279062443: { respRemrkAttLst: [] },
};

// downloadClosureOrder: the three documents that ended the proceeding.
const CLOSURE = {
  procdngReqId: PROC,
  closureSeqNo: "293849909",
  satDocId: null,
  docNam: null,
  satDocDetlList: [
    { satDocId: 440242261, docNam: "70000000142171562_182305803_2025_AST_AAAPZ1000A_Order us 143(3)_1086883937(1)_05032026.pdf" },
    { satDocId: 439483756, docNam: "70000000142190043_181974345_2025_AST_AAAPZ1000A_Computation Sheet_1086897329(1)_05032026.pdf" },
    { satDocId: 439466034, docNam: "70000000142194673_181978478_2025_AST_AAAPZ1000A_Demand Notice us 156_1086900090(1)_05032026.pdf" },
  ],
};

/* ---------------- the stubs ---------------- */

const calls = [];      // every service the sync asked for
const ingested = [];   // every message it handed to the ingest

function stub(mod, exports) { require.cache[P(mod)] = { id: P(mod), filename: P(mod), loaded: true, exports }; }

stub("pacing", { jsleep: async () => {}, PACE: { betweenDocs: [0, 0] } });
stub("ingest", { ingestSyncMessage: async (m) => { ingested.push(m); return { ok: true }; } });
stub("portalAppeals", { syncAppealForms: async () => {} });
stub("portalReturns", { syncReturns: async () => {} });

const realApi = require("../connector/src/main/portalApi.js");
stub("portalApi", {
  ...realApi,
  proceedings: async (_page, { statusFlag }) => {
    calls.push(`list:${statusFlag}`);
    return { ok: true, json: { eProceedingPaginatedRequests: statusFlag === "FYI" ? [FYI_ROW] : [] } };
  },
  apiCall: async (_page, { serviceName, payload }) => {
    calls.push(serviceName);
    if (serviceName === "eProceedingDetailsService") return { ok: true, json: NOTICES };
    if (serviceName === "itbaResponseService") return { ok: true, json: REPLIES[payload.headerSeqNo] || { respRemrkAttLst: [] } };
    if (serviceName === "downloadClosureOrder") return { ok: true, json: CLOSURE };
    if (serviceName === "noticeletterpdf") return { ok: true, json: { satDocId: 1, docNam: "notice.pdf", docMap: { 1: "notice.pdf" } } };
    return { ok: true, json: {} };
  },
  getDoc: async (_page, { docId }) => ({ ok: true, base64: "JVBERi0=", filename: `${docId}.pdf`, contentType: "application/pdf", bytes: 1024 }),
});

const { syncPortalData } = require("../connector/src/main/portalFetch.js");

/* The practitioner's state when they reported it: four notices on file, not one
   reply, no order. Exactly what buildSyncKnowns produces for that. */
const heldEverything = () => ({
  knownDins: NOTICES.map((n) => n.documentIdentificationNumber),
  knownByProc: { [PROC]: { n: 4 } },
  knownResponseIds: [],
  noticeReplies: Object.fromEntries(NOTICES.map((n) => [n.documentIdentificationNumber, { n: 0, last: 0 }])),
  procNeedsMeta: [],
  noticeDocsPending: [],
  procNeedsDocs: [],
  knownActiveProcs: [],
});

async function run(scope, knowns) {
  calls.length = 0;
  ingested.length = 0;
  const job = { assesseeId: "a1", pan: PAN, knowns };
  const summary = { proceedings: 0, notices: 0, documents: 0, responses: 0, appeals: 0, returns: 0, orders: 0 };
  await syncPortalData({}, job, scope, () => {}, summary);
  return summary;
}

/* ---------------- the failure, and the fix ---------------- */

test("the fast scope reads BOTH tabs, so a closed proceeding is visible at all", async () => {
  // It used to read "for your action" only. A closed scrutiny is in neither the
  // action tab nor, once the app has recorded it as closed, the synthetic list —
  // so on the scope the app defaults to after the first sync, and the one every
  // bulk sync uses, this proceeding did not exist.
  await run("eproc", heldEverything());
  assert.ok(calls.includes("list:FYA"));
  assert.ok(calls.includes("list:FYI"));
});

for (const scope of ["eproc", "all"]) {
  test(`${scope}: the three replies the practitioner was missing come down`, async () => {
    const summary = await run(scope, heldEverything());
    assert.equal(summary.responses, 3, "one for each notice the portal reports a reply against");

    const replies = ingested.filter((m) => m.kind === "response" && m.response.responseId);
    assert.deepEqual(replies.map((m) => m.response.responseId).sort(), ["23814961", "24304905", "24430153"]);
    // With their attachments, fetched by the id the portal states (`docId`).
    const withDocs = replies.find((m) => m.response.responseId === "24430153");
    assert.equal(withDocs.response.attachments.length, 2);
    assert.ok(withDocs.response.attachments.every((a) => a.contentBase64));
    assert.equal(withDocs.response.attachments[0].label, "ALL 13 LAC RECEIPTS OF DONATIONS");
    assert.equal(withDocs.response.noticeKey, "100100855319");
  });

  test(`${scope}: the closure order set comes down — order, computation, demand notice`, async () => {
    await run(scope, heldEverything());
    const orders = ingested.filter((m) => m.kind === "notice" && m.notice.isOrder);
    assert.deepEqual(orders.map((m) => m.notice.docKey).sort(), ["sat:439466034", "sat:439483756", "sat:440242261"]);
    // The demand notice is the one with a clock on it: 30 days from service.
    const demand = orders.find((m) => /Demand Notice us 156/.test(m.notice.description));
    assert.ok(demand, "the demand notice u/s 156 must arrive");
    assert.ok(demand.notice.contentBase64, "with its PDF");
    // Dated from the portal's own filename, which is where the date lives.
    assert.equal(demand.notice.issuedOn, "2026-03-05");
  });
}

test("the notice the portal says has no reply costs no call", async () => {
  await run("all", heldEverything());
  // Three reply calls, not four: the fourth notice carries no reply and the
  // portal says so. The old code asked about every notice on every open
  // proceeding and about none on a closed one — wrong in both directions.
  assert.equal(calls.filter((c) => c === "itbaResponseService").length, 3);
});

test("nothing is fetched twice: a second sync over the same state is quiet", async () => {
  // What the practitioner's fourth sync SHOULD have cost once the first had
  // worked — the two list calls, and nothing else.
  const caughtUp = {
    ...heldEverything(),
    knownDins: [...NOTICES.map((n) => n.documentIdentificationNumber), "sat:440242261", "sat:439483756", "sat:439466034"],
    knownByProc: { [PROC]: { n: 4, o: true, r: 1772828433000 } },
    noticeReplies: Object.fromEntries(NOTICES.map((n) => [n.documentIdentificationNumber, { n: 1, last: 1772828433000 }])),
  };
  const summary = await run("eproc", caughtUp);
  assert.equal(summary.responses, 0);
  assert.equal(summary.notices, 0);
  assert.equal(summary.skipped, 1, "and it says the proceeding was skipped rather than implying it was read");
  assert.deepEqual(calls, ["list:FYA", "list:FYI"]);
});

test("a proceeding that is skipped is counted, so 'up to date' is never asserted blind", async () => {
  // The grievance under the grievance: the sync reported success over data it
  // had decided not to look at, and nothing anywhere said so.
  const caughtUp = {
    ...heldEverything(),
    knownByProc: { [PROC]: { n: 4, o: true, r: 1772828433000 } },
    noticeReplies: Object.fromEntries(NOTICES.map((n) => [n.documentIdentificationNumber, { n: 1, last: 1772828433000 }])),
  };
  const summary = await run("all", caughtUp);
  assert.equal(summary.skipped, 1);
});

test("a reply filed after the last sync is picked up on the next one", async () => {
  // The proceeding is settled except for one reply filed since. The portal says
  // so on the row and on the notice; both are compared, and it is fetched.
  const almost = {
    ...heldEverything(),
    knownByProc: { [PROC]: { n: 4, o: true, r: 1755933127933 } },
    noticeReplies: {
      100100855319: { n: 0, last: 0 },
      100099900712: { n: 1, last: 1755933127933 },
      100097337990: { n: 1, last: 1752016133078 },
      100097283891: { n: 0, last: 0 },
    },
  };
  const summary = await run("eproc", almost);
  assert.equal(summary.responses, 1);
  assert.equal(ingested.find((m) => m.kind === "response" && m.response.responseId).response.responseId, "24430153");
});
