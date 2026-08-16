// What a sync already holds — the incremental diff, computed once.
//
// CommonJS twin of src/syncKnowns.js. The web app's module is ESM and Electron's
// main process cannot import it, so the rules are written twice and
// test/syncKnowns.test.mjs runs BOTH over the same input and asserts they agree
// field for field.
//
// That test is not ceremony. The two copies DID drift: this one never computed
// `procNeedsMeta`, so the repair path meant to reach into a closed proceeding
// did nothing at all on the path that actually runs — and a skip leaves no
// trace, so nothing anywhere said so. Keep them identical, or delete one.
//
// Pure: plain arrays in, plain object out, no Firestore and no Electron. That is
// what makes it testable, and testable is the whole point.
"use strict";

/* The portal states every timestamp as epoch milliseconds. A reply we hold
   carries whatever it was stored as — the ingest keeps it as a string — so this
   accepts both and answers 0 for anything it cannot read, which reads as "we
   hold nothing" and therefore fetches. Erring towards fetching is the right way
   round for a number that decides whether to ask. */
function toMillis(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).trim();
  if (/^\d{10,}$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

/** The replies held against one notice: how many, and the newest. */
function replyState(notice) {
  const list = Array.isArray(notice && notice.responses) ? notice.responses : [];
  let last = 0;
  for (const r of list) {
    const ms = toMillis(r && r.submittedOn);
    if (ms > last) last = ms;
  }
  return { n: list.length, last };
}

/**
 * @param notices  every notice doc held for this user
 * @param pan      the assessee's PAN — rows for other PANs are ignored
 * @param matters  matter docs (for which proceedings are still Active)
 * @param returns  return docs (for filed returns and CPC orders)
 * @param dob      whether a date of birth is on file, which is the only thing
 *                 that can unlock an encrypted CPC order
 */
function buildSyncKnowns(notices, pan, matters, returns, dob) {
  const knownDins = new Set();
  const knownResponseIds = new Set();
  const procNotices = {};        // proceedingReqId -> Set<DIN>
  const procHasOrder = new Set();
  const procNeedsMeta = new Set();
  const procLastReply = {};      // proceedingReqId -> newest reply held (ms)
  const noticeReplies = {};      // DIN -> { n, last }
  /* Notices stored back when ONE notice meant ONE file — the portal serves a
     s.148 notice as a set and only one of them was ever taken. Listed here with
     the name of the file we DO hold, so the sweep fetches only what is missing.
     Self-limiting: the ingest stamps `docsSyncedAt` however the sweep goes. */
  const noticeDocsPending = [];
  const procNeedsDocs = new Set();

  (notices || []).forEach((n) => {
    if (n.pan !== pan) return;
    if (n.din) knownDins.add(n.din);
    if (n.docKey) knownDins.add(n.docKey);
    if (n.din && !n.isOrder && !n.docsSyncedAt) {
      noticeDocsPending.push({ din: String(n.din), fileName: String(n.fileName || "") });
      if (n.proceedingReqId) procNeedsDocs.add(String(n.proceedingReqId));
    }
    const rs = replyState(n);
    if (n.din) noticeReplies[String(n.din)] = rs;
    const pid = n.proceedingReqId ? String(n.proceedingReqId) : "";
    if (pid) {
      if (n.isOrder) procHasOrder.add(pid);
      if (n.din) (procNotices[pid] || (procNotices[pid] = new Set())).add(String(n.din));
      if (rs.last > (procLastReply[pid] || 0)) procLastReply[pid] = rs.last;
      // A reply on file whose portal metadata has never been read — "Response
      // viewed by AO on" is the one that matters, and it lands days later.
      if (rs.n && !n.metaSyncedAt) procNeedsMeta.add(pid);
    }
    (n.responses || []).forEach((r) => { if (r && r.responseId != null) knownResponseIds.add(String(r.responseId)); });
  });

  const knownByProc = {};
  Object.keys(procNotices).forEach((pid) => { knownByProc[pid] = { n: procNotices[pid].size }; });
  procHasOrder.forEach((pid) => { (knownByProc[pid] || (knownByProc[pid] = { n: 0 })).o = true; });
  /* The newest reply held anywhere in the proceeding, against which the portal's
     own `lastResponseSubmittedOn` on the list row is compared. That comparison
     is what answers "has anything been filed since we last looked?" — the
     question the notice count was standing in for, and answering wrongly. */
  Object.keys(procLastReply).forEach((pid) => {
    if (procLastReply[pid]) (knownByProc[pid] || (knownByProc[pid] = { n: 0 })).r = procLastReply[pid];
  });

  const knownActiveProcs = (matters || [])
    .filter((m) => m.pan === pan && m.status === "Active" && m.proceedingReqId)
    .map((m) => String(m.proceedingReqId));

  /* A return only gets re-fetched when it is new; an order only when there is
     something a fetch could change. "Known" means finished, in either of two
     ways: we hold a readable PDF, OR the portal will never give us one (orders
     before A.Y. 2017-18 go through a request-and-email flow it will not serve). */
  const knownAckNums = [];
  const knownOrderRefs = [];
  const lockedOrderRefs = [];
  const knownFormAcks = [];
  (returns || []).forEach((r) => {
    if (r.pan !== pan) return;
    if (r.ackNum) knownAckNums.push(String(r.ackNum));
    if (r.ackNum && (r.formPdfPath || r.formPdfError)) knownFormAcks.push(String(r.ackNum));
    (r.orders || []).forEach((o) => {
      if (!o || !o.commRefNo) return;
      const ref = String(o.commRefNo);
      if ((o.storagePath && !o.locked) || o.lockReason === "request-only") knownOrderRefs.push(ref);
      else if (o.storagePath && o.locked) lockedOrderRefs.push(ref);
    });
  });

  return {
    knownDins: [...knownDins], knownByProc, knownResponseIds: [...knownResponseIds],
    noticeReplies, procNeedsMeta: [...procNeedsMeta],
    noticeDocsPending, procNeedsDocs: [...procNeedsDocs],
    knownActiveProcs, knownAckNums, knownOrderRefs, lockedOrderRefs, knownFormAcks,
    canUnlockOrders: Boolean(dob),
  };
}

module.exports = { buildSyncKnowns, replyState, toMillis };
