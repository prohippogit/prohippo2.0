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
//   "all"     — FYA + FYI + notices/orders/replies (+ Form 35, pass 3, + filed
//               returns and CPC orders, pass 4).
//   "eproc"   — FYA only → diff → new notices/orders; synthetic closed rows for
//               proceedings that just left FYA. No FYI scan.
//   "appeals" — filed Form 35s only (pass 3).
//   "returns" — filed ITRs + s.143(1) intimations and s.154 orders only (pass 4).
"use strict";

const { jsleep, PACE } = require("./pacing");
const { PATHS, FORM, apiCall, getDoc, proceedings } = require("./portalApi");
const { ingestSyncMessage } = require("./ingest");
const { syncAppealForms } = require("./portalAppeals");
const { syncReturns } = require("./portalReturns");

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const MAX_PDF_BYTES = 25 * 1024 * 1024;

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

// Responses filed against one notice (remarks + attachment PDFs).
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
    if (!rr || (!rr.remarks && atts.length === 0)) continue;
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
  const scope = job.scope;
  const isClosed = (r) => /information/i.test(r.tab || "") || r.proceedingStatus === "C";
  const targets = rows.filter((r) => (r.viewNoticeCount || 0) > 0 && r.proceedingReqId);

  for (let i = 0; i < targets.length; i++) {
    const r = targets[i];
    const kp = knownByProc[r.proceedingReqId] || {};
    const countMatches = (r.viewNoticeCount || 0) <= (kp.n || 0);
    // Unchanged closed proceeding (or unchanged active one in eproc mode): skip
    // its detail call and every per-notice reply call entirely — unless its
    // notices are still missing the metadata that only that call carries.
    if (countMatches && (isClosed(r) || scope === "eproc") && !needsMeta.has(String(r.proceedingReqId))) continue;
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
      if (!isKnown) {
        let pdf = null;
        if (headerSeqNo) {
          const doc = await t.time("pdf", () => apiCall(page, {
            path: PATHS.SAVE_ENTITY, serviceName: "noticeletterpdf",
            payload: { serviceName: "noticeletterpdf", headerSeqNo: String(headerSeqNo), procdngReqId: r.proceedingReqId, loggedInUserId: pan, header: FORM },
          }));
          const satDocId = doc.json && doc.json.satDocId;
          if (satDocId) {
            const got = await t.time("pdf", () => getDoc(page, { docId: String(satDocId) }));
            if (got && got.ok && got.bytes && got.bytes <= MAX_PDF_BYTES) pdf = got;
          }
        }
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
            contentBase64: (pdf && pdf.base64) || null,
            bytes: (pdf && pdf.bytes) || 0,
          },
        }));
        summary.notices++;
        await t.time("pacing", () => jsleep(...PACE.betweenDocs));
      }
      // Replies. A reply can be filed against a notice long after we first saw
      // it, so a KNOWN notice still needs checking — but only while its
      // proceeding is still open. A closed proceeding cannot receive new
      // replies, so skip the call rather than asking the portal every sync.
      const skipReplies = isKnown && isClosed(r);
      if (headerSeqNo && din0 && !skipReplies) {
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

  // Closure / final orders — a separate pass over every proceeding, independent
  // of the notice counts (some proceedings show a "Download Closure Order"
  // button the list doesn't flag; the service returns empty where there's none).
  const withOrders = rows.filter((r) => r.proceedingReqId);
  for (const r of withOrders) {
    const kp = knownByProc[r.proceedingReqId] || {};
    if (isClosed(r) && kp.o) continue;
    if (scope === "eproc" && !isClosed(r) && !r.closureSeqNo) continue;
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

  emit("fetch", "Fetching e-Proceedings (FYA)…", "info", 24);
  const rows = [];
  const push = (res, tab) => {
    const list = res && res.json && res.json.eProceedingPaginatedRequests;
    if (Array.isArray(list)) for (const o of list) rows.push(mapRow(o, tab));
  };
  // The two tabs are independent list calls against the same session — fetch
  // them together rather than one after the other.
  const lists = await t.time("list", () => Promise.all([
    proceedings(page, { pan, statusFlag: "FYA", pageSize: 100 }),
    scope === "all" ? proceedings(page, { pan, statusFlag: "FYI", pageSize: 100 }) : null,
  ]));
  push(lists[0], "For your Action");
  if (lists[1]) push(lists[1], "For your Information");

  // eproc closure detection: a proceeding we knew as ACTIVE that is no longer in
  // FYA has just closed — add a synthetic (closed) row so its closure order is
  // fetched, without scanning the whole FYI list.
  if (scope === "eproc") {
    const fyaIds = new Set(rows.map((r) => r.proceedingReqId).filter(Boolean));
    for (const pid of job.knowns.knownActiveProcs || []) {
      const id = String(pid || "");
      if (id && !fyaIds.has(id)) {
        rows.push({ tab: "For your Information", proceedingStatus: "C", name: "", ay: "", section: "", pan, assessee: "", proceedingReqId: id, viewNoticeCount: 0, closureSeqNo: "" });
      }
    }
  }

  // No e-Proceedings is the normal state for most assessees, not a reason to
  // stop: a PAN with a clean compliance record still has filed returns and CPC
  // intimations to pull in the "all" passes below.
  if (!rows.length) {
    emit("fetch", "Nothing in FYA — up to date");
  } else {
    emit("fetch", `${rows.length} proceeding(s) — saving…`, "info", 30);
    await t.time("ingest", () => ingestSyncMessage({ assesseeId: job.assesseeId, kind: "proceedings", proceedings: rows }));
    summary.proceedings = rows.length;

    await syncNotices(page, job, pan, rows, summary, emit);
  }

  if (scope === "all") {
    try { await syncAppealForms(page, job, pan, summary, emit); }
    catch { /* appeals are best-effort; don't fail the whole sync */ }
    try { await syncReturns(page, job, pan, summary, emit); }
    catch { /* returns are best-effort too; a portal hiccup here is not a failed sync */ }
  }
  return summary;
}

module.exports = { syncPortalData };
