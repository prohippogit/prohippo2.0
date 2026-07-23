// Filed Form 35 (CIT(A) appeals) sync — Playwright port of syncAppealForms from
// extension/portal-login.js.
//
// For each filed Form 35 (from "View Filed Forms"), pull the structured filed-
// form data, render the form + ARN receipt to PDF via pdfweb, download the
// uploaded attachments (Grounds of Appeal etc.), and hand the whole thing to the
// existing ingestPortalAppealForm callable so it attaches to the matching First
// Appeal proceeding. The pdfweb renderer needs a full-shape payload or it 502s,
// so we merge the filed data onto the static template (f35-template.js).
"use strict";

const { jsleep, PACE } = require("./pacing");
const { PATHS, FORM, apiCall, getDoc, postDoc } = require("./portalApi");
const { ingestSyncMessage } = require("./ingest");
const { loadF35Template } = require("./f35Template");

const MAX_PDF_BYTES = 25 * 1024 * 1024;

// Deep-merge live data onto a full-shape template so no field the renderer reads
// is ever undefined. Objects merge key-wise; arrays merge element-wise against
// the shape's element template AND keep the shape's length (padding). Port.
function deepMergeShape(shape, data) {
  if (Array.isArray(shape)) {
    const el = shape.length ? shape[0] : {};
    const src = Array.isArray(data) ? data : [];
    const out = src.map((x) => deepMergeShape(el, x));
    for (let i = out.length; i < shape.length; i++) out.push(deepMergeShape(el, {}));
    return out;
  }
  if (shape && typeof shape === "object") {
    const out = {};
    for (const k of Object.keys(shape)) out[k] = deepMergeShape(shape[k], data ? data[k] : undefined);
    if (data && typeof data === "object") for (const k of Object.keys(data)) if (!(k in out)) out[k] = data[k];
    return out;
  }
  return data !== undefined && data !== null ? data : shape;
}

// "23-Nov-2024" → "23/11/2024 12:00:00 PM" (format the pdfweb verification block
// parses; a wrong format 502s the renderer). Port.
function itfTs(s) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(s || ""));
  if (!m) return "";
  const mo = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" }[m[2]];
  return mo ? `${m[1].padStart(2, "0")}/${mo}/${m[3]} 12:00:00 PM` : "";
}

// Form 35 gives AY as the start year (selectyear) → "2015-16". Port.
function ayFromForm(d) {
  const y = Number(d.selectyear || d.assessmentYear || 0);
  if (!y || y < 1900) return "";
  return y + "-" + String((y + 1) % 100).padStart(2, "0");
}

async function syncAppealForms(page, job, pan, summary, emit) {
  const assesseeId = job.assesseeId;
  emit("appeals", "Fetching filed appeals (Form 35)…", "info", 88);

  let forms;
  try {
    const list = await apiCall(page, {
      path: PATHS.SERVICES_SAVE, serviceName: "viewFiledForms",
      payload: { serviceName: "viewFiledForms", entityNum: pan, formTypeCd: "F35", currentPage: "0", pageSize: "50", filterParameterDetails: [] },
    });
    forms = list.json && Array.isArray(list.json.forms) ? list.json.forms : [];
  } catch { return; }
  if (!forms.length) { emit("appeals", "No filed Form 35"); return; }

  // Taxpayer name + address, for the ARN receipt + the Form 35 entity block.
  const entType = ({ P: "Individual", C: "Company", H: "HUF", F: "Firm", A: "AOP/BOI", B: "AOP/BOI", T: "Trust" }[(pan[3] || "").toUpperCase()]) || "Individual";
  let entName = "", entAddr = "", entFields = {};
  try {
    const pd = await apiCall(page, { path: PATHS.SERVICES_SAVE, serviceName: "myPanDetailsService", payload: { serviceName: "myPanDetailsService", contactPan: pan, userId: pan } });
    const j = (pd && pd.json) || {};
    const ln = (x) => (x || "").toString().trim();
    entName = [j.firstNm, j.midNm, j.surname].map(ln).filter(Boolean).join(" ");
    entAddr = [j.commnLine1, j.commnLine2, j.commnLine3, j.commnLine4, j.commnLine5].map(ln).filter(Boolean).join(", ");
    entFields = {
      entityNumber: pan,
      entityFirstName: ln(j.firstNm), entityMidName: ln(j.midNm), entityLastName: ln(j.surname),
      entityAddrLine1Txt: [j.commnLine1, j.commnLine2].map(ln).filter(Boolean).join(", "),
      entityPostofficeDesc: [j.commnLine3, j.commnLine4].map(ln).filter(Boolean).join(", "),
      entityLocalityDesc: ln(j.commnLine5),
      entityPinCd: j.commnPin != null && j.commnPin !== "" ? Number(j.commnPin) : "",
      entityTaxPayerCatgCd: ({ P: "IND", C: "COM", H: "HUF", F: "FIR", A: "AOP", B: "BOI", T: "TRU" }[(pan[3] || "").toUpperCase()]) || "IND",
      entityTaxPayerCatgDesc: entType,
    };
  } catch { /* fallback fields only */ }

  const F35T = loadF35Template();
  const knownForms = new Set((job.knowns.knownDins || []).map((d) => String(d)));

  for (const f of forms) {
    const ackNum = f.ackNum || f.ackNo || "";
    if (!ackNum) continue;
    if (knownForms.has("f35:" + ackNum)) continue; // already on file — skip

    let d = {};
    try {
      const inv = await apiCall(page, {
        path: PATHS.ITF_INVOKE, serviceName: "viewFiledFormService",
        payload: { metadata: { sn: "viewFiledFormService", formName: "F35", submitedBy: "", loggedInUserId: pan }, data: { ackNum } },
      });
      d = inv.json && inv.json.data ? inv.json.data : {};
    } catch { /* keep going with empty d */ }

    const attachments = [];
    const ackDt = (Array.isArray(f.ackDt) ? f.ackDt[0] : f.ackDt) || (Array.isArray(f.ackDate) ? f.ackDate[0] : f.ackDate) || "";
    let formPdfError = "";

    // The rendered Form 35 ("Download Form"). invoke data MUST win the merge
    // (…entFields then …d) — overwriting its correctly-typed values 502s pdfweb.
    try {
      const f35data = F35T ? deepMergeShape(F35T.shape, { ...entFields, ...d, arn: ackNum }) : { ...entFields, ...d, arn: ackNum };
      const ts = itfTs(ackDt);
      const dscJson = { evc: "", verMode: "OTP", submitDate: ts, fullName: entName, verPan: pan, verDate: ts };
      const body = { formStatus: f.formStatus || "Completed", udinNum: null, formName: "F35", submitMode: "Online", data: f35data, list: F35T ? F35T.list : {}, dscJson, childData: F35T ? F35T.childData : {} };
      let rendered = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        rendered = await postDoc(page, { path: PATHS.PDFWEB, serviceName: "F35", payload: body });
        if (rendered && rendered.ok) break;
        const st = rendered && rendered.status;
        if (st && st < 500) break; // a 4xx won't fix itself
        await jsleep(1200, 1800); // 5xx/timeout → retry
      }
      if (rendered && rendered.ok && rendered.bytes && rendered.bytes <= MAX_PDF_BYTES) {
        attachments.push({ filename: "Form 35 - " + ackNum + ".pdf", label: "Form 35 (filed)", contentType: rendered.contentType || "application/pdf", contentBase64: rendered.base64 });
      } else {
        formPdfError = "HTTP " + ((rendered && rendered.status) || "?") + (rendered && rendered.notPdf ? " (not a PDF)" : "");
      }
    } catch (e) { formPdfError = "error: " + ((e && e.message) || e); }

    // The acknowledgement (ARN) receipt.
    try {
      const ackPdf = await postDoc(page, { path: PATHS.PDFWEB, serviceName: "arn", payload: { formStatus: "", udinNum: null, formName: "arn", submitMode: "Online", data: {
        dateOfEfiling: ackDt, arn: ackNum, name: entName, nameSignatory: entName, entityNum: pan, address: entAddr,
        formNo: "Form 35", formdescription: f.formName || "Appeal to the Commissioner (Appeals)",
        assessmentYear: ayFromForm(d), filingType: "Original", entityType: entType, verifiedBy: pan, refYearType: "A.Y.",
      } } });
      if (ackPdf && ackPdf.ok && ackPdf.bytes && ackPdf.bytes <= MAX_PDF_BYTES) {
        attachments.push({ filename: "Acknowledgement - " + ackNum + ".pdf", label: "Acknowledgement (ARN)", contentType: ackPdf.contentType || "application/pdf", contentBase64: ackPdf.base64 });
      }
    } catch { /* ARN is best-effort */ }

    // Uploaded attachments (Grounds of Appeal etc.). Skip order/demand copies —
    // those come with the assessment proceeding already.
    try {
      const att = await apiCall(page, { path: PATHS.SERVICES_GET, serviceName: "attachmentDetails", payload: { entityNum: pan, serviceName: "attachmentDetails", ackNum } });
      const docs = Array.isArray(att.json) ? att.json : (att.json && Array.isArray(att.json.attachmentList) ? att.json.attachmentList : []);
      for (const doc of docs) {
        const id = doc.satDocId || doc.docId;
        const nm = doc.docName || doc.docNam || "";
        if (!id) continue;
        if (/order\s*u\/?s|demand notice|computation sheet/i.test(nm)) continue;
        const got = await getDoc(page, { docId: String(id) });
        if (got && got.ok && got.bytes && got.bytes <= MAX_PDF_BYTES) {
          attachments.push({ filename: nm || id + ".pdf", label: "Grounds / attachment", contentType: got.contentType || "application/pdf", contentBase64: got.base64 });
        }
        await jsleep(...PACE.betweenDocs);
      }
    } catch { /* attachments best-effort */ }

    await ingestSyncMessage({
      assesseeId, kind: "appealForm",
      appeal: {
        formCd: "F35", formName: "Form 35", ackNum, ackDt,
        ay: ayFromForm(d),
        orderDin: d.din || d.orderNum || "",
        orderSection: d.sectionSubsectionForItf || "",
        appealSection: d.sectionSubsectionAppeal || "",
        dateOrder: d.dateOrder || "",
        dateFiling: d.dateFiling || "",
        authorityOrder: d.authorityOrder || "",
        amountAssessed: d.amountAssessed || "",
        disputedDemand: d.disputedDemandAmount || "",
        formPdfError, attachments,
      },
    });
    summary.appeals = (summary.appeals || 0) + 1;
    emit("appeals", `Filed appeal ${ackNum} — saved`, "info", 94);
    await jsleep(...PACE.betweenDocs);
  }
}

module.exports = { syncAppealForms };
