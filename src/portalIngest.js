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
import { doc as fsDoc, getDoc as fsGetDoc } from "firebase/firestore";
import { functions, storage, auth, db } from "./firebase";
import { derivePassword, unlockBase64 } from "./pdfUnlock";

/* Metadata for every object we upload.
 *
 * Content-Disposition: attachment is what makes a browser SAVE the file rather
 * than render it in a tab. The in-app buttons don't rely on this — they fetch
 * the blob and name it themselves (downloadFile.js) — but a download URL opened
 * outside the app has only this to go on, and a practitioner who pastes one
 * into a browser should get a file, not a viewer.
 */
const attachment = (contentType) => ({
  contentType: contentType || "application/pdf",
  contentDisposition: "attachment",
});

/* The date of birth / incorporation for one assessee, remembered for the run.
   The returns pass streams one message per assessment year and every order in
   them needs the same date to build its password, so without this we would
   re-read the same document ten times per sync. */
const dobCache = new Map();
async function assesseeDob(assesseeId) {
  if (dobCache.has(assesseeId)) return dobCache.get(assesseeId);
  let dob = "";
  try {
    const uid = auth.currentUser?.uid;
    const snap = await fsGetDoc(fsDoc(db, `users/${uid}/assessees/${assesseeId}`));
    dob = (snap.exists() && snap.data().dob) || "";
  } catch { /* a missing date just means we cannot unlock — not fatal */ }
  dobCache.set(assesseeId, dob);
  return dob;
}

/* Pull the date of birth / incorporation out of a filed return, as a fallback
   for practices that never filled the field in. Individuals carry it under
   PersonalInfo, non-individuals under the entity block — the key differs per
   form, so we look everywhere rather than branching on form type. */
function dobFromItrJson(json) {
  if (!json || typeof json !== "object") return "";
  const KEYS = ["DateOfBirth", "DOB", "DateOFFormOrIncorp", "DateOfIncorporation", "FormationDate"];
  let found = "";
  const walk = (node, depth) => {
    if (found || !node || typeof node !== "object" || depth > 8) return;
    for (const [k, v] of Object.entries(node)) {
      if (found) return;
      if (KEYS.includes(k) && typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) { found = v; return; }
      if (v && typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(json, 0);
  return found;
}

export async function ingestPortalSyncMessage(payload) {
  if (!payload || !payload.assesseeId) return { kind: payload?.kind };

  if (payload.kind === "notice") {
    const n = payload.notice || {};
    let storagePath = null;
    if (n.contentBase64) {
      const uid = auth.currentUser?.uid;
      const safeId = (n.din || `${n.proceedingReqId}-${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, "");
      storagePath = `users/${uid}/assessees/${payload.assesseeId}/notices/${safeId}.pdf`;
      await uploadString(storageRef(storage, storagePath), n.contentBase64, "base64", attachment(n.contentType));
    }
    const meta = { ...n };
    delete meta.contentBase64;
    const res = await httpsCallable(functions, "ingestPortalNotice")({ assesseeId: payload.assesseeId, notice: meta, storagePath, filename: n.filename });
    // Parse order PDFs on fetch, so the real document type (order vs demand
    // notice vs computation sheet) and the order's own metadata are known right
    // away — this drives the appeal detection and the Form 35 match. Best-effort.
    if (meta.isOrder && storagePath && res.data && res.data.noticeId) {
      try {
        await httpsCallable(functions, "summarizePortalNotice")({ noticeId: res.data.noticeId });
      } catch (e) {
        console.warn("auto-parse of order PDF failed", e?.message || e);
      }
    }
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
    /* A refresh carries no documents. It is the portal's latest word on replies
       already on file — chiefly the date the officer opened them, which only
       appears against a reply we have already seen once. Straight through, no
       Storage work. */
    if (Array.isArray(r.refresh)) {
      const res = await httpsCallable(functions, "ingestPortalResponse")({
        assesseeId: payload.assesseeId, noticeKey: r.noticeKey, response: { refresh: r.refresh },
      });
      return { kind: "response", data: res.data };
    }
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
        await uploadString(storageRef(storage, storagePath), at.contentBase64, "base64", attachment(at.contentType));
      }
      attachments.push({ storagePath, filename: at.filename || "attachment.pdf", label: at.label || "" });
      ai++;
    }
    const res = await httpsCallable(functions, "ingestPortalResponse")({
      assesseeId: payload.assesseeId, noticeKey: r.noticeKey,
      response: { responseId: r.responseId, remarks: r.remarks, submittedOn: r.submittedOn, respType: r.respType, extra: r.extra || {}, attachments },
    });
    return { kind: "response", data: res.data };
  }

  // One filed return for one assessment year: the ITR JSON as filed, the ITR-V,
  // and any s.143(1) intimation or s.154 rectification order.
  //
  // The orders arrive encrypted — CPC locks every one of them with the PAN in
  // lower case plus the date of birth / incorporation as DDMMYYYY. We unlock
  // here, before upload, so Storage never holds a file the practitioner then has
  // to type a password into. A failure is not fatal: the encrypted PDF is kept
  // and flagged, and the Returns tab offers to unlock it once the date is known.
  if (payload.kind === "return") {
    const r = payload.return || {};
    const uid = auth.currentUser?.uid;
    const ay = String(r.ay || "unknown").replace(/[^A-Za-z0-9_-]/g, "");
    const base = `users/${uid}/assessees/${payload.assesseeId}/returns/${ay}`;

    // The ITR JSON is both the practitioner's ask and the input the Computation
    // of Income generator reads, so it is stored as a document in its own right.
    let jsonPath = null;
    if (r.itrJson) {
      jsonPath = `${base}/itr.json`;
      const bytes = new TextEncoder().encode(JSON.stringify(r.itrJson));
      let bin = "";
      const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      await uploadString(storageRef(storage, jsonPath), btoa(bin), "base64", attachment("application/json"));
    }

    let ackPdfPath = null;
    if (r.ackPdfBase64) {
      ackPdfPath = `${base}/acknowledgement.pdf`;
      await uploadString(storageRef(storage, ackPdfPath), r.ackPdfBase64, "base64", attachment("application/pdf"));
    }

    let formPdfPath = null;
    if (r.formPdfBase64) {
      formPdfPath = `${base}/form.pdf`;
      await uploadString(storageRef(storage, formPdfPath), r.formPdfBase64, "base64", attachment("application/pdf"));
    }

    const passwords = [];
    if ((r.orders || []).some((o) => o && o.contentBase64)) {
      const pan = r.pan || "";
      for (const d of [await assesseeDob(payload.assesseeId), dobFromItrJson(r.itrJson)]) {
        const pw = derivePassword(pan, d);
        if (pw && !passwords.includes(pw)) passwords.push(pw);
      }
    }

    const orders = [];
    for (const o of (r.orders || [])) {
      let storagePath = null;
      let locked = Boolean(o.locked);
      let lockReason = o.lockReason || "";
      let content = o.contentBase64;
      if (content) {
        const res = await unlockBase64(content, passwords);
        if (res.ok) { content = res.base64; locked = false; lockReason = ""; }
        else if (res.reason !== "not-encrypted") { locked = true; lockReason = res.reason; }
        const safe = String(o.commRefNo || "order").replace(/[^A-Za-z0-9_-]/g, "");
        storagePath = `${base}/order-${safe}.pdf`;
        await uploadString(storageRef(storage, storagePath), content, "base64", attachment("application/pdf"));
      }
      const meta = { ...o };
      delete meta.contentBase64;
      orders.push({ ...meta, storagePath, locked, lockReason });
    }

    const meta = { ...r };
    delete meta.itrJson;
    delete meta.ackPdfBase64;
    delete meta.formPdfBase64;
    delete meta.orders;
    const res = await httpsCallable(functions, "ingestPortalReturn")({
      assesseeId: payload.assesseeId, return: meta, jsonPath, ackPdfPath, formPdfPath, orders,
    });
    return { kind: "return", data: res.data };
  }

  // The fully rendered ITR form for one year, fetched on demand from the Returns
  // tab rather than on every sync (10-12 MB apiece).
  if (payload.kind === "returnForm") {
    const f = payload.form || {};
    if (!f.contentBase64) return { kind: "returnForm", data: { ok: false } };
    const uid = auth.currentUser?.uid;
    const ay = String(f.ay || "unknown").replace(/[^A-Za-z0-9_-]/g, "");
    const formPdfPath = `users/${uid}/assessees/${payload.assesseeId}/returns/${ay}/form.pdf`;
    await uploadString(storageRef(storage, formPdfPath), f.contentBase64, "base64", attachment("application/pdf"));
    const res = await httpsCallable(functions, "attachReturnDocument")({
      assesseeId: payload.assesseeId, ay: f.ay, ackNum: f.ackNum, formPdfPath,
    });
    return { kind: "returnForm", data: res.data };
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
        await uploadString(storageRef(storage, storagePath), at.contentBase64, "base64", attachment(at.contentType));
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
