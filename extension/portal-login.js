/*
 * ProHippo Sync — Income-tax portal auto-login.  (badge shows build tag)
 *
 * Asks the background worker for a credential stashed for THIS tab. If none,
 * does nothing. Otherwise fills the multi-step Angular login:
 *   User ID -> Continue  [-> secure-access confirm -> Continue]  -> Password -> Continue
 *
 * IMPORTANT: we poll on a gentle timer only. An earlier version also used a
 * MutationObserver over the whole page; because filling a field / clicking
 * mutates the DOM, that re-triggered the observer in a tight loop and froze
 * the portal ("Page Unresponsive"). Timer-only polling avoids that entirely.
 */
(function () {
  const BUILD = "v17";
  const INTERVAL_MS = 1000;

  /* ---------- approach (a): talk to the MAIN-world network probe ----------
   * portal-net.js watches the calls the portal makes to itself and can replay
   * the e-Proceedings data call directly. Here we (1) collect the sanitized
   * capture descriptors it broadcasts, and (2) ask it to replay + time a call.
   */
  const NET = (() => {
    const caps = [];
    let authReady = false;   // MAIN-world probe has captured the session token
    let sessionPan = null;   // PAN learned from the portal's own API traffic
    if (typeof window !== "undefined") {
      window.addEventListener("message", (e) => {
        if (e.source !== window) return;
        const d = e.data;
        if (!d || d.__prohippoNet !== true) return;
        if (d.kind === "capture" && d.entry) caps.push(d.entry);
        if (d.kind === "auth") { if (d.hasSn) authReady = true; if (d.pan) sessionPan = d.pan; }
      });
    }
    // Resolve once the probe reports it has captured the session token.
    const waitAuth = (timeoutMs = 15000) => new Promise((resolve) => {
      if (authReady) return resolve(true);
      const start = Date.now();
      const t = setInterval(() => {
        if (authReady) { clearInterval(t); resolve(true); }
        else if (Date.now() - start > timeoutMs) { clearInterval(t); resolve(false); }
      }, 400);
    });
    const pan = () => sessionPan;
    // Ask the probe to call the e-Proceedings API directly for one status flag.
    const proceedings = (opts, timeoutMs = 20000) => new Promise((resolve) => {
      const id = "pr-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      const onMsg = (e) => {
        if (e.source !== window) return;
        const d = e.data;
        if (!d || d.__prohippoNet !== true || d.kind !== "fetchResult" || d.id !== id) return;
        window.removeEventListener("message", onMsg);
        resolve(d.result || { ok: false, error: "empty result" });
      };
      window.addEventListener("message", onMsg);
      window.postMessage(Object.assign({ __prohippoNet: true, kind: "proceedings", id }, opts), window.location.origin);
      setTimeout(() => { window.removeEventListener("message", onMsg); resolve({ ok: false, error: "timeout" }); }, timeoutMs);
    });
    // The most recent capture that looks like the proceedings list, if any.
    const bestProceedingId = () => {
      const hits = caps.filter((c) => c.looksLikeProceedings).sort((a, b) => b.at - a.at);
      return hits[0] ? hits[0].id : null;
    };
    // Ask the probe to replay a captured call; resolves with { ok, ms, json, ... }.
    const apiFetch = (capId, timeoutMs = 20000) => new Promise((resolve) => {
      const id = "af-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      const onMsg = (e) => {
        if (e.source !== window) return;
        const d = e.data;
        if (!d || d.__prohippoNet !== true || d.kind !== "fetchResult" || d.id !== id) return;
        window.removeEventListener("message", onMsg);
        resolve(d.result || { ok: false, error: "empty result" });
      };
      window.addEventListener("message", onMsg);
      window.postMessage({ __prohippoNet: true, kind: "fetch", id, capId }, window.location.origin);
      setTimeout(() => { window.removeEventListener("message", onMsg); resolve({ ok: false, error: "timeout" }); }, timeoutMs);
    });
    // Generic direct API call / document download via the MAIN-world probe.
    const send = (msg, timeoutMs = 30000) => new Promise((resolve) => {
      const id = "nx-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      const onMsg = (e) => {
        if (e.source !== window) return;
        const d = e.data;
        if (!d || d.__prohippoNet !== true || d.kind !== "fetchResult" || d.id !== id) return;
        window.removeEventListener("message", onMsg);
        resolve(d.result || { ok: false, error: "empty result" });
      };
      window.addEventListener("message", onMsg);
      window.postMessage(Object.assign({ __prohippoNet: true, id }, msg), window.location.origin);
      setTimeout(() => { window.removeEventListener("message", onMsg); resolve({ ok: false, error: "timeout" }); }, timeoutMs);
    });
    const apiCall = (opts) => send(Object.assign({ kind: "apicall" }, opts));
    const getDoc = (opts) => send(Object.assign({ kind: "getdoc" }, opts), 45000);

    return { caps, bestProceedingId, apiFetch, waitAuth, pan, proceedings, apiCall, getDoc };
  })();

  // Portal API endpoints + form, mirrored from portal-net.js.
  const GET_ENTITY_PATH = "/iec/returnservicesapi/auth/getEntity";
  const SAVE_ENTITY_PATH = "/iec/returnservicesapi/auth/saveEntity";
  const FORM = { formName: "FO-041_PCDNG" };

  chrome.runtime.sendMessage({ type: "GET_PORTAL_CREDS" }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok || !resp.creds) return; // not our tab
    run(resp.creds);
  });

  function onLoginScreen() {
    return /\/login/i.test(location.href) || /\/login/i.test(location.hash);
  }

  function run(creds) {
    const badge = makeBadge();
    const started = Date.now();
    let busy = false;
    let navigated = false;
    let sawPassword = false;
    let lastUid = "";
    let lastPwd = "";
    let retriedLogin = false; // allow one auto-retry after a session-expiry bounce
    log("started");

    const finish = (ok, msg) => {
      clearInterval(timer);
      badge.set(msg || (ok ? "Logged in — opening e-Proceedings…" : "Couldn't finish — please continue manually."), !ok);
      setTimeout(() => badge.remove(), ok ? 4000 : 10000);
    };

    const tick = () => {
      if (busy || navigated) return;
      busy = true;
      try {
        if (Date.now() - started > 90000) { finish(false); return; }

        // The portal allows only ONE active session per PAN. If it finds an
        // existing one it shows a "Dual Login Detected" dialog — click
        // "Login Here" to take the session over and keep authenticating here.
        if (handleDualLogin()) { badge.set("Dual login — taking over the existing session…"); return; }

        // If the portal bounced us to "Session has Expired", our login didn't
        // stick (usually a leftover session or idle timeout). Try the on-screen
        // "Login" link ONCE — the loop then re-fills the credentials. If it
        // expires again, stop and tell the user exactly what to fix.
        if (isSessionExpired()) {
          if (!retriedLogin && clickSessionExpiryLogin()) {
            retriedLogin = true; sawPassword = false; lastUid = ""; lastPwd = "";
            badge.set("Session expired — retrying login…", true);
            return;
          }
          finish(false, "Portal keeps ending the session. Log out of the Income-tax portal in every other tab, browser and device, then run the sync again.");
          return;
        }

        // Logged in once we leave the login screen. Do NOT change the URL to
        // jump to e-Proceedings — the portal treats Back/Forward/URL changes as
        // a blocked action and prompts logout. Navigate by clicking the menu.
        if (sawPassword && !onLoginScreen() && !isSessionExpired()) {
          navigated = true;
          clearInterval(timer);
          if (creds.mode === "sync") {
            beginSync(creds, badge).catch((e) => { log("sync error", e); badge.set("Sync failed — " + (e.message || e), true); });
          } else {
            finish(true, "Logged in ✓ — you're in the portal.");
          }
          return;
        }

        // Password step.
        const pwd = findPassword();
        if (pwd) {
          sawPassword = true;
          // Set the value at most once per rendered field (avoid event storms).
          if (lastPwd !== creds.portalPassword) { setValue(pwd, creds.portalPassword); lastPwd = creds.portalPassword; badge.set("Entered password…"); }
          tickConfirmCheckbox();
          const clicked = clickContinue();
          log("password step, clicked=", clicked);
          return;
        }

        // User ID step.
        const uid = findUserId();
        if (uid) {
          if (lastUid !== creds.portalUserId) { setValue(uid, creds.portalUserId); lastUid = creds.portalUserId; badge.set("Entered User ID…"); }
          const clicked = clickContinue();
          log("userid step, clicked=", clicked);
          return;
        }

        // Intermediate page (secure-access confirm) or still LOADING.
        if (onLoginScreen()) { tickConfirmCheckbox(); }
      } finally {
        busy = false;
      }
    };

    // Timer only — NO MutationObserver (that caused the freeze).
    const timer = setInterval(tick, INTERVAL_MS);
    setTimeout(tick, 1200); // first attempt after the SPA has a moment to render
  }

  /* ---------- detection ---------- */
  function isVisible(el) {
    if (!el || el.disabled) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.offsetParent !== null;
  }
  function findVisible(selector) {
    for (const el of document.querySelectorAll(selector)) if (isVisible(el)) return el;
    return null;
  }
  function findPassword() { return findVisible('input[type="password"]'); }
  function findUserId() {
    const guesses = [
      'input[formcontrolname*="userId" i]', 'input#userId', 'input[name*="userId" i]',
      'input[placeholder*="user id" i]', 'input[placeholder*="PAN" i]', 'input[placeholder*="Aadhaar" i]',
    ];
    for (const g of guesses) { const el = findVisible(g); if (el) return el; }
    for (const el of document.querySelectorAll("input")) {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (["text", "tel", "email", ""].includes(t) && isVisible(el)) return el;
    }
    return null;
  }
  // Tick the "confirm secure access message" checkbox. It's an Angular
  // Material checkbox whose real <input> is visually hidden (0x0), so we can't
  // require it to be "visible" — click the label / mat-checkbox wrapper that a
  // human would click, which lets Material update its form model.
  function tickConfirmCheckbox() {
    let acted = false;
    for (const chk of document.querySelectorAll('input[type="checkbox"]')) {
      if (chk.checked) continue;
      const wrap =
        chk.closest("mat-checkbox, .mat-checkbox, .mat-mdc-checkbox") ||
        (chk.id && document.querySelector('label[for="' + cssEscape(chk.id) + '"]')) ||
        chk.closest("label") ||
        chk.parentElement ||
        chk;
      realClick(wrap);
      if (!chk.checked) { try { chk.click(); } catch { /* noop */ } }
      if (!chk.checked) {
        chk.checked = true;
        chk.dispatchEvent(new Event("input", { bubbles: true }));
        chk.dispatchEvent(new Event("change", { bubbles: true }));
      }
      acted = true;
    }
    return acted;
  }
  function cssEscape(s) {
    return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }
  function clickContinue() {
    const btns = [...document.querySelectorAll('button, input[type="submit"], a[role="button"]')].filter(isVisible);
    const text = (x) => (x.textContent || x.value || "").trim();
    let b = btns.find((x) => /^\s*(continue|proceed)\b/i.test(text(x)));
    if (!b) b = btns.find((x) => /^(verify|submit)\b/i.test(text(x)));
    if (!b) b = btns.find((x) => x.type === "submit");
    if (!b) return false;
    if (b.disabled || b.getAttribute("aria-disabled") === "true") return false;
    realClick(b);
    return true;
  }

  /* ---------- session / dual-login handling ---------- */
  // The "Dual Login Detected" dialog offers a "Login Here" button that takes
  // over the existing session and continues authenticating in this tab.
  function handleDualLogin() {
    const btn = [...document.querySelectorAll("button, a")].filter(isVisible)
      .find((x) => /^login\s*here$/i.test((x.textContent || "").trim()));
    if (!btn || btn.disabled || btn.getAttribute("aria-disabled") === "true") return false;
    realClick(btn);
    return true;
  }
  function isSessionExpired() {
    return /sessionExpire/i.test(location.href) || /sessionExpire/i.test(location.hash) ||
           /session has expired/i.test(document.body.innerText || "");
  }
  // The "Session has Expired" screen shows a "Login" link back to the login page.
  function clickSessionExpiryLogin() {
    const link = [...document.querySelectorAll("a, button")].filter(isVisible)
      .find((x) => /^login$/i.test((x.textContent || "").trim()));
    if (!link) return false;
    realClick(link);
    return true;
  }
  // Navigating within the SPA (our hash route to e-Proceedings) trips the
  // portal's guard: "…disabled Back, Forward and Refresh… Are you sure you want
  // to Logout?". Auto-click "No" to stay logged in. The data is already fetched
  // by then, so this just clears the popup so the user needn't dismiss it.
  function dismissLogoutDialog() {
    if (!/want to logout|disabled back,?\s*forward/i.test(document.body.innerText || "")) return false;
    const btn = [...document.querySelectorAll("button, a")].filter(isVisible)
      .find((x) => /^(no|cancel)$/i.test((x.textContent || "").trim()));
    if (!btn) return false;
    realClick(btn);
    return true;
  }

  /* ---------- value + click ---------- */
  function setValue(el, value) {
    el.focus();
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }
  function realClick(el) {
    const o = { bubbles: true, cancelable: true, view: window };
    try { el.dispatchEvent(new PointerEvent("pointerdown", o)); } catch { /* noop */ }
    el.dispatchEvent(new MouseEvent("mousedown", o));
    try { el.dispatchEvent(new PointerEvent("pointerup", o)); } catch { /* noop */ }
    el.dispatchEvent(new MouseEvent("mouseup", o));
    el.dispatchEvent(new MouseEvent("click", o));
    el.click();
  }

  function log(...a) { try { console.log("[ProHippo " + BUILD + "]", ...a); } catch { /* noop */ } }

  /* ---------- Phase 2 step 1: sync the e-Proceedings list ---------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function waitFor(pred, timeout) {
    return new Promise((resolve) => {
      const start = Date.now();
      const t = setInterval(() => {
        let ok; try { ok = pred(); } catch { ok = false; }
        if (ok) { clearInterval(t); resolve(true); }
        else if (Date.now() - start > timeout) { clearInterval(t); resolve(false); }
      }, 500);
    });
  }
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Find a small, visible element whose text starts with one of the labels.
  function findByText(cands) {
    const els = [...document.querySelectorAll('a, button, span, li, [role="menuitem"], [routerlink]')].filter(isVisible);
    for (const c of cands) {
      const matches = els
        .filter((e) => { const t = (e.textContent || "").trim(); return t && t.length < 40 && new RegExp("^" + escapeRe(c) + "\\b", "i").test(t); })
        .sort((a, b) => a.textContent.trim().length - b.textContent.trim().length);
      if (matches[0]) return matches[0];
    }
    return null;
  }
  function clickByText(cands) { const el = findByText(cands); if (el) { realClick(el); return true; } return false; }
  // The e-Proceedings menu anchor exists in the DOM even when the dropdown is
  // closed; clicking it triggers Angular router navigation (no logout guard).
  function findEProceedingsLink() {
    const links = [...document.querySelectorAll("a")];
    const attr = (a, n) => (a.getAttribute(n) || "");
    return (
      links.find((a) => /eproceeding/i.test(attr(a, "href")) || /eproceeding/i.test(attr(a, "routerlink"))) ||
      links.find((a) => /e-?proceeding/i.test((a.textContent || "").trim()) && (a.textContent || "").trim().length < 40) ||
      null
    );
  }
  // Any small, visible element whose text contains "e-proceeding(s)". NOTE: we
  // match by CONTAINS, not a word-boundary — the menu label is "E-Proceedings"
  // (plural), and an earlier `\b` after "Proceeding" never matched the "s".
  function findEProceedingsItem() {
    const els = [...document.querySelectorAll('a, button, span, li, [role="menuitem"], [routerlink]')].filter(isVisible);
    return els
      .filter((e) => { const t = (e.textContent || "").trim(); return t && t.length < 40 && /e-?proceeding/i.test(t); })
      .sort((a, b) => a.textContent.trim().length - b.textContent.trim().length)[0] || null;
  }
  function openPendingActionsMenu() {
    const trig = findByText(["Pending Actions"]);
    if (!trig) return false;
    for (const t of ["pointerenter", "mouseenter", "mouseover", "mousedown", "mouseup", "click"]) {
      try { trig.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); } catch { /* noop */ }
    }
    return true;
  }
  function clickEProceedingsItem() {
    const el = findEProceedingsLink() || findEProceedingsItem();
    if (!el) return false;
    // Click the nearest actually-clickable ancestor (router link / menu item).
    const target = el.closest('a, [routerlink], [role="menuitem"], button, li') || el;
    realClick(target);
    return true;
  }
  const onEProceedings = () => /eProceedings/i.test(location.href);
  async function goToEProceedings() {
    if (onEProceedings()) return true;

    // Primary: navigate via the Angular hash route — the same URL the menu
    // click produces (#/dashboard/eProceedings). This is deterministic and
    // avoids the fragile dropdown click. It loads the e-Proceedings module,
    // which fires the portal's own proceedings API (handing us the token).
    try { location.hash = "#/dashboard/eProceedings"; } catch { /* noop */ }
    await waitFor(() => onEProceedings() || isSessionExpired(), 5000);
    if (onEProceedings()) { await sleep(900); return true; }
    if (isSessionExpired()) { log("hash nav bounced to sessionExpire"); return false; }

    // Fallback: open the Pending Actions menu and click the E-Proceedings item.
    for (let attempt = 0; attempt < 3; attempt++) {
      openPendingActionsMenu();
      await waitFor(() => !!findEProceedingsLink() || !!findEProceedingsItem(), 5000);
      if (clickEProceedingsItem()) {
        await sleep(1600);
        if (onEProceedings()) return true;
      }
      await sleep(600);
    }
    return onEProceedings();
  }
  // Parse the proceedings list from the page text (labels are stable).
  function scrapeList(tab) {
    const text = document.body.innerText || "";
    const segs = text.split(/Proceeding Name\s*:/i).slice(1);
    const out = [];
    for (const seg of segs) {
      const grab = (re) => { const m = seg.match(re); return m ? m[1].trim().replace(/\s+/g, " ") : ""; };
      const name = (seg.split(/Assessment Year\s*:/i)[0] || "").trim().replace(/\s+/g, " ");
      const pan = grab(/\b([A-Z]{5}[0-9]{4}[A-Z])\b/);
      const ay = grab(/Assessment Year\s*:\s*([^\n]+)/i);
      const assessee = grab(/Name of Assessee\s*\n?\s*([^\n]+(?:\n[A-Z][^\n]+){0,2})/i).replace(/\s+/g, " ");
      const fy = grab(/Financial Year\s*:\s*([^\n]+)/i);
      const act = grab(/Applicable Act\s*:\s*([^\n]+)/i);
      const statusDate = grab(/\b(\d{1,2}-[A-Za-z]{3}-\d{4})\b/);
      const nc = seg.match(/View Notices\/Orders\s*\((\d+)\)/i);
      if (name || pan) out.push({ tab, name, ay, pan, assessee, fy, act, statusDate, noticeCount: nc ? Number(nc[1]) : null });
    }
    return out;
  }
  /* ---------- approach (a): map the API JSON → proceedings rows ----------
   * We don't hard-code the portal's field names (they can change and we can't
   * see them from here). Instead we walk the JSON, find the array of objects
   * that best looks like a proceedings list, and fuzzy-map each object's keys.
   */
  function collectArrays(node, out, depth) {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) {
      if (node.length && typeof node[0] === "object" && node[0] && !Array.isArray(node[0])) out.push(node);
      for (const it of node) collectArrays(it, out, depth + 1);
      return;
    }
    if (typeof node === "object") for (const k of Object.keys(node)) collectArrays(node[k], out, depth + 1);
  }
  const KEY_HINTS = /proceed|assess|notice|order|financial|applicableact|pan|\bay\b|assessee|din|requestid/i;
  function scoreArray(arr) {
    const obj = arr[0] || {};
    let s = 0;
    for (const k of Object.keys(obj)) if (KEY_HINTS.test(k)) s++;
    return s;
  }
  // Pull a value by trying several fuzzy key patterns against an object.
  function pick(obj, patterns) {
    const keys = Object.keys(obj);
    for (const p of patterns) {
      const k = keys.find((x) => p.test(x));
      if (k != null && obj[k] != null && obj[k] !== "") return obj[k];
    }
    return "";
  }
  function mapProceedingsJson(json) {
    const arrays = [];
    collectArrays(json, arrays, 0);
    if (!arrays.length) return null;
    arrays.sort((a, b) => scoreArray(b) - scoreArray(a) || b.length - a.length);
    const best = arrays[0];
    if (scoreArray(best) < 2) return null; // not confidently a proceedings list
    return best.map((o) => ({
      tab: "api",
      name: String(pick(o, [/proceedingname/i, /proceeding/i, /subject/i]) || "").trim(),
      ay: String(pick(o, [/assessmentyear/i, /^ay$/i, /asstyear/i]) || "").trim(),
      pan: String(pick(o, [/^pan$/i, /pannumber/i, /pan/i]) || "").trim(),
      assessee: String(pick(o, [/assesseename/i, /nameofassessee/i, /assessee/i, /taxpayername/i]) || "").trim(),
      fy: String(pick(o, [/financialyear/i, /^fy$/i]) || "").trim(),
      act: String(pick(o, [/applicableact/i, /^act$/i]) || "").trim(),
      statusDate: String(pick(o, [/statusdate/i, /noticedate/i, /date/i]) || "").trim(),
      noticeCount: Number(pick(o, [/noticecount/i, /noofnotice/i, /count/i])) || null,
      din: String(pick(o, [/^din$/i, /documentid/i, /din/i]) || "").trim(),
    })).filter((p) => p.name || p.pan || p.din);
  }

  // Approach (a) fast path: replay the portal's own proceedings API + time it.
  // Returns { proceedings, ms, status, endpoint } or null if not available yet.
  async function tryApiFetch(badge) {
    const capId = NET.bestProceedingId();
    if (!capId) { log("api: no proceedings call captured yet"); return null; }
    badge.set("Fetching via portal API…");
    const res = await NET.apiFetch(capId);
    log("api replay result", res && { ok: res.ok, status: res.status, ms: res.ms });
    if (!res || !res.ok) return null;
    if (!res.json) { log("api: response was not JSON; sample:", res.textSample); return { proceedings: null, ms: res.ms, status: res.status, endpoint: res.url, unmapped: true }; }
    const rows = mapProceedingsJson(res.json);
    if (!rows || !rows.length) { log("api: JSON captured but shape not recognised — sample keys:", Object.keys(res.json || {})); return { proceedings: null, ms: res.ms, status: res.status, endpoint: res.url, unmapped: true, json: res.json }; }
    return { proceedings: rows, ms: res.ms, status: res.status, endpoint: res.url };
  }

  // Map one API proceeding object → the row shape the app/Cloud Function expect.
  // Also keeps proceedingReqId + viewNoticeCount for the notices fetch.
  function mapRow(o, tab) {
    const noticeCount = typeof o.viewNoticeCount === "number" ? o.viewNoticeCount : (Number(o.viewNoticeCount) || null);
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
    };
  }

  // Phase 2b: pull each proceeding's notices/orders + their PDFs and stream them
  // to the app (one message per document so large PDFs don't blow the message).
  // Chain per proceeding: eProceedingDetailsService (list) → noticeletterpdf
  // (satDocId) → GET /document/{satDocId} (PDF bytes). Auth is the session
  // cookie; "sn" is just the serviceName.
  const MAX_PDF_BYTES = 25 * 1024 * 1024; // skip storing absurdly large files
  async function syncNotices(creds, badge, pan, rows) {
    const known = new Set((creds.knownDins || []).map((d) => String(d)));
    const targets = rows.filter((r) => (r.viewNoticeCount || 0) > 0 && r.proceedingReqId);
    if (!targets.length) { log("notices: none to fetch"); return; }
    let docCount = 0, skipped = 0;
    for (let i = 0; i < targets.length; i++) {
      const r = targets[i];
      badge.set("Notices " + (i + 1) + "/" + targets.length + " — " + (r.name || "proceeding").slice(0, 28) + "…");
      const det = await NET.apiCall({
        path: GET_ENTITY_PATH, serviceName: "eProceedingDetailsService",
        payload: { serviceName: "eProceedingDetailsService", proceedingReqId: r.proceedingReqId, pan, header: FORM },
      });
      const items = Array.isArray(det.json) ? det.json : [];
      log("notices: proceeding", r.proceedingReqId, "→", items.length, "items");
      for (const it of items) {
        // Incremental: a document we already hold (matched by DIN) is skipped —
        // no PDF re-download, no re-send. Only NEW documents are fetched.
        const din0 = it.documentIdentificationNumber || "";
        if (din0 && known.has(String(din0))) { skipped++; continue; }
        const headerSeqNo = it.headerSeqNo;
        let pdf = null;
        if (headerSeqNo) {
          const doc = await NET.apiCall({
            path: SAVE_ENTITY_PATH, serviceName: "noticeletterpdf",
            payload: { serviceName: "noticeletterpdf", headerSeqNo: String(headerSeqNo), procdngReqId: r.proceedingReqId, loggedInUserId: pan, header: FORM },
          });
          const satDocId = doc.json && doc.json.satDocId;
          if (satDocId) {
            const got = await NET.getDoc({ docId: String(satDocId) });
            if (got && got.ok && got.bytes && got.bytes <= MAX_PDF_BYTES) pdf = got;
            else if (got && got.bytes > MAX_PDF_BYTES) log("notices: skipping oversized pdf", got.bytes);
          }
        }
        const notice = {
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
        };
        chrome.runtime.sendMessage({ type: "SYNC_DATA", payload: { assesseeId: creds.assesseeId, kind: "notice", notice } }, () => {});
        docCount++;
        await sleep(150); // gentle pacing between documents
      }
    }
    log("notices: streamed " + docCount + " new document(s), skipped " + skipped + " already-synced");
    badge.set("Synced " + docCount + " new document(s)" + (skipped ? " · " + skipped + " already on file" : "") + " ✓");
  }

  /* ---------- log out + close the tab once a sync is done ---------- */
  function requestCloseTab() { try { chrome.runtime.sendMessage({ type: "CLOSE_TAB" }, () => {}); } catch { /* noop */ } }
  function tryLogout() {
    const el = [...document.querySelectorAll('a, button, span, [role="menuitem"]')].filter(isVisible)
      .find((x) => /^log\s?out$/i.test((x.textContent || "").trim()));
    if (el) { realClick(el); return true; }
    return false;
  }
  async function logoutAndClose(badge) {
    badge.set("Sync complete — logging out…");
    await sleep(3500); // let the result be visible first
    try { tryLogout(); } catch { /* noop */ }
    await sleep(1200);
    requestCloseTab();
  }

  // Approach (a), the real thing: after login, call the e-Proceedings API
  // directly (For your Action + For your Information) using the session token
  // the probe captured from the dashboard. No menu navigation. Returns true if
  // it handled the sync; false to fall back to navigate + scrape.
  async function tryDirectApi(creds, badge, waitMs = 15000) {
    badge.set("Fetching via portal API…");
    const ready = await NET.waitAuth(waitMs);
    if (!ready) { log("direct api: no session token captured yet"); return false; }
    const pan = (NET.pan() || creds.portalUserId || "").toString().toUpperCase().trim();
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) { log("direct api: no valid PAN", pan); return false; }

    const t0 = performance.now();
    const fya = await NET.proceedings({ pan, statusFlag: "FYA", pageSize: 100 });
    const fyi = await NET.proceedings({ pan, statusFlag: "FYI", pageSize: 100 });
    const ms = Math.round(performance.now() - t0);

    const rows = [];
    const push = (res, tab) => {
      const list = res && res.json && res.json.eProceedingPaginatedRequests;
      if (Array.isArray(list)) for (const o of list) rows.push(mapRow(o, tab));
    };
    push(fya, "For your Action");
    push(fyi, "For your Information");

    if (!rows.length) { log("direct api: no rows", { fya: fya && fya.status, fyi: fyi && fyi.status, err: (fya && fya.error) || (fyi && fyi.error) }); return false; }

    log("DIRECT API OK — " + rows.length + " proceedings in " + ms + " ms");
    badge.set("API sync ✓ " + rows.length + " proceedings in " + ms + " ms");
    chrome.runtime.sendMessage({ type: "SYNC_DATA", payload: { assesseeId: creds.assesseeId, kind: "proceedings", via: "api", ms, endpoint: "/auth/getEntity · eProceedingsPaginatedService", proceedings: rows } }, () => {});
    // Then pull each proceeding's notices/orders + PDFs.
    try { await syncNotices(creds, badge, pan, rows); }
    catch (e) { log("notices error", e); }
    // Done — log out and close the portal tab so no session is left open.
    await logoutAndClose(badge);
    return true;
  }

  async function beginSync(creds, badge) {
    // Auto-dismiss the portal's "Are you sure you want to Logout?" guard for the
    // duration of the sync — our hash navigation trips it, but the data fetch is
    // unaffected, so the user shouldn't have to click "No".
    const logoutGuard = setInterval(dismissLogoutDialog, 350);
    setTimeout(() => clearInterval(logoutGuard), 30000);

    // 1) Quick direct attempt — succeeds if the dashboard already exposed the
    //    e-Proceedings session token (short wait so we don't stall if it hasn't).
    try { if (await tryDirectApi(creds, badge, 4000)) return; }
    catch (e) { log("direct api error", e); }

    // 2) Open e-Proceedings. This makes the portal load the module and fire its
    //    OWN proceedings API — which hands us the session token + the captured
    //    call, even though we won't need to read the screen.
    badge.set("Opening e-Proceedings…");
    await goToEProceedings();
    await sleep(1200); // let the portal's own API call land + be captured

    // 3) Direct attempt again — the token is captured now.
    try { if (await tryDirectApi(creds, badge, 8000)) return; }
    catch (e) { log("direct api retry error", e); }

    // 4) Replay the portal's own captured call as a secondary API path.
    try {
      const api = await tryApiFetch(badge);
      if (api && api.proceedings && api.proceedings.length) {
        log("API fast path OK — " + api.proceedings.length + " rows in " + api.ms + "ms via " + api.endpoint);
        badge.set("API sync ✓ " + api.proceedings.length + " proceedings in " + api.ms + " ms");
        chrome.runtime.sendMessage({ type: "SYNC_DATA", payload: { assesseeId: creds.assesseeId, kind: "proceedings", via: "api", ms: api.ms, endpoint: api.endpoint, proceedings: api.proceedings } }, () => {});
        setTimeout(() => badge.remove(), 10000);
        return;
      }
      if (api && api.unmapped) {
        // We reached the API and got a JSON/response back fast, but its shape
        // needs a one-time calibration. Report the timing + a sample so the
        // mapping can be finalised, then fall through to scraping for now.
        badge.set("API reached in " + api.ms + " ms (mapping needs calibration) — scraping meanwhile…");
        chrome.runtime.sendMessage({ type: "SYNC_DATA", payload: { assesseeId: creds.assesseeId, kind: "api-probe", via: "api", ms: api.ms, status: api.status, endpoint: api.endpoint, sample: api.json || null } }, () => {});
        log("=== PROHIPPO API PROBE ===", "endpoint:", api.endpoint, "ms:", api.ms, "json:", api.json);
      }
    } catch (e) { log("api path error", e); }

    let onList = await waitFor(() => /eProceedings/i.test(location.href) && !/viewNotices/i.test(location.href) && /Proceeding Name/i.test(document.body.innerText), 45000);
    if (!onList) {
      badge.set("Open Pending Actions → e-Proceedings; sync continues automatically…", true);
      onList = await waitFor(() => /Proceeding Name/i.test(document.body.innerText), 90000);
      if (!onList) { badge.set("Couldn't open e-Proceedings — open it and click Update status again.", true); return; }
    }
    await sleep(1500);
    const list = [];
    const seen = new Set();
    const collect = (tab) => {
      for (const p of scrapeList(tab)) {
        const k = [p.name, p.ay, p.fy, p.statusDate].join("|");
        if (!seen.has(k)) { seen.add(k); list.push(p); }
      }
    };
    collect("For your Action");
    if (clickByText(["For your Information"])) { await sleep(1800); collect("For your Information"); }
    log("scraped proceedings", list);
    badge.set("Found " + list.length + " proceedings — saving to ProHippo…");
    chrome.runtime.sendMessage({ type: "SYNC_DATA", payload: { assesseeId: creds.assesseeId, kind: "proceedings", proceedings: list } }, () => {});
    setTimeout(() => badge.set("Synced " + list.length + " proceedings ✓ — check ProHippo."), 900);
    setTimeout(() => badge.remove(), 10000);
  }

  /* ---------- badge ---------- */
  function makeBadge() {
    const box = document.createElement("div");
    box.style.cssText = [
      "position:fixed", "top:14px", "right:14px", "z-index:2147483647",
      "background:#6C5CE7", "color:#fff", "font:600 13px system-ui,sans-serif",
      "padding:10px 14px", "border-radius:10px", "max-width:340px",
      "box-shadow:0 6px 20px rgba(0,0,0,.25)",
    ].join(";");
    box.textContent = "ProHippo " + BUILD + ": logging you in…";
    const attach = () => (document.body || document.documentElement).appendChild(box);
    if (document.body) attach(); else window.addEventListener("DOMContentLoaded", attach);
    return {
      set: (t, warn) => { box.textContent = "ProHippo " + BUILD + ": " + t; box.style.background = warn ? "#C0392B" : "#6C5CE7"; },
      remove: () => box.remove(),
    };
  }
})();
