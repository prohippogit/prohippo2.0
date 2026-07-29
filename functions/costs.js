/*
 * ProHippo — admin console cost reporting.
 *
 * Reads the rollups that functions/spend.js writes. Nothing here ever scans the
 * raw `spend` collection for a total: `spendDaily` exists precisely so that a
 * dashboard refresh costs a handful of document reads however many API calls
 * are behind it.
 *
 * Two things this module is careful about:
 *
 *   • It reports what your rate table says, and tells you when that table has
 *     not been checked. `ratesVerified: false` drives a banner over every total
 *     in the console. A cost figure you know is unverified is survivable; one
 *     you believe is not.
 *
 *   • It includes Firebase. Firebase is not an API this codebase calls, so
 *     there is no response to meter — it is entered by hand each month from the
 *     invoice. A "consolidated cost" that silently omits your hosting bill is
 *     not consolidated, so the manual figure is folded into the same totals and
 *     labelled as manual.
 */
"use strict";

const { onCall } = require("firebase-functions/v2/https");
const { HttpsError } = require("firebase-functions/v2/https");

const { requireAdmin, makeAudit } = require("./adminCore");
const pricing = require("./pricing");

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const monthKey = (iso) => String(iso).slice(0, 7);
const nowISO = () => new Date().toISOString();

/* Sum a list of {k: {inrMicro, calls, tokens}} maps into one. */
function mergeBuckets(target, source) {
  for (const [k, v] of Object.entries(source || {})) {
    if (!target[k]) target[k] = { inrMicro: 0, calls: 0, tokens: 0 };
    target[k].inrMicro += v.inrMicro || 0;
    target[k].calls += v.calls || 0;
    target[k].tokens += v.tokens || 0;
  }
  return target;
}

exports.build = function build({ REGIONS, db }) {
  const audit = makeAudit(db);
  const OPTS = { region: REGIONS, maxInstances: 10 };

  /*
   * Everything the Costs page needs, in one call.
   *
   * `days` is the window for the daily series and the by-vendor / by-SKU
   * breakdown. Today and month-to-date are computed from the same documents,
   * so the headline numbers can never disagree with the chart beneath them.
   */
  const adminCostSummary = onCall(OPTS, async (request) => {
    requireAdmin(request);
    const days = Math.min(120, Math.max(1, Math.round(Number(request.data?.days) || 30)));

    // Read the window by document id — no query, no index, no surprises.
    const ids = [];
    for (let i = 0; i < days; i++) ids.push(dayKey(Date.now() - i * 86400000));
    const refs = ids.map((d) => db.doc(`spendDaily/${d}`));
    const snaps = await db.getAll(...refs);

    const today = dayKey(Date.now());
    const thisMonth = monthKey(today);
    const lastMonth = monthKey(new Date(Date.now() - 32 * 86400000).toISOString());

    const series = [];
    const byVendor = {};
    const bySku = {};
    const byFeature = {};
    // Same breakdown but restricted to the calendar month, because plan
    // allowances (Resend's 3,000 free emails) reset monthly, not on a rolling
    // window. Reporting a 30-day count against a monthly allowance would be
    // wrong in both directions depending on the date.
    const mtdBySku = {};
    let windowInrMicro = 0;
    let mtdInrMicro = 0;
    let todayInrMicro = 0;
    let calls = 0;
    let failures = 0;
    let unpriced = 0;
    let msTotal = 0;
    let daysElapsedThisMonth = 0;

    for (const snap of snaps) {
      if (!snap.exists) continue;
      const d = snap.data();
      const inr = d.totalInrMicro || 0;

      series.push({ date: d.date, inrMicro: inr, calls: d.calls || 0, failures: d.failures || 0 });
      windowInrMicro += inr;
      calls += d.calls || 0;
      failures += d.failures || 0;
      unpriced += d.unpricedCalls || 0;
      msTotal += d.msTotal || 0;
      mergeBuckets(byVendor, d.byVendor);
      mergeBuckets(bySku, d.bySku);
      mergeBuckets(byFeature, d.byFeature);

      if (d.date === today) todayInrMicro = inr;
      if (monthKey(d.date) === thisMonth) {
        mtdInrMicro += inr;
        daysElapsedThisMonth++;
        mergeBuckets(mtdBySku, d.bySku);
      }
    }
    series.sort((a, b) => a.date.localeCompare(b.date));

    // Manual figures (Firebase) for this month and last, so the consolidated
    // total is actually complete rather than API-only.
    const [thisManual, lastManual] = await db.getAll(
      db.doc(`manualCosts/${thisMonth}`),
      db.doc(`manualCosts/${lastMonth}`)
    );
    const manualThis = thisManual.exists ? thisManual.data() : null;
    const manualInrMicro = Object.values(manualThis?.byVendor || {}).reduce((a, v) => a + (v.inrMicro || 0), 0);

    // Straight-line projection from month-to-date. Crude on purpose — a
    // seasonality model over three weeks of data would be false precision.
    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    const projectedInrMicro = daysElapsedThisMonth
      ? Math.round((mtdInrMicro / daysElapsedThisMonth) * daysInMonth) + manualInrMicro
      : manualInrMicro;

    return {
      window: { days, inrMicro: windowInrMicro, calls, failures, unpriced },
      todayInrMicro,
      mtdInrMicro,
      manualInrMicro,
      // What the month has actually cost so far, API spend plus manual.
      consolidatedMtdInrMicro: mtdInrMicro + manualInrMicro,
      projectedInrMicro,
      avgMs: calls ? Math.round(msTotal / calls) : 0,
      byVendor,
      bySku,
      byFeature,
      series,
      manual: {
        month: thisMonth,
        byVendor: manualThis?.byVendor || {},
        lastMonthByVendor: lastManual.exists ? lastManual.data().byVendor || {} : {},
      },
      /* Plan allowances. Resend Free costs nothing per message but stops at
         3,000 a month — so the number that matters there is VOLUME, not
         rupees, and it needs to be visible before the cliff rather than on the
         invoice after it. */
      allowances: {
        emailsThisMonth:
          (mtdBySku["email-otp"]?.calls || 0) + (mtdBySku["email-client"]?.calls || 0),
        emailIncluded: pricing.RESEND_PLAN.includedPerMonth,
        emailPlan: pricing.RESEND_PLAN.name,
        emailDailyLimit: pricing.RESEND_PLAN.dailyLimit,
        smsThisMonth: mtdBySku["sms-otp"]?.calls || 0,
        smsPackCredits: pricing.SMS_PACK.credits,
      },
      rates: {
        version: pricing.RATE_VERSION,
        verified: pricing.RATES_VERIFIED,
        usdInr: pricing.USD_INR,
        notes: pricing.notes,
        gemini: pricing.GEMINI_RATES,
        smsInrPerSend: pricing.SMS_INR_PER_SEND,
        smsPack: pricing.SMS_PACK,
        resendPlan: pricing.RESEND_PLAN,
      },
      at: nowISO(),
    };
  });

  /*
   * Enter a monthly invoice figure that cannot be metered from inside the app —
   * Firebase today, anything else you pay for later. Rupees in, micro-rupees
   * stored, so it adds to the same totals as everything else.
   */
  const adminSetManualCost = onCall(OPTS, async (request) => {
    requireAdmin(request);
    const month = String(request.data?.month || "");
    const vendor = String(request.data?.vendor || "firebase");
    const amountInr = Number(request.data?.amountInr);

    if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpsError("invalid-argument", "month must look like 2026-07.");
    if (!Number.isFinite(amountInr) || amountInr < 0) throw new HttpsError("invalid-argument", "amountInr must be a positive number.");

    await db.doc(`manualCosts/${month}`).set(
      {
        month,
        byVendor: { [vendor]: { inrMicro: Math.round(amountInr * 1e6), enteredAt: nowISO() } },
        note: String(request.data?.note || "").slice(0, 500),
        updatedAt: nowISO(),
        updatedBy: request.auth.uid,
      },
      { merge: true }
    );

    await audit(request, "cost.manual", month, { vendor, amountInr });
    return { ok: true };
  });

  /*
   * The most recent failed calls, for the "what is breaking" panel. Equality
   * filter only — no composite index needed — and sorted in the client, which
   * is fine at the 50 documents this returns.
   */
  const adminRecentFailures = onCall(OPTS, async (request) => {
    requireAdmin(request);
    const snap = await db.collection("spend").where("ok", "==", false).limit(50).get();
    const rows = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.at || "").localeCompare(a.at || ""));
    return { rows };
  });

  return { adminCostSummary, adminSetManualCost, adminRecentFailures };
};

exports.helpers = { mergeBuckets, monthKey };
