// Portal JSON API — Playwright port of the direct-call helpers in
// extension/portal-net.js.
//
// KEY INSIGHT (from portal-net.js): the portal's "sn" header is NOT a secret
// token — it is just the serviceName echoed verbatim. The real authorisation is
// the session cookie. So once the context is logged in we can call any service
// directly with `sn: <serviceName>` + the session cookie — no token capture, no
// UI navigation, no MAIN-world probe.
//
// We run these calls with page.evaluate so they use the page's OWN fetch: same
// origin, same cookies, same Origin/Referer the portal expects — identical to
// what the extension did in-page.
//
// EVERY CALL IN HERE HAS A DEADLINE, and that is not decoration. A browser
// `fetch` waits for ever by default, and `page.evaluate` waits for whatever it
// is given, so a portal that accepted a request for a document and then stopped
// sending it used to hang the PAN — and with it a pool slot — until the app was
// killed. That is the "it gets stuck and nothing happens" this file is written
// against. Each helper now aborts in the page, is raced against a slightly
// longer deadline in Node in case the page itself is the thing that has stopped
// answering, and is retried once before it gives up. See TIMEOUTS in config.js.
"use strict";

const { jsleep } = require("./pacing");
const { TIMEOUTS } = require("./config");

// API paths + form header, from observed portal traffic (portal-login.js).
const PATHS = {
  GET_ENTITY: "/iec/returnservicesapi/auth/getEntity",
  SAVE_ENTITY: "/iec/returnservicesapi/auth/saveEntity",
  SERVICES_SAVE: "/iec/servicesapi/auth/saveEntity",
  SERVICES_GET: "/iec/servicesapi/auth/getEntity",
  ITF_INVOKE: "/iec/itfweb/auth/invoke", // filed-form data
  PDFWEB: "/iec/pdfweb/pdf", // renders a filed form to PDF
  DOC_BASE: "/iec/document/",

  // ---- Filed returns (the "View Filed Returns" page) ---------------------
  // One call returns EVERY assessment year's return with its full CPC activity
  // timeline, so there is no per-AY list call to make.
  ITR_STATUS: "/iec/servicesapi/auth/getEntity", // sn: itrStatusService
  ITR_DOWNLOAD_FILE: "/iec/itrweb/auth/v0.1/returns/downloadfile", // the ITR JSON
  ITR_PDF: "/iec/itrweb/auth/v0.1/returns/pdf", // ITR-V / acknowledgement
  ITR_PREVIEW: "/iec/itrweb/auth/v0.1/returns/preview/", // + AY — the full form
  DOC_INTIMATION: "/iec/document/intimation", // 143(1) / 154 order PDF
};
const FORM = { formName: "FO-041_PCDNG" };
const ITR_FORM = { formName: "FO-006-ITRST" }; // the filed-returns page's own form id

/* Run one in-page fetch under a deadline, twice if it needs it.
 *
 * The page's own AbortSignal is the real mechanism: it cancels the request AND
 * the body it was part-way through reading, which is what a stalled document
 * download actually is. The Node-side race is the backstop for the case the
 * signal cannot help with — the renderer process itself wedged, or the context
 * torn down under us (which is exactly what Skip and Stop do) — so a caller can
 * never be left awaiting a promise that will not settle.
 *
 * Returns the same `{ ok:false, … }` shape the in-page helpers already return
 * on a network error, plus `timedOut:true`. No caller has to learn anything
 * new: every one of them already handles a call that did not come back. */
async function withDeadline(page, fn, arg, ms, what) {
  for (let attempt = 0; ; attempt++) {
    const res = await once(page, fn, arg, ms, what);
    if (res && res.ok) return res;
    // A context somebody closed on purpose (Skip, Stop, the per-PAN deadline)
    // is not a portal problem and will not answer on the second attempt either.
    if (res && res.closed) return res;
    /* Otherwise retry only what a retry can fix: a stall, a network drop, or the
       portal falling over (5xx / 429). A 400 or a 404 means the answer is "no",
       and asking twice is a second portal round trip for the same no. */
    const worthRetrying = Boolean(res) && (res.timedOut || res.error || res.status >= 500 || res.status === 429);
    if (!worthRetrying || attempt >= TIMEOUTS.retries) return res;
    console.warn(`[portal] ${what} ${res.timedOut ? `timed out after ${Math.round(ms / 1000)}s` : `failed (${res.status || res.error})`} — retrying once`);
    await jsleep(TIMEOUTS.retryPause.min, TIMEOUTS.retryPause.max);
  }
}

function once(page, fn, arg, ms, what) {
  let timer = null;
  // Given a few seconds' grace over the in-page signal, so a request that
  // aborts cleanly reports what actually happened rather than losing the race
  // to its own backstop.
  const backstop = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, timedOut: true, error: `${what} did not answer within ${Math.round(ms / 1000)}s` }), ms + 8000);
  });
  return Promise.race([
    page.evaluate(fn, { ...arg, timeoutMs: ms }).catch((err) => {
      // A closed context (Skip, Stop, or the per-PAN deadline) lands here.
      const msg = String((err && err.message) || err);
      return { ok: false, error: msg, closed: /closed|crashed|destroyed/i.test(msg) };
    }),
    backstop,
  ]).finally(() => clearTimeout(timer));
}

/* The four `inPage…` bodies below run INSIDE the page: Playwright sends them
 * across as source, so nothing from this file's scope travels with them. That
 * is why the abort signal and the error shape are written out longhand in each
 * rather than shared — a helper referenced in there would be `undefined` by the
 * time it ran — and why they are written as expressions rather than
 * declarations, which is the form this file has always shipped across.
 *
 * `AbortSignal.timeout` covers the whole exchange — connection, headers and
 * body — so a document that starts arriving and then stops is aborted like any
 * other stall rather than counting as progress for ever. */

// One JSON API call. Port of portal-net.js apiCall().
//
// extraHeaders covers the handful of services that read a value from a header
// rather than the body (the ITR form preview wants `ackNum` up there).
function apiCall(page, { path, serviceName, method, payload, extraHeaders }) {
  return withDeadline(
    page, inPageApiCall,
    { path, serviceName, method, payload, extraHeaders },
    TIMEOUTS.api, serviceName || path
  );
}

const inPageApiCall = async ({ path, serviceName, method, payload, extraHeaders, timeoutMs }) => {
  const ORIGIN = window.location.origin;
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (serviceName) headers["sn"] = serviceName; // == serviceName, by design
  Object.assign(headers, extraHeaders || {});
  try {
    const resp = await fetch(ORIGIN + path, {
      method: method || "POST",
      credentials: "include",
      headers,
      body: payload != null ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { ok: resp.ok, status: resp.status, json, textSample: json ? null : (text || "").slice(0, 4000) };
  } catch (err) {
    const name = String((err && err.name) || "");
    return { ok: false, timedOut: name === "TimeoutError" || name === "AbortError", error: String((err && err.message) || err) };
  }
};

// Download a document (notice/order PDF) by id → base64 + filename. Port of
// portal-net.js getDoc().
function getDoc(page, { docId }) {
  return withDeadline(page, inPageGetDoc, { docId: String(docId), DOC_BASE: PATHS.DOC_BASE }, TIMEOUTS.doc, `document ${docId}`);
}

const inPageGetDoc = async ({ docId, DOC_BASE, timeoutMs }) => {
  const ORIGIN = window.location.origin;
  try {
    const resp = await fetch(ORIGIN + DOC_BASE + encodeURIComponent(docId), {
      method: "GET",
      credentials: "include",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return { ok: false, status: resp.status };
    const cd = resp.headers.get("content-disposition") || "";
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
    const filename = m ? decodeURIComponent(m[1]).replace(/\.gz$/i, "") : docId + ".pdf";
    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = "";
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return {
      ok: true,
      status: resp.status,
      base64: btoa(bin),
      filename,
      contentType: resp.headers.get("content-type") || "application/pdf",
      bytes: bytes.length,
    };
  } catch (err) {
    const name = String((err && err.name) || "");
    return { ok: false, timedOut: name === "TimeoutError" || name === "AbortError", error: String((err && err.message) || err) };
  }
};

// POST a JSON body to a service that streams back a binary (PDF), e.g. pdfweb
// which renders a filed form. Returns base64 like getDoc, or an error/notPdf.
// Port of portal-net.js postDoc().
function postDoc(page, { path, serviceName, payload }) {
  return withDeadline(page, inPagePostDoc, { path, serviceName, payload }, TIMEOUTS.binary, serviceName || path);
}

const inPagePostDoc = async ({ path, serviceName, payload, timeoutMs }) => {
  const ORIGIN = window.location.origin;
  const headers = { "Content-Type": "application/json", Accept: "application/pdf" };
  if (serviceName) headers["sn"] = serviceName;
  try {
    const resp = await fetch(ORIGIN + path, {
      method: "POST",
      credentials: "include",
      headers,
      body: payload != null ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      let t = ""; try { t = await resp.text(); } catch { /* noop */ }
      return { ok: false, status: resp.status, text: (t || "").slice(0, 300) };
    }
    const ct = resp.headers.get("content-type") || "";
    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);
    // An error usually comes back as JSON, not a PDF — surface it as such.
    if (/json|text/i.test(ct)) {
      const txt = new TextDecoder().decode(bytes);
      let json = null; try { json = JSON.parse(txt); } catch { /* noop */ }
      return { ok: false, status: resp.status, json, notPdf: true, text: (txt || "").slice(0, 300) };
    }
    let bin = "";
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return { ok: true, status: resp.status, base64: btoa(bin), contentType: ct || "application/pdf", bytes: bytes.length };
  } catch (err) {
    const name = String((err && err.name) || "");
    return { ok: false, timedOut: name === "TimeoutError" || name === "AbortError", error: String((err && err.message) || err) };
  }
};

// POST a JSON body and pull a PDF out of whatever comes back.
//
// The filed-returns endpoints are not consistent about how they hand over a
// document. /iec/document/intimation streams a genuine `application/pdf`, but
// /returns/pdf and /returns/preview/{ay} return a Java-serialised
// `Object[]{HashMap<headers>, byte[]}` envelope — mislabelled
// `Content-Type: application/json`, with the PDF sitting raw inside it.
//
// Rather than parse Java's serialisation format, we scan the bytes for the PDF
// itself: `%PDF-` to the final `%%EOF`. That works for both shapes and for the
// envelope changing under us, which it eventually will.
//
// Returns { ok, base64, bytes } or { ok:false, status, json|text } — a portal
// error comes back as real JSON with no `%PDF-` anywhere in it, so the absence
// of the marker is exactly how we tell failure from success.
function postBinary(page, { path, serviceName, payload, extraHeaders }) {
  return withDeadline(page, inPagePostBinary, { path, serviceName, payload, extraHeaders }, TIMEOUTS.binary, serviceName || path);
}

const inPagePostBinary = async ({ path, serviceName, payload, extraHeaders, timeoutMs }) => {
  const ORIGIN = window.location.origin;
  const headers = { "Content-Type": "application/json", Accept: "application/pdf" };
  if (serviceName) headers["sn"] = serviceName;
  Object.assign(headers, extraHeaders || {});
  try {
    const resp = await fetch(ORIGIN + path, {
      method: "POST",
      credentials: "include",
      headers,
      body: payload != null ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const bytes = new Uint8Array(await resp.arrayBuffer());

    // Locate "%PDF-" without decoding the whole buffer as text — these can
    // be 11 MB and a TextDecoder pass over that is pure waste.
    const MARK = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
    let start = -1;
    for (let i = 0; i + MARK.length <= bytes.length; i++) {
      let hit = true;
      for (let j = 0; j < MARK.length; j++) if (bytes[i + j] !== MARK[j]) { hit = false; break; }
      if (hit) { start = i; break; }
    }
    if (start < 0) {
      // No PDF in there — so it really is an error payload. Surface it.
      const txt = new TextDecoder().decode(bytes.subarray(0, 4000));
      let json = null; try { json = JSON.parse(txt); } catch { /* not json */ }
      return { ok: false, status: resp.status, json, text: json ? null : txt.slice(0, 300) };
    }

    // Trim anything the envelope appended after the last %%EOF.
    const EOF = [0x25, 0x25, 0x45, 0x4f, 0x46]; // %%EOF
    let end = bytes.length;
    for (let i = bytes.length - EOF.length; i >= start; i--) {
      let hit = true;
      for (let j = 0; j < EOF.length; j++) if (bytes[i + j] !== EOF[j]) { hit = false; break; }
      if (hit) { end = i + EOF.length; break; }
    }

    const pdf = bytes.subarray(start, end);
    let bin = "";
    const CH = 0x8000;
    for (let i = 0; i < pdf.length; i += CH) bin += String.fromCharCode.apply(null, pdf.subarray(i, i + CH));
    return { ok: true, status: resp.status, base64: btoa(bin), contentType: "application/pdf", bytes: pdf.length };
  } catch (err) {
    const name = String((err && err.name) || "");
    return { ok: false, timedOut: name === "TimeoutError" || name === "AbortError", error: String((err && err.message) || err) };
  }
};

// The paginated e-Proceedings list for one status flag. Port of
// portal-net.js fetchProceedings().
function proceedings(page, { pan, statusFlag, pageSize, pageNo }) {
  return apiCall(page, {
    path: PATHS.GET_ENTITY,
    serviceName: "eProceedingsPaginatedService",
    payload: {
      serviceName: "eProceedingsPaginatedService",
      pan: String(pan || "").toUpperCase(),
      prcdngStatusFlag: statusFlag || "FYA",
      prcdngTypeFlag: "self",
      pageConfig: { pageSize: pageSize || 100, pageNo: pageNo || 1, searchTerm: "", sortBy: "createdDt", sortAsc: false, filters: {} },
      header: FORM,
    },
  });
}

/* EVERY document behind one "Notice/Letter pdf" screen.
 *
 * THIS IS THE BUG THIS MODULE EXISTED WITH. The noticeletterpdf response names
 * ONE document at the top level — `satDocId` + `docNam` — and then lists the
 * WHOLE set under `docMap`, keyed by satDocId:
 *
 *   satDocId: 442426058,
 *   docNam:  "…_AST_APPROVAL TO JAO.pdf.gz",
 *   docMap: {
 *     "442426058": "…_AST_APPROVAL TO JAO.pdf.gz",
 *     "442426042": "…_AST_SET NOTE APPROVAL.pdf.gz",
 *     "442426059": "…_AST_AXIPP8954H_Notice us 148_….pdf.gz",
 *     "442426040": "…_AST_AXIPP8954H_Print Approval Search_….pdf.gz"
 *   }
 *
 * `docMap` is what the portal's own screen renders — four Download buttons. We
 * read `satDocId` and stopped, so three of the four never left the portal, and
 * on this notice the one we DID take was the internal approval rather than the
 * s.148 notice the assessee has to answer.
 *
 * Sorted by satDocId ascending, which is the order the portal lists them in
 * (the docMap's own key order is not it). Stable, so a re-sync numbers the same
 * document the same way. */
function noticeDocuments(json) {
  const named = new Map();
  const add = (id, nam) => {
    const key = String(id == null ? "" : id).trim();
    if (!key || !/^\d+$/.test(key)) return;
    if (!named.has(key) || (nam && !named.get(key))) named.set(key, String(nam || ""));
  };
  const map = json && json.docMap;
  if (map && typeof map === "object" && !Array.isArray(map)) {
    for (const [id, nam] of Object.entries(map)) add(id, nam);
  }
  // The top-level pair, for the (older, single-document) responses with no map.
  if (json) add(json.satDocId, json.docNam);
  return [...named.entries()]
    .map(([satDocId, docNam]) => ({ satDocId, docNam }))
    .sort((a, b) => Number(a.satDocId) - Number(b.satDocId));
}

/* Which of them is THE notice.
 *
 * It matters: the primary is what the "PDF" button saves, what the summary is
 * read from, and what the appeal detection parses. The portal's own `satDocId`
 * is NOT a reliable answer — on the s.148 set above it points at an 11 MB
 * "APPROVAL TO JAO" while the notice sits three files away — so the set is
 * scored on what the files are CALLED, and the portal's pick is kept only as
 * the tie-break. Everything not chosen is still fetched; this decides billing
 * of attention, not what gets downloaded.
 *
 * Returns an index into `docs`. */
function pickPrimaryDocument(docs, { section, declaredSatDocId } = {}) {
  if (!docs.length) return -1;
  const fallback = Math.max(0, docs.findIndex((d) => String(d.satDocId) === String(declaredSatDocId || "")));
  if (docs.length === 1) return 0;
  // "143(2)" → 143. The filename writes it as "Notice us 143(2)" or "u_s 143",
  // so the bare number is the part worth matching.
  const sec = (String(section || "").match(/\d+/) || [])[0];
  const secRe = sec ? new RegExp(`(^|\\D)${sec}(\\D|$)`) : null;
  const score = (d) => {
    const n = String(d.docNam || "").toLowerCase();
    let s = 0;
    if (secRe && secRe.test(n)) s += 4;
    if (/\bnotice\b|\bletter\b|\bintimation\b|\bquestionnaire\b/.test(n)) s += 3;
    // The paperwork the department attaches to a notice, never the notice.
    if (/approval|set note|search|annexure|enclosure/.test(n)) s -= 3;
    return s;
  };
  let best = fallback;
  let bestScore = score(docs[fallback]);
  docs.forEach((d, i) => {
    const s = score(d);
    if (s > bestScore) { best = i; bestScore = s; }
  });
  return best;
}

module.exports = {
  PATHS, FORM, ITR_FORM,
  apiCall, getDoc, postDoc, postBinary, proceedings,
  noticeDocuments, pickPrimaryDocument,
};
