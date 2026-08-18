// Filed Form 35 (CIT(A) appeals) sync — Playwright port of syncAppealForms from
// extension/portal-login.js.
//
// For each filed Form 35 (from "View Filed Forms"), pull the structured filed-
// form data, render the form + ARN receipt to PDF via pdfweb, download the
// uploaded attachments (Grounds of Appeal etc.), and hand the whole thing to the
// existing ingestPortalAppealForm callable so it attaches to the matching First
// Appeal proceeding. The pdfweb renderer needs a full-shape payload or it 502s,
// so we merge the filed data onto the static template (f35-template.js).
//
/* WHAT WENT WRONG HERE, AND THE THREE THINGS THAT WERE WRONG ABOUT IT.
 *
 * Reported: "it takes much time and most of the time it does not fetch the pdfs
 * of all the Form 35 and its attachments. It stalls at a place and skips
 * everything which is yet to be fetched after Form 35. Moreover, it shows the
 * user that the data is synced though the data is not synced."
 *
 * Three separate faults, and each one hid the next.
 *
 *   TIME. The rendered form was asked for three times in a loop, and each of
 *   those asks was itself retried once by portalApi, at the ceiling meant for an
 *   11 MB rendered return. Six renders of one small PDF, ~150 seconds apiece —
 *   sixteen minutes for ONE form's first document, before its receipt, its
 *   attachment list, or a single attachment. The per-PAN deadline is fifteen.
 *   Now: one ask, retried once by portalApi as everything else is, at a ceiling
 *   sized for what a Form 35 actually is (TIMEOUTS.render).
 *
 *   THE REST OF THE SYNC. Because appeals could spend the whole PAN deadline,
 *   the passes after it — filed returns, CPC intimations — did not run. Nothing
 *   said so. Now the pass works to a budget (BUDGETS.appeals) that stops short
 *   of the PAN's deadline by BUDGETS.reserve, and each form to a slice of that,
 *   so neither one form nor this whole pass can take the run.
 *
 *   COMING BACK FOR IT. A form was ingested however badly it had gone, and the
 *   ingest writes `f35:<ackNum>` into the docKeys this pass skips on. So a form
 *   whose PDF 502'd, or whose attachments never came, was marked as held for
 *   ever and no later sync would look at it again. That is why re-syncing
 *   changed nothing. Now a form is only "held" once it is COMPLETE; what is
 *   missing is recorded on the appeal (`formPdfError`, `attachmentsMissing`) and
 *   syncKnowns turns that into `appealFormsPending`, which brings this pass back
 *   to it — up to MAX_TRIES, so a form the portal will genuinely never render
 *   stops costing every future sync.
 *
 * And the reporting: whatever is left unfetched goes into `summary.incomplete`,
 * which is what stops the window saying "synced" over it. */
"use strict";

const { jsleep, PACE } = require("./pacing");
const { PATHS, apiCall, getDoc, postDoc } = require("./portalApi");
const { TIMEOUTS, BUDGETS } = require("./config");
const { makeBudget } = require("./syncBudget");
const { ingestSyncMessage } = require("./ingest");
const { loadF35Template } = require("./f35Template");

const MAX_PDF_BYTES = 25 * 1024 * 1024;

/* How many syncs may go looking for the same missing document before it is
   accepted as one the portal is not going to hand over. Kept in step with the
   same figure in syncKnowns.js, which is what decides when to ask again. */
const MAX_TRIES = 3;

/* Enough of a budget left to be worth STARTING one of these. Not how long they
   take — how long it is worth waiting to find out. Below this the step is
   skipped and recorded as missing, which is honest and costs the next sync one
   call, rather than being begun and abandoned half way, which costs the time
   and produces nothing. */
const NEED = {
  formData: 20000,   // the filed-form invoke
  render: 25000,     // a pdfweb render
  attList: 15000,    // the attachment list
  attachment: 20000, // one attachment download
};

/* NO CALL OUTLIVES THE BUDGET IT WAS STARTED UNDER.
 *
 * Asking "is there room for this?" before a call is only half of it: with forty
 * seconds left, a document download at its own 90-second ceiling still runs for
 * ninety, and the pass overruns into the time the pass behind it was promised.
 * So a call's deadline is whichever is shorter — its own ceiling, or what is
 * actually left. A call cut off this way is recorded as missing and fetched by
 * the next sync with a full budget in hand, which is the same outcome as any
 * other document that did not arrive. */
const capped = (ceiling, budget) => Math.max(1000, Math.min(ceiling, budget.left()));

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

const NO_CLOCK = { time: (_name, fn) => fn(), add: () => {} };

/* Say, once, what this run did not get to. One line per PAN, in the words a
   practitioner would use about it, and the same strings go on the finished-sync
   card. `summary.incomplete` existing at all is what makes the difference
   between "synced" and "partly synced" downstream (pool.js). */
function note(summary, text) {
  (summary.incomplete || (summary.incomplete = [])).push(text);
}

async function syncAppealForms(page, job, pan, summary, emit) {
  const assesseeId = job.assesseeId;
  const t = (job && job.timer) || NO_CLOCK;
  emit("appeals", "Fetching filed appeals (Form 35)…", "info", 88);

  /* THE PASS'S SHARE OF THE RUN. `job.deadlineAt` is when the pool gives up on
     this PAN altogether (pool.js); this pass stops BUDGETS.reserve short of it
     so the returns pass behind it still has time to run. Where no deadline was
     handed down — the "appeals" scope, run on its own — the cap is the only
     wall, which is right: there is nothing queued behind it. */
  const budget = makeBudget(BUDGETS.appeals, {
    notAfter: Number.isFinite(job.deadlineAt) ? job.deadlineAt - BUDGETS.reserve : undefined,
  });

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
  /* Held, but not finished: the PDF never rendered, or an attachment never came
     down. These are exactly the forms a re-sync used to walk straight past. */
  const pending = new Map((job.knowns.appealFormsPending || []).map((p) => [String(p && p.ackNum), p]));

  /* What this pass has to do, so the count it reports when it runs out of time
     is honest rather than "the ones I happened to notice". `doneCount` counts
     forms REACHED, whether or not they came back whole — a form that was tried
     and came back empty has already said so in its own words, and must not also
     be counted among the ones nothing was attempted for. */
  const wanted = forms
    .map((f) => String(f.ackNum || f.ackNo || ""))
    .filter((ack) => ack && (!knownForms.has("f35:" + ack) || pending.has(ack)));
  let doneCount = 0;

  for (const f of forms) {
    const ackNum = f.ackNum || f.ackNo || "";
    if (!ackNum) continue;
    const retry = pending.get(String(ackNum));
    if (knownForms.has("f35:" + ackNum) && !retry) continue; // held, and complete — skip

    /* OUT OF TIME. Stop where we are and say how many are left, rather than
       starting a form that will be abandoned half-fetched. They are all still in
       `wanted`, all still pending, and the next sync begins with them. */
    if (budget.expired()) {
      const left = wanted.length - doneCount;
      if (left > 0) {
        emit("appeals", `${left} filed appeal(s) not reached this run — the next sync starts with them`, "warn", 94);
        note(summary, `${left} filed appeal(s) not fetched`);
      }
      break;
    }
    // One form's share. Never more than the pass has left, so four forms cannot
    // each take two minutes out of a six-minute pass and leave nothing behind.
    const form = budget.slice(BUDGETS.appealForm);
    const tries = Number(retry && retry.tries) || 0;

    let d = {};
    try {
      const inv = await apiCall(page, {
        path: PATHS.ITF_INVOKE, serviceName: "viewFiledFormService",
        payload: { metadata: { sn: "viewFiledFormService", formName: "F35", submitedBy: "", loggedInUserId: pan }, data: { ackNum } },
        timeoutMs: capped(TIMEOUTS.api, form),
        retries: form.enoughFor(2 * NEED.formData) ? undefined : 0,
      });
      d = inv.json && inv.json.data ? inv.json.data : {};
    } catch { /* keep going with empty d */ }

    const attachments = [];
    const missing = []; // what this form was supposed to have and did not get
    const ackDt = (Array.isArray(f.ackDt) ? f.ackDt[0] : f.ackDt) || (Array.isArray(f.ackDate) ? f.ackDate[0] : f.ackDate) || "";
    let formPdfError = "";

    // The rendered Form 35 ("Download Form"). invoke data MUST win the merge
    // (…entFields then …d) — overwriting its correctly-typed values 502s pdfweb.
    //
    // ONE ask, not three. portalApi retries a 5xx or a stall once already, which
    // is what the loop that used to be here was for; stacking the two turned a
    // renderer that was never going to answer into sixteen minutes of waiting.
    try {
      if (!form.enoughFor(NEED.render)) {
        formPdfError = "not fetched — the sync ran out of time for this form";
      } else {
        const f35data = F35T ? deepMergeShape(F35T.shape, { ...entFields, ...d, arn: ackNum }) : { ...entFields, ...d, arn: ackNum };
        const ts = itfTs(ackDt);
        const dscJson = { evc: "", verMode: "OTP", submitDate: ts, fullName: entName, verPan: pan, verDate: ts };
        const body = { formStatus: f.formStatus || "Completed", udinNum: null, formName: "F35", submitMode: "Online", data: f35data, list: F35T ? F35T.list : {}, dscJson, childData: F35T ? F35T.childData : {} };
        const rendered = await t.time("f35-render", () => postDoc(page, {
          path: PATHS.PDFWEB, serviceName: "F35", payload: body,
          timeoutMs: capped(TIMEOUTS.render, form),
          // Room for the retry, or none: better to move on to the next form.
          retries: form.enoughFor(2 * (TIMEOUTS.render + 8000)) ? undefined : 0,
        }));
        if (rendered && rendered.ok && rendered.bytes && rendered.bytes <= MAX_PDF_BYTES) {
          attachments.push({ filename: "Form 35 - " + ackNum + ".pdf", label: "Form 35 (filed)", contentType: rendered.contentType || "application/pdf", contentBase64: rendered.base64 });
        } else {
          formPdfError = "HTTP " + ((rendered && rendered.status) || "?") + (rendered && rendered.notPdf ? " (not a PDF)" : "");
        }
      }
    } catch (e) { formPdfError = "error: " + ((e && e.message) || e); }

    // The acknowledgement (ARN) receipt. Best-effort, and deliberately not part
    // of what makes a form complete: it is a covering receipt, and a form held
    // back for its sake would be re-fetched for ever over a page nobody reads.
    try {
      if (form.enoughFor(NEED.render)) {
        const ackPdf = await postDoc(page, { path: PATHS.PDFWEB, serviceName: "arn", timeoutMs: capped(TIMEOUTS.render, form), retries: 0, payload: { formStatus: "", udinNum: null, formName: "arn", submitMode: "Online", data: {
          dateOfEfiling: ackDt, arn: ackNum, name: entName, nameSignatory: entName, entityNum: pan, address: entAddr,
          formNo: "Form 35", formdescription: f.formName || "Appeal to the Commissioner (Appeals)",
          assessmentYear: ayFromForm(d), filingType: "Original", entityType: entType, verifiedBy: pan, refYearType: "A.Y.",
        } } });
        if (ackPdf && ackPdf.ok && ackPdf.bytes && ackPdf.bytes <= MAX_PDF_BYTES) {
          attachments.push({ filename: "Acknowledgement - " + ackNum + ".pdf", label: "Acknowledgement (ARN)", contentType: ackPdf.contentType || "application/pdf", contentBase64: ackPdf.base64 });
        }
      }
    } catch { /* ARN is best-effort */ }

    /* Uploaded attachments (Grounds of Appeal etc.). Skip order/demand copies —
       those come with the assessment proceeding already.
       EVERY ONE THAT DOES NOT ARRIVE IS NAMED. They used to be dropped in
       silence, which is how a Form 35 could be filed on file with no grounds
       attached to it and nothing anywhere saying a document was expected. */
    let expected = 0;
    try {
      if (!form.enoughFor(NEED.attList)) {
        missing.push("the attachment list");
      } else {
        const att = await apiCall(page, {
          path: PATHS.SERVICES_GET, serviceName: "attachmentDetails",
          payload: { entityNum: pan, serviceName: "attachmentDetails", ackNum },
          timeoutMs: capped(TIMEOUTS.api, form),
          retries: form.enoughFor(2 * NEED.attList) ? undefined : 0,
        });
        const docs = Array.isArray(att.json) ? att.json : (att.json && Array.isArray(att.json.attachmentList) ? att.json.attachmentList : []);
        for (const doc of docs) {
          const id = doc.satDocId || doc.docId;
          const nm = doc.docName || doc.docNam || "";
          if (!id) continue;
          if (/order\s*u\/?s|demand notice|computation sheet/i.test(nm)) continue;
          expected++;
          if (!form.enoughFor(NEED.attachment)) { missing.push(nm || String(id)); continue; }
          const got = await getDoc(page, {
            docId: String(id),
            timeoutMs: capped(TIMEOUTS.doc, form),
            retries: form.enoughFor(2 * TIMEOUTS.doc) ? undefined : 0,
          });
          if (got && got.ok && got.bytes && got.bytes <= MAX_PDF_BYTES) {
            attachments.push({ filename: nm || id + ".pdf", label: "Grounds / attachment", contentType: got.contentType || "application/pdf", contentBase64: got.base64 });
          } else {
            missing.push(nm || String(id));
          }
          await jsleep(...PACE.betweenDocs);
        }
      }
    } catch (e) { missing.push(`the attachment list (${(e && e.message) || e})`); }

    /* A RUN THAT GOT NOTHING WRITES NOTHING. If neither the filed-form data nor
       a single PDF came back, the only thing an ingest would achieve is to write
       the `f35:<ackNum>` docKey — the very key this pass skips on — over a form
       nobody has read. Leaving it unwritten leaves it UNKNOWN, which is the
       strongest form of "come back for this": the next sync treats it as a form
       it has never seen, with a full budget in hand. */
    if (!Object.keys(d).length && !attachments.length) {
      emit("appeals", `Filed appeal ${ackNum} — nothing came back this run; the next sync starts here`, "warn", 94);
      note(summary, `appeal ${ackNum}: not fetched`);
      doneCount++; // reached, however badly — not one of the "never got to" count
      await t.time("pacing", () => jsleep(...PACE.betweenDocs));
      continue;
    }

    await t.time("ingest", () => ingestSyncMessage({
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
        /* What was wanted against what came. This is the record the next sync
           reads to decide whether to come back — and, until it does, the record
           the screen reads to say a document is outstanding rather than showing
           an appeal that looks complete because nothing contradicts it. */
        formPdfError, attachmentsExpected: expected, attachmentsMissing: missing,
        attachments,
      },
    }));
    summary.appeals = (summary.appeals || 0) + 1;
    doneCount++;

    const short = Boolean(formPdfError) || missing.length > 0;
    if (!short) {
      emit("appeals", `Filed appeal ${ackNum} — saved`, "info", 94);
    } else if (tries + 1 >= MAX_TRIES) {
      /* Asked for as many times as it is going to be. Said plainly, once,
         because from here on the app will stop trying and a practitioner who
         needs the document has to fetch it from the portal themselves. */
      const what = formPdfError ? "its PDF" : `${missing.length} attachment(s)`;
      emit("appeals", `Filed appeal ${ackNum} — saved, but ${what} could not be fetched after ${MAX_TRIES} tries`, "warn", 94);
      note(summary, `appeal ${ackNum}: ${what} unavailable`);
    } else {
      const what = [formPdfError ? "its PDF" : "", missing.length ? `${missing.length} attachment(s)` : ""].filter(Boolean).join(" and ");
      emit("appeals", `Filed appeal ${ackNum} — saved without ${what}; the next sync will try again`, "warn", 94);
      note(summary, `appeal ${ackNum}: ${what} still to fetch`);
    }
    await t.time("pacing", () => jsleep(...PACE.betweenDocs));
  }
}

module.exports = { syncAppealForms, MAX_TRIES };
