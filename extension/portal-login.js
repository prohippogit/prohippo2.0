/*
 * ProHippo Sync — Income-tax portal auto-login.
 *
 * Runs on incometax.gov.in. Asks the background worker for a credential
 * stashed for THIS tab (the tab ProHippo just opened). If none, does nothing,
 * so normal browsing is unaffected.
 *
 * The e-filing login is a multi-step Angular form:
 *   1. enter User ID (PAN)                    -> Continue
 *   2. (secure-access confirm, if shown)      -> Continue
 *   3. enter Password (+ confirm checkbox)    -> Continue
 * Each step's primary button is labelled "Continue". Angular briefly disables
 * it right after a field changes, so we re-attempt every tick until the page
 * advances rather than clicking once. Field detection is heuristic and may
 * need calibration against the live portal.
 */
(function () {
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

    const finish = (ok) => {
      clearInterval(timer);
      obs.disconnect();
      if (ok) {
        badge.set("Logged in — opening e-Proceedings…");
        setTimeout(() => badge.remove(), 4000);
      } else {
        badge.set("Couldn't finish automatically — please continue manually.", true);
        setTimeout(() => badge.remove(), 9000);
      }
    };

    const tick = () => {
      if (navigated) return;
      if (Date.now() - started > 60000) { finish(false); return; }

      // Left the login screen => logged in. Land on e-Proceedings once.
      if (sawPassword && !onLoginScreen()) {
        navigated = true;
        setTimeout(() => { try { location.hash = EPROCEEDINGS_HASH; } catch { /* noop */ } }, 1500);
        finish(true);
        return;
      }

      // Step: Password (checked first — once it appears we're past User ID).
      const pwd = findPassword();
      if (pwd) {
        sawPassword = true;
        if (!pwd.value) { setValue(pwd, creds.portalPassword); badge.set("Entered password…"); }
        tickConfirmCheckbox();
        clickContinue();
        return;
      }

      // Step: User ID.
      const uid = findUserId();
      if (uid) {
        if (!uid.value) { setValue(uid, creds.portalUserId); badge.set("Entered User ID…"); }
        clickContinue();
        return;
      }

      // Intermediate page (e.g. secure-access confirm) with no input yet.
      if (onLoginScreen()) {
        tickConfirmCheckbox();
        clickContinue();
      }
    };

    const timer = setInterval(tick, 700);
    const obs = new MutationObserver(tick);
    obs.observe(document.documentElement, { childList: true, subtree: true });
    tick();
  }

  /* ---------- field detection (heuristic) ---------- */
  function isVisible(el) {
    if (!el || el.disabled) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.offsetParent !== null;
  }
  function findVisible(selector, root = document) {
    for (const el of root.querySelectorAll(selector)) if (isVisible(el)) return el;
    return null;
  }
  function findPassword() {
    return findVisible('input[type="password"]');
  }
  function findUserId() {
    const guesses = [
      'input[formcontrolname*="userId" i]',
      'input#userId',
      'input[name*="userId" i]',
      'input[placeholder*="user id" i]',
      'input[placeholder*="PAN" i]',
      'input[placeholder*="Aadhaar" i]',
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
    if (chk && !chk.checked) chk.click();
  }
  // Click the step's primary button. The portal labels it "Continue" (some
  // steps "Proceed"/"Verify"/"Submit"). Deliberately does NOT match "Login" to
  // avoid the header sign-in link. Returns false while it's disabled so the
  // caller keeps retrying until Angular enables it.
  function clickContinue() {
    const btns = [...document.querySelectorAll('button, input[type="submit"]')].filter(isVisible);
    const text = (x) => (x.textContent || x.value || "").trim();
    let b = btns.find((x) => /^\s*(continue|proceed)\b/i.test(text(x)));
    if (!b) b = btns.find((x) => /^(verify|submit)\b/i.test(text(x)));
    if (!b) b = btns.find((x) => x.type === "submit");
    if (b && !b.disabled && b.getAttribute("aria-disabled") !== "true") { b.click(); return true; }
    return false;
  }

  /* ---------- value setting that Angular notices ---------- */
  function setValue(el, value) {
    el.focus();
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  /* ---------- status badge ---------- */
  function makeBadge() {
    const box = document.createElement("div");
    box.style.cssText = [
      "position:fixed", "top:14px", "right:14px", "z-index:2147483647",
      "background:#6C5CE7", "color:#fff", "font:600 13px system-ui,sans-serif",
      "padding:10px 14px", "border-radius:10px", "max-width:320px",
      "box-shadow:0 6px 20px rgba(0,0,0,.25)",
    ].join(";");
    box.textContent = "ProHippo: logging you in…";
    const attach = () => (document.body || document.documentElement).appendChild(box);
    if (document.body) attach(); else window.addEventListener("DOMContentLoaded", attach);
    return {
      set: (t, warn) => { box.textContent = "ProHippo: " + t; box.style.background = warn ? "#C0392B" : "#6C5CE7"; },
      remove: () => box.remove(),
    };
  }
})();
