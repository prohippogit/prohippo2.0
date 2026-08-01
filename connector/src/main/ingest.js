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
    // Order PDFs still get auto-parsed (the real doc type — order vs demand
    // notice vs computation sheet — plus the order's own metadata drives appeal
    // detection and the Form 35 match), but NOT from here.
    //
    // This used to await summarizePortalNotice inline: a Gemini read of the PDF,
    // 5-25s per order, capped at 5 concurrent instances shared across every
    // worker, sitting squarely on the sync's critical path. It is now a Firestore
    // trigger on the notice document (see onNoticeWritten in functions/index.js),
    // so it runs on Google's side after the sync has moved on — and still
    // completes if the user closes the connector the moment the sync ends.
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

  if (payload.kind === "return") {
    const r = payload.return || {};
    const uid = fb.uid();
    const base = `users/${uid}/assessees/${assesseeId}/returns/${safe(r.ay || "unknown")}`;

    /* Every object below is independent — a different path, no ordering
       between them — and one of them is the 11 MB rendered return. Uploading
       them one after another meant a sync spent the sum of four uploads where
       it could spend the longest of them. Storage is perfectly happy to take
       them at once; the portal is not involved in any of this, so the
       human-paced rhythm the rest of the sync keeps is untouched. */
    const uploads = [];

    // The ITR JSON is the practitioner's ask AND the input the Computation of
    // Income generator reads, so it is stored as a first-class document rather
    // than being flattened into fields.
    let jsonPath = null;
    if (r.itrJson) {
      jsonPath = `${base}/itr.json`;
      const b64 = Buffer.from(JSON.stringify(r.itrJson), "utf8").toString("base64");
      uploads.push(fb.uploadBase64(jsonPath, b64, "application/json"));
    }

    let ackPdfPath = null;
    if (r.ackPdfBase64) {
      ackPdfPath = `${base}/acknowledgement.pdf`;
      uploads.push(fb.uploadBase64(ackPdfPath, r.ackPdfBase64, "application/pdf"));
    }

    let formPdfPath = null;
    if (r.formPdfBase64) {
      formPdfPath = `${base}/form.pdf`;
      uploads.push(fb.uploadBase64(formPdfPath, r.formPdfBase64, "application/pdf"));
    }

    const orders = [];
    for (const o of r.orders || []) {
      let storagePath = null;
      if (o.contentBase64) {
        storagePath = `${base}/order-${safe(o.commRefNo)}.pdf`;
        uploads.push(fb.uploadBase64(storagePath, o.contentBase64, "application/pdf"));
      }
      const meta = { ...o };
      delete meta.contentBase64;
      orders.push({ ...meta, storagePath });
    }

    // The metadata records these paths, so it must not be written before the
    // files behind them exist.
    await Promise.all(uploads);

    const meta = { ...r };
    delete meta.itrJson;
    delete meta.ackPdfBase64;
    delete meta.formPdfBase64;
    delete meta.orders;
    const data = await fb.callable("ingestPortalReturn", {
      assesseeId, return: meta, jsonPath, ackPdfPath, formPdfPath, orders,
    });
    return { kind: "return", data };
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
