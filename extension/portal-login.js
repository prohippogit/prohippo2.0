/*
 * ProHippo Sync — Income-tax portal auto-login.  (badge shows build tag)
 *
 * Asks the background worker for a credential stashed for THIS tab. If none,
 * does nothing. Otherwise fills the multi-step Angular login:
 *   User ID -> Continue  [-> secure-access confirm -> Continue]  -> Password -> Continue
 * Angular briefly disables Continue after a field changes, so we re-attempt
 * every tick. Field/button detection is heuristic and may need calibration.
 */
(function () {
  const BUILD = "v3";
  const EPROCEEDINGS_HASH = "#/pendingActions/eProceedings"; // best-effort; calibrate

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
    let navigated = false;
    let sawPassword = false;
    let uidSet = false;
    let pwdSet = false;
    log("started");

    const finish = (ok, msg) => {
      clearInterval(timer);
      obs.disconnect();
      badge.set(msg || (ok ? "Logged in — opening e-Proceedings…" : "Couldn't finish — please continue manually."), !ok);
      setTimeout(() => badge.remove(), ok ? 4000 : 10000);
    };

    const tick = () => {
      if (navigated) return;
      if (Date.now() - started > 60000) { finish(false); return; }

      if (sawPassword && !onLoginScreen()) {
        navigated = true;
        setTimeout(() => { try { location.hash = EPROCEEDINGS_HASH; } catch { /* noop */ } }, 1500);
        finish(true);
        return;
      }

      // Password step.
      const pwd = findPassword();
      if (pwd) {
        sawPassword = true;
        if (!pwdSet || pwd.value !== creds.portalPassword) { setValue(pwd, creds.portalPassword); pwdSet = true; badge.set("Entered password…"); }
        tickConfirmCheckbox();
        const clicked = clickContinue();
        log("password step, continue clicked=", clicked);
        return;
      }

      // User ID step.
      const uid = findUserId();
      if (uid) {
        // Always drive the value through events at least once so Angular's
        // model updates even if the box was pre-filled by the browser.
        if (!uidSet || uid.value !== creds.portalUserId) { setValue(uid, creds.portalUserId); uidSet = true; badge.set("Entered User ID…"); }
        const clicked = clickContinue();
        log("userid step, continue clicked=", clicked);
        return;
      }

      // Intermediate page (secure-access confirm) with no input.
      if (onLoginScreen()) { tickConfirmCheckbox(); clickContinue(); }
    };

    const timer = setInterval(tick, 700);
    const obs = new MutationObserver(tick);
    obs.observe(document.documentElement, { childList: true, subtree: true });
    tick();
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
  function tickConfirmCheckbox() {
    const chk = findVisible('input[type="checkbox"]');
    if (chk && !chk.checked) realClick(chk);
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

  /* ---------- robust value + click ---------- */
  function setValue(el, value) {
    el.focus();
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
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

  /* ---------- badge (shows build tag so you can confirm the reload) ---------- */
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
