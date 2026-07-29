/*
 * ProHippo — the cost meter.
 *
 * Every paid outbound call — Gemini, 2Factor SMS, Resend email — records the
 * same shape here. That sameness is the whole point: "what did this customer
 * cost me" has to be one sum over one collection, not arithmetic done in your
 * head across three vendor dashboards.
 *
 * Four writes, one batch, one round trip:
 *
 *   spend/{id}                  the raw call, for drill-down and failures
 *   spendDaily/{YYYY-MM-DD}     consolidated totals by vendor and SKU
 *   usageDaily/{uid}_{date}     per-account, per-day
 *   accounts/{uid}.spend        running totals, so the Customers table can
 *                               show a ₹ column with no extra query
 *
 * WHY THIS IS AWAITED RATHER THAN FIRE-AND-FORGET. The instinct is to return
 * the user's result first and write the meter afterwards. In Cloud Functions
 * that loses records: once the response is sent the instance may be frozen or
 * reclaimed, and a dangling promise is simply dropped. Cost data you didn't
 * record cannot be reconstructed, so the batch is awaited — one in-region round
 * trip against calls that already take seconds. It is wrapped so that a
 * metering failure can never fail, or even surface in, the user's request.
 *
 * WHAT IS NEVER RECORDED: prompts, responses, phone numbers, email addresses.
 * `spend` is admin-readable, so anything in it is something support can read,
 * and these calls carry the practitioner's clients' tax records. Token counts,
 * model, latency, uid. Nothing else.
 */
"use strict";

const { FieldValue } = require("firebase-admin/firestore");
const { priceCall } = require("./pricing");

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

/* Firestore map keys cannot contain "/" and field PATHS cannot contain ".".
   Model ids like "gemini-3.1-flash-lite" are full of dots, so every rollup
   below is written as a nested object literal with merge — never as a dotted
   update path, which would silently split the SKU into three nested keys. */
const safeKey = (s) => String(s || "unknown").replace(/[/.]/g, "_");

exports.makeMeter = function makeMeter({ db }) {
  /*
   * Record one paid call.
   *
   * uid may be null — login OTPs are sent before anyone is authenticated, and
   * for someone who never completes signup there is no account to attribute to
   * even in principle. Those land in the console's "Login & signup" bucket
   * rather than being forced onto an arbitrary customer.
   */
  return async function recordSpend({
    uid = null,
    vendor,
    sku,
    feature,
    attempt = 1,
    promptTokens = 0,
    outputTokens = 0,
    units = 1,
    ms = 0,
    ok = true,
    errorCode = null,
  }) {
    try {
      const priced = priceCall({ vendor, sku, promptTokens, outputTokens, units });
      const at = new Date();
      const date = dayKey(at.getTime());
      const vKey = safeKey(vendor);
      const sKey = safeKey(sku);
      const fKey = safeKey(feature);
      const inr = priced.costMicroInr;

      const batch = db.batch();

      batch.set(db.collection("spend").doc(), {
        uid,
        vendor,
        sku,
        feature,
        attempt,
        promptTokens,
        outputTokens,
        totalTokens: (promptTokens || 0) + (outputTokens || 0),
        units,
        costMicro: priced.costMicro,
        currency: priced.currency,
        costMicroInr: inr,
        fxRate: priced.fxRate,
        rateVersion: priced.rateVersion,
        priced: priced.priced,
        ms,
        ok,
        errorCode,
        date,
        at: at.toISOString(),
      });

      // Consolidated. `unpricedCalls` is deliberately counted: a SKU with no
      // rate would otherwise report as free, which is the one error mode that
      // makes a cost dashboard actively misleading.
      batch.set(
        db.doc(`spendDaily/${date}`),
        {
          date,
          totalInrMicro: FieldValue.increment(inr),
          calls: FieldValue.increment(1),
          failures: FieldValue.increment(ok ? 0 : 1),
          unpricedCalls: FieldValue.increment(priced.priced ? 0 : 1),
          msTotal: FieldValue.increment(ms),
          byVendor: { [vKey]: { inrMicro: FieldValue.increment(inr), calls: FieldValue.increment(1) } },
          bySku: {
            [sKey]: {
              inrMicro: FieldValue.increment(inr),
              calls: FieldValue.increment(1),
              tokens: FieldValue.increment((promptTokens || 0) + (outputTokens || 0)),
            },
          },
          byFeature: { [fKey]: { inrMicro: FieldValue.increment(inr), calls: FieldValue.increment(1) } },
          updatedAt: at.toISOString(),
        },
        { merge: true }
      );

      if (uid) {
        batch.set(
          db.doc(`usageDaily/${uid}_${date}`),
          {
            uid,
            date,
            totalInrMicro: FieldValue.increment(inr),
            calls: FieldValue.increment(1),
            byVendor: { [vKey]: { inrMicro: FieldValue.increment(inr), calls: FieldValue.increment(1) } },
            byFeature: { [fKey]: { inrMicro: FieldValue.increment(inr), calls: FieldValue.increment(1) } },
          },
          { merge: true }
        );

        // Live running totals. The nightly rollup recomputes mtd/last30 from
        // usageDaily, which is what handles the month boundary — these
        // increments exist so the console is current within the day.
        batch.set(
          db.doc(`accounts/${uid}`),
          {
            spend: {
              lifetimeInrMicro: FieldValue.increment(inr),
              mtdInrMicro: FieldValue.increment(inr),
              lastCallAt: at.toISOString(),
            },
          },
          { merge: true }
        );
      }

      await batch.commit();
    } catch (e) {
      // A meter that can break a notice parse is worse than no meter.
      console.error("recordSpend failed:", e.message || e);
    }
  };
};

exports.helpers = { dayKey, safeKey };
