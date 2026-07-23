// Ingest layer — faithful port of src/portalIngest.js (ingestPortalSyncMessage).
//
// The portal worker builds the SAME payload shapes the extension streams
// ({kind:"proceedings"|"notice"|"response"|"appealForm", ...}); this handler
// uploads any PDF to Storage under the user's own path and calls the identical
// ingestPortal* Cloud Functions. Keeping this a 1:1 port of the web app's
// handler means the connector and the web app can never drift apart — same
// Storage paths, same function calls, same order auto-parse.
//
// This is the ONLY place the connector talks to the backend about portal data,
// so if the fetch source ever moves to ERI/AR, only portalFetch.js changes.
"use strict";

const fb = require("./firebaseClient");

const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "");

async function ingestSyncMessage(payload) {
  if (!payload || !payload.assesseeId) return { kind: payload && payload.kind };
  const assesseeId = payload.assesseeId;

  if (payload.kind === "proceedings") {
    const data = await fb.callable("ingestPortalProceedings", {
      assesseeId,
      proceedings: payload.proceedings || [],
    });
    return { kind: "proceedings", data };
  }

  if (payload.kind === "notice") {
    const n = payload.notice || {};
    let storagePath = null;
    if (n.contentBase64) {
      const uid = fb.uid();
      const id = safe(n.din || `${n.proceedingReqId}-${Date.now()}`);
      storagePath = `users/${uid}/assessees/${assesseeId}/notices/${id}.pdf`;
      await fb.uploadBase64(storagePath, n.contentBase64, n.contentType);
    }
    const meta = { ...n };
    delete meta.contentBase64;
    const data = await fb.callable("ingestPortalNotice", {
      assesseeId, notice: meta, storagePath, filename: n.filename,
    });
    // Auto-parse order PDFs on fetch so the real doc type (order vs demand notice
    // vs computation sheet) + the order's metadata are known immediately — drives
    // appeal detection and the Form 35 match. Best-effort.
    if (meta.isOrder && storagePath && data && data.noticeId) {
      try { await fb.callable("summarizePortalNotice", { noticeId: data.noticeId }); }
      catch { /* best-effort */ }
    }
    return { kind: "notice", data };
  }

  if (payload.kind === "response") {
    const r = payload.response || {};
    const uid = fb.uid();
    const attachments = [];
    let ai = 0;
    for (const at of r.attachments || []) {
      let storagePath = null;
      if (at.contentBase64) {
        const id = safe(`${r.responseId || "resp"}-${ai}`);
        storagePath = `users/${uid}/assessees/${assesseeId}/responses/${id}.pdf`;
        await fb.uploadBase64(storagePath, at.contentBase64, at.contentType);
      }
      attachments.push({ storagePath, filename: at.filename || "attachment.pdf", label: at.label || "" });
      ai++;
    }
    const data = await fb.callable("ingestPortalResponse", {
      assesseeId, noticeKey: r.noticeKey,
      response: { responseId: r.responseId, remarks: r.remarks, submittedOn: r.submittedOn, respType: r.respType, attachments },
    });
    return { kind: "response", data };
  }

  if (payload.kind === "appealForm") {
    const ap = payload.appeal || {};
    const uid = fb.uid();
    const attachments = [];
    let ai = 0;
    for (const at of ap.attachments || []) {
      let storagePath = null;
      if (at.contentBase64) {
        const id = safe(`${ap.ackNum || "f35"}-${ai}`);
        storagePath = `users/${uid}/assessees/${assesseeId}/appeals/${id}.pdf`;
        await fb.uploadBase64(storagePath, at.contentBase64, at.contentType);
      }
      attachments.push({ storagePath, filename: at.filename || "appeal.pdf", label: at.label || "" });
      ai++;
    }
    const meta = { ...ap };
    delete meta.attachments;
    const data = await fb.callable("ingestPortalAppealForm", { assesseeId, appeal: meta, attachments });
    return { kind: "appealForm", data };
  }

  return { kind: payload.kind };
}

module.exports = { ingestSyncMessage };
