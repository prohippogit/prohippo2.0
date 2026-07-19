/*
 * ProHippo — shared handler for the messages the ProHippo Sync extension streams
 * during a portal sync. Used by both the single-assessee card and the bulk
 * (multi-select) sync so the two never drift apart.
 *
 * - kind "notice":      upload the PDF (if any) to Storage, then record the
 *                       notice via the ingestPortalNotice Cloud Function.
 * - kind "proceedings": upsert the proceedings/matters via ingestPortalProceedings.
 * Returns { kind, data } so callers can update their own UI (timing, "closed"
 * popups, counts), or { kind } for messages with no data step.
 */
import { httpsCallable } from "firebase/functions";
import { ref as storageRef, uploadString } from "firebase/storage";
import { functions, storage, auth } from "./firebase";

export async function ingestPortalSyncMessage(payload) {
  if (!payload || !payload.assesseeId) return { kind: payload?.kind };

  if (payload.kind === "notice") {
    const n = payload.notice || {};
    let storagePath = null;
    if (n.contentBase64) {
      const uid = auth.currentUser?.uid;
      const safeId = (n.din || `${n.proceedingReqId}-${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, "");
      storagePath = `users/${uid}/assessees/${payload.assesseeId}/notices/${safeId}.pdf`;
      await uploadString(storageRef(storage, storagePath), n.contentBase64, "base64", { contentType: n.contentType || "application/pdf" });
    }
    const meta = { ...n };
    delete meta.contentBase64;
    const res = await httpsCallable(functions, "ingestPortalNotice")({ assesseeId: payload.assesseeId, notice: meta, storagePath, filename: n.filename });
    return { kind: "notice", data: res.data };
  }

  if (payload.kind === "proceedings") {
    const res = await httpsCallable(functions, "ingestPortalProceedings")({ assesseeId: payload.assesseeId, proceedings: payload.proceedings || [] });
    return { kind: "proceedings", data: res.data };
  }

  // A response filed against a notice: upload its attachment PDFs, then record
  // the remarks + attachment paths on the matching notice.
  if (payload.kind === "response") {
    const r = payload.response || {};
    const uid = auth.currentUser?.uid;
    const attachments = [];
    let ai = 0;
    for (const at of (r.attachments || [])) {
      let storagePath = null;
      if (at.contentBase64) {
        // Deterministic path (responseId + index) so a re-sync overwrites the
        // same object instead of leaving orphaned copies behind.
        const safe = `${(r.responseId || "resp")}-${ai}`.replace(/[^A-Za-z0-9_-]/g, "");
        storagePath = `users/${uid}/assessees/${payload.assesseeId}/responses/${safe}.pdf`;
        await uploadString(storageRef(storage, storagePath), at.contentBase64, "base64", { contentType: at.contentType || "application/pdf" });
      }
      attachments.push({ storagePath, filename: at.filename || "attachment.pdf", label: at.label || "" });
      ai++;
    }
    const res = await httpsCallable(functions, "ingestPortalResponse")({
      assesseeId: payload.assesseeId, noticeKey: r.noticeKey,
      response: { responseId: r.responseId, remarks: r.remarks, submittedOn: r.submittedOn, respType: r.respType, attachments },
    });
    return { kind: "response", data: res.data };
  }

  // A CIT(A) appeal filed as Form 35: upload its PDFs, then record it against
  // the matching First Appeal proceeding.
  if (payload.kind === "appealForm") {
    const ap = payload.appeal || {};
    const uid = auth.currentUser?.uid;
    const attachments = [];
    let ai = 0;
    for (const at of (ap.attachments || [])) {
      let storagePath = null;
      if (at.contentBase64) {
        const safe = `${(ap.ackNum || "f35")}-${ai}`.replace(/[^A-Za-z0-9_-]/g, "");
        storagePath = `users/${uid}/assessees/${payload.assesseeId}/appeals/${safe}.pdf`;
        await uploadString(storageRef(storage, storagePath), at.contentBase64, "base64", { contentType: at.contentType || "application/pdf" });
      }
      attachments.push({ storagePath, filename: at.filename || "appeal.pdf", label: at.label || "" });
      ai++;
    }
    const meta = { ...ap };
    delete meta.attachments;
    const res = await httpsCallable(functions, "ingestPortalAppealForm")({ assesseeId: payload.assesseeId, appeal: meta, attachments });
    return { kind: "appealForm", data: res.data };
  }

  return { kind: payload.kind };
}
