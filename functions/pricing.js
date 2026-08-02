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
 * ----------------------------------------------------------------------------
 * TAX TREATMENT: ALL RATES BELOW ARE EXCLUSIVE OF GST.
 *
 * The 2Factor pack was ₹2,596 for 10,000 SMS — ₹2,200 plus 18% GST. The rate
 * used is ₹0.22, the ex-GST figure, because MEHTAJI BIZCON LLP is registered
 * and takes input tax credit on that invoice: the GST is recovered, so it is
 * not a cost. The USD vendors are quoted ex-tax already, which keeps all three
 * consistent.
 *
 * If you are NOT claiming input credit, set SMS_INR_PER_SEND to 0.2596 (the
 * cash-out figure) and bump RATE_VERSION. Do not mix the two.
 * ----------------------------------------------------------------------------
 */
"use strict";

const RATE_VERSION = "2026-07-B";

/* Confirmed against the vendors' own pricing pages on 2026-07-29:
 *   Gemini 3.1 Flash-Lite  https://ai.google.dev/pricing
 *   2Factor                the 10,000-SMS pack invoice
 *   Resend                 https://resend.com/pricing
 * The one gap is ESCALATION_MODEL — see GEMINI_RATES below. */
const RATES_VERIFIED = true;

/* Set this to the rate your card is actually settling at. It is frozen onto
   every record, so changing it never rewrites history. */
const USD_INR = 88.0;

/*
 * Gemini bills per million tokens, input and output separately. Images and PDF
 * pages arrive already counted inside promptTokenCount, so there is no separate
 * per-page rate.
 *
 * NOTE ON OUTPUT: Google's output price is "including thinking tokens", and the
 * API reports those separately as `thoughtsTokenCount`. The meter adds them to
 * candidatesTokenCount — counting only the visible answer would under-report
 * every call.
 *
 * gemini-3.1-flash (ESCALATION_MODEL in index.js) is deliberately ABSENT: its
 * price has not been confirmed, and inventing one would be worse than leaving
 * it out. Calls to it are counted as unpriced and shown on the Costs page as
 * "N calls had no rate", which is a visible gap rather than a silent ₹0.
 */
const GEMINI_RATES = {
  // Paid tier, text/image/video input. Audio input is $0.50 — not used here.
  "gemini-3.1-flash-lite": { inUsdPerMTok: 0.25, outUsdPerMTok: 1.50 },
};

/* 2Factor: prepaid credits, one per SMS sent. Only AUTOGEN sends a message —
   VERIFY is free, and metering it would double every SMS figure. */
const SMS_INR_PER_SEND = 0.22;
const SMS_PACK = { credits: 10000, paidInr: 2596, paidExGstInr: 2200 };

/*
 * Resend is a SUBSCRIPTION, not a per-unit charge, and ProHippo is on Free.
 *
 * That makes the marginal cost of one more email exactly zero — the Free plan
 * has no overage billing, it just stops you at 100/day and 3,000/month. Pricing
 * each email at some notional per-unit rate would invent a cost that is not
 * being incurred.
 *
 * What matters instead is the CLIFF: at 3,000/month the next step is Pro at
 * $20/month. The Costs page therefore reports email VOLUME against the
 * allowance rather than a rupee figure, so the jump is visible before it
 * arrives rather than on the invoice after.
 *
 * When you move to Pro: set plan to "pro", and enter the $20 in
 * Costs → Monthly invoice. Overage beyond 50,000 is $0.90 per 1,000.
 */
const RESEND_PLAN = {
  name: "free",
  monthlyUsd: 0,
  includedPerMonth: 3000,
  dailyLimit: 100,
  overageUsdPer1000: 0, // Free does not bill overage; it rate-limits instead
};

/*
 * Sarvam bills the inbound voice agent by the minute, and the rate depends on
 * the plan and the number the calls land on. It is DELIBERATELY UNPRICED here,
 * for the same reason as gemini-3.1-flash above: a made-up rate is worse than a
 * visible gap. Minutes are still metered — the Costs page reports them as
 * "N calls had no rate", so the volume is in front of you before the invoice is.
 *
 * To price it: add `sarvam` to priceCall() with a per-minute INR rate taken off
 * your actual Sarvam invoice, and bump RATE_VERSION. `units` on these records is
 * MINUTES (fractional), not calls.
 */
const SARVAM_INR_PER_MINUTE = null; // unconfirmed — see the note above

/* Vendors and the SKUs each can bill. The console groups by these. */
const VENDORS = ["gemini", "2factor", "resend", "sarvam", "firebase"];
const SKUS = {
  gemini: Object.keys(GEMINI_RATES),
  "2factor": ["sms-otp"],
  resend: ["email-otp", "email-client"],
  sarvam: ["voice-agent"],
  firebase: ["manual"],
};

const VENDOR_LABEL = {
  gemini: "Gemini",
  "2factor": "2Factor SMS",
  resend: "Resend email",
  sarvam: "Sarvam voice",
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

/*
 * Email marginal cost. Zero on the Free plan by definition — the monthly fee is
 * a subscription, not a per-message charge, and is entered under Monthly
 * invoice. On Pro, only genuine overage beyond the included volume costs
 * anything per message.
 */
function priceEmail(units) {
  const n = Math.max(0, Number(units ?? 1));
  const per = (RESEND_PLAN.overageUsdPer1000 || 0) / 1000;
  return { costMicro: toMicro(per * n), currency: "USD", priced: true };
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

const notes = [
  `Rates are exclusive of GST. SMS is ₹${SMS_INR_PER_SEND} (the ₹${SMS_PACK.paidExGstInr}/${SMS_PACK.credits.toLocaleString("en-IN")} pack rate) — ₹${(SMS_PACK.paidInr / SMS_PACK.credits).toFixed(4)} including GST, which is recovered as input credit.`,
  `Email marginal cost is ₹0: Resend Free includes ${RESEND_PLAN.includedPerMonth.toLocaleString("en-IN")} messages a month with no overage billing. Watch the volume, not the rupees — the next step is Pro at $20/month.`,
  `Gemini output pricing includes thinking tokens, so thoughtsTokenCount is counted alongside the visible answer.`,
  `Sarvam voice minutes are metered but not yet priced — the per-minute rate is unconfirmed, so those calls show under "no rate" rather than as ₹0.`,
];

module.exports = {
  RATE_VERSION,
  RATES_VERIFIED,
  USD_INR,
  GEMINI_RATES,
  SMS_INR_PER_SEND,
  SMS_PACK,
  SARVAM_INR_PER_MINUTE,
  RESEND_PLAN,
  VENDORS,
  SKUS,
  VENDOR_LABEL,
  priceGemini,
  priceSms,
  priceEmail,
  priceCall,
  toInrMicro,
  inrFromMicro,
  notes,
};
