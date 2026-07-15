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
  const BUILD = "v8";
  const INTERVAL_MS = 1000;

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

        // Logged in once we leave the login screen. Do NOT change the URL to
        // jump to e-Proceedings — the portal treats Back/Forward/URL changes as
        // a blocked action and prompts logout. Navigate by clicking the menu.
        if (sawPassword && !onLoginScreen()) {
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
        let ok = false; try { ok = pred(); } catch { ok = false; }
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
  async function goToEProceedings() {
    // 1) Direct router-link click (works even if the dropdown is closed).
    let link = findEProceedingsLink();
    if (link) { realClick(link); await sleep(1500); if (/eProceedings/i.test(location.href)) return; }
    // 2) Open the "Pending Actions" menu (hover + click), then click the item.
    const trig = findByText(["Pending Actions"]);
    if (trig) {
      for (const t of ["pointerenter", "mouseenter", "mouseover", "mousedown", "mouseup", "click"]) {
        try { trig.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); } catch { /* noop */ }
      }
    }
    await waitFor(() => !!findEProceedingsLink() || !!findByText(["e-Proceeding"]), 6000);
    link = findEProceedingsLink() || findByText(["e-Proceeding"]);
    if (link) realClick(link);
    await sleep(1500);
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
  async function beginSync(creds, badge) {
    badge.set("Opening e-Proceedings…");
    await goToEProceedings();
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
