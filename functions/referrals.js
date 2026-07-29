/*
 * ProHippo — referral, partner and promo codes.
 *
 * Three kinds of code share one schema and one validation path:
 *   • partner — handed to a CA association / reseller. Discount for the
 *     customer, recurring commission for the partner.
 *   • promo   — a campaign coupon (LAUNCH50). Capped, dated, discount only.
 *   • member  — auto-generated per customer for word-of-mouth. Two-sided.
 *
 * Trust boundary: `referralCodes` and `referralRedemptions` are top-level
 * collections that firestore.rules gives ADMINS read on and NOBODY write, the
 * same shape as otpChallenges and deviceSessions in index.js. Every mutation
 * runs through a callable here, under the Admin SDK.
 *
 * Two things that look like paranoia and are not:
 *
 *   1. Redemption runs inside runTransaction and the redemption document has a
 *      DETERMINISTIC id (`${uid}__${CODE}`). Two taps on a slow connection, or
 *      a callable retried by the client SDK, therefore cannot redeem twice or
 *      push `redemptions` past `maxRedemptions`.
 *
 *   2. `validateReferralCode` is rate-limited and its failure messages are
 *      deliberately vague. An unlimited, precise validator is a free oracle
 *      telling anyone which of your discount codes are live.
 */
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { FieldValue } = require("firebase-admin/firestore");
const crypto = require("crypto");

const {
  normaliseCode,
  isValidCode,
  generateCode,
  BENEFIT_TYPES,
  benefitLabel,
  evaluateCode,
  publicReason,
  requireAdmin,
  makeAudit,
  makeRateLimiter,
} = require("./adminCore");

const KINDS = ["partner", "promo", "member"];
const DURATIONS = ["first_invoice", "months", "forever"];

// crypto-backed float in [0,1) for the code generator.
const rand = () => crypto.randomInt(0, 1 << 30) / (1 << 30);

const nowISO = () => new Date().toISOString();

// Redemption ids are derived, not random: same (account, code) always maps to
// the same document, so a retry updates rather than duplicates.
const redemptionId = (uid, code) => `${uid}__${code}`;

/* An empty funnel, so every code doc has the same shape and the admin table
   never has to special-case a missing counter. */
const emptyFunnel = () => ({
  clicked: 0,
  signed_up: 0,
  activated: 0,
  converted: 0,
  renewed: 0,
  churned: 0,
});

/* Normalise whatever the admin form sent into a storable code document.
   Rejects rather than coerces: a benefit typo that silently becomes "0% off"
   is worse than a form error. */
function sanitiseCodeInput(input, { partial } = {}) {
  const d = input || {};
  const out = {};

  if (d.kind !== undefined || !partial) {
    if (!KINDS.includes(d.kind)) throw new HttpsError("invalid-argument", `kind must be one of ${KINDS.join(", ")}.`);
    out.kind = d.kind;
  }
  if (d.benefit !== undefined || !partial) {
    const b = d.benefit || {};
    if (!BENEFIT_TYPES.includes(b.type)) {
      throw new HttpsError("invalid-argument", `benefit.type must be one of ${BENEFIT_TYPES.join(", ")}.`);
    }
    const value = Number(b.value);
    if (!Number.isFinite(value) || value < 0) throw new HttpsError("invalid-argument", "benefit.value must be a positive number.");
    if (b.type === "percent" && value > 100) throw new HttpsError("invalid-argument", "A percentage benefit cannot exceed 100.");
    out.benefit = { type: b.type, value: Math.round(value) };
  }
  if (d.duration !== undefined || !partial) {
    const dur = d.duration || "first_invoice";
    if (!DURATIONS.includes(dur)) throw new HttpsError("invalid-argument", `duration must be one of ${DURATIONS.join(", ")}.`);
    out.duration = dur;
    out.durationMonths = dur === "months" ? Math.max(1, Math.round(Number(d.durationMonths) || 1)) : 0;
  }
  if (d.owner !== undefined) {
    const o = d.owner || {};
    out.owner = {
      name: String(o.name || "").trim(),
      email: String(o.email || "").trim().toLowerCase(),
      phone: String(o.phone || "").trim(),
      uid: o.uid ? String(o.uid) : null,
    };
  }
  if (d.appliesToPlans !== undefined) {
    out.appliesToPlans = Array.isArray(d.appliesToPlans) ? d.appliesToPlans.map(String).slice(0, 20) : [];
  }
  if (d.newCustomersOnly !== undefined) out.newCustomersOnly = !!d.newCustomersOnly;
  if (d.maxRedemptions !== undefined) out.maxRedemptions = Math.max(0, Math.round(Number(d.maxRedemptions) || 0));
  if (d.validFrom !== undefined) out.validFrom = d.validFrom ? new Date(d.validFrom).toISOString() : null;
  if (d.validTo !== undefined) out.validTo = d.validTo ? new Date(d.validTo).toISOString() : null;
  if (d.commission !== undefined) {
    const c = d.commission || {};
    const pct = Number(c.percent) || 0;
    if (pct < 0 || pct > 100) throw new HttpsError("invalid-argument", "commission.percent must be between 0 and 100.");
    out.commission = { percent: Math.round(pct), months: Math.max(0, Math.round(Number(c.months) || 0)) };
  }
  if (d.status !== undefined) {
    if (!["active", "paused"].includes(d.status)) throw new HttpsError("invalid-argument", "status must be active or paused.");
    out.status = d.status;
  }
  if (d.notes !== undefined) out.notes = String(d.notes || "").slice(0, 2000);

  if (out.validFrom && out.validTo && Date.parse(out.validFrom) > Date.parse(out.validTo)) {
    throw new HttpsError("invalid-argument", "The 'valid from' date is after the 'valid to' date.");
  }
  return out;
}

exports.build = function build({ REGIONS, db }) {
  const audit = makeAudit(db);
  const rateLimit = makeRateLimiter(db);

  const OPTS = { region: REGIONS, maxInstances: 10 };

  const codeRef = (code) => db.doc(`referralCodes/${code}`);
  const accountRef = (uid) => db.doc(`accounts/${uid}`);

  /* Load everything a validation decision needs. Kept in one place so the
     dry-run (`validateReferralCode`) and the real thing (`redeemReferralCode`)
     can never disagree about what "valid" means. */
  async function buildContext(uid, code, planId, tx) {
    const get = (ref) => (tx ? tx.get(ref) : ref.get());
    const [redemptionSnap, accountSnap] = await Promise.all([
      get(db.doc(`referralRedemptions/${redemptionId(uid, code)}`)),
      get(accountRef(uid)),
    ]);
    const account = accountSnap.exists ? accountSnap.data() : null;
    return {
      nowMs: Date.now(),
      planId: planId || null,
      // "New" until the account has ever carried a paid plan. A trial is new.
      isNewCustomer: !account || !account.plan || account.status === "trial",
      alreadyRedeemed: redemptionSnap.exists && !redemptionSnap.data().reversed,
      accountAttributedTo: account?.referral?.code || null,
      account,
    };
  }

  /* ============================================================
     Customer-facing
     ============================================================ */

  /*
   * Dry-run a code without consuming it — powers the "code applied ✓" line in
   * onboarding and, later, at checkout.
   */
  const validateReferralCode = onCall(OPTS, async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");

    const code = normaliseCode(request.data?.code);
    if (!isValidCode(code)) return { ok: false, message: publicReason("not_found") };

    // Enumeration guard. Generous enough that a customer fixing a typo never
    // sees it, tight enough that a script cannot walk the keyspace.
    await rateLimit(`refval:${uid}`, {
      max: 20,
      windowMs: 60 * 60 * 1000,
      message: "Too many code attempts. Please try again in a little while.",
    });

    const snap = await codeRef(code).get();
    const doc = snap.exists ? { code, ...snap.data() } : null;
    const ctx = await buildContext(uid, code, request.data?.planId);
    if (doc && doc.owner?.uid === uid) ctx.selfReferral = true;

    const verdict = evaluateCode(doc, ctx);
    if (!verdict.ok) return { ok: false, message: publicReason(verdict.reason) };

    return {
      ok: true,
      code,
      kind: doc.kind,
      label: benefitLabel(doc.benefit),
      benefit: doc.benefit,
      ownerName: doc.kind === "member" ? doc.owner?.name || "" : "",
    };
  });

  /*
   * Attribute this account to a code. Called once, from onboarding.
   *
   * The whole thing is one transaction so the quota check and the increment
   * cannot be separated by a concurrent redemption.
   */
  const redeemReferralCode = onCall(OPTS, async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");

    const code = normaliseCode(request.data?.code);
    if (!isValidCode(code)) throw new HttpsError("invalid-argument", publicReason("not_found"));

    await rateLimit(`refredeem:${uid}`, {
      max: 10,
      windowMs: 60 * 60 * 1000,
      message: "Too many attempts. Please try again in a little while.",
    });

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(codeRef(code));
      const doc = snap.exists ? { code, ...snap.data() } : null;
      const ctx = await buildContext(uid, code, request.data?.planId, tx);
      if (doc && doc.owner?.uid === uid) ctx.selfReferral = true;

      const verdict = evaluateCode(doc, ctx);
      if (!verdict.ok) throw new HttpsError("failed-precondition", publicReason(verdict.reason));

      const at = nowISO();
      const label = benefitLabel(doc.benefit);
      const account = ctx.account;

      tx.set(db.doc(`referralRedemptions/${redemptionId(uid, code)}`), {
        code,
        kind: doc.kind,
        uid,
        partnerUid: doc.owner?.uid || null,
        accountEmail: account?.email || request.auth.token?.email || "",
        firmName: account?.firmName || "",
        stage: "signed_up",
        stageAt: { signed_up: at },
        attributedAt: at,
        firstTouch: request.data?.firstTouch || at,
        lastTouch: request.data?.lastTouch || at,
        benefitSnapshot: { ...doc.benefit, label },
        duration: doc.duration || "first_invoice",
        durationMonths: doc.durationMonths || 0,
        commissionSnapshot: doc.commission || { percent: 0, months: 0 },
        revenuePaise: 0,
        commissionPaise: 0,
        commissionPaidAt: null,
        reversed: false,
      });

      tx.set(
        codeRef(code),
        {
          redemptions: FieldValue.increment(1),
          "funnel.signed_up": FieldValue.increment(1),
          lastRedeemedAt: at,
        },
        { merge: true }
      );

      // The account mirror is what the admin console reads; the users/{uid}
      // copy is what the practitioner's own app can read under its rules.
      tx.set(accountRef(uid), { referral: { code, kind: doc.kind, label, attributedAt: at } }, { merge: true });
      tx.set(db.doc(`users/${uid}`), { referral: { code, label, appliedAt: at } }, { merge: true });

      return { code, label, kind: doc.kind };
    });

    return { ok: true, ...result };
  });

  /*
   * Record a landing-page visit carrying ?ref=CODE. Unauthenticated by
   * necessity — nobody has signed in yet — so it is deduped per visitor and
   * rate-limited per IP, and it can only ever increment a counter.
   */
  const trackReferralVisit = onCall(OPTS, async (request) => {
    const code = normaliseCode(request.data?.code);
    const visitor = String(request.data?.visitorId || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    if (!isValidCode(code) || !visitor) return { ok: false };

    const ip = request.rawRequest?.ip || "unknown";
    try {
      await rateLimit(`refvisit:${ip}`, { max: 60, windowMs: 60 * 60 * 1000 });
    } catch {
      return { ok: false }; // a flood is not worth an error page on the landing
    }

    const seenRef = db.doc(`referralVisits/${visitor}__${code}`);
    const wrote = await db.runTransaction(async (tx) => {
      const [seen, codeSnap] = await Promise.all([tx.get(seenRef), tx.get(codeRef(code))]);
      if (seen.exists || !codeSnap.exists) return false;
      tx.set(seenRef, { code, visitor, at: nowISO(), ip });
      tx.set(codeRef(code), { "funnel.clicked": FieldValue.increment(1) }, { merge: true });
      return true;
    });
    return { ok: wrote };
  });

  /*
   * Get — or lazily mint — the signed-in customer's own share code. This is
   * the word-of-mouth loop: every practitioner has a code they can hand to the
   * CA at the next desk.
   */
  const myReferralCode = onCall(OPTS, async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");

    const existing = await db
      .collection("referralCodes")
      .where("owner.uid", "==", uid)
      .where("kind", "==", "member")
      .limit(1)
      .get();
    if (!existing.empty) {
      const d = existing.docs[0];
      return { code: d.id, label: benefitLabel(d.data().benefit), funnel: d.data().funnel || emptyFunnel() };
    }

    const [accountSnap, userSnap] = await Promise.all([accountRef(uid).get(), db.doc(`users/${uid}`).get()]);
    const profile = userSnap.exists ? userSnap.data() : {};
    const owner = {
      name: profile.firmName || profile.ownerName || accountSnap.data()?.firmName || "",
      email: profile.email || request.auth.token?.email || "",
      phone: profile.phone || "",
      uid,
    };

    // Collisions are astronomically unlikely at 8 characters from a 25-symbol
    // alphabet, but "unlikely" is not "handled".
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = generateCode("PH", 6, rand);
      const created = await db.runTransaction(async (tx) => {
        const snap = await tx.get(codeRef(code));
        if (snap.exists) return false;
        tx.set(codeRef(code), {
          code,
          kind: "member",
          owner,
          benefit: { type: "free_days", value: 30 },
          duration: "first_invoice",
          durationMonths: 0,
          appliesToPlans: [],
          newCustomersOnly: true,
          maxRedemptions: 0,
          redemptions: 0,
          validFrom: null,
          validTo: null,
          commission: { percent: 0, months: 0 },
          status: "active",
          funnel: emptyFunnel(),
          revenuePaise: 0,
          commissionPaise: 0,
          notes: "Auto-generated member code",
          createdBy: uid,
          createdAt: nowISO(),
          updatedAt: nowISO(),
        });
        return true;
      });
      if (created) return { code, label: "30 days free", funnel: emptyFunnel() };
    }
    throw new HttpsError("internal", "Could not generate a code. Please try again.");
  });

  /* ============================================================
     Admin console
     ============================================================ */

  const adminCreateReferralCode = onCall(OPTS, async (request) => {
    requireAdmin(request);
    const fields = sanitiseCodeInput(request.data, { partial: false });

    let code = normaliseCode(request.data?.code);
    if (code && !isValidCode(code)) {
      throw new HttpsError("invalid-argument", "A code must be 4–24 letters or digits.");
    }
    if (!code) code = generateCode("", 8, rand);

    const at = nowISO();
    const created = await db.runTransaction(async (tx) => {
      const snap = await tx.get(codeRef(code));
      if (snap.exists) return false;
      tx.set(codeRef(code), {
        code,
        owner: { name: "", email: "", phone: "", uid: null },
        appliesToPlans: [],
        newCustomersOnly: true,
        maxRedemptions: 0,
        validFrom: null,
        validTo: null,
        commission: { percent: 0, months: 0 },
        status: "active",
        notes: "",
        ...fields,
        redemptions: 0,
        funnel: emptyFunnel(),
        revenuePaise: 0,
        commissionPaise: 0,
        createdBy: request.auth.uid,
        createdAt: at,
        updatedAt: at,
      });
      return true;
    });
    if (!created) throw new HttpsError("already-exists", `The code ${code} is already in use.`);

    await audit(request, "referral.create", code, fields);
    return { ok: true, code };
  });

  /*
   * Edit a code. Counters (`redemptions`, `funnel`, revenue) are NOT editable
   * here — they are derived, and an admin who can hand-set them can hand-set a
   * partner's commission too.
   */
  const adminUpdateReferralCode = onCall(OPTS, async (request) => {
    requireAdmin(request);
    const code = normaliseCode(request.data?.code);
    if (!isValidCode(code)) throw new HttpsError("invalid-argument", "A valid code is required.");

    const patch = sanitiseCodeInput(request.data?.patch, { partial: true });
    if (!Object.keys(patch).length) throw new HttpsError("invalid-argument", "Nothing to update.");

    const ref = codeRef(code);
    if (!(await ref.get()).exists) throw new HttpsError("not-found", `No code ${code}.`);
    await ref.set({ ...patch, updatedAt: nowISO() }, { merge: true });

    await audit(request, "referral.update", code, patch);
    return { ok: true };
  });

  /*
   * Undo an attribution — the fraud lever. Frees the account to be attributed
   * again, gives the quota slot back, and writes off any commission accrued.
   */
  const adminReverseRedemption = onCall(OPTS, async (request) => {
    requireAdmin(request);
    const id = String(request.data?.redemptionId || "");
    const reason = String(request.data?.reason || "").slice(0, 500);
    if (!id) throw new HttpsError("invalid-argument", "redemptionId is required.");

    const ref = db.doc(`referralRedemptions/${id}`);
    const out = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError("not-found", "No such redemption.");
      const d = snap.data();
      if (d.reversed) throw new HttpsError("failed-precondition", "This redemption is already reversed.");

      const at = nowISO();
      tx.set(ref, { reversed: true, reversedAt: at, reversedBy: request.auth.uid, reversalReason: reason }, { merge: true });
      tx.set(
        codeRef(d.code),
        {
          redemptions: FieldValue.increment(-1),
          "funnel.signed_up": FieldValue.increment(-1),
          commissionPaise: FieldValue.increment(-(d.commissionPaise || 0)),
        },
        { merge: true }
      );
      tx.set(accountRef(d.uid), { referral: FieldValue.delete() }, { merge: true });
      tx.set(db.doc(`users/${d.uid}`), { referral: FieldValue.delete() }, { merge: true });
      return { code: d.code, uid: d.uid };
    });

    await audit(request, "referral.reverse", id, { reason, ...out });
    return { ok: true };
  });

  return {
    validateReferralCode,
    redeemReferralCode,
    trackReferralVisit,
    myReferralCode,
    adminCreateReferralCode,
    adminUpdateReferralCode,
    adminReverseRedemption,
  };
};

// Exposed for the unit tests.
exports.helpers = { sanitiseCodeInput, emptyFunnel, redemptionId, KINDS, DURATIONS };
