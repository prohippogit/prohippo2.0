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
