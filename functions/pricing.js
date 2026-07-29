/*
 * ProHippo — what every outbound API call costs.
 *
 * ONE FILE. Every rate ProHippo pays lives here and nowhere else, so there is
 * never a second copy to forget when a vendor changes their price.
 *
 * Three rules this file exists to enforce:
 *
 *   1. COST IS COMPUTED AT WRITE TIME AND FROZEN. A spend record stores the
 *      rupees it cost, not the tokens it used, plus the RATE_VERSION that
 *      priced it. Vendors change prices; last quarter's numbers must not
 *      quietly change when they do.
 *
 *   2. THE FX RATE IS FROZEN TOO. Gemini and Resend bill in USD, 2Factor bills
 *      in INR, and the business runs in INR. If the conversion happened at read
 *      time, every report would move with the rupee.
 *
 *   3. MONEY IS INTEGER MICRO-UNITS. A single flash-lite call costs a small
 *      fraction of a cent — paise is far too coarse to hold it, and floats
 *      accumulate error over a month of calls. `costMicro` is millionths of one
 *      unit of `currency`.
 *
 * ============================================================================
 * THE RATES BELOW ARE PLACEHOLDERS AND ARE ALMOST CERTAINLY NOT WHAT YOU PAY.
 *
 * Before trusting a single number in the admin console, put the real figures in
 * from each vendor's own pricing page / invoice, then set RATES_VERIFIED = true
 * and bump RATE_VERSION. Until you do, the Costs page shows an "unverified
 * rates" banner over every total — a wrong number you know is wrong is
 * survivable; one you believe is not.
 *
 *   Gemini    https://ai.google.dev/pricing
 *   2Factor   your 2Factor dashboard — the per-SMS credit price you bought at
 *   Resend    https://resend.com/pricing
 * ============================================================================
 */
"use strict";

const RATE_VERSION = "2026-07-placeholder";
const RATES_VERIFIED = false;

// Used to convert USD-billed vendors into the rupees the business thinks in.
// Frozen onto every record — see rule 2.
const USD_INR = 87.0;

/* Gemini bills per million tokens, separately for input and output. Images and
   PDF pages arrive already counted inside promptTokenCount, so no separate
   per-page rate is needed. */
const GEMINI_RATES = {
  "gemini-3.1-flash-lite": { inUsdPerMTok: 0.10, outUsdPerMTok: 0.40 },
  "gemini-3.1-flash": { inUsdPerMTok: 0.30, outUsdPerMTok: 2.50 },
};

// 2Factor sells SMS credits in rupees. Only AUTOGEN sends a message — VERIFY is
// free, and metering it would double every SMS number in the console.
const SMS_INR_PER_SEND = 0.20;

// Resend bills per email above a monthly free allowance. See freeTierNote below
// for why the console reports gross of that allowance.
const EMAIL_USD_PER_SEND = 0.0004;
const EMAIL_FREE_PER_MONTH = 3000;

/* Vendors and the SKUs each can bill. The console groups by these, so a typo
   here becomes a silently missing row rather than an error — hence the
   allowlist and the `unknown` fallbacks. */
const VENDORS = ["gemini", "2factor", "resend", "firebase"];
const SKUS = {
  gemini: Object.keys(GEMINI_RATES),
  "2factor": ["sms-otp"],
  resend: ["email-otp", "email-client"],
  firebase: ["manual"],
};

const VENDOR_LABEL = {
  gemini: "Gemini",
  "2factor": "2Factor SMS",
  resend: "Resend email",
  firebase: "Firebase",
};

/* ---------------- pricing ---------------- */

const toMicro = (amount) => Math.round(amount * 1e6);

/*
 * Micro-USD for a Gemini call.
 *
 * costUsd = inTok/1e6 * rateIn + outTok/1e6 * rateOut, so micro-USD is just
 * tokens × rate — no division, no float drift at the magnitudes involved.
 */
function priceGemini(model, promptTokens, outputTokens) {
  const r = GEMINI_RATES[model];
  if (!r) return { costMicro: 0, currency: "USD", priced: false };
  const micro = Math.round((promptTokens || 0) * r.inUsdPerMTok + (outputTokens || 0) * r.outUsdPerMTok);
  return { costMicro: micro, currency: "USD", priced: true };
}

/* `units ?? 1`, not `units || 1`. The meter passes 0 for a send the vendor
   rejected — nothing left their gateway, so nothing is owed — and `||` would
   quietly turn that zero back into a full charge. */
function priceSms(units) {
  const n = Math.max(0, Number(units ?? 1));
  return { costMicro: toMicro(SMS_INR_PER_SEND * n), currency: "INR", priced: true };
}

function priceEmail(units) {
  const n = Math.max(0, Number(units ?? 1));
  return { costMicro: toMicro(EMAIL_USD_PER_SEND * n), currency: "USD", priced: true };
}

/* Convert into the reporting currency at a rate the caller then stores. */
function toInrMicro(costMicro, currency, fxRate) {
  if (currency === "INR") return Math.round(costMicro || 0);
  return Math.round((costMicro || 0) * (fxRate || USD_INR));
}

/*
 * The single entry point. Everything a spend record needs, priced and
 * converted, with the rate and FX that produced it attached.
 */
function priceCall({ vendor, sku, promptTokens, outputTokens, units }) {
  let base;
  if (vendor === "gemini") base = priceGemini(sku, promptTokens, outputTokens);
  else if (vendor === "2factor") base = priceSms(units);
  else if (vendor === "resend") base = priceEmail(units);
  else base = { costMicro: 0, currency: "INR", priced: false };

  return {
    costMicro: base.costMicro,
    currency: base.currency,
    costMicroInr: toInrMicro(base.costMicro, base.currency, USD_INR),
    fxRate: base.currency === "USD" ? USD_INR : 1,
    rateVersion: RATE_VERSION,
    // false when the SKU had no rate — the console surfaces these rather than
    // reporting an unpriced call as free.
    priced: base.priced,
  };
}

/* Display helpers, shared with the client through adminApi. */
const inrFromMicro = (micro) => (micro || 0) / 1e6;

const freeTierNote =
  `Email costs are reported gross of Resend's first ${EMAIL_FREE_PER_MONTH.toLocaleString("en-IN")} ` +
  `messages a month, which are free. Below that volume the real invoice is lower than the figure shown.`;

module.exports = {
  RATE_VERSION,
  RATES_VERIFIED,
  USD_INR,
  GEMINI_RATES,
  SMS_INR_PER_SEND,
  EMAIL_USD_PER_SEND,
  EMAIL_FREE_PER_MONTH,
  VENDORS,
  SKUS,
  VENDOR_LABEL,
  priceGemini,
  priceSms,
  priceEmail,
  priceCall,
  toInrMicro,
  inrFromMicro,
  freeTierNote,
};
