/*
 * ProHippo — admin console backend.
 *
 * The console runs at /admin inside the same React app, but it is a different
 * trust domain, and the boundary is drawn here rather than in the browser:
 *
 *   • Access is a CUSTOM CLAIM (`admin: true`), not a Firestore flag. It is
 *     signed into the ID token, so firestore.rules and every callable agree
 *     without an extra read, and nothing the browser can write can grant it.
 *
 *   • The console reads `accounts/{uid}` — a server-owned mirror of who the
 *     customer is and what they are paying — and NEVER `users/{uid}/**`. That
 *     subtree is the practitioner's clients' PANs, notices and assessment
 *     records. Support does not need it, this codebase does not read it, and
 *     the rules do not permit it. The counters below are the deliberate
 *     compromise: how MANY assessees, never which.
 *
 *   • Every mutation writes an `adminAudit` entry.
 *
 * `accounts` is kept in step by a trigger on the profile document, not by the
 * client, so an account cannot lie about its own plan.
 */
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { getAuth } = require("firebase-admin/auth");
const { FieldValue } = require("firebase-admin/firestore");

const { requireAdmin, makeAudit, dayKey, canAdvance } = require("./adminCore");

const nowISO = () => new Date().toISOString();

const ACCOUNT_STATUSES = ["trial", "active", "past_due", "cancelled", "suspended", "deleted"];
const TRIAL_DAYS = 14;

/* Which per-tenant collections the nightly rollup counts. Counting is done with
   Firestore aggregate queries (billed at one read per 1000 documents), so this
   list can grow without the job getting expensive. */
const COUNTED = ["assessees", "matters", "hearings", "notices", "communications", "invoices"];

exports.build = function build({ REGIONS, PRIMARY_REGION, TRIGGER_REGION, db }) {
  const audit = makeAudit(db);
  const OPTS = { region: REGIONS, maxInstances: 10 };

  const accountRef = (uid) => db.doc(`accounts/${uid}`);

  /* ============================================================
     Account mirror
     ============================================================ */

  /*
   * users/{uid} is the practitioner's own profile document — the only thing
   * they can write about themselves. This copies the non-sensitive identity
   * fields into accounts/{uid}, which is what the console reads.
   *
   * Note what is NOT copied: plan, status, entitlements. Those are set by
   * admins and (later) by the payment webhook. If the mirror wrote them, a
   * customer could grant themselves a plan by writing their own profile.
   */
  const mirrorAccountProfile = onDocumentWritten(
    { document: "users/{uid}", region: TRIGGER_REGION },
    async (event) => {
      const uid = event.params.uid;
      const after = event.data?.after?.data();

      if (!after) {
        // Profile gone. Keep the account row — billing history and referral
        // attribution outlive the profile — but mark it.
        await accountRef(uid).set({ status: "deleted", deletedAt: nowISO() }, { merge: true }).catch(() => {});
        return;
      }

      const existing = await accountRef(uid).get();
      const createdAt = after.createdAt || existing.data()?.createdAt || nowISO();

      const mirror = {
        uid,
        ownerName: after.ownerName || "",
        firmName: after.firmName || "",
        email: after.email || "",
        phone: after.phone || "",
        phoneVerified: !!after.phoneVerified,
        createdAt,
        lastSeenAt: after.lastSeenAt || existing.data()?.lastSeenAt || null,
        profileUpdatedAt: nowISO(),
      };

      if (!existing.exists) {
        // First sight of this account: start the trial clock.
        mirror.plan = null;
        mirror.status = "trial";
        mirror.trialEndsAt = new Date(Date.parse(createdAt) + TRIAL_DAYS * 86400000).toISOString();
        mirror.seats = 1;
        mirror.signupSource = after.signupSource || "web";
        mirror.counters = {};
        mirror.flags = {};
      }

      await accountRef(uid).set(mirror, { merge: true });
    }
  );

  /* ============================================================
     Console reads
     ============================================================ */

  /*
   * Headline numbers for the overview page. Aggregate count queries rather
   * than fetching documents, so this stays a handful of reads however many
   * customers there are.
   */
  const adminOverview = onCall(OPTS, async (request) => {
    requireAdmin(request);
    const accounts = db.collection("accounts");
    const since = (days) => new Date(Date.now() - days * 86400000).toISOString();

    const countOf = async (q) => (await q.count().get()).data().count;

    const [total, trial, active, pastDue, cancelled, new7, new30, active7, codes, redemptions] = await Promise.all([
      countOf(accounts),
      countOf(accounts.where("status", "==", "trial")),
      countOf(accounts.where("status", "==", "active")),
      countOf(accounts.where("status", "==", "past_due")),
      countOf(accounts.where("status", "==", "cancelled")),
      countOf(accounts.where("createdAt", ">=", since(7))),
      countOf(accounts.where("createdAt", ">=", since(30))),
      countOf(accounts.where("lastSeenAt", ">=", since(7))),
      countOf(db.collection("referralCodes").where("status", "==", "active")),
      countOf(db.collection("referralRedemptions").where("reversed", "==", false)),
    ]);

    // Trials that ran out without converting are the number worth watching.
    // This is the one query here needing a composite index (see
    // firestore.indexes.json); until it finishes building, the rest of the
    // overview should still render rather than the whole page erroring.
    const expiredTrials = await countOf(
      accounts.where("status", "==", "trial").where("trialEndsAt", "<", nowISO())
    ).catch((e) => {
      console.warn("expiredTrials count unavailable:", e.message || e);
      return null;
    });

    return {
      accounts: { total, trial, active, pastDue, cancelled },
      growth: { new7, new30, active7, expiredTrials },
      referrals: { activeCodes: codes, redemptions },
      // Conversion over the whole life of the product, not a window — a rate
      // computed over 30 days when you have 30 customers is noise.
      conversionRate: total ? Math.round((active / total) * 1000) / 10 : 0,
      at: nowISO(),
    };
  });

  /*
   * Exact-match customer lookup by email or phone, going through Firebase Auth
   * so a customer who signed up by SMS and mailed support from a different
   * address is still findable. Substring search over the visible list is done
   * in the browser against `accounts`, which admins can read directly.
   */
  const adminLookupUser = onCall(OPTS, async (request) => {
    requireAdmin(request);
    const q = String(request.data?.query || "").trim();
    if (!q) throw new HttpsError("invalid-argument", "A search term is required.");

    const auth = getAuth();
    let record = null;
    try {
      record = q.includes("@")
        ? await auth.getUserByEmail(q.toLowerCase())
        : await auth.getUserByPhoneNumber(q.startsWith("+") ? q : `+91${q.replace(/\D/g, "").slice(-10)}`);
    } catch {
      return { found: false };
    }

    const snap = await accountRef(record.uid).get();
    return {
      found: true,
      uid: record.uid,
      email: record.email || null,
      phone: record.phoneNumber || null,
      disabled: record.disabled,
      createdAt: record.metadata?.creationTime || null,
      lastSignInAt: record.metadata?.lastSignInTime || null,
      isAdmin: record.customClaims?.admin === true,
      account: snap.exists ? snap.data() : null,
    };
  });

  /* ============================================================
     Console writes
     ============================================================ */

  /*
   * Change a customer's plan, status or trial end. This is the manual lever —
   * extend a trial for a prospect, suspend an abusive account, park a customer
   * on `past_due` while a mandate is re-authorised.
   */
  const adminUpdateAccount = onCall(OPTS, async (request) => {
    requireAdmin(request);
    const uid = String(request.data?.uid || "");
    if (!uid) throw new HttpsError("invalid-argument", "uid is required.");

    const d = request.data?.patch || {};
    const patch = {};
    if (d.plan !== undefined) patch.plan = d.plan ? String(d.plan) : null;
    if (d.status !== undefined) {
      if (!ACCOUNT_STATUSES.includes(d.status)) {
        throw new HttpsError("invalid-argument", `status must be one of ${ACCOUNT_STATUSES.join(", ")}.`);
      }
      patch.status = d.status;
    }
    if (d.trialEndsAt !== undefined) {
      patch.trialEndsAt = d.trialEndsAt ? new Date(d.trialEndsAt).toISOString() : null;
    }
    if (d.seats !== undefined) patch.seats = Math.max(1, Math.round(Number(d.seats) || 1));
    if (d.notes !== undefined) patch.notes = String(d.notes || "").slice(0, 4000);
    if (d.flags !== undefined && typeof d.flags === "object") patch.flags = d.flags;

    if (!Object.keys(patch).length) throw new HttpsError("invalid-argument", "Nothing to update.");
    if (!(await accountRef(uid).get()).exists) throw new HttpsError("not-found", "No such account.");

    patch.updatedAt = nowISO();
    patch.updatedBy = request.auth.uid;
    await accountRef(uid).set(patch, { merge: true });

    await audit(request, "account.update", uid, patch);
    return { ok: true };
  });

  /*
   * Grant or revoke admin on another account.
   *
   * The FIRST admin is granted out-of-band by scripts/grant-admin.mjs, run
   * against a service account from a machine you control. There is deliberately
   * no self-service path in here: an endpoint that can make its caller an admin
   * is a privilege-escalation hole no amount of validation redeems.
   */
  const adminSetRole = onCall(OPTS, async (request) => {
    const actor = requireAdmin(request);
    const uid = String(request.data?.uid || "");
    const makeAdmin = !!request.data?.admin;
    if (!uid) throw new HttpsError("invalid-argument", "uid is required.");
    if (uid === actor) throw new HttpsError("failed-precondition", "You can't change your own admin access.");

    const auth = getAuth();
    const record = await auth.getUser(uid).catch(() => null);
    if (!record) throw new HttpsError("not-found", "No such user.");

    // Preserve any other claims; drop the key entirely when revoking rather
    // than storing `admin: false`, so the token stays small and the rules'
    // `== true` test is the only thing that ever matters.
    const claims = { ...(record.customClaims || {}) };
    if (makeAdmin) claims.admin = true;
    else delete claims.admin;
    await auth.setCustomUserClaims(uid, claims);
    // Existing ID tokens keep the old claim until they expire (up to an hour).
    // Revoking forces a refresh, so removing access takes effect immediately.
    if (!makeAdmin) await auth.revokeRefreshTokens(uid);
    await accountRef(uid).set({ isAdmin: makeAdmin }, { merge: true }).catch(() => {});

    await audit(request, makeAdmin ? "role.grant" : "role.revoke", uid, { email: record.email || null });
    return { ok: true };
  });

  /* ============================================================
     Nightly rollup
     ============================================================ */

  /*
   * An account's API spend over the last 30 days and month-to-date, summed from
   * the per-day documents the cost meter writes. Read by document id — 30 keyed
   * reads, no query and no index.
   */
  async function recomputeSpend(uid) {
    const ids = [];
    for (let i = 0; i < 31; i++) ids.push(dayKey(Date.now() - i * 86400000));
    const snaps = await db.getAll(...ids.map((d) => db.doc(`usageDaily/${uid}_${d}`)));

    const thisMonth = dayKey(Date.now()).slice(0, 7);
    let last30 = 0;
    let mtd = 0;
    let calls = 0;
    for (const s of snaps) {
      if (!s.exists) continue;
      const d = s.data();
      last30 += d.totalInrMicro || 0;
      calls += d.calls || 0;
      if ((d.date || "").startsWith(thisMonth)) mtd += d.totalInrMicro || 0;
    }
    return { last30InrMicro: last30, mtdInrMicro: mtd, last30Calls: calls, recomputedAt: nowISO() };
  }

  /*
   * Refreshes per-account usage counters and advances referral funnel stages.
   *
   * Activation is computed HERE rather than reported by the client: "this
   * account did something real" is a number a partner gets paid on, and a
   * client-reported milestone is a number a partner can fake.
   *
   * 02:30 IST — after the day has rolled over in India, before anyone is
   * looking at the dashboard.
   */
  const rollupAccounts = onSchedule(
    { schedule: "30 2 * * *", timeZone: "Asia/Kolkata", region: PRIMARY_REGION, timeoutSeconds: 540 },
    async () => {
      const snap = await db.collection("accounts").select("counters", "referral", "status").get();
      const today = dayKey(Date.now());
      let activatedNow = 0;

      for (const doc of snap.docs) {
        const uid = doc.id;
        const counters = {};
        for (const name of COUNTED) {
          try {
            counters[name] = (await db.collection(`users/${uid}/${name}`).count().get()).data().count;
          } catch {
            counters[name] = doc.data().counters?.[name] || 0;
          }
        }
        /* Recompute spend from usageDaily rather than trusting the live
           increments. Those exist so the console is current within the day;
           this is what handles the month boundary — without it, mtd would keep
           climbing from January forever. */
        const spend = await recomputeSpend(uid);
        await doc.ref.set({ counters, countersAt: nowISO(), spend }, { merge: true });

        // Activation: the account has real work in it, not just a signup.
        const referral = doc.data().referral;
        if (referral?.code && counters.assessees > 0) {
          const redRef = db.doc(`referralRedemptions/${uid}__${referral.code}`);
          const red = await redRef.get();
          if (red.exists && !red.data().reversed && canAdvance(red.data().stage, "activated")) {
            await redRef.set(
              { stage: "activated", [`stageAt.activated`]: nowISO() },
              { merge: true }
            );
            await db.doc(`referralCodes/${referral.code}`)
              .set({ "funnel.activated": FieldValue.increment(1) }, { merge: true })
              .catch(() => {});
            activatedNow++;
          }
        }
      }

      // A daily snapshot, so the console can chart growth without ever
      // scanning the whole accounts collection.
      const countOf = async (q) => (await q.count().get()).data().count;
      const accounts = db.collection("accounts");
      await db.doc(`growthDaily/${today}`).set({
        date: today,
        total: snap.size,
        trial: await countOf(accounts.where("status", "==", "trial")),
        active: await countOf(accounts.where("status", "==", "active")),
        pastDue: await countOf(accounts.where("status", "==", "past_due")),
        cancelled: await countOf(accounts.where("status", "==", "cancelled")),
        activatedToday: activatedNow,
        at: nowISO(),
      });

      console.info(`rollupAccounts: ${snap.size} accounts, ${activatedNow} newly activated`);
    }
  );

  return {
    mirrorAccountProfile,
    adminOverview,
    adminLookupUser,
    adminUpdateAccount,
    adminSetRole,
    rollupAccounts,
  };
};

exports.constants = { ACCOUNT_STATUSES, TRIAL_DAYS, COUNTED };
