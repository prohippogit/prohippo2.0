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
//   "all"     — FYA + FYI + notices/orders/replies (+ Form 35, pass 3).
//   "eproc"   — FYA only → diff → new notices/orders; synthetic closed rows for
//               proceedings that just left FYA. No FYI scan.
//   "appeals" — filed Form 35s only (pass 3).
"use strict";

const { jsleep, PACE } = require("./pacing");
const { PATHS, FORM, apiCall, getDoc, proceedings } = require("./portalApi");
const { ingestSyncMessage } = require("./ingest");

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const MAX_PDF_BYTES = 25 * 1024 * 1024;

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

// Responses filed against one notice (remarks + attachment PDFs).
async function syncResponses(page, job, pan, din, headerSeqNo) {
  const knownResp = new Set((job.knowns.knownResponseIds || []).map((x) => String(x)));
  const resp = await apiCall(page, {
    path: PATHS.GET_ENTITY, serviceName: "itbaResponseService",
    payload: { serviceName: "itbaResponseService", headerSeqNo, pan, header: FORM },
  });
  const list = resp.json && Array.isArray(resp.json.respRemrkAttLst) ? resp.json.respRemrkAttLst : [];
  let count = 0;
  for (const rr of list) {
    const atts = Array.isArray(rr.attachmentLst) ? rr.attachmentLst : [];
    if (!rr || (!rr.remarks && atts.length === 0)) continue;
    const responseId = String(rr.responseId || rr.remarksHash || rr.submittedOn || (rr.remarks || "").slice(0, 24));
    if (knownResp.has(responseId)) continue;
    const attachments = [];
    for (const at of atts) {
      const adocId = at.docId || at.satDocId || at.documentId || at.attachmentId || at.refId;
      let apdf = null;
      if (adocId) { const g = await getDoc(page, { docId: String(adocId) }); if (g && g.ok && g.bytes && g.bytes <= MAX_PDF_BYTES) apdf = g; }
      const base = at.attachmentName || at.docNam || at.fileName || (adocId ? adocId + ".pdf" : "attachment.pdf");
      const filename = /\.[a-z0-9]{2,5}$/i.test(base) ? base : base + ".pdf";
      attachments.push({
        filename: apdf && apdf.filename && /\.[a-z0-9]{2,5}$/i.test(apdf.filename) ? apdf.filename : filename,
        label: at.categorieName || "",
        contentType: (apdf && apdf.contentType) || "application/pdf",
        contentBase64: apdf ? apdf.base64 : null,
      });
    }
    await ingestSyncMessage({
      assesseeId: job.assesseeId, kind: "response",
      response: { noticeKey: din, responseId, remarks: rr.remarks || "", submittedOn: rr.submittedOn || "", respType: rr.respType || "", attachments },
    });
    count++;
    await jsleep(...PACE.betweenDocs);
  }
  return count;
}

// Each proceeding's notices/orders + PDFs (incremental), then closure orders.
async function syncNotices(page, job, pan, rows, summary, emit) {
  const known = new Set((job.knowns.knownDins || []).map((d) => String(d)));
  const knownByProc = job.knowns.knownByProc || {};
  const scope = job.scope;
  const isClosed = (r) => /information/i.test(r.tab || "") || r.proceedingStatus === "C";
  const targets = rows.filter((r) => (r.viewNoticeCount || 0) > 0 && r.proceedingReqId);

  for (let i = 0; i < targets.length; i++) {
    const r = targets[i];
    const kp = knownByProc[r.proceedingReqId] || {};
    const countMatches = (r.viewNoticeCount || 0) <= (kp.n || 0);
    // Unchanged closed proceeding (or unchanged active one in eproc mode): skip
    // its detail call and every per-notice reply call entirely.
    if (countMatches && (isClosed(r) || scope === "eproc")) continue;
    emit("fetch", `Notices ${i + 1}/${targets.length} — ${(r.name || "proceeding").slice(0, 28)}…`);
    const det = await apiCall(page, {
      path: PATHS.GET_ENTITY, serviceName: "eProceedingDetailsService",
      payload: { serviceName: "eProceedingDetailsService", proceedingReqId: r.proceedingReqId, pan, header: FORM },
    });
    const items = Array.isArray(det.json) ? det.json : [];
    for (const it of items) {
      const din0 = it.documentIdentificationNumber || "";
      const headerSeqNo = it.headerSeqNo;
      const isKnown = din0 && known.has(String(din0));
      if (!isKnown) {
        let pdf = null;
        if (headerSeqNo) {
          const doc = await apiCall(page, {
            path: PATHS.SAVE_ENTITY, serviceName: "noticeletterpdf",
            payload: { serviceName: "noticeletterpdf", headerSeqNo: String(headerSeqNo), procdngReqId: r.proceedingReqId, loggedInUserId: pan, header: FORM },
          });
          const satDocId = doc.json && doc.json.satDocId;
          if (satDocId) {
            const got = await getDoc(page, { docId: String(satDocId) });
            if (got && got.ok && got.bytes && got.bytes <= MAX_PDF_BYTES) pdf = got;
          }
        }
        await ingestSyncMessage({
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
            filename: (pdf && pdf.filename) || "",
            contentType: (pdf && pdf.contentType) || "application/pdf",
            contentBase64: (pdf && pdf.base64) || null,
            bytes: (pdf && pdf.bytes) || 0,
          },
        });
        summary.notices++;
        await jsleep(...PACE.betweenDocs);
      }
      // Responses (for both new and known notices — a reply can be filed later).
      if (headerSeqNo && din0) {
        try { summary.responses += await syncResponses(page, job, pan, din0, String(headerSeqNo)); }
        catch { /* per-notice; keep going */ }
      }
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
    emit("fetch", `Orders — ${(r.name || "proceeding").slice(0, 28)}…`);
    try {
      const clo = await apiCall(page, {
        path: PATHS.GET_ENTITY, serviceName: "downloadClosureOrder",
        payload: { serviceName: "downloadClosureOrder", procdngReqId: r.proceedingReqId, loggedInUserId: pan, header: FORM },
      });
      let docs = clo.json && Array.isArray(clo.json.satDocDetlList) ? clo.json.satDocDetlList.slice() : [];
      if (!docs.length && clo.json && clo.json.satDocId) docs = [{ satDocId: clo.json.satDocId, docNam: clo.json.docNam }];
      for (const od of docs) {
        const satDocId = od.satDocId;
        if (!satDocId) continue;
        const docKey = "sat:" + satDocId;
        if (known.has(docKey)) continue;
        const got = await getDoc(page, { docId: String(satDocId) });
        const pdf = got && got.ok && got.bytes && got.bytes <= MAX_PDF_BYTES ? got : null;
        await ingestSyncMessage({
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
        });
        summary.notices++;
        await jsleep(...PACE.betweenDocs);
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
    // TODO(port pass 3): syncAppealForms — filed Form 35s via viewFiledForms +
    // pdfweb render (deepMergeShape/template), then ingest kind:"appealForm".
    emit("fetch", "Appeals (Form 35) fetch — coming in pass 3", "warn");
    return summary;
  }

  emit("fetch", "Fetching e-Proceedings (FYA)…");
  const rows = [];
  const push = (res, tab) => {
    const list = res && res.json && res.json.eProceedingPaginatedRequests;
    if (Array.isArray(list)) for (const o of list) rows.push(mapRow(o, tab));
  };
  push(await proceedings(page, { pan, statusFlag: "FYA", pageSize: 100 }), "For your Action");
  if (scope === "all") {
    push(await proceedings(page, { pan, statusFlag: "FYI", pageSize: 100 }), "For your Information");
  }

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

  if (!rows.length) { emit("fetch", "Nothing in FYA — up to date"); return summary; }

  emit("fetch", `${rows.length} proceeding(s) — saving…`);
  await ingestSyncMessage({ assesseeId: job.assesseeId, kind: "proceedings", proceedings: rows });
  summary.proceedings = rows.length;

  await syncNotices(page, job, pan, rows, summary, emit);

  if (scope === "all") {
    // TODO(port pass 3): syncAppealForms on a full sync too.
    emit("fetch", "Form 35 appeals fetch — coming in pass 3", "warn");
  }
  return summary;
}

module.exports = { syncPortalData };
