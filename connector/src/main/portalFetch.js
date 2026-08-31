// Scoped, incremental e-Proceedings sync — Playwright port of tryDirectApi /
// syncNotices / syncResponses from extension/portal-login.js.
//
// Runs against a context that is already logged in and on the dashboard. Uses
// portalApi.js (direct JSON calls, session-cookie auth) to pull the proceedings
// list, then each proceeding's notices/orders + filed responses, applying the
// same scope + incremental "knowns" diff as the extension so only NEW data is
// fetched. Every new item is handed to ingest.ingestSyncMessage — the exact
// payload shapes the extension streamed.
//
// Scope:
//   "all"     — both proceeding tabs + notices/orders/replies (+ Form 35, pass 3,
//               + filed returns and CPC orders, pass 4).
//   "eproc"   — the same two tabs, but per proceeding it fetches only what the
//               portal says has moved, and asks for a closure order only where
//               the portal names one. No Form 35, no filed returns.
//   "appeals" — filed Form 35s only (pass 3).
//   "returns" — filed ITRs + s.143(1) intimations and s.154 orders only (pass 4).
//
// "Fast" is about how much is fetched PER PROCEEDING, not about how much of the
// portal is looked at. It used to mean the second — the fast scope read only the
// "for your action" tab — and a closed scrutiny with three replies and an
// assessment order was invisible to it for good. See syncDecisions.js.
"use strict";

const { jsleep, PACE } = require("./pacing");
const { PATHS, FORM, apiCall, getDoc, proceedings, noticeDocuments, pickPrimaryDocument } = require("./portalApi");
const { ingestSyncMessage } = require("./ingest");
const { syncAppealForms } = require("./portalAppeals");
const { syncReturns } = require("./portalReturns");
const { shouldFetchReplies, proceedingSettled, shouldFetchClosureOrder } = require("./syncDecisions");

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const MAX_PDF_BYTES = 25 * 1024 * 1024;
/* One notice, several files. A s.148 set is four; the ceilings are here so a
   pathological one cannot stall a whole practice's sync, and how many were
   listed is reported either way (`docsTotal`) so the card can say "4 of 6"
   rather than quietly showing four and implying that is all there was. */
const MAX_SET_DOCS = 12;
const MAX_SET_BYTES = 60 * 1024 * 1024;

// Per-phase stopwatch, hung off the job by portalWorker. Falls back to a no-op
// so this module stays usable without one.
const NO_CLOCK = { time: (_name, fn) => fn(), add: () => {} };
const clock = (job) => (job && job.timer) || NO_CLOCK;

// Portal order filenames end in a DDMMYYYY date, e.g. "…_15012022.pdf".
function dateFromFilename(name) {
  const m = /(\d{2})(\d{2})(\d{4})\.pdf$/i.exec(String(name || ""));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
}

// Map one API proceeding object → the row shape the Cloud Function expects.
function mapRow(o, tab) {
  const noticeCount = typeof o.viewNoticeCount === "number" ? o.viewNoticeCount : Number(o.viewNoticeCount) || null;
  return {
    tab,
    name: o.proceedingName || "",
    ay: o.assessmentYear || "",
    pan: o.pan || "",
    assessee: o.nameOfAssesse || "",
    fy: o.financialYr || "",
    act: o.proceedingType || "",
    statusDate: o.issuedOn || o.servedOn || "",
    noticeCount,
    proceedingReqId: o.proceedingReqId || "",
    viewNoticeCount: noticeCount,
    proceedingStatus: o.proceedingStatus || "",
    closureSeqNo: o.proceedingClosureOrder != null ? String(o.proceedingClosureOrder) : "",
    /* When a reply was last filed ANYWHERE in this proceeding, as the portal
       states it on the list row. Carried because it is the only thing on the row
       that says a reply has moved — the notice count does not change when one is
       filed, which is how a proceeding with three replies and a closure order
       was skipped four times running as "unchanged". See syncDecisions.js. */
    lastResponseSubmittedOn: o.lastResponseSubmittedOn || "",
  };
}

/* Fields on a portal response row that we map by name. Everything else scalar
   is swept up by extraFields() below. */
const RESPONSE_MAPPED = new Set([
  "responseId", "remarks", "remarksHash", "submittedOn", "respType", "attachmentLst",
]);

/* Same, for a notice row out of eProceedingDetailsService. */
const NOTICE_MAPPED = new Set([
  "documentIdentificationNumber", "headerSeqNo", "noticeSection", "description",
  "issuedOn", "servedOn", "responseDueDate", "documentReferenceId",
  "ay", "pan", "proceedingStatus", "proceedingName",
]);

/* WHAT THE PORTAL SENDS THAT WE HAVE NO NAME FOR YET.
 *
 * "View Notices for e-Proceedings" prints, on each notice, a line reading
 * "Response viewed by AO on : 21-Jul-2026" — directly under the response due
 * date. It is the single most useful thing a practitioner can know after
 * filing, because it is the difference between "he hasn't looked" and "he's
 * looked and said nothing".
 *
 * What ITBA calls that field in the JSON behind the label is another matter,
 * and its naming is not consistent across its own services. So rather than
 * guess once and be silently wrong, every remaining SCALAR on both the notice
 * row and the reply row is carried through under `extra`: bounded hard, no
 * documents, no nested objects. One sync then shows the real key on screen and
 * it can be given a proper label.
 *
 * Deliberately narrow: strings, numbers and booleans only, 12 of them, 120
 * characters each. This is a discovery hatch, not a second data model. */
function extraFields(row, mapped) {
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(row || {})) {
    if (mapped.has(k) || v === null || v === undefined || v === "") continue;
    const t = typeof v;
    if (t !== "string" && t !== "number" && t !== "boolean") continue;
    if (n >= 12) break;
    out[String(k).slice(0, 40)] = t === "string" ? v.slice(0, 120) : v;
    n++;
  }
  return out;
}

/* Two portal filenames for the same object. `docMap` keeps the storage name
   ("….pdf.gz"); Content-Disposition hands back the served name ("….pdf"). */
const normDoc = (s) => String(s || "").replace(/\.gz$/i, "").trim().toLowerCase();

/* Download EVERY document behind one notice.
 *
 * A notice on e-Proceedings is a SET, not a file — see noticeDocuments() in
 * portalApi.js for what the portal actually sends. This fetches all of them,
 * puts the one that is the notice itself first, and returns the rest as
 * attachments.
 *
 * `held` switches it to repair mode for a notice already on file: the document
 * we already hold is identified by name and never re-downloaded, and everything
 * else comes back as an attachment. A notice whose PDF never arrived at all
 * passes no `held` and gets a primary chosen for it, which is how a failed
 * first fetch heals.
 *
 * Returns { primary, attachments, docsTotal, docsFetched }. Both primary and
 * attachments carry { satDocId, filename, contentType, contentBase64, bytes }. */
async function fetchNoticeSet(page, t, { pan, proceedingReqId, headerSeqNo, section, held }) {
  const out = { primary: null, attachments: [], docsTotal: 0, docsFetched: 0 };
  if (!headerSeqNo) return out;

  const doc = await t.time("pdf", () => apiCall(page, {
    path: PATHS.SAVE_ENTITY, serviceName: "noticeletterpdf",
    payload: { serviceName: "noticeletterpdf", headerSeqNo: String(headerSeqNo), procdngReqId: proceedingReqId, loggedInUserId: pan, header: FORM },
  }));
  const all = noticeDocuments(doc.json);
  out.docsTotal = all.length;
  if (!all.length) return out;

  const heldIdx = held ? all.findIndex((d) => normDoc(d.docNam) === normDoc(held)) : -1;
  // Repair mode drops the document already on file; a first fetch promotes the
  // notice itself to the front so a truncated set never loses it.
  let wantsPrimary = false;
  let ordered;
  if (heldIdx >= 0) {
    ordered = all.filter((_, i) => i !== heldIdx);
  } else {
    const pi = pickPrimaryDocument(all, { section, declaredSatDocId: doc.json && doc.json.satDocId });
    ordered = [all[pi], ...all.filter((_, i) => i !== pi)];
    wantsPrimary = true;
  }

  let budget = MAX_SET_BYTES;
  for (let i = 0; i < ordered.length && i < MAX_SET_DOCS; i++) {
    const d = ordered[i];
    if (i > 0) await t.time("pacing", () => jsleep(...PACE.betweenDocs));
    const got = await t.time("pdf", () => getDoc(page, { docId: String(d.satDocId) }));
    if (!got || !got.ok || !got.base64 || !got.bytes) continue;
    if (got.bytes > MAX_PDF_BYTES || got.bytes > budget) continue;
    budget -= got.bytes;
    const entry = {
      satDocId: String(d.satDocId),
      filename: got.filename || String(d.docNam || "").replace(/\.gz$/i, "") || `${d.satDocId}.pdf`,
      contentType: got.contentType || "application/pdf",
      contentBase64: got.base64,
      bytes: got.bytes,
    };
    if (wantsPrimary && i === 0) out.primary = entry;
    else out.attachments.push(entry);
    out.docsFetched++;
  }
  return out;
}

// Replies filed against one notice (remarks + attachment PDFs).
async function syncResponses(page, job, pan, din, headerSeqNo) {
  const t = clock(job);
  const knownResp = new Set((job.knowns.knownResponseIds || []).map((x) => String(x)));
  const resp = await t.time("replies", () => apiCall(page, {
    path: PATHS.GET_ENTITY, serviceName: "itbaResponseService",
    payload: { serviceName: "itbaResponseService", headerSeqNo, pan, header: FORM },
  }));
  const list = resp.json && Array.isArray(resp.json.respRemrkAttLst) ? resp.json.respRemrkAttLst : [];
  let count = 0;
  /* KNOWN responses, gathered and sent in ONE message at the end.
   *
   * They cannot be skipped outright any more: an AO opens a reply days after it
   * is filed, so the fields that say so only ever appear on a row we have
   * already seen once. Skipping is exactly why nothing downstream could learn
   * that a reply had been looked at.
   *
   * But one callable per response per sync would be a round trip per reply for
   * ever, so they ride together — one small call per notice, no PDFs, and the
   * ingest merges rather than duplicating. */
  const refresh = [];
  for (const rr of list) {
    const atts = Array.isArray(rr.attachmentLst) ? rr.attachmentLst : [];
    /* Remarks TRIMMED, not merely present. ITBA returns reply rows whose remarks
       are a single space and whose attachment list is empty; stored, they became
       empty green "Response" cards on the notice — three of them under one
       s.142(1) notice, saying nothing at all. A row with no words and no file is
       not a reply anyone can read. */
    if (!rr || (!String(rr.remarks || "").trim() && atts.length === 0)) continue;
    const responseId = String(rr.responseId || rr.remarksHash || rr.submittedOn || (rr.remarks || "").slice(0, 24));
    if (knownResp.has(responseId)) {
      refresh.push({ responseId, extra: extraFields(rr, RESPONSE_MAPPED) });
      continue;
    }
    const attachments = [];
    for (const at of atts) {
      const adocId = at.docId || at.satDocId || at.documentId || at.attachmentId || at.refId;
      let apdf = null;
      if (adocId) { const g = await t.time("pdf", () => getDoc(page, { docId: String(adocId) })); if (g && g.ok && g.bytes && g.bytes <= MAX_PDF_BYTES) apdf = g; }
      const base = at.attachmentName || at.docNam || at.fileName || (adocId ? adocId + ".pdf" : "attachment.pdf");
      const filename = /\.[a-z0-9]{2,5}$/i.test(base) ? base : base + ".pdf";
      attachments.push({
        filename: apdf && apdf.filename && /\.[a-z0-9]{2,5}$/i.test(apdf.filename) ? apdf.filename : filename,
        label: at.categorieName || "",
        contentType: (apdf && apdf.contentType) || "application/pdf",
        contentBase64: apdf ? apdf.base64 : null,
      });
    }
    await t.time("ingest", () => ingestSyncMessage({
      assesseeId: job.assesseeId, kind: "response",
      response: {
        noticeKey: din, responseId,
        remarks: rr.remarks || "", submittedOn: rr.submittedOn || "", respType: rr.respType || "",
        extra: extraFields(rr, RESPONSE_MAPPED),
        attachments,
      },
    }));
    count++;
    await t.time("pacing", () => jsleep(...PACE.betweenDocs));
  }
  // Not counted as a synced response — nothing new arrived, we only refreshed
  // what the portal now says about replies already on file.
  if (refresh.length) {
    await t.time("ingest", () => ingestSyncMessage({
      assesseeId: job.assesseeId, kind: "response",
      response: { noticeKey: din, refresh },
    }));
  }
  return count;
}

// Each proceeding's notices/orders + PDFs (incremental), then closure orders.
async function syncNotices(page, job, pan, rows, summary, emit) {
  const t = clock(job);
  const known = new Set((job.knowns.knownDins || []).map((d) => String(d)));
  const knownByProc = job.knowns.knownByProc || {};
  /* Proceedings holding a reply whose portal metadata we have never read.
   *
   * THIS IS WHY "Response viewed by AO on" DID NOT ARRIVE. A disposed appeal is
   * closed and its notice count never changes again, so the skip below took it
   * out before the detail call that carries the metadata was ever made — and a
   * disposed appeal is precisely where a practitioner wants to know whether the
   * officer read the submission before dismissing it.
   *
   * Self-limiting: the app only lists a proceeding here while one of its
   * replied-to notices has no metadata on file, so this costs one call each
   * until the answer lands and then nothing. */
  const needsMeta = new Set((job.knowns.procNeedsMeta || []).map((p) => String(p)));
  /* Notices on file from before we understood that a notice is a SET of files.
   *
   * Every one of them was stored with exactly one document, because that is all
   * the old code asked for — so on this assessee the s.148 notice, its approval,
   * its set note and its search print exist on the portal and one of them
   * exists here. Fixing the fetch alone would only ever help notices that
   * arrive AFTER the fix, which is no help at all to a file already open.
   *
   * `din -> the filename we already hold`, so the repair re-downloads only what
   * is missing. Self-limiting in exactly the way procNeedsMeta is: the ingest
   * stamps `docsSyncedAt` whatever the portal says, so a notice appears here
   * once and then never again. */
  const pendingDocs = new Map();
  for (const p of job.knowns.noticeDocsPending || []) {
    if (p && p.din) pendingDocs.set(String(p.din), String(p.fileName || ""));
  }
  const needsDocs = new Set((job.knowns.procNeedsDocs || []).map((p) => String(p)));
  /* Replies already on file, per notice. The portal states on every notice when
     one was last filed against it, so this is the other half of the comparison
     that decides whether to ask for them (syncDecisions.js). */
  const heldReplies = job.knowns.noticeReplies || {};
  const scope = job.scope;
  /* Nothing here asks "is this proceeding closed?" any more. It used to, in two
     places, and both were wrong for the same reason: closed says nothing about
     whether its replies and its order are on file. syncDecisions.js owns the
     question now, and answers it from what the portal states. */
  const targets = rows.filter((r) => (r.viewNoticeCount || 0) > 0 && r.proceedingReqId);

  for (let i = 0; i < targets.length; i++) {
    const r = targets[i];
    const kp = knownByProc[r.proceedingReqId] || {};
    /* Skip only what the PORTAL says has not moved — its notice count, its last
       reply, and its closure order — never the notice count alone. That was the
       bug: replies and orders do not change a notice count, so the proceeding
       holding them was the one guaranteed to be skipped. */
    const settled = proceedingSettled(r, kp, {
      scope,
      needsMeta: needsMeta.has(String(r.proceedingReqId)),
      needsDocs: needsDocs.has(String(r.proceedingReqId)),
    });
    if (settled.skip) { summary.skipped = (summary.skipped || 0) + 1; continue; }
    emit("fetch", `Notices ${i + 1}/${targets.length} — ${(r.name || "proceeding").slice(0, 28)}…`, "info", 30 + Math.round(((i + 1) / targets.length) * 50));
    const det = await t.time("notice-list", () => apiCall(page, {
      path: PATHS.GET_ENTITY, serviceName: "eProceedingDetailsService",
      payload: { serviceName: "eProceedingDetailsService", proceedingReqId: r.proceedingReqId, pan, header: FORM },
    }));
    const items = Array.isArray(det.json) ? det.json : [];
    /* Fields on notices we already hold that may have MOVED since we saw them.
     *
     * "Response viewed by AO on" is the reason: the officer opens a reply days
     * after it is filed, which is long after the notice itself first synced. A
     * known notice used to be skipped outright, so that date could never
     * arrive. One small call per proceeding carries them, no PDFs. */
    const meta = [];
    for (const it of items) {
      const din0 = it.documentIdentificationNumber || "";
      const headerSeqNo = it.headerSeqNo;
      const isKnown = din0 && known.has(String(din0));
      if (isKnown && din0) {
        meta.push({
          din: String(din0),
          responseDueDate: it.responseDueDate || "",
          servedOn: it.servedOn || "",
          extra: extraFields(it, NOTICE_MAPPED),
        });
      }
      /* A notice already on file, stored back when one notice meant one file:
         fetch the rest of its set and attach them. No PDF we already hold is
         downloaded twice, and nothing about the notice itself is touched.

         Per-notice try/catch, deliberately: this is a repair on data that is
         already usable, so it must never be able to fail a sync that would
         otherwise have succeeded. A miss is retried next run — the notice is
         only taken off the repair list once the ingest lands. */
      if (isKnown && din0 && pendingDocs.has(String(din0))) {
        try {
          const set = await fetchNoticeSet(page, t, {
            pan, proceedingReqId: r.proceedingReqId, headerSeqNo,
            section: it.noticeSection, held: pendingDocs.get(String(din0)),
          });
          await t.time("ingest", () => ingestSyncMessage({
            assesseeId: job.assesseeId, kind: "notice-docs",
            noticeDocs: {
              din: String(din0),
              primary: set.primary,
              attachments: set.attachments,
              docsTotal: set.docsTotal,
            },
          }));
          summary.documents += set.docsFetched;
        } catch { /* per-notice repair; keep going */ }
      }
      if (!isKnown) {
        const set = await fetchNoticeSet(page, t, {
          pan, proceedingReqId: r.proceedingReqId, headerSeqNo, section: it.noticeSection,
        });
        const pdf = set.primary;
        await t.time("ingest", () => ingestSyncMessage({
          assesseeId: job.assesseeId, kind: "notice",
          notice: {
            proceedingReqId: r.proceedingReqId,
            proceedingName: r.name || it.proceedingName || "",
            din: it.documentIdentificationNumber || "",
            section: it.noticeSection || "",
            description: it.description || "",
            issuedOn: it.issuedOn || "",
            servedOn: it.servedOn || "",
            responseDueDate: it.responseDueDate || "",
            docRefId: it.documentReferenceId || "",
            ay: it.ay || r.ay || "",
            pan: it.pan || pan,
            proceedingStatus: it.proceedingStatus || "",
            extra: extraFields(it, NOTICE_MAPPED),
            filename: (pdf && pdf.filename) || "",
            contentType: (pdf && pdf.contentType) || "application/pdf",
            contentBase64: (pdf && pdf.contentBase64) || null,
            bytes: (pdf && pdf.bytes) || 0,
            // The rest of the set — the approval, the set note, the search
            // print, or a ZIP the department bundled instead of listing.
            attachments: set.attachments,
            docsTotal: set.docsTotal,
          },
        }));
        summary.notices++;
        summary.documents += set.docsFetched;
        await t.time("pacing", () => jsleep(...PACE.betweenDocs));
      }
      /* Replies. The portal states on the notice itself whether one has been
         filed and when — `lastResponseSubmittedOn`, `respStatus: "S"` — so that
         is what decides, not whether the proceeding is open.

         It used to read "a closed proceeding cannot receive new replies, so
         don't ask". True, and beside the point: the replies were filed while it
         was open, and if we had not already fetched them by the time it closed
         we never would. On the assessee that exposed this, three replies with 22
         attachments were unreachable for good, on a proceeding the app showed as
         complete. */
      const want = shouldFetchReplies(it, heldReplies[String(din0)], isKnown);
      if (headerSeqNo && din0 && want.fetch) {
        try { summary.responses += await syncResponses(page, job, pan, din0, String(headerSeqNo)); }
        catch { /* per-notice; keep going */ }
      }
    }
    // Not counted as a synced notice — nothing new arrived, we only refreshed
    // what the portal now says about notices already on file.
    if (meta.length) {
      await t.time("ingest", () => ingestSyncMessage({
        assesseeId: job.assesseeId, kind: "notice-meta", notices: meta,
      }));
    }
  }

  /* Closure / final orders — a separate pass over every proceeding, independent
     of the notice counts.

     The portal names the order on the list row (`proceedingClosureOrder`), so
     the decision is mostly answerable without a call; where it says nothing and
     the proceeding is closed we still ask, because the service has returned
     documents for rows that never flagged one. shouldFetchClosureOrder() holds
     the rules and the reasons. */
  const withOrders = rows.filter((r) => r.proceedingReqId);
  for (const r of withOrders) {
    const kp = knownByProc[r.proceedingReqId] || {};
    const wantOrder = shouldFetchClosureOrder(r, kp, { scope });
    if (!wantOrder.fetch) continue;
    emit("fetch", `Orders — ${(r.name || "proceeding").slice(0, 28)}…`, "info", 84);
    try {
      const clo = await t.time("order-list", () => apiCall(page, {
        path: PATHS.GET_ENTITY, serviceName: "downloadClosureOrder",
        payload: { serviceName: "downloadClosureOrder", procdngReqId: r.proceedingReqId, loggedInUserId: pan, header: FORM },
      }));
      let docs = clo.json && Array.isArray(clo.json.satDocDetlList) ? clo.json.satDocDetlList.slice() : [];
      if (!docs.length && clo.json && clo.json.satDocId) docs = [{ satDocId: clo.json.satDocId, docNam: clo.json.docNam }];
      for (const od of docs) {
        const satDocId = od.satDocId;
        if (!satDocId) continue;
        const docKey = "sat:" + satDocId;
        if (known.has(docKey)) continue;
        const got = await t.time("pdf", () => getDoc(page, { docId: String(satDocId) }));
        const pdf = got && got.ok && got.bytes && got.bytes <= MAX_PDF_BYTES ? got : null;
        await t.time("ingest", () => ingestSyncMessage({
          assesseeId: job.assesseeId, kind: "notice",
          notice: {
            proceedingReqId: r.proceedingReqId,
            proceedingName: r.name || "",
            din: "", docKey, isOrder: true,
            section: r.section || "",
            description: od.docNam || "Order",
            issuedOn: dateFromFilename(od.docNam) || "",
            ay: r.ay || "", pan,
            filename: (pdf && pdf.filename) || od.docNam || "",
            contentType: (pdf && pdf.contentType) || "application/pdf",
            contentBase64: (pdf && pdf.base64) || null,
            bytes: (pdf && pdf.bytes) || 0,
          },
        }));
        summary.notices++;
        summary.documents += pdf ? 1 : 0;
        await t.time("pacing", () => jsleep(...PACE.betweenDocs));
      }
    } catch { /* per-proceeding; keep going */ }
  }
}

// Top-level scoped sync for one logged-in PAN. Port of tryDirectApi's core.
async function syncPortalData(page, job, scope, emit, summary) {
  const pan = String(job.pan || "").toUpperCase().trim();
  if (!PAN_RE.test(pan)) throw new Error(`No valid PAN for this assessee (${job.pan}).`);
  job.scope = scope;
  job.knowns = job.knowns || {};

  if (scope === "appeals") {
    await syncAppealForms(page, job, pan, summary, emit);
    return summary;
  }

  if (scope === "returns") {
    await syncReturns(page, job, pan, summary, emit);
    return summary;
  }

  const t = clock(job);

  emit("fetch", "Fetching e-Proceedings…", "info", 24);
  const rows = [];
  const push = (res, tab) => {
    const list = res && res.json && res.json.eProceedingPaginatedRequests;
    if (Array.isArray(list)) for (const o of list) rows.push(mapRow(o, tab));
  };
  /* BOTH TABS, IN EVERY SCOPE THAT LISTS PROCEEDINGS AT ALL.
   *
   * The fast scope used to fetch "For your Action" only and infer closures from
   * what had left it. That inference has one blind spot and it is a wide one:
   * once any sync has recorded a proceeding as closed, it is in neither list the
   * fast scope looks at, so the closure order that ended it — the assessment
   * order, the computation sheet, the demand notice u/s 156 — is unreachable on
   * the path the app defaults to after the first sync and the one every bulk
   * sync uses. The practitioner who reported this had synced four times.
   *
   * The cost of closing that hole is one list call of a few kilobytes. What made
   * the fast scope fast was never skipping this call; it is the per-proceeding
   * skip below, which is now decided from what the portal says has moved. */
  const lists = await t.time("list", () => Promise.all([
    proceedings(page, { pan, statusFlag: "FYA", pageSize: 100 }),
    proceedings(page, { pan, statusFlag: "FYI", pageSize: 100 }),
  ]));
  /* A LIST CALL THAT DID NOT SUCCEED IS NOT AN EMPTY LIST.
   *
   * `push` reads the rows out of the response and shrugs at anything else, so a
   * call that timed out, died on the wire, or came back 500 produced no rows —
   * and no rows is indistinguishable, three lines further down, from an
   * assessee with a clean compliance record. The sync then went on to report
   * "Nothing in FYA — up to date" and stamp the PAN as synced, on a run that
   * had not managed to ask the question. That is the worst outcome this file
   * can produce: a green tick over data nobody fetched.
   *
   * The test is the RESPONSE, not the transport: it used to let a refusal
   * through — a 500, a 403 from the WAF — because those carry a status rather
   * than an error, and portalApi has already retried one of them by the time it
   * gets here. What is still forgiven is a call that SUCCEEDED and whose body is
   * shaped unexpectedly: the portal has changed its own payloads before, and
   * the rest of the sync should not stop for it. */
  const fya = lists[0];
  if (!fya || !fya.ok) {
    throw new Error(
      fya && fya.timedOut
        ? "The portal did not answer when asked for this assessee's e-Proceedings. Nothing was changed — try again in a few minutes."
        : `Couldn't read the portal's e-Proceedings list (${(fya && (fya.error || (fya.status && `HTTP ${fya.status}`))) || "no response"}). Nothing was changed.`
    );
  }
  push(fya, "For your Action");
  if (lists[1]) push(lists[1], "For your Information");

  /* A proceeding we hold as ACTIVE that is now in neither list has closed and
     been archived out of both. Rare, and cheap to cover: a synthetic closed row
     so its closure order is still asked for. `justClosed` is what tells the
     order pass to ask despite the row carrying no fields to judge by. */
  const listed = new Set(rows.map((r) => r.proceedingReqId).filter(Boolean));
  for (const pid of job.knowns.knownActiveProcs || []) {
    const id = String(pid || "");
    if (id && !listed.has(id)) {
      rows.push({ tab: "For your Information", proceedingStatus: "C", name: "", ay: "", section: "", pan, assessee: "", proceedingReqId: id, viewNoticeCount: 0, closureSeqNo: "", justClosed: true });
    }
  }

  // No e-Proceedings is the normal state for most assessees, not a reason to
  // stop: a PAN with a clean compliance record still has filed returns and CPC
  // intimations to pull in the "all" passes below.
  if (!rows.length) {
    emit("fetch", "No e-Proceedings on the portal for this PAN");
  } else {
    emit("fetch", `${rows.length} proceeding(s) — saving…`, "info", 30);
    await t.time("ingest", () => ingestSyncMessage({ assesseeId: job.assesseeId, kind: "proceedings", proceedings: rows }));
    summary.proceedings = rows.length;

    await syncNotices(page, job, pan, rows, summary, emit);
    /* Say what was NOT looked at. A skip is a decision, and until now it was an
       invisible one: a practitioner told "up to date" had no way of telling a
       portal with nothing on it from a sync that decided not to ask. */
    if (summary.skipped) {
      emit("fetch", `${summary.skipped} proceeding(s) unchanged on the portal — not re-read`, "info", 88);
    }
  }

  if (scope === "all") {
    /* BEST-EFFORT, BUT NOT SILENT. A pass that fell over here used to leave no
       trace at all: the sync carried on, finished, and reported success. The
       swallow is still right — one portal hiccup in the appeals pass should not
       throw away the proceedings that did come down — but what was swallowed is
       now on the summary, so the window says "partly synced" rather than
       "synced" over it.
       Each pass keeps its own share of the per-PAN deadline (BUDGETS in
       config.js), which is what stops the first of them taking the run and
       leaving the second unrun and unmentioned. */
    try { await syncAppealForms(page, job, pan, summary, emit); }
    catch (e) { (summary.incomplete || (summary.incomplete = [])).push(`filed appeals (${(e && e.message) || e})`); }
    try { await syncReturns(page, job, pan, summary, emit); }
    catch (e) { (summary.incomplete || (summary.incomplete = [])).push(`filed returns (${(e && e.message) || e})`); }
  }
  return summary;
}

module.exports = { syncPortalData };
