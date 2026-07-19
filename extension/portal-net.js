/*
 * ProHippo Sync — portal network probe.  (prototype for approach "a")
 *
 * WHY THIS EXISTS
 * ---------------
 * Approach (a) = fetch the e-Proceedings data by calling the portal's OWN JSON
 * API instead of scraping the rendered Angular screen. The screen is slow (you
 * wait for it to draw) and fragile (selectors break on every UI tweak); the
 * API returns clean structured data in one shot.
 *
 * The catch: we don't know the exact API URL up front, and it may need an auth
 * token the portal keeps in memory. So instead of guessing, this script runs in
 * the PAGE's own world (manifest `world: "MAIN"`) and simply WATCHES the calls
 * the portal already makes to itself. When the user opens e-Proceedings once,
 * the portal fetches the proceedings list — we capture that call (URL, method,
 * body, auth headers) and can then REPLAY it directly, as many times as we like,
 * with no screen rendering in the loop. That replay is the "call the JSON API"
 * fast path, and we time it so you get a real per-PAN number.
 *
 * SECURITY NOTE
 * -------------
 * Captured auth headers (e.g. a bearer token) NEVER leave this MAIN-world
 * script. We hand the content script only a sanitized descriptor (url, method,
 * a flag, a timestamp). When the content script asks us to fetch, we replay the
 * request here using the stored headers and post back only the resulting data.
 * The token is not written to postMessage, storage, or the DOM.
 */
(function () {
  if (window.__prohippoNetInstalled) return;
  window.__prohippoNetInstalled = true;

  const ORIGIN = window.location.origin;
  const MAX_STORE = 40; // cap memory: keep only the most recent captures
  const SAMPLE_LEN = 4000; // chars of response peeked at, just to classify it

  // Full captures (with headers/body) live ONLY here in the page world.
  /** @type {Array<{id:string,url:string,method:string,body:any,headers:Object,looksLikeProceedings:boolean,at:number}>} */
  const store = [];
  let seq = 0;

  // The session token ("sn" header) and PAN, learned from the dashboard's own
  // authenticated API calls. These let us call the e-Proceedings API directly,
  // without navigating the UI. The token stays in this page-world script.
  let lastAuth = null;   // { headers } from a captured call carrying an "sn" header
  let sessionPan = null; // PAN seen in a captured request payload
  const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/i;
  // Portal API endpoints, from observed traffic.
  const GET_ENTITY_PATH = "/iec/returnservicesapi/auth/getEntity";
  const DOC_BASE = "/iec/document/";
  const FORM = { formName: "FO-041_PCDNG" };

  const isPortalApi = (url) => {
    try {
      const u = new URL(url, ORIGIN);
      // Same-origin only: the real e-Proceedings API is served from the app's
      // own origin (eportal.*). This deliberately skips static.incometax.gov.in
      // — its i18n translation JSON contains UI label strings like "Proceeding
      // Name", so it was being mis-detected as the proceedings list, and
      // replaying that cross-origin with credentials trips a CORS failure.
      if (u.origin !== ORIGIN) return false;
      if (/\/(assets|i18n|static)\//i.test(u.pathname)) return false;
      return !/\.(js|css|png|jpg|jpeg|svg|woff2?|ttf|ico|map|json)(\?|$)/i.test(u.pathname);
    } catch { return false; }
  };

  // Heuristic: does this URL or response look like the e-Proceedings list?
  const urlHint = (url) => /proceed|eproceeding|notice|worklist|pendingaction|itba/i.test(url);
  const bodyHint = (text) => {
    if (!text) return false;
    return /proceedingName|assessmentYear|financialYear|noticeOrOrder|proceedingRequestId|assesseeName|applicableAct/i.test(text);
  };

  function record(url, method, reqHeaders, reqBody, sampleText) {
    if (!isPortalApi(url)) return;
    const looks = urlHint(url) || bodyHint(sampleText);
    // Keep everything from the API host (so we can show candidates), but flag
    // the ones that look like proceedings so the content script can pick fast.
    const entry = {
      id: "cap" + (++seq),
      url: String(url),
      method: (method || "GET").toUpperCase(),
      body: reqBody != null ? reqBody : null,
      headers: reqHeaders || {},
      looksLikeProceedings: looks,
      at: Date.now(),
    };
    store.push(entry);
    while (store.length > MAX_STORE) store.shift();
    // Tell the content script (sanitized — no headers, no body).
    post("capture", {
      entry: { id: entry.id, url: entry.url, method: entry.method, looksLikeProceedings: looks, at: entry.at },
    });

    // Learn the session token + PAN so we can hit the e-Proceedings API
    // directly. The "sn" token is PER-SERVICE, so we must reuse the one that
    // belongs to the e-Proceedings service (formName FO-041_PCDNG) — replaying
    // another service's token against getEntity fails. The dashboard's
    // proceeding/metadata call (fired on load to show pending-action counts)
    // carries exactly this token. Keep the token here; tell the content script
    // only that auth is ready (+ the non-secret PAN).
    const hasSn = Object.keys(reqHeaders || {}).some((k) => k.toLowerCase() === "sn");
    let isProc = /proceeding\/metadata/i.test(url);
    let body = null;
    if (reqBody != null) { try { body = typeof reqBody === "string" ? JSON.parse(reqBody) : reqBody; } catch { /* not json */ } }
    if (body) {
      if (typeof body.pan === "string" && PAN_RE.test(body.pan)) sessionPan = body.pan.toUpperCase();
      if (body.serviceName === "eProceedingsPaginatedService" || (body.header && body.header.formName === "FO-041_PCDNG")) isProc = true;
    }
    if (hasSn && isProc) lastAuth = { headers: reqHeaders };
    if (lastAuth || sessionPan) post("auth", { hasSn: !!lastAuth, pan: sessionPan });
  }

  function post(kind, extra) {
    try { window.postMessage(Object.assign({ __prohippoNet: true, kind }, extra), ORIGIN); } catch { /* noop */ }
  }

  /* ---------- hook fetch() ---------- */
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      let url = "", method = "GET", headers = {}, body = null;
      try {
        url = typeof input === "string" ? input : (input && input.url) || "";
        method = (init && init.method) || (input && input.method) || "GET";
        headers = headersToObject((init && init.headers) || (input && input.headers));
        body = (init && init.body) || null;
      } catch { /* noop */ }
      const p = origFetch.apply(this, arguments);
      if (isPortalApi(url)) {
        p.then((resp) => {
          try {
            resp.clone().text().then((t) => record(url, method, headers, body, (t || "").slice(0, SAMPLE_LEN)),
                                     () => record(url, method, headers, body, ""));
          } catch { record(url, method, headers, body, ""); }
        }).catch(() => { /* noop */ });
      }
      return p;
    };
  }

  /* ---------- hook XMLHttpRequest ---------- */
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    const origSetHeader = XHR.prototype.setRequestHeader;
    XHR.prototype.open = function (method, url) {
      this.__pp = { method, url, headers: {} };
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.setRequestHeader = function (name, value) {
      try { if (this.__pp) this.__pp.headers[name] = value; } catch { /* noop */ }
      return origSetHeader.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      const meta = this.__pp;
      if (meta && isPortalApi(meta.url)) {
        this.addEventListener("readystatechange", () => {
          if (this.readyState === 4) {
            let sample = "";
            try { if (this.responseType === "" || this.responseType === "text") sample = (this.responseText || "").slice(0, SAMPLE_LEN); } catch { /* noop */ }
            record(meta.url, meta.method, meta.headers, body != null ? body : null, sample);
          }
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  /* ---------- replay on request from the content script ---------- */
  window.addEventListener("message", async (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__prohippoNet !== true || d.kind !== "fetch") return;
    const { id, capId } = d;
    const cap = store.find((c) => c.id === capId) || store.filter((c) => c.looksLikeProceedings).slice(-1)[0];
    if (!cap) { post("fetchResult", { id, result: { ok: false, error: "no captured endpoint" } }); return; }
    const t0 = performance.now();
    try {
      const headers = replayHeaders(cap.headers);
      const init = { method: cap.method, credentials: "include", headers };
      if (cap.method !== "GET" && cap.method !== "HEAD" && cap.body != null) init.body = cap.body;
      const resp = await origFetch.call(window, cap.url, init);
      const ms = Math.round(performance.now() - t0);
      const text = await resp.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      post("fetchResult", {
        id,
        result: {
          ok: resp.ok, status: resp.status, ms,
          url: cap.url, method: cap.method,
          json, textSample: json ? null : (text || "").slice(0, SAMPLE_LEN),
        },
      });
    } catch (err) {
      post("fetchResult", { id, result: { ok: false, error: String(err && err.message || err), ms: Math.round(performance.now() - t0) } });
    }
  });

  /* ---------- approach (a): call the portal API directly ----------
   * KEY INSIGHT: the portal's "sn" header is not a secret token — it is simply
   * the serviceName echoed verbatim (char-for-char). The real authorisation is
   * the session cookie. So we can call any service directly with
   * `sn: <serviceName>` + credentials, with no UI navigation or token capture.
   */
  async function apiCall(opts) {
    const { path, serviceName, method, payload } = opts;
    const headers = { "Content-Type": "application/json", "Accept": "application/json" };
    if (serviceName) headers["sn"] = serviceName; // == serviceName, by design
    const t0 = performance.now();
    try {
      const resp = await origFetch.call(window, ORIGIN + (path || GET_ENTITY_PATH), {
        method: method || "POST", credentials: "include", headers,
        body: payload != null ? JSON.stringify(payload) : undefined,
      });
      const ms = Math.round(performance.now() - t0);
      const text = await resp.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { ok: resp.ok, status: resp.status, ms, json, textSample: json ? null : (text || "").slice(0, SAMPLE_LEN) };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err), ms: Math.round(performance.now() - t0) };
    }
  }

  // Download a document (notice/order PDF) by its id → base64 + filename.
  async function getDoc(opts) {
    const t0 = performance.now();
    try {
      const resp = await origFetch.call(window, ORIGIN + DOC_BASE + encodeURIComponent(opts.docId), { method: "GET", credentials: "include" });
      const ms = Math.round(performance.now() - t0);
      if (!resp.ok) return { ok: false, status: resp.status, ms };
      const cd = resp.headers.get("content-disposition") || "";
      const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
      const filename = m ? decodeURIComponent(m[1]).replace(/\.gz$/i, "") : (opts.docId + ".pdf");
      const buf = await resp.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = ""; const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      return { ok: true, status: resp.status, ms, base64: btoa(bin), filename, contentType: resp.headers.get("content-type") || "application/pdf", bytes: bytes.length };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err), ms: Math.round(performance.now() - t0) };
    }
  }

  // POST a JSON body to a service that streams back a binary (PDF), e.g.
  // pdfweb/pdf which renders a filed form. Returns base64 like getDoc.
  async function postDoc(opts) {
    const t0 = performance.now();
    try {
      const headers = { "Content-Type": "application/json", "Accept": "application/pdf" };
      if (opts.serviceName) headers["sn"] = opts.serviceName;
      const resp = await origFetch.call(window, ORIGIN + opts.path, {
        method: "POST", credentials: "include", headers,
        body: opts.payload != null ? JSON.stringify(opts.payload) : undefined,
      });
      const ms = Math.round(performance.now() - t0);
      if (!resp.ok) { let t = ""; try { t = await resp.text(); } catch { /* noop */ } return { ok: false, status: resp.status, ms, text: (t || "").slice(0, 300) }; }
      const ct = resp.headers.get("content-type") || "";
      const buf = await resp.arrayBuffer();
      const bytes = new Uint8Array(buf);
      // An error usually comes back as JSON, not a PDF — surface it as such.
      if (/json|text/i.test(ct)) { const txt = new TextDecoder().decode(bytes); let json = null; try { json = JSON.parse(txt); } catch { /* noop */ } return { ok: false, status: resp.status, ms, json, notPdf: true, text: (txt || "").slice(0, 300) }; }
      let bin = ""; const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      return { ok: true, status: resp.status, ms, base64: btoa(bin), contentType: ct || "application/pdf", bytes: bytes.length };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err), ms: Math.round(performance.now() - t0) };
    }
  }

  // Convenience: the paginated e-Proceedings list for one status flag.
  function fetchProceedings(opts) {
    const pan = String(opts.pan || "").toUpperCase();
    if (!PAN_RE.test(pan)) return Promise.resolve({ ok: false, error: "no valid PAN" });
    return apiCall({
      path: GET_ENTITY_PATH, serviceName: "eProceedingsPaginatedService",
      payload: {
        serviceName: "eProceedingsPaginatedService", pan,
        prcdngStatusFlag: opts.statusFlag || "FYA", prcdngTypeFlag: "self",
        pageConfig: { pageSize: opts.pageSize || 100, pageNo: opts.pageNo || 1, searchTerm: "", sortBy: "createdDt", sortAsc: false, filters: {} },
        header: FORM,
      },
    });
  }

  window.addEventListener("message", async (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__prohippoNet !== true) return;
    let result;
    if (d.kind === "proceedings") result = await fetchProceedings(d);
    else if (d.kind === "apicall") result = await apiCall(d);
    else if (d.kind === "getdoc") result = await getDoc(d);
    else if (d.kind === "postdoc") result = await postDoc(d);
    else return;
    post("fetchResult", { id: d.id, result });
  });

  /* ---------- helpers ---------- */
  function headersToObject(h) {
    const out = {};
    try {
      if (!h) return out;
      if (typeof Headers !== "undefined" && h instanceof Headers) { h.forEach((v, k) => { out[k] = v; }); return out; }
      if (Array.isArray(h)) { for (const [k, v] of h) out[k] = v; return out; }
      if (typeof h === "object") return Object.assign({}, h);
    } catch { /* noop */ }
    return out;
  }
  // Browser sets these itself; re-sending them is forbidden or wrong on replay.
  const FORBIDDEN = /^(cookie|host|content-length|connection|accept-encoding|origin|referer|user-agent)$/i;
  function replayHeaders(h) {
    const out = {};
    for (const k of Object.keys(h || {})) if (!FORBIDDEN.test(k)) out[k] = h[k];
    return out;
  }

  post("ready", { origin: ORIGIN });
})();
