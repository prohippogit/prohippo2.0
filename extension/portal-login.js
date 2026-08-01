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
  const BUILD = "v40";

  // Post-sync logout pacing (milliseconds), tunable in one place. Background /
  // bulk syncs run unwatched, so they skip the cosmetic pause and log out fast;
  // foreground (single) syncs keep a short visible beat. sync-done is emitted
  // AFTER logout, so the bulk loop never starts the next login until the
  // previous session is gone — no cookie collision.
  // Post-sync logout pacing as [min,max] millisecond ranges — randomised at use
  // so the cadence never looks robotic. Background/bulk syncs log out fast.
  const PACE = { bgPreLogout: [180, 360], bgPostLogout: [360, 620], fgPreLogout: [1200, 1800], fgPostLogout: [700, 1100] };
  // Login poll cadence (ms): base ± jitter. Faster than the old fixed 1000ms
  // (Tier 2 speed-up) AND randomised so repeated logins aren't a robotic pattern.
  const POLL = { min: 360, max: 680, firstMin: 800, firstMax: 1400 };
  // Random integer in [min,max]. Math.random is available in the extension
  // content script (unlike workflow scripts).
  const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

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
    const postDoc = (opts) => send(Object.assign({ kind: "postdoc" }, opts), opts.timeoutMs || 45000);
    // The filed-returns documents can be 11 MB, so they get a longer leash.
    const postBinary = (opts) => send(Object.assign({ kind: "postbinary" }, opts), opts.timeoutMs || 90000);

    return { caps, bestProceedingId, apiFetch, waitAuth, pan, proceedings, apiCall, getDoc, postDoc, postBinary };
  })();

  // Portal API endpoints + form, mirrored from portal-net.js.
  const GET_ENTITY_PATH = "/iec/returnservicesapi/auth/getEntity";
  const SAVE_ENTITY_PATH = "/iec/returnservicesapi/auth/saveEntity";
  // Profile / master-data services live under a different base path.
  const SERVICES_SAVE_PATH = "/iec/servicesapi/auth/saveEntity";
  const SERVICES_GET_PATH = "/iec/servicesapi/auth/getEntity";
  const ITF_INVOKE_PATH = "/iec/itfweb/auth/invoke"; // filed-form data
  const PDFWEB_PATH = "/iec/pdfweb/pdf";             // renders a filed form to PDF
  // Filed returns. itrStatusService returns EVERY assessment year in one call.
  const ITR_DOWNLOAD_FILE_PATH = "/iec/itrweb/auth/v0.1/returns/downloadfile"; // the ITR JSON
  const ITR_PDF_PATH = "/iec/itrweb/auth/v0.1/returns/pdf";                    // ITR-V / acknowledgement
  const ITR_PREVIEW_PATH = "/iec/itrweb/auth/v0.1/returns/preview/";           // + AY — the full form
  const DOC_INTIMATION_PATH = "/iec/document/intimation";                      // 143(1) / 154 order PDF
  const FORM = { formName: "FO-041_PCDNG" };
  const ITR_FORM = { formName: "FO-006-ITRST" }; // the filed-returns page's own form id

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
    let timer = null;
    let stopped = false;
    const stopLoop = () => { stopped = true; clearTimeout(timer); };
    log("started");

    const finish = (ok, msg) => {
      stopLoop();
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
          stopLoop();
          if (creds.mode === "sync") {
            beginSync(creds, badge)
              .catch((e) => { log("sync error", e); badge.set("Sync failed — " + (e.message || e), true); })
              // Always tell the app this assessee is done, so a bulk queue advances.
              .finally(() => { try { chrome.runtime.sendMessage({ type: "SYNC_DATA", payload: { assesseeId: creds.assesseeId, kind: "sync-done" } }, () => {}); } catch { /* noop */ } });
          } else if (creds.mode === "master") {
            beginMasterSync(creds, badge)
              .catch((e) => { log("master sync error", e); badge.set("Master fetch failed — " + (e.message || e), true); })
              .finally(() => { try { chrome.runtime.sendMessage({ type: "SYNC_DATA", payload: { assesseeId: creds.assesseeId, kind: "master-done", clientRef: creds.clientRef || null } }, () => {}); } catch { /* noop */ } });
          } else {
            // "Open portal": leave the user logged in on the portal dashboard,
            // ready to work. After an automated login the SPA can sit on a
            // half-loaded / intermediate route that just spins; nudge the Angular
            // router to the Dashboard (hash navigation is safe — it's the same
            // technique the sync uses to open e-Proceedings), then step aside and
            // remove the badge so nothing blocks the user.
            (async () => {
              try {
                location.hash = "#/dashboard";
                await waitFor(() => /dashboard/i.test(location.hash) && !onLoginScreen(), 4000);
                await sleep(500);
              } catch (e) { log("open: dashboard nav error", e); }
              finish(true, "Logged in ✓ — you're on the portal dashboard.");
            })();
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

    // Self-rescheduling poll with a jittered cadence: faster than the old fixed
    // 1s interval (Tier 2) and non-robotic (each gap is randomised). No
    // MutationObserver — that caused the freeze.
    const loop = () => {
      if (stopped) return;
      tick();
      if (!stopped) timer = setTimeout(loop, rand(POLL.min, POLL.max));
    };
    timer = setTimeout(loop, rand(POLL.firstMin, POLL.firstMax)); // first attempt after the SPA renders
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
  // Jittered sleep — a random pause in [min,max] ms, so inter-request pacing is
  // never a fixed, robotic value the portal could fingerprint.
  const jsleep = (min, max) => sleep(rand(min, max));
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
      // "C" = closed; proceedingClosureOrder is the closure sequence no. — its
      // presence means a "Download Closure Order" set exists for this proceeding.
      proceedingStatus: o.proceedingStatus || "",
      closureSeqNo: (o.proceedingClosureOrder != null ? String(o.proceedingClosureOrder) : ""),
    };
  }

  // Phase 2b: pull each proceeding's notices/orders + their PDFs and stream them
  // to the app (one message per document so large PDFs don't blow the message).
  // Chain per proceeding: eProceedingDetailsService (list) → noticeletterpdf
  // (satDocId) → GET /document/{satDocId} (PDF bytes). Auth is the session
  // cookie; "sn" is just the serviceName.
  const MAX_PDF_BYTES = 25 * 1024 * 1024; // skip storing absurdly large files

  // Fetch the responses filed against one notice (remarks + attachment PDFs),
  // and stream each to the app to attach to that notice.
  async function syncResponses(creds, pan, din, headerSeqNo) {
    const knownResp = new Set((creds.knownResponseIds || []).map((x) => String(x)));
    const resp = await NET.apiCall({
      path: GET_ENTITY_PATH, serviceName: "itbaResponseService",
      payload: { serviceName: "itbaResponseService", headerSeqNo, pan, header: FORM },
    });
    const list = (resp.json && Array.isArray(resp.json.respRemrkAttLst)) ? resp.json.respRemrkAttLst : [];
    for (const rr of list) {
      const atts = Array.isArray(rr.attachmentLst) ? rr.attachmentLst : [];
      if (!rr || (!rr.remarks && atts.length === 0)) continue;
      // A reply already on file needs no work — skip its attachment downloads.
      const responseId = String(rr.responseId || rr.remarksHash || rr.submittedOn || (rr.remarks || "").slice(0, 24));
      if (knownResp.has(responseId)) continue;
      const attachments = [];
      for (const at of atts) {
        const adocId = at.docId || at.satDocId || at.documentId || at.attachmentId || at.refId;
        let apdf = null;
        if (adocId) { const g = await NET.getDoc({ docId: String(adocId) }); if (g && g.ok && g.bytes && g.bytes <= MAX_PDF_BYTES) apdf = g; }
        // Portal fields (confirmed from itbaResponseService): attachmentName =
        // human filename, categorieName = a label like "Written submission".
        const base = at.attachmentName || at.docNam || at.fileName || (adocId ? adocId + ".pdf" : "attachment.pdf");
        const filename = /\.[a-z0-9]{2,5}$/i.test(base) ? base : base + ".pdf";
        attachments.push({
          filename: (apdf && apdf.filename && /\.[a-z0-9]{2,5}$/i.test(apdf.filename)) ? apdf.filename : filename,
          label: at.categorieName || "",
          contentType: (apdf && apdf.contentType) || "application/pdf",
          contentBase64: apdf ? apdf.base64 : null,
        });
      }
      const response = {
        noticeKey: din,
        responseId,
        remarks: rr.remarks || "",
        submittedOn: rr.submittedOn || "",
        respType: rr.respType || "",
        attachments,
      };
      chrome.runtime.sendMessage({ type: "SYNC_DATA", payload: { assesseeId: creds.assesseeId, kind: "response", response } }, () => {});
      await jsleep(120, 320);
    }
  }

  // Portal order filenames end in a DDMMYYYY date, e.g. "…_15012022.pdf".
  function dateFromFilename(name) {
    const m = /(\d{2})(\d{2})(\d{4})\.pdf$/i.exec(String(name || ""));
    return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
  }
  async function syncNotices(creds, badge, pan, rows) {
    const known = new Set((creds.knownDins || []).map((d) => String(d)));
    const knownByProc = creds.knownByProc || {};
    const isClosed = (r) => /information/i.test(r.tab || "") || r.proceedingStatus === "C";
    const targets = rows.filter((r) => (r.viewNoticeCount || 0) > 0 && r.proceedingReqId);
    if (!targets.length) { log("notices: none to fetch"); return; }
    let docCount = 0, skipped = 0, skippedProcs = 0;
    for (let i = 0; i < targets.length; i++) {
      const r = targets[i];
      // Incremental: a CLOSED proceeding whose notices are all on file can never
      // change — skip its detail call (and every per-notice reply call) entirely.
      // Active proceedings are still checked (a reply may be new), but the
      // per-notice/response loop below only downloads what isn't already held.
      const kp = knownByProc[r.proceedingReqId] || {};
      const countMatches = (r.viewNoticeCount || 0) <= (kp.n || 0);
      // Skip a proceeding whose notice count is already on file: always for
      // closed proceedings, and in e-Proceedings-only mode for active ones too
      // (that mode treats a notice-count change as the only trigger, so an
      // unchanged FYA proceeding is left untouched — no detail, no reply calls).
      if (countMatches && (isClosed(r) || creds.scope === "eproc")) {
        skipped += (r.viewNoticeCount || 0); skippedProcs++;
        continue;
      }
      badge.set("Notices " + (i + 1) + "/" + targets.length + " — " + (r.name || "proceeding").slice(0, 28) + "…");
      const det = await NET.apiCall({
        path: GET_ENTITY_PATH, serviceName: "eProceedingDetailsService",
        payload: { serviceName: "eProceedingDetailsService", proceedingReqId: r.proceedingReqId, pan, header: FORM },
      });
      const items = Array.isArray(det.json) ? det.json : [];
      log("notices: proceeding", r.proceedingReqId, "→", items.length, "items");
      for (const it of items) {
        const din0 = it.documentIdentificationNumber || "";
        const headerSeqNo = it.headerSeqNo;
        // Incremental: a notice PDF we already hold (matched by DIN) is not
        // re-downloaded or re-sent. But we STILL check for responses filed
        // against it below — those can be filed AFTER the notice first synced,
        // so skipping known notices entirely would never pick them up.
        const isKnown = din0 && known.has(String(din0));
        if (!isKnown) {
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
          await jsleep(120, 320); // jittered pacing between documents
        } else {
          skipped++;
        }

        // Responses the assessee filed against THIS notice (remarks + PDFs) —
        // fetched for BOTH new and already-known notices. itbaResponseService
        // returns an empty respRemrkAttLst when nothing was filed (skipped by
        // the loop), and the ingest dedups responses by id, so re-asking on a
        // later sync is safe and picks up newly filed responses.
        if (headerSeqNo && din0) {
          try { await syncResponses(creds, pan, din0, String(headerSeqNo)); }
          catch (e) { log("responses error", e); }
        }
      }
    }

    // Closure / final orders — a SEPARATE pass over every proceeding that
    // carries a closureSeqNo (proceedingClosureOrder), i.e. the ones with the
    // portal's "Download Closure Order" button. Run independently of the notice
    // pass (not gated by pending-notice counts, and its own try/catch) so a hit
    // or miss here can never depend on the notices loop. Closed (FYI)
    // proceedings live here — this is where their orders come from.
    // Ask for every proceeding, not only the ones the list flags with a
    // closureSeqNo — the portal shows a "Download Closure Order" button on some
    // proceedings the list doesn't flag (e.g. still-Open ones with an order),
    // and the service simply returns an empty list where there's nothing.
    const withOrders = rows.filter((r) => r.proceedingReqId);
    log("orders: checking " + withOrders.length + " proceeding(s) for closure orders");
    for (const r of withOrders) {
      // A closed proceeding whose order we already hold is final — skip its
      // closure-order lookup. Active proceedings are still checked (an order may
      // newly appear), and within any proceeding known docs are skipped by docKey.
      const kp = knownByProc[r.proceedingReqId] || {};
      if (isClosed(r) && kp.o) { skipped++; continue; }
      // e-Proceedings-only: don't probe a still-active proceeding for a closure
      // order unless the list flags one. The just-closed synthetic rows (marked
      // closed) and flagged proceedings are the only ones worth a call here.
      if (creds.scope === "eproc" && !isClosed(r) && !r.closureSeqNo) continue;
      badge.set("Orders — " + (r.name || "proceeding").slice(0, 28) + "…");
      try {
        const clo = await NET.apiCall({
          path: GET_ENTITY_PATH, serviceName: "downloadClosureOrder",
          payload: { serviceName: "downloadClosureOrder", procdngReqId: r.proceedingReqId, loggedInUserId: pan, header: FORM },
        });
        let docs = (clo.json && Array.isArray(clo.json.satDocDetlList)) ? clo.json.satDocDetlList.slice() : [];
        // Fallback: some responses carry a single doc at the top level.
        if (!docs.length && clo.json && clo.json.satDocId) docs = [{ satDocId: clo.json.satDocId, docNam: clo.json.docNam }];
        log("orders: proceeding", r.proceedingReqId, "→", docs.length, "doc(s)", "status", clo && clo.status);
        for (const od of docs) {
          const satDocId = od.satDocId;
          if (!satDocId) continue;
          const docKey = "sat:" + satDocId;
          if (known.has(docKey)) { skipped++; continue; }
          const got = await NET.getDoc({ docId: String(satDocId) });
          const pdf = (got && got.ok && got.bytes && got.bytes <= MAX_PDF_BYTES) ? got : null;
          const notice = {
            proceedingReqId: r.proceedingReqId,
            proceedingName: r.name || "",
            din: "", docKey, isOrder: true,
            section: r.section || "",
            description: od.docNam || "Order",
            issuedOn: dateFromFilename(od.docNam) || "",
            ay: r.ay || "", pan,
            filename: (pdf && pdf.filename) || od.docNam || "",
            contentType: (pdf && pdf.contentType) || "application/pdf",
            contentBase64: (pdf && pdf.base64) || null,
            bytes: (pdf && pdf.bytes) || 0,
          };
          chrome.runtime.sendMessage({ type: "SYNC_DATA", payload: { assesseeId: creds.assesseeId, kind: "notice", notice } }, () => {});
          docCount++;
          await jsleep(120, 320);
        }
      } catch (e) { log("orders: error for", r.proceedingReqId, e); }
    }

    log("notices: streamed " + docCount + " new document(s), skipped " + skipped + " already-synced (" + skippedProcs + " unchanged proceeding(s) skipped without a detail call)");
    badge.set("Synced " + docCount + " new document(s)" + (skipped ? " · " + skipped + " already on file" : "") + " ✓");
  }

  // Deep-merge live data onto a full-shape template so no field/sub-field the
  // pdfweb renderer reads is ever undefined. Objects merge key-wise; arrays
  // merge element-wise against the shape's element template AND keep the
  // shape's length (padding, e.g. attachmentDocument's 20 slots).
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
    return (data !== undefined && data !== null) ? data : shape;
  }

  // "23-Nov-2024" → "23/11/2024 12:00:00 PM" (the format the pdfweb renderer
  // parses for the verification block; a wrong format crashes it → 502).
  function itfTs(s) {
    const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(s || ""));
    if (!m) return "";
    const mo = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" }[m[2]];
    return mo ? `${m[1].padStart(2, "0")}/${mo}/${m[3]} 12:00:00 PM` : "";
  }

  // Form 35 gives AY as the start year (selectyear) → "2015-16".
  function ayFromForm(d) {
    const y = Number(d.selectyear || d.assessmentYear || 0);
    if (!y || y < 1900) return "";
    return y + "-" + String((y + 1) % 100).padStart(2, "0");
  }

  // CIT(A) appeals filed as Form 35 (from "View Filed Forms"): pull the filed
  // form's structured data + PDFs and stream each so the app can attach it to
  // the matching First Appeal proceeding (matched by AY + order date/section).
  async function syncAppealForms(creds, badge, pan) {
    badge.set("Fetching filed appeals (Form 35)…");
    let forms;
    try {
      const list = await NET.apiCall({
        path: SERVICES_SAVE_PATH, serviceName: "viewFiledForms",
        payload: { serviceName: "viewFiledForms", entityNum: pan, formTypeCd: "F35", currentPage: "0", pageSize: "50", filterParameterDetails: [] },
      });
      forms = (list.json && Array.isArray(list.json.forms)) ? list.json.forms : [];
    } catch (e) { log("appeals: list error", e); return; }
    log("appeals: " + forms.length + " Form 35 filing(s)");
    if (!forms.length) return;

    // Taxpayer name + address (for the ARN receipt and the Form 35's entity
    // block) — one profile call.
    const entType = ({ P: "Individual", C: "Company", H: "HUF", F: "Firm", A: "AOP/BOI", B: "AOP/BOI", T: "Trust" }[(pan[3] || "").toUpperCase()]) || "Individual";
    let entName = "", entAddr = "", entFields = {};
    try {
      const pd = await NET.apiCall({ path: SERVICES_SAVE_PATH, serviceName: "myPanDetailsService", payload: { serviceName: "myPanDetailsService", contactPan: pan, userId: pan } });
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
        entityPinCd: (j.commnPin != null && j.commnPin !== "") ? Number(j.commnPin) : "",
        entityTaxPayerCatgCd: ({ P: "IND", C: "COM", H: "HUF", F: "FIR", A: "AOP", B: "BOI", T: "TRU" }[(pan[3] || "").toUpperCase()]) || "IND",
        entityTaxPayerCatgDesc: entType,
      };
    } catch (e) { log("appeals: pan details error", e); }
    const F35T = (typeof window !== "undefined" && window.__PH_F35) || null;
    const knownForms = new Set((creds.knownDins || []).map((d) => String(d)));

    for (const f of forms) {
      const ackNum = f.ackNum || f.ackNo || "";
      if (!ackNum) continue;
      // Already-filed Form 35 on file (deduped by "f35:<ackNum>") — the rendered
      // form + ARN + attachments are expensive, so skip it entirely.
      if (knownForms.has("f35:" + ackNum)) { log("appeals: skip already-filed", ackNum); continue; }

      // Full filed-form data (AY, order DIN/date/section, amounts, filing date).
      let d = {};
      try {
        const inv = await NET.apiCall({
          path: ITF_INVOKE_PATH, serviceName: "viewFiledFormService",
          payload: { metadata: { sn: "viewFiledFormService", formName: "F35", submitedBy: "", loggedInUserId: pan }, data: { ackNum } },
        });
        d = (inv.json && inv.json.data) ? inv.json.data : {};
      } catch (e) { log("appeals: invoke error", e); }

      const attachments = [];
      const ackDt = (Array.isArray(f.ackDt) ? f.ackDt[0] : f.ackDt) || (Array.isArray(f.ackDate) ? f.ackDate[0] : f.ackDate) || "";
      // The rendered Form 35 itself ("Download Form"). The renderer reads many
      // fields + the dropdown `list` + `childData`; a missing field throws, so
      // we start from a full empty-by-type template, overlay the filed-form
      // data + the entity block + ack number, and send the static list/child.
      let formPdfError = "";
      try {
        // The filed-form data (invoke) is authoritative and already carries the
        // entity block; entFields are only a FALLBACK for fields it lacks, so
        // invoke MUST win the merge (…entFields then …d). Overwriting invoke's
        // correctly-typed values — e.g. numeric entityPinCd — crashed the
        // renderer (502).
        const f35data = F35T ? deepMergeShape(F35T.shape, { ...entFields, ...d, arn: ackNum }) : { ...entFields, ...d, arn: ackNum };
        const ts = itfTs(ackDt);
        const dscJson = { evc: "", verMode: "OTP", submitDate: ts, fullName: entName, verPan: pan, verDate: ts };
        const body = {
          formStatus: f.formStatus || "Completed", udinNum: null, formName: "F35", submitMode: "Online",
          data: f35data, list: F35T ? F35T.list : {}, dscJson, childData: F35T ? F35T.childData : {},
        };
        let rendered = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          rendered = await NET.postDoc({ path: PDFWEB_PATH, serviceName: "F35", payload: body, timeoutMs: 60000 });
          if (rendered && rendered.ok) break;
          const st = rendered && rendered.status;
          if (st && st < 500) break;          // a 4xx won't fix itself; stop
          await sleep(1500);                  // 5xx or timeout/no-status → retry
        }
        if (rendered && rendered.ok && rendered.bytes && rendered.bytes <= MAX_PDF_BYTES) {
          attachments.push({ filename: "Form 35 - " + ackNum + ".pdf", label: "Form 35 (filed)", contentType: rendered.contentType || "application/pdf", contentBase64: rendered.base64 });
        } else {
          formPdfError = "HTTP " + (rendered && rendered.status || "?") + (rendered && rendered.notPdf ? " (not a PDF)" : "") + (F35T ? "" : " · template missing") + (rendered && rendered.error ? " · " + String(rendered.error).slice(0, 90) : "") + (rendered && rendered.bytes ? " · " + rendered.bytes + " bytes" : "") + (rendered && rendered.text ? " · " + rendered.text.replace(/\s+/g, " ").slice(0, 120) : "");
          log("appeals: F35 pdf failed", formPdfError);
        }
      } catch (e) { formPdfError = "error: " + (e && e.message || e); log("appeals: F35 pdf error", e); }

      // The acknowledgement (ARN) receipt.
      try {
        const ackPdf = await NET.postDoc({ path: PDFWEB_PATH, serviceName: "arn", payload: { formStatus: "", udinNum: null, formName: "arn", submitMode: "Online", data: {
          dateOfEfiling: ackDt, arn: ackNum, name: entName, nameSignatory: entName, entityNum: pan, address: entAddr,
          formNo: "Form 35", formdescription: f.formName || "Appeal to the Commissioner (Appeals)",
          assessmentYear: ayFromForm(d), filingType: "Original", entityType: entType, verifiedBy: pan, refYearType: "A.Y.",
        } } });
        if (ackPdf && ackPdf.ok && ackPdf.bytes && ackPdf.bytes <= MAX_PDF_BYTES) {
          attachments.push({ filename: "Acknowledgement - " + ackNum + ".pdf", label: "Acknowledgement (ARN)", contentType: ackPdf.contentType || "application/pdf", contentBase64: ackPdf.base64 });
        } else { log("appeals: ARN pdf failed", ackPdf && ackPdf.status, ackPdf && ackPdf.notPdf); }
      } catch (e) { log("appeals: ARN pdf error", e); }

      // Uploaded attachments (Grounds of Appeal, etc.). Skip the order/demand
      // copies — those are already pulled with the assessment proceeding.
      try {
        const att = await NET.apiCall({
          path: SERVICES_GET_PATH, serviceName: "attachmentDetails",
          payload: { entityNum: pan, serviceName: "attachmentDetails", ackNum },
        });
        const docs = Array.isArray(att.json) ? att.json : ((att.json && Array.isArray(att.json.attachmentList)) ? att.json.attachmentList : []);
        for (const doc of docs) {
          const id = doc.satDocId || doc.docId;
          const nm = doc.docName || doc.docNam || "";
          if (!id) continue;
          if (/order\s*u\/?s|demand notice|computation sheet/i.test(nm)) continue;
          const got = await NET.getDoc({ docId: String(id) });
          if (got && got.ok && got.bytes && got.bytes <= MAX_PDF_BYTES) {
            attachments.push({ filename: nm || (id + ".pdf"), label: "Grounds / attachment", contentType: got.contentType || "application/pdf", contentBase64: got.base64 });
          }
          await sleep(120);
        }
      } catch (e) { log("appeals: attachments error", e); }

      const appeal = {
        formCd: "F35", formName: "Form 35",
        ackNum, ackDt,
        ay: ayFromForm(d),
        orderDin: d.din || d.orderNum || "",
        orderSection: d.sectionSubsectionForItf || "",
        appealSection: d.sectionSubsectionAppeal || "",
        dateOrder: d.dateOrder || "",
        dateFiling: d.dateFiling || "",
        authorityOrder: d.authorityOrder || "",
        amountAssessed: d.amountAssessed || "",
        disputedDemand: d.disputedDemandAmount || "",
        formPdfError,
        attachments,
      };
      log("appeals: F35 ack", ackNum, "AY", appeal.ay, "orderDate", appeal.dateOrder, "atts", attachments.length);
      chrome.runtime.sendMessage({ type: "SYNC_DATA", payload: { assesseeId: creds.assesseeId, kind: "appealForm", appeal } }, () => {});
      await jsleep(120, 320);
    }
  }

  /* ---------- filed returns + CPC intimations / s.154 orders ----------
   * Mirror of connector/src/main/portalReturns.js — keep the two in step.
   *
   * itrStatusService returns EVERY assessment year in one call, each with its
   * acknowledgement number and its full CPC activity timeline, so there is no
   * per-year list call. Everything after that is per-document.
   *
   * SIZE, AND WHY THE BIG ONE HAS A WINDOW. returns/preview/{ay} — the fully
   * rendered ITR form — is 10-12 MB per year against a few hundred KB for
   * everything else, and it is uploaded to Storage as well as downloaded. The
   * sync pulls it only for the FORM_SYNC_RECENT_YEARS most recent assessment
   * years; older years are one click away on the Returns tab ("Fetch form").
   * Rationing the backfill across runs was tried first and was worse: it made
   * every sync slow instead of one. See connector/src/main/portalReturns.js for
   * the full reasoning — the two paths must stay in step.
   *
   * ORDERS. Every activity row carries a commRefNo in its activityTxt blob, and
   * that reference is the refno the document endpoint wants. The statuses that
   * actually have a document behind them are the ones the portal's own bundle
   * marks with a `dnlIntOrdr` action — ORDER_ACTIVITIES below. Codes in the 60s
   * are s.143(1) intimations; the 70s (and 613) are s.154 rectification orders.
   *
   * These PDFs arrive encrypted (PAN lower-case + DDMMYYYY). We stream them out
   * as-is and let the web app decrypt before upload — it has the assessee's date
   * of birth and the qpdf-wasm module (src/pdfUnlock.js); a content script has
   * neither.
   */
  const ORDER_ACTIVITIES = {
    61: "143(1)", 62: "143(1)", 63: "143(1)", 64: "143(1)", 65: "143(1)",
    71: "154", 72: "154", 73: "154", 74: "154", 75: "154", 613: "154",
  };
  // Before AY 2017-18 the portal will not serve an order directly — it opens a
  // request form and emails it out, which we cannot complete unattended.
  const DIRECT_DOWNLOAD_FROM_AY = 2017;
  const MAX_RETURN_PDF_BYTES = 25 * 1024 * 1024;
  // The rendered return gets a larger ceiling than an order PDF: a full ITR-3
  // runs well past 25 MB, and the old cap silently discarded those after paying
  // to download them. Keep in step with the connector's MAX_FORM_BYTES.
  const MAX_FORM_BYTES = 80 * 1024 * 1024;
  // Zero: the rendered return is never synced, only fetched on demand. It is
  // 10-25 MB against a few hundred KB for everything else, and nothing in the
  // app depends on it — the computation reads the JSON, proof of filing is the
  // ITR-V. Keep in step with the connector's FORM_SYNC_RECENT_YEARS.
  const FORM_SYNC_RECENT_YEARS = 0;

  // "Tue Nov 25 14:16:09 IST 2025" → "2025-11-25". Java's Date.toString(),
  // which Date.parse cannot read on any engine because of the zone abbreviation.
  const RET_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  function javaDate(s) {
    const m = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+[\d:]+\s+\S+\s+(\d{4})$/.exec(String(s || "").trim());
    if (!m) return "";
    const mo = RET_MONTHS[m[1].toLowerCase()];
    return mo ? `${m[3]}-${String(mo).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}` : "";
  }
  // Activity detail is a JSON *string* inside the row. Most rows have none, so a
  // parse failure is an empty object, never an error.
  function activityDetail(row) {
    try {
      const p = JSON.parse(row && row.activityTxt);
      return p && typeof p === "object" ? p : {};
    } catch { return {}; }
  }

  async function syncReturns(creds, badge, pan) {
    badge.set("Fetching filed returns…");
    const knownAcks = new Set((creds.knownAckNums || []).map((x) => String(x)));
    const knownOrders = new Set((creds.knownOrderRefs || []).map((x) => String(x)));
    const knownFormPdfs = new Set((creds.knownFormAcks || []).map((x) => String(x)));
    // Orders already downloaded that the app could not decrypt. The password is
    // the PAN plus the assessee's date of birth and nothing else, so retrying
    // one without that date on file re-downloads the same file every sync and
    // fails the same way. canUnlockOrders is the app telling us whether it now
    // has the date — it is the app that decrypts, not us.
    const lockedRefs = new Set((creds.lockedOrderRefs || []).map((x) => String(x)));
    let fetched = 0;

    const res = await NET.apiCall({
      path: SERVICES_GET_PATH, serviceName: "itrStatusService",
      payload: { header: ITR_FORM, serviceName: "itrStatusService", entityNum: pan },
    });
    const list = res && Array.isArray(res.json) ? res.json : [];
    if (!list.length) { log("returns: none filed"); return; }
    log("returns: " + list.length + " assessment year(s)");

    // Newest year first — the window is "the first N of these", read off the
    // portal's own list rather than computed from the clock.
    list.sort((x, y) => Number((y && y.assmentYear) || 0) - Number((x && x.assmentYear) || 0));
    let formsOnDemand = 0;

    for (let i = 0; i < list.length; i++) {
      const r = list[i] || {};
      const ackNum = String((r && r.ackNum) || "").trim();
      const ay = String((r && r.assmentYear) || "").trim();
      if (!ackNum || !ay) continue;
      const isNew = !knownAcks.has(ackNum);
      if (isNew) fetched += 1;
      // Only announce a year we are going to do something about — a line per
      // year on a run with nothing to do makes an instant pass look slow.
      if (isNew) badge.set("Return A.Y. " + ay + "…");

      // The return itself is fetched once — a filed return never changes.
      let itrJson = null;
      let ackPdfBase64 = null;
      let formPdfBase64 = null;
      let formError = "";
      // Tracked on its own, so a year that has its JSON but not its form can be
      // completed without re-fetching everything else.
      const needsForm = !knownFormPdfs.has(ackNum) && i < FORM_SYNC_RECENT_YEARS;
      if (!knownFormPdfs.has(ackNum) && !needsForm) formsOnDemand += 1;
      if (isNew) {
        const j = await NET.apiCall({ path: ITR_DOWNLOAD_FILE_PATH, serviceName: "NA", payload: { ackNum, loggedInUserId: pan } });
        if (j && j.ok && j.json) itrJson = j.json;
        await jsleep(120, 320);
        const p = await NET.postBinary({ path: ITR_PDF_PATH, serviceName: "NA", payload: { ackNum, ay, loggedInUserId: pan } });
        if (p && p.ok && p.bytes && p.bytes <= MAX_RETURN_PDF_BYTES) ackPdfBase64 = p.base64;
        await jsleep(120, 320);
      }

      // The filed return itself, fully rendered — the one rationed item (see the
      // note above). Outside the isNew branch on purpose: a year recorded on an
      // earlier run with its form deferred is completed here.
      if (needsForm) {
        fetched += 1;
        const f = await NET.postBinary({
          path: ITR_PREVIEW_PATH + encodeURIComponent(ay), serviceName: "NA",
          payload: { ackNum, loggedInUserId: pan },
          extraHeaders: { ackNum }, timeoutMs: 180000,
        });
        if (f && f.ok && f.bytes && f.bytes <= MAX_FORM_BYTES) {
          formPdfBase64 = f.base64;
        } else {
          // Record why rather than retrying it for ever on every sync — see
          // connector/src/main/portalReturns.js for the full reasoning.
          formError = !f ? "no response from the portal"
            : f.bytes > MAX_FORM_BYTES ? "the portal returned " + (f.bytes / 1048576).toFixed(1) + " MB, past the " + (MAX_FORM_BYTES / 1048576) + " MB limit"
              : "the portal returned " + (f.status || "no status");
          log("returns: AY " + ay + " form fetch failed — " + formError);
        }
        await jsleep(120, 320);
      }

      const orders = [];
      for (const row of (r.itrPanDetlList || [])) {
        const section = ORDER_ACTIVITIES[Number(row && row.itrActivityCd)];
        if (!section) continue;
        const detail = activityDetail(row);
        const refNo = String(detail.commRefNo || "").trim();
        if (!refNo || knownOrders.has(refNo)) continue;
        if (lockedRefs.has(refNo) && !creds.canUnlockOrders) continue;

        const order = {
          commRefNo: refNo, section,
          statusDesc: row.statusDesc || "",
          activityCd: String(row.itrActivityCd || ""),
          orderDate: javaDate(detail.orderDt) || javaDate(detail.intimationDt) || "",
          emailedOn: javaDate(detail.emailDt) || "",
          demand: detail.computedDemndAmt != null ? String(detail.computedDemndAmt) : "",
          refund: detail.computedRefndAmt != null ? String(detail.computedRefndAmt) : "",
          contentBase64: null, locked: false, lockReason: "",
        };

        if (Number(ay) < DIRECT_DOWNLOAD_FROM_AY) {
          // Record it so the year does not look empty, and say why the file is
          // missing rather than showing nothing.
          order.lockReason = "request-only";
          orders.push(order);
          continue;
        }

        fetched += 1;
        const got = await NET.postBinary({ path: DOC_INTIMATION_PATH, serviceName: "NA", payload: { refno: refNo, year: ay, entityNum: pan } });
        if (got && got.ok && got.bytes && got.bytes <= MAX_RETURN_PDF_BYTES) {
          order.contentBase64 = got.base64;
          order.bytes = got.bytes;
        } else {
          order.lockReason = "unavailable";
        }
        orders.push(order);
        await jsleep(120, 320);
      }

      // A return we already hold, with no new order and no form to attach, is
      // nothing to say.
      if (!isNew && !orders.length && !formPdfBase64 && !formError) continue;

      const ret = {
        pan, ay, ackNum,
        formTypeCd: r.formTypeCd || "",
        filingTypeCd: r.filingTypeCd || "",
        filedOn: r.ackDt || null,
        efileStatus: r.efileStatus || "",
        statusDesc: (r.itrPanDetlList && r.itrPanDetlList[0] && r.itrPanDetlList[0].statusDesc) || "",
        verified: r.verStatus === "Y",
        verifiedMode: r.verMode || "",
        verifiedOn: r.verDt || null,
        demandAmt: r.demandAmt || "",
        refundAmt: r.refundAmt || "",
        computedDemndAmt: r.computedDemndAmt || "",
        computedRefndAmt: r.computedRefndAmt || "",
        submitBy: r.submitBy || "",
        timeline: (r.itrPanDetlList || []).map((row) => ({
          activityCd: String(row.itrActivityCd || ""),
          statusDesc: row.statusDesc || "",
          activityDt: row.activityDt || null,
        })),
        itrJson: isNew ? itrJson : null,
        ackPdfBase64,
        formPdfBase64,
        formPdfError: formError || null,
        orders,
      };
      log("returns: AY", ay, "ack", ackNum, "orders", orders.length);
      chrome.runtime.sendMessage({ type: "SYNC_DATA", payload: { assesseeId: creds.assesseeId, kind: "return", return: ret } }, () => {});
      await jsleep(120, 320);
    }

    // A run that changed nothing should say so — silence after a list call is
    // indistinguishable from a stall.
    if (!fetched) {
      log("returns: already up to date — " + list.length + " assessment year(s) on file");
      badge.set("Returns already up to date");
    }

    // Older years without a rendered form are a deliberate omission, not
    // pending work — do not promise a later run that will never come.
    if (formsOnDemand) {
      log("returns: " + formsOnDemand + " older year(s) keep their form PDF off the sync — use Fetch form");
    }
  }

  // The fully rendered ITR form for ONE year, fetched when the Returns tab asks
  // for it. The sync pulls these too, but rations them (see syncReturns), so
  // this is how a practitioner gets a deferred year immediately instead of
  // waiting for the next few syncs to work back through the history.
  async function fetchReturnForm(creds, badge, pan) {
    const req = creds.formRequest || {};
    const ackNum = String(req.ackNum || "");
    const ay = String(req.ay || "");
    if (!ackNum || !ay) return;
    badge.set("Fetching the ITR form for A.Y. " + ay + "…");
    const got = await NET.postBinary({
      path: ITR_PREVIEW_PATH + encodeURIComponent(ay),
      serviceName: "NA",
      payload: { ackNum, loggedInUserId: pan },
      extraHeaders: { ackNum },
      timeoutMs: 180000, // this one really is 11 MB
    });
    const ok = got && got.ok && got.bytes;
    log("returnForm:", ay, ok ? got.bytes + " bytes" : "failed");
    chrome.runtime.sendMessage({
      type: "SYNC_DATA",
      payload: {
        assesseeId: creds.assesseeId, kind: "returnForm",
        form: { ay, ackNum, contentBase64: ok ? got.base64 : null, bytes: ok ? got.bytes : 0 },
      },
    }, () => {});
  }

  // The extra passes a full sync runs beyond e-Proceedings. Guarded so the two
  // call sites (proceedings found / none found) can never run them twice.
  let fullExtrasDone = false;
  async function syncFullExtras(creds, badge, pan) {
    if (fullExtrasDone) return;
    fullExtrasDone = true;
    try { await syncAppealForms(creds, badge, pan); } catch (e) { log("appeals error", e); }
    try { await syncReturns(creds, badge, pan); } catch (e) { log("returns error", e); }
  }

  /* ---------- log out + close the tab once a sync is done ---------- */
  function requestCloseTab() { try { chrome.runtime.sendMessage({ type: "CLOSE_TAB" }, () => {}); } catch { /* noop */ } }
  function tryLogout() {
    const el = [...document.querySelectorAll('a, button, span, [role="menuitem"]')].filter(isVisible)
      .find((x) => /^log\s?out$/i.test((x.textContent || "").trim()));
    if (el) { realClick(el); return true; }
    return false;
  }
  async function logoutAndClose(badge, creds) {
    const bg = Boolean(creds && creds.background);
    badge.set("Sync complete — logging out…");
    await jsleep(...(bg ? PACE.bgPreLogout : PACE.fgPreLogout)); // was 3500 (cosmetic)
    try { tryLogout(); } catch { /* noop */ }
    await jsleep(...(bg ? PACE.bgPostLogout : PACE.fgPostLogout)); // let logout register
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

    // Sync scope (from the app's dropdown):
    //   "all"     — FYA + FYI + notices/orders/replies + Form 35 + filed returns.
    //   "eproc"   — FYA only → diff → new notices/orders; no FYI scan, no Form 35.
    //   "appeals" — filed Form 35s only, nothing else.
    //   "returns" — filed ITRs + s.143(1) intimations and s.154 orders only.
    const scope = creds.scope || "all";

    if (scope === "appeals") {
      log("scope=appeals — Form 35 only");
      badge.set("Fetching filed appeals (Form 35)…");
      try { await syncAppealForms(creds, badge, pan); } catch (e) { log("appeals error", e); }
      await logoutAndClose(badge, creds);
      return true;
    }

    if (scope === "returns") {
      log("scope=returns — filed ITRs + CPC orders only");
      try { await syncReturns(creds, badge, pan); } catch (e) { log("returns error", e); }
      await logoutAndClose(badge, creds);
      return true;
    }

    if (scope === "returnForm") {
      log("scope=returnForm — one ITR form PDF on demand");
      try { await fetchReturnForm(creds, badge, pan); } catch (e) { log("returnForm error", e); }
      await logoutAndClose(badge, creds);
      return true;
    }

    const t0 = performance.now();
    const fya = await NET.proceedings({ pan, statusFlag: "FYA", pageSize: 100 });
    const rows = [];
    const push = (res, tab) => {
      const list = res && res.json && res.json.eProceedingPaginatedRequests;
      if (Array.isArray(list)) for (const o of list) rows.push(mapRow(o, tab));
    };
    push(fya, "For your Action");
    // A full sync also pulls the FYI (closed) list; e-Proceedings-only skips it.
    if (scope === "all") {
      const fyi = await NET.proceedings({ pan, statusFlag: "FYI", pageSize: 100 });
      push(fyi, "For your Information");
    }
    const ms = Math.round(performance.now() - t0);

    // e-Proceedings-only closure detection: a proceeding we knew as ACTIVE that
    // is no longer in FYA has just closed — add a synthetic (closed) row so its
    // closure order is fetched and its matter flips to Closed, WITHOUT scanning
    // the whole FYI list.
    if (scope === "eproc") {
      const fyaIds = new Set(rows.map((r) => r.proceedingReqId).filter(Boolean));
      let added = 0;
      for (const pid of (creds.knownActiveProcs || [])) {
        const id = String(pid || "");
        if (id && !fyaIds.has(id)) {
          rows.push({ tab: "For your Information", proceedingStatus: "C", name: "", ay: "", section: "", pan, assessee: "", proceedingReqId: id, viewNoticeCount: 0, closureSeqNo: "" });
          added++;
        }
      }
      if (added) log("eproc: " + added + " proceeding(s) left FYA (just closed) — will fetch their orders");
    }

    if (!rows.length) {
      // Nothing in FYA (and, for a full sync, nothing in FYI either).
      if (scope === "eproc") { log("eproc: FYA empty — nothing to do, logging out"); await logoutAndClose(badge, creds); return true; }
      // A clean compliance record is the normal state for most assessees, and it
      // says nothing about their filed returns — run the full-sync extras before
      // handing back to the scrape fallback, or a PAN with no proceedings would
      // never get its returns pulled at all.
      if (scope === "all") await syncFullExtras(creds, badge, pan);
      log("direct api: no rows", { fya: fya && fya.status, err: fya && fya.error }); return false;
    }

    log("DIRECT API OK (" + scope + ") — " + rows.length + " proceedings in " + ms + " ms");
    badge.set("API sync ✓ " + rows.length + " proceedings in " + ms + " ms");
    chrome.runtime.sendMessage({ type: "SYNC_DATA", payload: { assesseeId: creds.assesseeId, kind: "proceedings", via: "api", ms, endpoint: "/auth/getEntity · eProceedingsPaginatedService", proceedings: rows } }, () => {});
    // Then pull each proceeding's notices/orders + PDFs (incremental).
    try { await syncNotices(creds, badge, pan, rows); }
    catch (e) { log("notices error", e); }
    // Form 35 appeals and filed returns — only on a full sync; e-Proceedings-only
    // deliberately skips the (expensive) Form 35 render.
    if (scope === "all") await syncFullExtras(creds, badge, pan);
    // Done — log out and close the portal tab so no session is left open.
    await logoutAndClose(badge, creds);
    return true;
  }

  // Master data: the taxpayer's own profile (name, DOB, address) + jurisdiction
  // / Assessing Officer. Both are plain cookie-authenticated services (sn ==
  // serviceName), so no token capture or UI navigation is needed. We send the
  // raw fields back; the app formats the name/address and resolves the state.
  async function syncMaster(creds, badge, pan) {
    badge.set("Fetching master data…");
    const master = { clientRef: creds.clientRef || null, pan };

    const pd = await NET.apiCall({
      path: SERVICES_SAVE_PATH, serviceName: "myPanDetailsService",
      payload: { serviceName: "myPanDetailsService", contactPan: pan, userId: pan },
    });
    if (pd && pd.json && !(pd.json.errors && pd.json.errors.length)) {
      const j = pd.json;
      master.firstNm = j.firstNm || ""; master.midNm = j.midNm || ""; master.surname = j.surname || "";
      master.dobEpoch = j.dob || null; master.incorporateDate = j.incorporateDate || "";
      master.addrLines = [j.commnLine1, j.commnLine2, j.commnLine3, j.commnLine4, j.commnLine5].map((x) => x || "");
      master.stateCode = (j.commnState != null ? String(j.commnState) : "");
      master.pin = (j.commnPin != null ? String(j.commnPin) : "");
      master.sex = j.sex || "";
    } else { log("master: pan details empty", pd && pd.status); }

    const jd = await NET.apiCall({
      path: SERVICES_SAVE_PATH, serviceName: "jurisdictionDetailsService",
      payload: { serviceName: "jurisdictionDetailsService", loggedInUserId: pan },
    });
    if (jd && jd.json && !(jd.json.errors && jd.json.errors.length)) {
      const j = jd.json;
      master.jurisdiction = {
        ward: j.aoPplrName || "", aoEmail: j.aoEmailId || "", building: j.aoBldgDesc || "",
        area: j.areaDesc || "", areaCd: j.areaCd || "", range: j.rangeCd || "", aoNo: j.aoNo || "", aoType: j.aoType || "",
      };
    } else { log("master: jurisdiction empty", jd && jd.status); }

    // The taxpayer's own primary email + mobile live on the full-profile
    // service. Field names vary (priEmailId / primEmailId / priMobileNum / …),
    // so pull them by shape: an "@" value under an email-ish key, a digit run
    // under a mobile-ish key, preferring the primary (pri*/prim*) one.
    const up = await NET.apiCall({
      path: SERVICES_SAVE_PATH, serviceName: "userProfileService",
      payload: { serviceName: "userProfileService", userId: pan },
    });
    if (up && up.json && !(up.json.errors && up.json.errors.length)) {
      const c = pickContact(up.json);
      if (c.email) master.email = c.email;
      if (c.mobile) master.mobile = c.mobile;
    } else { log("master: user profile empty", up && up.status); }

    chrome.runtime.sendMessage({ type: "SYNC_DATA", payload: { assesseeId: creds.assesseeId, kind: "master", master } }, () => {});
    badge.set("Master data fetched ✓");
  }

  // Extract the taxpayer's primary email + mobile from a profile JSON without
  // hard-coding field names: match by key hint + value shape, prefer primary.
  function pickContact(j) {
    const emails = [], mobiles = [];
    const rank = (k) => /^pri(m)?/i.test(k) ? 0 : /prim/i.test(k) ? 1 : 2;
    for (const k of Object.keys(j || {})) {
      const v = j[k];
      if (typeof v !== "string" && typeof v !== "number") continue;
      const s = String(v).trim();
      if (/e[-]?mail/i.test(k) && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) emails.push([k, s]);
      if (/mob|phone|cell/i.test(k)) { const digits = s.replace(/\D/g, ""); if (digits.length >= 10 && digits.length <= 13) mobiles.push([k, s.replace(/\s+/g, "")]); }
    }
    emails.sort((a, b) => rank(a[0]) - rank(b[0]));
    mobiles.sort((a, b) => rank(a[0]) - rank(b[0]));
    return { email: emails[0] ? emails[0][1] : "", mobile: mobiles[0] ? mobiles[0][1] : "" };
  }

  async function beginMasterSync(creds, badge) {
    // Keep the portal's logout guard dismissed while we work.
    const logoutGuard = setInterval(dismissLogoutDialog, 350);
    setTimeout(() => clearInterval(logoutGuard), 20000);
    await sleep(1500); // let the dashboard land + set the session cookie
    const pan = (NET.pan() || creds.portalUserId || "").toString().toUpperCase().trim();
    if (/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) {
      try { await syncMaster(creds, badge, pan); }
      catch (e) { log("master error", e); badge.set("Master fetch failed — fill details manually.", true); }
    } else {
      badge.set("Couldn't read the PAN — fill details manually.", true);
    }
    await logoutAndClose(badge, creds);
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
