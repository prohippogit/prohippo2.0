/* Unit tests for the pure half of the admin/referral system — the parts where
 * a quiet mistake shows up as a discount you didn't intend to give, or a
 * partner invoicing you for a signup that was never theirs.
 *
 * Run:  node functions/adminCore.test.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  normaliseCode,
  isValidCode,
  generateCode,
  CODE_ALPHABET,
  benefitFor,
  benefitLabel,
  commissionFor,
  evaluateCode,
  publicReason,
  canAdvance,
} = require("./adminCore.js");
const { sanitiseCodeInput, redemptionId } = require("./referrals.js").helpers;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const DAY = 86400000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString();

const CODE = {
  code: "AHMCA25",
  kind: "partner",
  status: "active",
  benefit: { type: "percent", value: 25 },
  appliesToPlans: [],
  newCustomersOnly: true,
  maxRedemptions: 0,
  redemptions: 0,
  validFrom: null,
  validTo: null,
  commission: { percent: 20, months: 12 },
  owner: { uid: "partner-uid" },
};
const ctx = (over) => ({ nowMs: Date.now(), planId: "solo", isNewCustomer: true, ...over });

/* ---------------- code normalisation ---------------- */

test("normalise accepts the shapes people actually type", () => {
  for (const raw of ["ahmca25", " AHMCA25 ", "ahm-ca-25", "AHM CA 25", "ahmca25\n"]) {
    assert.equal(normaliseCode(raw), "AHMCA25", `failed on ${JSON.stringify(raw)}`);
  }
});

test("normalise is total — never throws, never returns null", () => {
  assert.equal(normaliseCode(null), "");
  assert.equal(normaliseCode(undefined), "");
  assert.equal(normaliseCode(12345), "12345");
});

test("code validity is bounded at both ends", () => {
  assert.equal(isValidCode("ABCD"), true);
  assert.equal(isValidCode("ABC"), false, "3 chars is too guessable");
  assert.equal(isValidCode("A".repeat(24)), true);
  assert.equal(isValidCode("A".repeat(25)), false);
  assert.equal(isValidCode("ahmca25"), false, "must already be normalised");
});

test("generated codes avoid every look-alike character", () => {
  // The whole point of the custom alphabet: these get misread over the phone.
  for (const ch of "OIL0125SZB8") {
    assert.ok(!CODE_ALPHABET.includes(ch), `${ch} should not be in the alphabet`);
  }
  const code = generateCode("PH", 6, () => 0.5);
  assert.equal(code.length, 8);
  assert.ok(code.startsWith("PH"));
  assert.ok(isValidCode(code));
});

test("generator spans the whole alphabet", () => {
  assert.equal(generateCode("", 1, () => 0)[0], CODE_ALPHABET[0]);
  assert.equal(generateCode("", 1, () => 0.9999)[0], CODE_ALPHABET[CODE_ALPHABET.length - 1]);
});

/* ---------------- benefit maths ---------------- */

test("percentage discount is exact in paise", () => {
  // ₹1,499 at 25% = ₹374.75. Rupee floats would lose the 75 paise.
  const r = benefitFor({ type: "percent", value: 25 }, 149900);
  assert.equal(r.discountPaise, 37475);
  assert.equal(r.payablePaise, 112425);
});

test("a flat discount can never exceed the price", () => {
  const r = benefitFor({ type: "flat", value: 500000 }, 149900);
  assert.equal(r.discountPaise, 149900);
  assert.equal(r.payablePaise, 0, "no negative invoices");
});

test("percentages are clamped to 0–100", () => {
  assert.equal(benefitFor({ type: "percent", value: 250 }, 100000).payablePaise, 0);
  assert.equal(benefitFor({ type: "percent", value: -50 }, 100000).payablePaise, 100000);
});

test("free days grant time, not money", () => {
  const r = benefitFor({ type: "free_days", value: 30 }, 149900);
  assert.equal(r.freeDays, 30);
  assert.equal(r.payablePaise, 149900);
});

test("an unknown benefit type charges full price rather than giving it away", () => {
  const r = benefitFor({ type: "nonsense", value: 99 }, 149900);
  assert.equal(r.discountPaise, 0);
  assert.equal(r.payablePaise, 149900);
});

test("benefit labels read the way a customer expects", () => {
  assert.equal(benefitLabel({ type: "percent", value: 25 }), "25% off");
  assert.equal(benefitLabel({ type: "free_days", value: 30 }), "30 days free");
  assert.equal(benefitLabel(null), "—");
});

/* ---------------- commission ---------------- */

test("commission stops after the agreed number of months", () => {
  assert.equal(commissionFor(CODE, 100000, 0), 20000);
  assert.equal(commissionFor(CODE, 100000, 11), 20000);
  assert.equal(commissionFor(CODE, 100000, 12), 0, "month 12 is past a 12-month cap");
  assert.equal(commissionFor(CODE, 100000, 99), 0);
});

test("a zero-month cap means forever", () => {
  const forever = { commission: { percent: 10, months: 0 } };
  assert.equal(commissionFor(forever, 100000, 500), 10000);
});

test("no commission configured means no commission owed", () => {
  assert.equal(commissionFor({ commission: { percent: 0 } }, 100000, 0), 0);
  assert.equal(commissionFor({}, 100000, 0), 0);
});

/* ---------------- validation ---------------- */

test("a healthy code validates", () => {
  assert.deepEqual(evaluateCode(CODE, ctx()), { ok: true, reason: null });
});

test("a missing code is not found", () => {
  assert.equal(evaluateCode(null, ctx()).reason, "not_found");
});

test("paused, unstarted and expired codes are all refused", () => {
  assert.equal(evaluateCode({ ...CODE, status: "paused" }, ctx()).reason, "inactive");
  assert.equal(evaluateCode({ ...CODE, validFrom: iso(1) }, ctx()).reason, "not_started");
  assert.equal(evaluateCode({ ...CODE, validTo: iso(-1) }, ctx()).reason, "expired");
});

test("a code inside its window is fine", () => {
  assert.ok(evaluateCode({ ...CODE, validFrom: iso(-1), validTo: iso(1) }, ctx()).ok);
});

test("quota is enforced at the boundary, not past it", () => {
  assert.ok(evaluateCode({ ...CODE, maxRedemptions: 10, redemptions: 9 }, ctx()).ok);
  assert.equal(evaluateCode({ ...CODE, maxRedemptions: 10, redemptions: 10 }, ctx()).reason, "exhausted");
  assert.ok(evaluateCode({ ...CODE, maxRedemptions: 0, redemptions: 9999 }, ctx()).ok, "0 means unlimited");
});

test("plan restrictions apply only when a plan list is set", () => {
  assert.equal(evaluateCode({ ...CODE, appliesToPlans: ["firm"] }, ctx({ planId: "solo" })).reason, "plan_mismatch");
  assert.ok(evaluateCode({ ...CODE, appliesToPlans: ["firm"] }, ctx({ planId: "firm" })).ok);
  assert.ok(evaluateCode({ ...CODE, appliesToPlans: [] }, ctx({ planId: "solo" })).ok);
});

test("new-customer codes are refused to existing customers", () => {
  assert.equal(evaluateCode(CODE, ctx({ isNewCustomer: false })).reason, "existing_customer");
});

test("nobody refers themselves", () => {
  assert.equal(evaluateCode(CODE, ctx({ selfReferral: true })).reason, "self_referral");
});

test("one redemption per account, and one code per account", () => {
  assert.equal(evaluateCode(CODE, ctx({ alreadyRedeemed: true })).reason, "already_used");
  assert.equal(evaluateCode(CODE, ctx({ accountAttributedTo: "OTHERCODE" })).reason, "account_attributed");
  // Re-running the same attribution is not a conflict with itself.
  assert.ok(evaluateCode(CODE, ctx({ accountAttributedTo: "AHMCA25" })).ok);
});

test("public messages don't leak which codes exist", () => {
  const leaky = ["not_found", "inactive", "not_started", "expired", "exhausted"].map(publicReason);
  assert.equal(new Set(leaky).size, 1, "these must be indistinguishable to a caller");
  // These are safe to be specific about — they're about the caller, not the code.
  assert.notEqual(publicReason("already_used"), leaky[0]);
  assert.notEqual(publicReason("self_referral"), leaky[0]);
});

/* ---------------- funnel ---------------- */

test("funnel stages only move forward, except into churn", () => {
  assert.ok(canAdvance("signed_up", "activated"));
  assert.ok(!canAdvance("converted", "activated"), "a late rollup must not demote a paying customer");
  assert.ok(!canAdvance("activated", "activated"), "re-running the rollup is a no-op");
  assert.ok(canAdvance("converted", "churned"));
});

/* ---------------- input sanitisation ---------------- */

test("a code form with a bad benefit is rejected, not coerced", () => {
  assert.throws(() => sanitiseCodeInput({ kind: "partner", benefit: { type: "nonsense", value: 5 } }));
  assert.throws(() => sanitiseCodeInput({ kind: "partner", benefit: { type: "percent", value: 150 } }));
  assert.throws(() => sanitiseCodeInput({ kind: "partner", benefit: { type: "percent", value: -5 } }));
  assert.throws(() => sanitiseCodeInput({ kind: "invented", benefit: { type: "percent", value: 5 } }));
});

test("a back-to-front validity window is rejected", () => {
  assert.throws(() =>
    sanitiseCodeInput({ kind: "promo", benefit: { type: "percent", value: 10 }, validFrom: iso(5), validTo: iso(1) })
  );
});

test("commission outside 0–100 is rejected", () => {
  const base = { kind: "partner", benefit: { type: "percent", value: 10 } };
  assert.throws(() => sanitiseCodeInput({ ...base, commission: { percent: 120 } }));
  assert.throws(() => sanitiseCodeInput({ ...base, commission: { percent: -1 } }));
});

test("sanitise never lets the form set a counter", () => {
  const out = sanitiseCodeInput({
    kind: "promo",
    benefit: { type: "percent", value: 10 },
    redemptions: 9999,
    funnel: { converted: 500 },
    revenuePaise: 10 ** 9,
  });
  assert.ok(!("redemptions" in out));
  assert.ok(!("funnel" in out));
  assert.ok(!("revenuePaise" in out));
});

test("partial updates only carry what was sent", () => {
  const out = sanitiseCodeInput({ status: "paused" }, { partial: true });
  assert.deepEqual(out, { status: "paused" });
});

test("redemption ids are deterministic — the retry guard depends on it", () => {
  assert.equal(redemptionId("uid1", "AHMCA25"), redemptionId("uid1", "AHMCA25"));
  assert.notEqual(redemptionId("uid1", "AHMCA25"), redemptionId("uid2", "AHMCA25"));
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
