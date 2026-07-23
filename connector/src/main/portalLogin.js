// Portal login — Playwright port of the login state machine in
// extension/portal-login.js.
//
// The portal is an Angular SPA that renders the login steps progressively
// (User ID → [secure-access confirm] → Password → Dashboard), and it guards
// against Back/Forward/URL changes. The extension drove this with a jittered
// poll loop; we keep exactly that shape here:
//
//   - ONE tick of the state machine runs in the page context (page.evaluate),
//     a faithful port of run()'s tick + its helpers. It performs the DOM action
//     and returns a short status.
//   - The Node side owns pacing (randomised POLL gaps) and the overall timeout,
//     and decides when we're done.
//
// The password is passed into the page only to be typed into the field; it is
// never logged or persisted.
"use strict";

const { rand, jsleep, POLL } = require("./pacing");
const { PORTAL } = require("./config");

const LOGIN_TIMEOUT_MS = 90000;

// This function is serialized and executed IN THE PAGE. Keep it self-contained
// (no closures over Node scope). It mirrors the extension's run() tick and its
// helper functions one-to-one. Returns { status, state } where state carries
// sawPassword / retried across ticks.
function tickInPage({ creds, state }) {
  const s = { ...state };

  /* ---------- detection (ported) ---------- */
  const onLoginScreen = () =>
    /\/login/i.test(location.href) || /\/login/i.test(location.hash);
  const isSessionExpired = () =>
    /sessionExpire/i.test(location.href) ||
    /sessionExpire/i.test(location.hash) ||
    /session has expired/i.test(document.body.innerText || "");
  const isVisible = (el) => {
    if (!el || el.disabled) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.offsetParent !== null;
  };
  const findVisible = (sel) => {
    for (const el of document.querySelectorAll(sel)) if (isVisible(el)) return el;
    return null;
  };
  const findPassword = () => findVisible('input[type="password"]');
  const findUserId = () => {
    const guesses = [
      'input[formcontrolname*="userId" i]', "input#userId", 'input[name*="userId" i]',
      'input[placeholder*="user id" i]', 'input[placeholder*="PAN" i]', 'input[placeholder*="Aadhaar" i]',
    ];
    for (const g of guesses) { const el = findVisible(g); if (el) return el; }
    for (const el of document.querySelectorAll("input")) {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (["text", "tel", "email", ""].includes(t) && isVisible(el)) return el;
    }
    return null;
  };
  const cssEscape = (str) =>
    window.CSS && CSS.escape ? CSS.escape(str) : String(str).replace(/[^a-zA-Z0-9_-]/g, "\\$&");

  /* ---------- value + click (ported) ---------- */
  const setValue = (el, value) => {
    el.focus();
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  };
  const realClick = (el) => {
    const o = { bubbles: true, cancelable: true, view: window };
    try { el.dispatchEvent(new PointerEvent("pointerdown", o)); } catch { /* noop */ }
    el.dispatchEvent(new MouseEvent("mousedown", o));
    try { el.dispatchEvent(new PointerEvent("pointerup", o)); } catch { /* noop */ }
    el.dispatchEvent(new MouseEvent("mouseup", o));
    el.dispatchEvent(new MouseEvent("click", o));
    el.click();
  };
  const tickConfirmCheckbox = () => {
    let acted = false;
    for (const chk of document.querySelectorAll('input[type="checkbox"]')) {
      if (chk.checked) continue;
      const wrap =
        chk.closest("mat-checkbox, .mat-checkbox, .mat-mdc-checkbox") ||
        (chk.id && document.querySelector('label[for="' + cssEscape(chk.id) + '"]')) ||
        chk.closest("label") || chk.parentElement || chk;
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
  };
  const clickContinue = () => {
    const btns = [...document.querySelectorAll('button, input[type="submit"], a[role="button"]')].filter(isVisible);
    const text = (x) => (x.textContent || x.value || "").trim();
    let b = btns.find((x) => /^\s*(continue|proceed)\b/i.test(text(x)));
    if (!b) b = btns.find((x) => /^(verify|submit)\b/i.test(text(x)));
    if (!b) b = btns.find((x) => x.type === "submit");
    if (!b) return false;
    if (b.disabled || b.getAttribute("aria-disabled") === "true") return false;
    realClick(b);
    return true;
  };
  const handleDualLogin = () => {
    const btn = [...document.querySelectorAll("button, a")].filter(isVisible)
      .find((x) => /^login\s*here$/i.test((x.textContent || "").trim()));
    if (!btn || btn.disabled || btn.getAttribute("aria-disabled") === "true") return false;
    realClick(btn);
    return true;
  };
  const clickSessionExpiryLogin = () => {
    const link = [...document.querySelectorAll("a, button")].filter(isVisible)
      .find((x) => /^login$/i.test((x.textContent || "").trim()));
    if (!link) return false;
    realClick(link);
    return true;
  };

  /* ---------- state machine (ported from run()'s tick) ---------- */
  // Dual Login Detected — take over the existing session.
  if (handleDualLogin()) return { status: "dual", state: s };

  // Session expired — retry the on-screen Login link once, else give up.
  if (isSessionExpired()) {
    if (!s.retried && clickSessionExpiryLogin()) {
      s.retried = true; s.sawPassword = false; s.lastUid = ""; s.lastPwd = "";
      return { status: "expired-retrying", state: s };
    }
    return { status: "expired-failed", state: s };
  }

  // Logged in once we've entered the password and left the login screen.
  if (s.sawPassword && !onLoginScreen()) return { status: "logged-in", state: s };

  // Password step.
  const pwd = findPassword();
  if (pwd) {
    s.sawPassword = true;
    if (s.lastPwd !== creds.portalPassword) { setValue(pwd, creds.portalPassword); s.lastPwd = creds.portalPassword; }
    tickConfirmCheckbox();
    clickContinue();
    return { status: "password", state: s };
  }

  // User ID step.
  const uid = findUserId();
  if (uid) {
    if (s.lastUid !== creds.portalUserId) { setValue(uid, creds.portalUserId); s.lastUid = creds.portalUserId; }
    clickContinue();
    return { status: "userid", state: s };
  }

  // Intermediate / still loading — nudge any confirm checkbox.
  if (onLoginScreen()) tickConfirmCheckbox();
  return { status: "waiting", state: s };
}

// Drive the login to completion for one PAN. Throws on timeout or a hard
// session-expiry loop. On success the caller is on the portal dashboard.
async function login(page, cred, emit) {
  await page.goto(PORTAL.origin + PORTAL.loginPath, { waitUntil: "domcontentloaded" });

  let state = { sawPassword: false, retried: false, lastUid: "", lastPwd: "" };
  const started = Date.now();
  let first = true;

  // Poll with a jittered cadence — never a fixed interval.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() - started > LOGIN_TIMEOUT_MS) {
      throw new Error("Login timed out after 90s — the portal may be slow or the credential wrong.");
    }
    await jsleep(
      first ? POLL.firstMin : POLL.min,
      first ? POLL.firstMax : POLL.max
    );
    first = false;

    const creds = { portalUserId: cred.portalUserId, portalPassword: cred.portalPassword };
    const { status, state: next } = await page.evaluate(tickInPage, { creds, state });
    state = next;

    if (status === "dual") emit("login", "Dual login — taking over the existing session…");
    else if (status === "userid") emit("login", "Entered User ID…");
    else if (status === "password") emit("login", "Entered password…");
    else if (status === "expired-retrying") emit("login", "Session expired — retrying login…", "warn");

    if (status === "logged-in") break;
    if (status === "expired-failed") {
      throw new Error(
        "Portal keeps ending the session. Log out of the Income-tax portal in " +
        "every other tab, browser and device, then run the sync again."
      );
    }
  }

  // We're off the login screen and the session cookie is set. The sync calls the
  // JSON API directly with that cookie, so we do NOT navigate anywhere — any URL
  // change (even a hash nudge to the dashboard) trips the portal's "disabled
  // Back/Forward — Logout?" guard. Just settle so the cookie is fully in place.
  await jsleep(900, 1500);
  emit("login", "Logged in", "success");
}

// The portal pops a "For security reasons… Are you sure you want to Logout?"
// modal on any navigation. If it ever shows, keep clicking "No" so it never
// blocks the sync. Port of dismissLogoutDialog from the extension. Returns a
// stop() function; run it for the whole sync and stop() in a finally.
function startLogoutGuard(page) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await page.evaluate(() => {
        const txt = document.body.innerText || "";
        if (!/want to logout|disabled back/i.test(txt)) return;
        const btn = [...document.querySelectorAll("button, a")]
          .filter((el) => el && el.offsetParent !== null)
          .find((x) => /^(no|cancel)$/i.test((x.textContent || "").trim()));
        if (btn) btn.click();
      });
    } catch { /* page busy / navigating — try again next tick */ }
    if (!stopped) setTimeout(tick, 400);
  };
  setTimeout(tick, 200);
  return () => { stopped = true; };
}

module.exports = { login, startLogoutGuard };
