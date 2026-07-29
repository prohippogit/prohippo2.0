/*
 * ProHippo — referral attribution capture.
 *
 * A partner sends someone to prohippo.in/?ref=AHMCA25. That person reads the
 * page, closes the tab, and signs up four days later from a Google search.
 * This module is what makes that still count as the partner's signup.
 *
 * Two touches are recorded and both are stored:
 *   • firstTouch — kept for the whole window, never overwritten. This is what
 *     partners are paid on. First-touch is the fair rule: it credits whoever
 *     actually introduced the customer, and it stops a coupon site from
 *     intercepting the attribution at the last second.
 *   • lastTouch  — refreshed on every visit, kept for reporting.
 *
 * Nothing here decides anything. The server re-validates the code on redemption
 * (functions/referrals.js); a value in localStorage is a hint, not a grant.
 */
import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase";

const REF_KEY = "prohippo-referral";
const VISITOR_KEY = "prohippo-visitor";

// How long a click keeps earning attribution. 30 days is the industry norm and,
// more practically, about as long as a CA takes to get round to signing up.
export const ATTRIBUTION_WINDOW_DAYS = 30;

// Same normalisation as functions/adminCore.js — codes are read off WhatsApp
// forwards and business cards, so case, spaces and hyphens must not matter.
export const normaliseCode = (raw) => String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

const read = (key) => {
  try {
    return JSON.parse(window.localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
};
const write = (key, value) => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private browsing — attribution is best-effort, never a blocker */
  }
};

/* A stable per-browser id, used only to stop one person refreshing the landing
   page from inflating a partner's click count. Not a tracking identifier: it
   never leaves this origin except attached to a code the visitor was sent with. */
function visitorId() {
  try {
    let id = window.localStorage.getItem(VISITOR_KEY);
    if (!id) {
      id = (crypto.randomUUID?.() || String(Math.random()).slice(2)).replace(/-/g, "").slice(0, 32);
      window.localStorage.setItem(VISITOR_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

/*
 * Call once, as early as possible. Reads ?ref= (or ?r=), stores it, cleans the
 * URL so the code doesn't ride along into every shared link, and reports the
 * click.
 */
export function captureReferralFromUrl() {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("ref") || params.get("r");
  if (!raw) return pendingReferral();

  const code = normaliseCode(raw);
  const now = new Date().toISOString();
  if (code.length >= 4 && code.length <= 24) {
    const existing = read(REF_KEY);
    write(REF_KEY, {
      code,
      // A different code arriving later starts its own first-touch clock;
      // the same code refreshes only the last touch.
      firstTouch: existing?.code === code ? existing.firstTouch : now,
      lastTouch: now,
    });

    const visitor = visitorId();
    if (visitor) {
      httpsCallable(functions, "trackReferralVisit")({ code, visitorId: visitor })
        .catch(() => { /* a click we failed to count is not worth an error */ });
    }
  }

  // Strip the parameter but keep everything else in the URL intact.
  params.delete("ref");
  params.delete("r");
  const qs = params.toString();
  window.history.replaceState({}, document.title, window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash);

  return pendingReferral();
}

/* The stored referral, or null if there isn't one or it has aged out. */
export function pendingReferral() {
  const stored = read(REF_KEY);
  if (!stored?.code) return null;
  const age = Date.now() - Date.parse(stored.firstTouch || stored.lastTouch || 0);
  if (!Number.isFinite(age) || age > ATTRIBUTION_WINDOW_DAYS * 86400000) {
    clearReferral();
    return null;
  }
  return stored;
}

export function clearReferral() {
  try {
    window.localStorage.removeItem(REF_KEY);
  } catch { /* ignore */ }
}

/* Dry-run a code against the server. Returns { ok, message } or { ok, label, … }. */
export async function validateReferralCode(code) {
  const res = await httpsCallable(functions, "validateReferralCode")({ code: normaliseCode(code) });
  return res.data;
}

/* Attribute the signed-in account to a code. Safe to call once per signup;
   the server rejects a second attribution. */
export async function redeemReferralCode(code) {
  const stored = pendingReferral();
  const res = await httpsCallable(functions, "redeemReferralCode")({
    code: normaliseCode(code),
    firstTouch: stored?.code === normaliseCode(code) ? stored.firstTouch : undefined,
    lastTouch: stored?.code === normaliseCode(code) ? stored.lastTouch : undefined,
  });
  clearReferral();
  return res.data;
}
