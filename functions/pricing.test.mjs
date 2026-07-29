/* Unit tests for the cost arithmetic — the parts where a quiet mistake shows up
 * as a business decision made on a number that was wrong all along.
 *
 * Run:  node functions/pricing.test.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  priceGemini,
  priceSms,
  priceEmail,
  priceCall,
  toInrMicro,
  inrFromMicro,
  GEMINI_RATES,
  USD_INR,
  SMS_INR_PER_SEND,
} = require("./pricing.js");
const { safeKey, dayKey } = require("./spend.js").helpers;
const { mergeBuckets, monthKey } = require("./costs.js").helpers;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* ---------------- Gemini ---------------- */

test("a Gemini call prices input and output separately", () => {
  const r = GEMINI_RATES["gemini-3.1-flash-lite"];
  const out = priceGemini("gemini-3.1-flash-lite", 1_000_000, 1_000_000);
  // 1M tokens each way = exactly one unit of each rate, in micro-USD.
  assert.equal(out.costMicro, Math.round(r.inUsdPerMTok * 1e6 + r.outUsdPerMTok * 1e6));
  assert.equal(out.currency, "USD");
  assert.equal(out.priced, true);
});

test("small calls keep resolution instead of rounding to zero", () => {
  // A few thousand tokens is a fraction of a cent — the whole reason costs are
  // stored in micro-units rather than paise.
  const out = priceGemini("gemini-3.1-flash-lite", 3000, 500);
  assert.ok(out.costMicro > 0, "a real call must not price at zero");
});

test("an unknown model is flagged, not silently free", () => {
  const out = priceGemini("gemini-9-imaginary", 100000, 5000);
  assert.equal(out.costMicro, 0);
  assert.equal(out.priced, false, "priced:false is what surfaces it in the console");
});

test("the escalation model costs more than the primary", () => {
  // If this ever flips, the escalation path stops being worth measuring.
  const lite = priceGemini("gemini-3.1-flash-lite", 100000, 10000).costMicro;
  const full = priceGemini("gemini-3.1-flash", 100000, 10000).costMicro;
  assert.ok(full > lite, "escalation should be the expensive path");
});

test("zero tokens costs zero", () => {
  assert.equal(priceGemini("gemini-3.1-flash-lite", 0, 0).costMicro, 0);
});

/* ---------------- SMS & email ---------------- */

test("SMS is priced in rupees and needs no conversion", () => {
  const out = priceSms(1);
  assert.equal(out.currency, "INR");
  assert.equal(out.costMicro, Math.round(SMS_INR_PER_SEND * 1e6));
});

test("a failed send bills zero units", () => {
  assert.equal(priceSms(0).costMicro, 0);
  assert.equal(priceEmail(0).costMicro, 0);
});

test("email is priced in USD", () => {
  assert.equal(priceEmail(1).currency, "USD");
});

/* ---------------- currency ---------------- */

test("INR passes through unconverted", () => {
  assert.equal(toInrMicro(500000, "INR", 87), 500000);
});

test("USD converts at the rate handed in, not a global", () => {
  // The rate is frozen onto each record precisely so history can't move.
  assert.equal(toInrMicro(1_000_000, "USD", 87), 87_000_000);
  assert.equal(toInrMicro(1_000_000, "USD", 90), 90_000_000);
});

test("priceCall attaches the rate and FX that produced the number", () => {
  const out = priceCall({ vendor: "gemini", sku: "gemini-3.1-flash-lite", promptTokens: 50000, outputTokens: 2000 });
  assert.equal(out.currency, "USD");
  assert.equal(out.fxRate, USD_INR);
  assert.ok(out.rateVersion, "every record must say which rate table priced it");
  assert.equal(out.costMicroInr, Math.round(out.costMicro * USD_INR));
});

test("an INR vendor records fxRate 1, not the USD rate", () => {
  const out = priceCall({ vendor: "2factor", sku: "sms-otp", units: 1 });
  assert.equal(out.fxRate, 1);
  assert.equal(out.costMicroInr, out.costMicro);
});

test("an unknown vendor prices to zero and says so", () => {
  const out = priceCall({ vendor: "nobody", sku: "x", units: 5 });
  assert.equal(out.costMicroInr, 0);
  assert.equal(out.priced, false);
});

test("micro-rupees convert back to rupees for display", () => {
  assert.equal(inrFromMicro(1_500_000), 1.5);
  assert.equal(inrFromMicro(0), 0);
  assert.equal(inrFromMicro(undefined), 0);
});

/* ---------------- rollup keys ---------------- */

test("model ids survive being used as Firestore map keys", () => {
  // "gemini-3.1-flash-lite" contains dots. As a dotted field PATH that would
  // split into nested maps; safeKey is what stops the SKU shattering.
  assert.equal(safeKey("gemini-3.1-flash-lite"), "gemini-3_1-flash-lite");
  assert.ok(!safeKey("gemini-3.1-flash").includes("."));
  assert.equal(safeKey(null), "unknown");
});

test("day keys are ISO dates, so string sort is chronological", () => {
  assert.equal(dayKey(Date.parse("2026-07-29T18:30:00Z")), "2026-07-29");
  assert.ok("2026-07-29" > "2026-07-28");
});

test("month keys slice off the day", () => {
  assert.equal(monthKey("2026-07-29"), "2026-07");
});

/* ---------------- aggregation ---------------- */

test("buckets merge additively across days", () => {
  const t = {};
  mergeBuckets(t, { gemini: { inrMicro: 100, calls: 2, tokens: 500 } });
  mergeBuckets(t, { gemini: { inrMicro: 50, calls: 1, tokens: 250 }, resend: { inrMicro: 10, calls: 1 } });
  assert.deepEqual(t.gemini, { inrMicro: 150, calls: 3, tokens: 750 });
  assert.equal(t.resend.inrMicro, 10);
  assert.equal(t.resend.tokens, 0, "a vendor with no tokens still gets a zero, not undefined");
});

test("merging nothing is a no-op, not a crash", () => {
  const t = { a: { inrMicro: 1, calls: 1, tokens: 0 } };
  mergeBuckets(t, undefined);
  mergeBuckets(t, {});
  assert.equal(t.a.inrMicro, 1);
});

/* ---------------- run ---------------- */

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  ${name}\n      ${e.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
