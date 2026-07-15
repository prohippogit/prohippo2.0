/*
 * ProHippo Sync — Income-tax portal auto-login.
 *
 * Runs on incometax.gov.in. It first asks the background worker whether a
 * credential was stashed for THIS tab (i.e. the tab ProHippo just opened). If
 * not, it does nothing — so normal browsing of the portal is unaffected.
 *
 * The e-filing login is a two-step Angular form:
 *   1. enter User ID (PAN)      -> Continue
 *   2. enter Password           -> Continue
 * The exact field names can change; detection below is deliberately
 * heuristic and may need one calibration pass against the live portal.
 * A status badge gives the user feedback and a manual fallback.
 */
(function () {
  const EPROCEEDINGS_HASH = "#/pendingActions/eProceedings"; // best-effort; calibrate

  chrome.runtime.sendMessage({ type: "GET_PORTAL_CREDS" }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok || !resp.creds) return; // not our tab
    run(resp.creds);
  });

  function run(creds) {
    const badge = makeBadge();
    let step = 1;               // 1 = user id, 2 = password
    let userSubmitted = false;
    let passwordSubmitted = false;
    const started = Date.now();

    const tick = () => {
      if (Date.now() - started > 45000) { stop(); return; }
      if (passwordSubmitted) {
        badge.set("Logging in…");
        // Once we leave the login screen, try to land on e-Proceedings.
        if (!/login/i.test(location.hash) && !/login/i.test(location.pathname)) {
          setTimeout(() => { try { location.hash = EPROCEEDINGS_HASH; } catch { /* noop */ } }, 1500);
          stop();
        }
        return;
      }

      const pwd = findPassword();
      if (pwd) {
        step = 2;
        // Tick any "confirm secure access message" checkbox before submitting.
        const chk = findVisible('input[type="checkbox"]');
        if (chk && !chk.checked) { chk.click(); }
        setValue(pwd, creds.portalPassword);
        badge.set("Entered password — signing in…");
        if (clickContinue()) { passwordSubmitted = true; }
        return;
      }

      if (step === 1 && !userSubmitted) {
        const uid = findUserId();
        if (uid) {
          setValue(uid, creds.portalUserId);
          badge.set("Entered User ID…");
          if (clickContinue()) { userSubmitted = true; }
        }
      }
    };

    const timer = setInterval(tick, 700);
    const obs = new MutationObserver(tick);
    obs.observe(document.documentElement, { childList: true, subtree: true });
    tick();

    function stop() {
      clearInterval(timer);
      obs.disconnect();
      if (!passwordSubmitted) {
        badge.set("Couldn't fill the form automatically — please log in; ProHippo will remember this tab.", true);
        setTimeout(() => badge.remove(), 8000);
      } else {
        setTimeout(() => badge.remove(), 4000);
      }
    }
  }

  /* ---------- field detection (heuristic) ---------- */

  function isVisible(el) {
    if (!el || el.disabled) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.offsetParent !== null;
  }
  function findVisible(selector) {
    for (const el of document.querySelectorAll(selector)) if (isVisible(el)) return el;
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
    // Fallback: first visible text-like input that isn't a password.
    for (const el of document.querySelectorAll('input')) {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (["text", "tel", "email", ""].includes(t) && isVisible(el)) return el;
    }
    return null;
  }
  function clickContinue() {
    const btns = [...document.querySelectorAll('button, input[type="submit"]')].filter(isVisible);
    let b = btns.find((x) => /continue|login|sign in|proceed/i.test((x.textContent || x.value || "").trim()));
    if (!b) b = btns.find((x) => x.type === "submit");
    if (b) { b.click(); return true; }
    return false;
  }

  /* ---------- value setting that Angular notices ---------- */
  function setValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
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
