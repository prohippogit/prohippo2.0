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

const { jsleep, POLL } = require("./pacing");
const { PORTAL } = require("./config");

const LOGIN_TIMEOUT_MS = 90000;

// Subresources the login screen doesn't need. Blocking these is the single
// cheapest win in the whole login path — the portal's SPA pulls a lot of
// artwork and webfonts we never look at.
//
// Stylesheets are deliberately NOT in this list. The state machine below decides
// what's visible with getBoundingClientRect() / offsetParent, and this is an
// Angular Material app whose control geometry comes entirely from CSS — blocking
// it would break the detection rather than speed it up.
const BLOCKED_DURING_LOGIN = new Set(["image", "media", "font"]);

async function blockHeavyAssets(context) {
  const handler = (route) => {
    if (BLOCKED_DURING_LOGIN.has(route.request().resourceType())) return route.abort();
    return route.continue();
  };
  await context.route("**/*", handler);
  // Lifted as soon as we're logged in, so nothing in the fetch phase is touched.
  return () => context.unroute("**/*", handler).catch(() => {});
}

// The session cookie lands a moment after the password step returns. Rather than
// sleeping a blind ~1.2s, watch the portal's cookie jar and continue the instant
// it stops changing — typically ~350ms. Capped, so a quiet jar can never wedge
// the sync; hitting the cap just means we waited as long as the old code did.
async function settleSession(page) {
  const context = page.context();
  const deadline = Date.now() + 1500;
  let prevCount = -1;
  let stableTicks = 0;
  while (Date.now() < deadline) {
    let count;
    try {
      count = (await context.cookies(PORTAL.origin)).length;
    } catch {
      return; // context going away — nothing useful left to wait for
    }
    if (count > 0 && count === prevCount) {
      if (++stableTicks >= 2) return;
    } else {
      stableTicks = 0;
    }
    prevCount = count;
    await jsleep(90, 150);
  }
}

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
  const unblock = await blockHeavyAssets(page.context());
  try {
    await page.goto(PORTAL.origin + PORTAL.loginPath, { waitUntil: "domcontentloaded" });

    let state = { sawPassword: false, retried: false, lastUid: "", lastPwd: "" };
    const started = Date.now();
    let first = true;

    // Poll with a jittered cadence — never a fixed interval.
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

      if (status === "dual") emit("login", "Dual login — taking over the existing session…", "info", 8);
      else if (status === "userid") emit("login", "Entered User ID…", "info", 8);
      else if (status === "password") emit("login", "Entered password…", "info", 14);
      else if (status === "expired-retrying") emit("login", "Session expired — retrying login…", "warn");

      if (status === "logged-in") break;
      if (status === "expired-failed") {
        throw new Error(
          "Portal keeps ending the session. Log out of the Income-tax portal in " +
          "every other tab, browser and device, then run the sync again."
        );
      }
    }

    // We're off the login screen and the session cookie is set. The sync calls
    // the JSON API directly with that cookie, so we do NOT navigate anywhere —
    // any URL change (even a hash nudge to the dashboard) trips the portal's
    // "disabled Back/Forward — Logout?" guard. Wait only until the cookie jar
    // has actually settled.
    await settleSession(page);
    emit("login", "Logged in", "success", 20);
  } finally {
    await unblock();
  }
}

// The portal pops a "For security reasons… Are you sure you want to Logout?"
// modal on any navigation. If it ever shows, click "No" so it never blocks the
// sync. Returns an async stop(); call it in a finally.
//
// This used to poll page.evaluate every 400ms for the entire sync — ~150 CDP
// round trips a minute per context, contending with the API calls we actually
// care about, to watch for a dialog that can barely ever appear (we never
// navigate after login). Now it installs a MutationObserver once and reacts.
//
// The observer's check is deliberately cheap: a querySelector for the dialog
// container, and only then textContent on that container. Reading
// document.body.innerText — as the old poll did — forces a full layout, which on
// a busy Angular page would make an observer *worse* than polling.
async function startLogoutGuard(page) {
  await page
    .evaluate(() => {
      if (window.__phLogoutGuard) return;
      const DIALOG_SEL =
        "mat-dialog-container, .mat-dialog-container, .mat-mdc-dialog-container, [role='dialog']";
      let scheduled = false;
      const check = () => {
        scheduled = false;
        const dlg = document.querySelector(DIALOG_SEL);
        if (!dlg) return;
        if (!/want to logout|disabled back/i.test(dlg.textContent || "")) return;
        const btn = [...dlg.querySelectorAll("button, a")].find((x) =>
          /^(no|cancel)$/i.test((x.textContent || "").trim())
        );
        if (btn) btn.click();
      };
      // Coalesce mutation bursts into one check per microtask.
      const observer = new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        Promise.resolve().then(check);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      window.__phLogoutGuard = observer;
      check(); // in case the dialog is already up
    })
    .catch(() => { /* page busy — the guard is best-effort */ });

  return async () => {
    await page
      .evaluate(() => {
        if (!window.__phLogoutGuard) return;
        window.__phLogoutGuard.disconnect();
        delete window.__phLogoutGuard;
      })
      .catch(() => { /* page already gone */ });
  };
}

module.exports = { login, startLogoutGuard };
