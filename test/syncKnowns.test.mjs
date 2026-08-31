/* What a sync already holds — and the two copies of the rules that say so.
 *
 *   node --test test/syncKnowns.test.mjs
 *
 * There are two implementations because there have to be: the web app's is ESM,
 * the connector's is CommonJS loaded by Electron's main process, and neither can
 * import the other. So this runs both over the same input and requires them to
 * agree field for field.
 *
 * That is not ceremony. They HAD drifted, in the direction that leaves no trace:
 * the connector's copy never computed `procNeedsMeta`, so the one mechanism for
 * reaching back into a closed proceeding did nothing on the path that actually
 * runs — and a sync that decides not to ask produces no error, no empty result,
 * nothing. It reports success over data it never looked at.
 *
 * The fixture is the reported assessee's shape, identifiers replaced: a closed
 * s.143(3) scrutiny whose four notices are on file and whose three replies and
 * closure order are not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

import { buildSyncKnowns as web, replyState, toMillis } from "../src/syncKnowns.js";

const require = createRequire(import.meta.url);
const { buildSyncKnowns: connector } = require("../connector/src/main/syncKnowns.js");

const PAN = "AAAPZ1000A";

const NOTICES = [
  // Four notices on the closed scrutiny. One carries a reply we already hold;
  // the rest carry none, though the portal has them.
  {
    pan: PAN, din: "100100855319", proceedingReqId: "54139244", fileName: "scn.pdf",
    docsSyncedAt: "2026-01-02T00:00:00.000Z", metaSyncedAt: "2026-01-02T00:00:00.000Z",
    responses: [{ responseId: "24430153", submittedOn: "1757009957123" }],
  },
  { pan: PAN, din: "100099900712", proceedingReqId: "54139244", docsSyncedAt: "2026-01-02T00:00:00.000Z" },
  { pan: PAN, din: "100097337990", proceedingReqId: "54139244", docsSyncedAt: "2026-01-02T00:00:00.000Z" },
  // Held with only one of its documents, from before a notice was understood to
  // be a set of files.
  { pan: PAN, din: "100097283891", proceedingReqId: "54139244", fileName: "intimation.pdf" },
  // A reply on file whose portal metadata has never been read — the case
  // procNeedsMeta exists for, and the one the connector's copy used to miss.
  {
    pan: PAN, din: "100088888888", proceedingReqId: "61138249",
    docsSyncedAt: "2026-01-02T00:00:00.000Z",
    responses: [{ responseId: "23814961", submittedOn: "1752016133078" }],
  },
  // A closure order held for another proceeding, keyed by docKey, not a DIN.
  { pan: PAN, docKey: "sat:440242261", isOrder: true, proceedingReqId: "61138249", docsSyncedAt: "2026-01-02T00:00:00.000Z" },
  /* Three filed Form 35s, which is where the SECOND reported version of the
     same fault lived. The appeals pass skips any form whose `f35:<ackNum>` it
     already holds, and the ingest writes that key however the fetch went — so
     the first two below, saved without documents they should have, were held
     for ever and no re-sync went back for them. */
  {
    pan: PAN, docKey: "f35:132456789012345", isAppealForm: true, proceedingReqId: "61138249",
    appeal: { ackNum: "132456789012345", formPdfError: "HTTP 502", attachmentsExpected: 1, attachmentsMissing: [], fetchTries: 1, attachments: [] },
  },
  {
    pan: PAN, docKey: "f35:132456789012346", isAppealForm: true, proceedingReqId: "61138249",
    appeal: { ackNum: "132456789012346", formPdfError: "", attachmentsExpected: 2, attachmentsMissing: ["Grounds of Appeal.pdf"], fetchTries: 0, attachments: [{ storagePath: "users/x/f35.pdf", filename: "Form 35 - 132456789012346.pdf" }] },
  },
  // Asked for as many times as it is going to be: the portal is not going to
  // render this one, and it must stop costing every future sync.
  {
    pan: PAN, docKey: "f35:132456789012347", isAppealForm: true, proceedingReqId: "61138249",
    appeal: { ackNum: "132456789012347", formPdfError: "HTTP 502", attachmentsExpected: 0, attachmentsMissing: [], fetchTries: 3, attachments: [] },
  },
  // And one that came down whole, which must never be fetched again.
  {
    pan: PAN, docKey: "f35:132456789012348", isAppealForm: true, proceedingReqId: "61138249",
    appeal: { ackNum: "132456789012348", formPdfError: "", attachmentsExpected: 1, attachmentsMissing: [], fetchTries: 0, attachments: [{ storagePath: "users/x/g.pdf", filename: "Grounds.pdf" }] },
  },
  // Another assessee's notice, which must not leak into this PAN's knowns.
  { pan: "AAAPZ9999A", din: "999", proceedingReqId: "99999", responses: [{ responseId: "9", submittedOn: "1800000000000" }] },
];

const MATTERS = [
  { pan: PAN, status: "Active", proceedingReqId: "61138249" },
  { pan: PAN, status: "Closed", proceedingReqId: "54139244" },
  { pan: "AAAPZ9999A", status: "Active", proceedingReqId: "99999" },
];

const RETURNS = [
  { pan: PAN, ackNum: "551745770010724", formPdfPath: "users/x/form.pdf", orders: [
    { commRefNo: "CPC1", storagePath: "users/x/o1.pdf" },
    { commRefNo: "CPC2", storagePath: "users/x/o2.pdf", locked: true },
    { commRefNo: "CPC3", lockReason: "request-only" },
  ] },
  { pan: "AAAPZ9999A", ackNum: "999", orders: [] },
];

const build = (fn) => fn(NOTICES, PAN, MATTERS, RETURNS, "1985-02-18");

/* ---------------- the two copies agree ---------------- */

test("the web app's rules and the connector's produce the same knowns", () => {
  // Sets are built by iteration, so order can differ without meaning differing;
  // everything here is compared as a sorted list or a plain object.
  const a = build(web);
  const b = build(connector);
  for (const k of Object.keys(a)) {
    const [x, y] = [a[k], b[k]];
    if (Array.isArray(x)) assert.deepEqual([...x].sort(), [...(y || [])].sort(), k);
    else assert.deepEqual(x, y, k);
  }
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), "and neither carries a field the other does not");
});

test("a filed Form 35 held without its documents is asked for again — and one held whole is not", () => {
  /* The reported fault: "most of the time it does not fetch the pdfs of all the
     Form 35 and its attachments", and re-syncing changed nothing. It changed
     nothing because the ingest had already written the docKey the appeals pass
     skips on, so the form was "held" — with no PDF behind it. */
  for (const fn of [web, connector]) {
    const pending = build(fn).appealFormsPending;
    assert.deepEqual(pending, [
      { ackNum: "132456789012345", tries: 1 }, // its PDF never rendered
      { ackNum: "132456789012346", tries: 0 }, // its grounds never came down
    ]);
    // Not the one asked for three times already — a document the portal will
    // genuinely never hand over must stop costing every sync from here on.
    assert.ok(!pending.some((p) => p.ackNum === "132456789012347"));
    // And never the complete one.
    assert.ok(!pending.some((p) => p.ackNum === "132456789012348"));
  }
});

test("both carry procNeedsMeta — the field one of them used to omit entirely", () => {
  // Named on its own because its absence is exactly what cannot be seen: a
  // missing "known" makes a sync skip MORE, silently.
  for (const fn of [web, connector]) {
    assert.deepEqual(build(fn).procNeedsMeta, ["61138249"]);
  }
});

/* ---------------- and every one of them survives the journey ---------------- */

test("every known reaches the connector — each hop names the fields it carries", () => {
  /* THE OTHER HALF OF THE SAME BUG. Computing a hint correctly is worthless if
     it is dropped in transit, and it was: `procNeedsMeta` was built by the web
     app, spread into openPortalLogin, and destructured away by a signature that
     did not mention it — then dropped again by the extension's own list. Three
     places name these fields one by one, and a field missing from any of them
     makes the sync skip MORE, with nothing to show that it did.

     So the source of each hop is read and required to mention every field the
     builder produces. Crude, and it catches exactly the thing that went wrong. */
  const hops = [
    ["src/portalSync.js", readFileSync(new URL("../src/portalSync.js", import.meta.url), "utf8")],
    ["extension/background.js", readFileSync(new URL("../extension/background.js", import.meta.url), "utf8")],
    /* THE LAST HOP, and the one that was missing from this list.
     *
     * Carrying a hint faultlessly to a sync that never reads it fails in exactly
     * the same way as dropping it, and for months that is what happened:
     * `noticeReplies`, `procNeedsMeta` and `appealFormsPending` arrived in the
     * extension's creds and nothing in portal-login.js so much as mentioned
     * them, so its fetch went on counting notices while the connector's read
     * what the portal said. Every field ends here, because this one file holds
     * every pass the extension runs. */
    ["extension/portal-login.js", readFileSync(new URL("../extension/portal-login.js", import.meta.url), "utf8")],
  ];
  const fields = Object.keys(build(web)).filter((k) => k !== "canUnlockOrders");
  for (const [name, source] of hops) {
    for (const f of fields) {
      assert.ok(new RegExp(`\\b${f}\\b`).test(source), `${name} does not carry ${f}`);
    }
  }
});

/* ---------------- what the knowns say ---------------- */

test("replies are counted per notice, so the portal's own figure can be compared", () => {
  const k = build(web);
  assert.deepEqual(k.noticeReplies["100100855319"], { n: 1, last: 1757009957123 });
  assert.deepEqual(k.noticeReplies["100099900712"], { n: 0, last: 0 });
  // A notice with no reply on file must read as zero rather than be absent —
  // "not in the map" and "no replies" have to mean the same thing downstream.
  assert.deepEqual(k.noticeReplies["100097283891"], { n: 0, last: 0 });
});

test("each proceeding carries its newest reply, which is what the list row is compared against", () => {
  const k = build(web);
  assert.equal(k.knownByProc["54139244"].n, 4);
  assert.equal(k.knownByProc["54139244"].r, 1757009957123);
  assert.equal(k.knownByProc["54139244"].o, undefined, "no closure order on file for the scrutiny");
  assert.equal(k.knownByProc["61138249"].o, true);
});

test("a notice missing its documents lists both the notice and its proceeding", () => {
  const k = build(web);
  assert.deepEqual(k.noticeDocsPending, [{ din: "100097283891", fileName: "intimation.pdf" }]);
  assert.deepEqual(k.procNeedsDocs, ["54139244"]);
});

test("DINs and docKeys are both 'known', because an order has no DIN", () => {
  const k = build(web);
  assert.ok(k.knownDins.includes("100100855319"));
  assert.ok(k.knownDins.includes("sat:440242261"));
});

test("another assessee's data never reaches this PAN's knowns", () => {
  const k = build(web);
  assert.ok(!k.knownDins.includes("999"));
  assert.ok(!k.knownResponseIds.includes("9"));
  assert.deepEqual(k.knownActiveProcs, ["61138249"]);
  assert.ok(!k.knownAckNums.includes("999"));
});

test("returns and orders are 'known' only when there is nothing left to fetch", () => {
  const k = build(web);
  assert.deepEqual(k.knownAckNums, ["551745770010724"]);
  assert.deepEqual(k.knownFormAcks, ["551745770010724"]);
  // Held and readable, or never servable, count as done. Held-but-locked does
  // not: a date of birth arriving later is how it gets repaired.
  assert.deepEqual(k.knownOrderRefs.sort(), ["CPC1", "CPC3"]);
  assert.deepEqual(k.lockedOrderRefs, ["CPC2"]);
  assert.equal(k.canUnlockOrders, true);
});

/* ---------------- the timestamp reader ---------------- */

test("a reply timestamp is read whether it was stored as a number or a string", () => {
  // The portal sends epoch milliseconds; the ingest stores whatever it was given
  // as a string. Both have to compare against the portal's own number.
  assert.equal(toMillis(1757009957123), 1757009957123);
  assert.equal(toMillis("1757009957123"), 1757009957123);
  assert.equal(toMillis("2025-09-04T18:19:17.123Z"), 1757009957123);
  // Anything unreadable is 0, which reads as "we hold nothing" and therefore
  // fetches. That is the right way to be wrong about a number that decides
  // whether to ask the portal a question.
  assert.equal(toMillis(""), 0);
  assert.equal(toMillis(null), 0);
  assert.equal(toMillis("not a date"), 0);
});

test("replyState takes the newest of several replies", () => {
  const n = { responses: [{ submittedOn: "1752016133078" }, { submittedOn: "1757009957123" }, { submittedOn: "" }] };
  assert.deepEqual(replyState(n), { n: 3, last: 1757009957123 });
  assert.deepEqual(replyState({}), { n: 0, last: 0 });
});
