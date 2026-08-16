/*
 * What a sync already holds — the incremental diff, computed once.
 *
 * A sync that cannot tell what is already on file re-downloads every notice
 * PDF, every filed reply and every Form 35 on every run. These "knowns" are how
 * it tells, and every one of them is a decision about what NOT to fetch — which
 * makes a wrong one invisible in exactly the way a missing figure is not. A
 * proceeding that is skipped leaves no trace: no error, no empty result, just
 * data that never arrives while the app reports a clean sync.
 *
 * So the rules live here, in one pure function, rather than in the screen that
 * happens to call them.
 *
 * THERE IS A SECOND COPY, and it is deliberate: connector/src/main/syncKnowns.js
 * is CommonJS, loaded by Electron's main process, which cannot import this
 * module. test/syncKnowns.test.mjs runs both over the same input and asserts
 * they agree field for field. That test exists because they DID drift — the
 * connector's copy never computed `procNeedsMeta` at all, so the repair path
 * that reaches into a closed proceeding did nothing on the path that actually
 * runs, and nobody could see it.
 *
 * Fields:
 *   knownDins         DINs + docKeys already on file (a docKey covers closure
 *                     orders as "sat:<id>" and filed Form 35s as "f35:<ackNum>")
 *   knownByProc       per-proceeding { n, o, r }: notice count, whether an order
 *                     is held, and the newest reply held (portal epoch ms)
 *   knownResponseIds  replies already recorded
 *   noticeReplies     per DIN { n, last } — how many replies are held against
 *                     that notice and the newest one's timestamp. This is what
 *                     lets a sync ask the portal's own question: "is there a
 *                     reply here I have not got?"
 *   procNeedsMeta     proceedings holding a reply whose portal metadata has
 *                     never been read
 *   noticeDocsPending notices held with only ONE of their documents
 *   procNeedsDocs     the proceedings those notices sit in
 *   knownActiveProcs  proceedingReqIds held as Active
 *   knownAckNums      returns already on file
 *   knownOrderRefs    CPC references already downloaded and unlocked
 *   lockedOrderRefs   orders held but not decryptable
 *   knownFormAcks     returns whose rendered ITR form PDF is already stored
 */

/* The portal states every timestamp as epoch milliseconds. A reply we hold
   carries whatever it was stored as — the ingest keeps it as a string — so this
   accepts both and answers 0 for anything it cannot read, which reads as "we
   hold nothing" and therefore fetches. Erring towards fetching is the right way
   round for a number that decides whether to ask. */
export function toMillis(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).trim();
  if (/^\d{10,}$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

/** The replies held against one notice: how many, and the newest. */
export function replyState(notice) {
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
export function buildSyncKnowns(notices, pan, matters, returns, dob) {
  const knownDins = new Set();
  const knownResponseIds = new Set();
  const procNotices = {};        // proceedingReqId -> Set<DIN>
  const procHasOrder = new Set();
  const procNeedsMeta = new Set();
  const procLastReply = {};      // proceedingReqId -> newest reply held (ms)
  const noticeReplies = {};      // DIN -> { n, last }
  /* Notices stored back when ONE notice meant ONE file. The portal serves a
     s.148 notice as a set — the notice, the approval to the JAO, the set note,
     the search print — and only one of them was ever taken. Listed here (with
     the name of the file we DO hold, so nothing is fetched twice) for a single
     sweep. Self-limiting the way procNeedsMeta is: the ingest stamps
     `docsSyncedAt` however the sweep goes, and the notice drops out for good.
     Orders are excluded — downloadClosureOrder always returned its whole list. */
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
      /* A notice with a reply on it but nothing yet from the portal's own
         metadata — "Response viewed by AO on" is the one that matters.
         Marking the PROCEEDING means the connector makes its one detail call
         even where the count is unchanged and the proceeding is closed, which
         is otherwise skipped outright. It is self-limiting: once the metadata
         is on file the notice drops out of this set and the skip returns. */
      if (rs.n && !n.metaSyncedAt) procNeedsMeta.add(pid);
    }
    (n.responses || []).forEach((r) => { if (r && r.responseId != null) knownResponseIds.add(String(r.responseId)); });
  });

  const knownByProc = {};
  Object.keys(procNotices).forEach((pid) => { knownByProc[pid] = { n: procNotices[pid].size }; });
  procHasOrder.forEach((pid) => { (knownByProc[pid] || (knownByProc[pid] = { n: 0 })).o = true; });
  /* The newest reply held anywhere in the proceeding. The portal states the
     same figure on its list row (`lastResponseSubmittedOn`), so comparing the
     two answers "has anything been filed since we last looked?" without opening
     the proceeding at all — which is the question the notice count was standing
     in for, and answering wrongly. */
  Object.keys(procLastReply).forEach((pid) => {
    if (procLastReply[pid]) (knownByProc[pid] || (knownByProc[pid] = { n: 0 })).r = procLastReply[pid];
  });

  const knownActiveProcs = (matters || [])
    .filter((m) => m.pan === pan && m.status === "Active" && m.proceedingReqId)
    .map((m) => String(m.proceedingReqId));
  const knownAckNums = [];
  const knownOrderRefs = [];
  const lockedOrderRefs = [];
  const knownFormAcks = [];
  (returns || []).forEach((r) => {
    if (r.pan !== pan) return;
    if (r.ackNum) knownAckNums.push(String(r.ackNum));
    // Either we hold it, or we tried and recorded why it failed. Both mean the
    // sync should leave it alone; the Fetch form button is how it gets retried.
    if (r.ackNum && (r.formPdfPath || r.formPdfError)) knownFormAcks.push(String(r.ackNum));
    (r.orders || []).forEach((o) => {
      if (!o || !o.commRefNo) return;
      const ref = String(o.commRefNo);
      // Finished, either way: we hold a readable PDF, or the portal will never
      // give us one.
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
