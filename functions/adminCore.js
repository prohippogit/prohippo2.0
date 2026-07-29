/*
 * ProHippo — shared primitives for the admin console and the referral system.
 *
 * Everything in here is either pure (so it can be unit-tested without a
 * Firestore, see adminCore.test.mjs) or a small factory that takes `db`. The
 * two feature modules — admin.js and referrals.js — import from here so there
 * is exactly one definition of what a code looks like, when it is valid, and
 * what a discount comes to.
 *
 * MONEY IS IN PAISE. Every amount crossing this boundary is an integer number
 * of paise (₹1,499 → 149900). Rupee floats and percentage arithmetic do not
 * mix, and a subscription that silently loses ₹0.01 per invoice is a support
 * ticket nobody enjoys.
 */
"use strict";

const { HttpsError } = require("firebase-functions/v2/https");

/* ---------------- codes ---------------- */

/* Codes get read out over the phone and typed off a WhatsApp forward, so the
   generator avoids every pair that looks alike in a sans-serif font:
   O/0, I/1/L, S/5, Z/2, B/8. What survives is this. */
const CODE_ALPHABET = "ACDEFGHJKMNPQRTUVWXY34679";
const CODE_RE = /^[A-Z0-9]{4,24}$/;

/* Accept anything the user types — lowercase, spaces, hyphens, a stray
   "Code: " prefix — and reduce it to the canonical form used as the document
   id. This is the ONLY way a code string should ever be turned into a lookup
   key, on the client or the server. */
function normaliseCode(raw) {
  return String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isValidCode(code) {
  return CODE_RE.test(code);
}

/* Generate `len` random characters after an optional prefix. `rand` is
   injectable so the test can pin the output; production passes a
   crypto-backed source. */
function generateCode(prefix, len, rand) {
  const p = normaliseCode(prefix);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  }
  return p + out;
}

/* ---------------- referral funnel ---------------- */

/* A redemption only ever moves forward through these. Ranking them means a
   late-arriving webhook or a re-run of the nightly rollup can never demote
   a customer from `converted` back to `activated`. */
const STAGES = ["clicked", "signed_up", "activated", "converted", "renewed", "churned"];
const stageRank = (s) => {
  const i = STAGES.indexOf(s);
  return i === -1 ? -1 : i;
};
/* Churn is the one transition that may go "backwards" in rank terms — it is an
   end state reachable from any paid stage. */
const canAdvance = (from, to) => to === "churned" || stageRank(to) > stageRank(from);

/* ---------------- benefit maths ---------------- */

const BENEFIT_TYPES = ["percent", "flat", "free_days", "plan_grant"];

/* What a code is worth against a given list price, in paise. Returns the
   discount, what is left to pay, and any free days granted instead of money.
   Never returns a negative payable or a discount above the list price. */
function benefitFor(benefit, listPricePaise) {
  const list = Math.max(0, Math.round(listPricePaise || 0));
  const b = benefit || {};
  const value = Number(b.value) || 0;
  if (b.type === "percent") {
    const pct = Math.min(100, Math.max(0, value));
    const discount = Math.round((list * pct) / 100);
    return { discountPaise: discount, payablePaise: list - discount, freeDays: 0 };
  }
  if (b.type === "flat") {
    const discount = Math.min(list, Math.max(0, Math.round(value)));
    return { discountPaise: discount, payablePaise: list - discount, freeDays: 0 };
  }
  if (b.type === "free_days") {
    return { discountPaise: 0, payablePaise: list, freeDays: Math.max(0, Math.round(value)) };
  }
  if (b.type === "plan_grant") {
    return { discountPaise: list, payablePaise: 0, freeDays: 0 };
  }
  return { discountPaise: 0, payablePaise: list, freeDays: 0 };
}

/* Human label for a benefit — shown to the customer at checkout and in the
   admin list, so there is one wording for both. */
function benefitLabel(benefit) {
  const b = benefit || {};
  const value = Number(b.value) || 0;
  if (b.type === "percent") return `${value}% off`;
  if (b.type === "flat") return `₹${Math.round(value / 100).toLocaleString("en-IN")} off`;
  if (b.type === "free_days") return `${value} days free`;
  if (b.type === "plan_grant") return "Free plan grant";
  return "—";
}

/* Partner commission on a payment. `months` caps how long a partner keeps
   earning on the same customer; 0 or absent means forever. */
function commissionFor(code, amountPaise, monthsSinceConversion) {
  const c = (code && code.commission) || {};
  const pct = Number(c.percent) || 0;
  if (pct <= 0) return 0;
  const cap = Number(c.months) || 0;
  if (cap > 0 && Number(monthsSinceConversion || 0) >= cap) return 0;
  return Math.round((Math.max(0, amountPaise || 0) * Math.min(100, pct)) / 100);
}

/* ---------------- code validation ---------------- */

/*
 * The single decision point for "may this account use this code right now".
 * Pure: the caller loads the code doc and the context, this returns a verdict.
 *
 * ctx: {
 *   nowMs, planId, isNewCustomer, alreadyRedeemed, accountAttributedTo, selfReferral
 * }
 *
 * One code per account, one redemption per code per account — deliberately.
 * Stacking is where SaaS quietly gives away free years, and an account that can
 * be re-attributed is an account two partners will both invoice you for.
 */
function evaluateCode(code, ctx) {
  const c = ctx || {};
  if (!code) return { ok: false, reason: "not_found" };
  if (code.status !== "active") return { ok: false, reason: "inactive" };

  const now = c.nowMs || 0;
  if (code.validFrom && now < Date.parse(code.validFrom)) return { ok: false, reason: "not_started" };
  if (code.validTo && now > Date.parse(code.validTo)) return { ok: false, reason: "expired" };

  const max = Number(code.maxRedemptions) || 0;
  if (max > 0 && (Number(code.redemptions) || 0) >= max) return { ok: false, reason: "exhausted" };

  const plans = Array.isArray(code.appliesToPlans) ? code.appliesToPlans : [];
  if (plans.length && c.planId && !plans.includes(c.planId)) return { ok: false, reason: "plan_mismatch" };

  if (code.newCustomersOnly && c.isNewCustomer === false) return { ok: false, reason: "existing_customer" };

  if (c.selfReferral) return { ok: false, reason: "self_referral" };
  if (c.alreadyRedeemed) return { ok: false, reason: "already_used" };
  if (c.accountAttributedTo && c.accountAttributedTo !== code.code) {
    return { ok: false, reason: "account_attributed" };
  }

  return { ok: true, reason: null };
}

/*
 * What the CUSTOMER is told. Deliberately lossy: "expired", "exhausted" and
 * "not_found" all collapse to the same sentence, because a caller who can tell
 * them apart can enumerate which of your codes are live and which are burnt.
 * The admin console reads the raw `reason` instead.
 */
function publicReason(reason) {
  switch (reason) {
    case "already_used":
      return "You've already used this code.";
    case "account_attributed":
      return "A referral code is already applied to this account.";
    case "existing_customer":
      return "This code is only for new customers.";
    case "plan_mismatch":
      return "This code doesn't apply to the plan you've picked.";
    case "self_referral":
      return "You can't use your own referral code.";
    default:
      return "That code isn't valid. Check the spelling and try again.";
  }
}

/* ---------------- date keys ---------------- */

const dayKey = (d) => new Date(d).toISOString().slice(0, 10); // YYYY-MM-DD
const monthKey = (d) => new Date(d).toISOString().slice(0, 7); // YYYY-MM
const addDays = (iso, n) => new Date(Date.parse(iso) + n * 86400000).toISOString();

/* ---------------- auth ---------------- */

/* Admin is a CUSTOM CLAIM, never a Firestore flag — a claim is signed into the
   ID token, so rules and callables agree without an extra read, and it cannot
   be granted by anything the browser can reach. Claims are set by
   scripts/grant-admin.mjs (first admin) or adminSetRole (subsequent ones). */
function requireAdmin(request) {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  if (request.auth.token?.admin !== true) {
    throw new HttpsError("permission-denied", "Admin access required.");
  }
  return uid;
}

/* ---------------- audit ---------------- */

/*
 * Every state-changing admin action lands here. Append-only from the app's
 * point of view: firestore.rules gives admins read and nobody write, so the
 * only path in is an Admin-SDK call from a function that already checked the
 * claim.
 */
function makeAudit(db) {
  return async function audit(request, action, target, details) {
    try {
      await db.collection("adminAudit").add({
        action,
        target: target || null,
        details: details || {},
        actorUid: request.auth?.uid || null,
        actorEmail: request.auth?.token?.email || null,
        at: new Date().toISOString(),
        ip: request.rawRequest?.ip || null,
      });
    } catch (e) {
      // An audit write must never take down the action it is describing, but a
      // silent loss is worse than a noisy one.
      console.error("adminAudit write failed:", e.message || e);
    }
  };
}

/* ---------------- rate limiting ---------------- */

/*
 * Fixed-window counter in Firestore, same shape as the OTP send limiter in
 * index.js. Used to stop code enumeration: without it, `validateReferralCode`
 * is a free oracle for "which discount codes are live".
 */
function makeRateLimiter(db) {
  return async function hit(key, { max, windowMs, message }) {
    const ref = db.doc(`rateLimits/${encodeURIComponent(key)}`);
    const now = Date.now();
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const d = snap.exists ? snap.data() : null;
      if (d && now - (d.windowStart || 0) < windowMs) {
        if ((d.count || 0) >= max) {
          throw new HttpsError("resource-exhausted", message || "Too many attempts. Please wait a minute.");
        }
        tx.set(ref, { count: (d.count || 0) + 1, windowStart: d.windowStart, updatedAt: now }, { merge: true });
      } else {
        tx.set(ref, { count: 1, windowStart: now, updatedAt: now });
      }
    });
  };
}

module.exports = {
  CODE_ALPHABET,
  normaliseCode,
  isValidCode,
  generateCode,
  STAGES,
  stageRank,
  canAdvance,
  BENEFIT_TYPES,
  benefitFor,
  benefitLabel,
  commissionFor,
  evaluateCode,
  publicReason,
  dayKey,
  monthKey,
  addDays,
  requireAdmin,
  makeAudit,
  makeRateLimiter,
};
