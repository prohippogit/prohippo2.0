/*
 * ProHippo — WhatsApp delivery through WATI.
 *
 * Self-contained, like googleCalendar.js: the region constants, the Firestore
 * handle and the cost meter are passed in rather than redefined, so there is
 * still exactly one definition of each. Setup: docs/WHATSAPP_SETUP.md
 *
 * THIS FILE SENDS NOTHING BY ITSELF. It is the pipe — address resolution,
 * consent, quota, the WATI call, the delivery log and the status webhook. The
 * six messages that use it (notice alerts, hearing reminder, cause list,
 * document request, invoice) arrive in later phases and each supplies its own
 * template and parameters.
 *
 * WHY A TEMPLATE AT ALL, AND NOT JUST TEXT. WhatsApp lets a business send free
 * text only inside a 24-hour window opened by the recipient writing first.
 * Everything ProHippo sends is business-initiated to someone who has not
 * written, so every message must be a template Meta approved in advance. That
 * is why TEMPLATES below is a registry rather than a formatting concern: it is
 * the record of what may legally be sent, and sending a name that is not in it
 * fails here rather than at Meta.
 */
"use strict";

const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const crypto = require("node:crypto");

const {
  whatsAppEnabledFor, userReachability, istDate,
  shouldAlertNotice, noticeAlertParams,
  isHearingLive, hearingReminderParams,
  burstDecision, BURST_MAX,
} = require("./whatsappCore");

/* Tenant-specific base, e.g. https://live-mt-server.wati.io/123456 — it is not
   a shared host, so it is configuration rather than a constant. The token is a
   long-lived bearer JWT. The webhook secret is ours, not WATI's: see
   verifyWebhookCaller(). */
const watiEndpoint = defineSecret("WATI_API_ENDPOINT");
const watiToken = defineSecret("WATI_API_TOKEN");
const watiWebhookSecret = defineSecret("WATI_WEBHOOK_SECRET");

const WATI_SECRETS = [watiEndpoint, watiToken];

/* WATI's REST path segment. Some tenants are provisioned on /api/v2/. Read the
   interactive API docs inside your own WATI dashboard — they are authoritative
   for your tenant, and generic documentation is not — and change this one
   constant if yours differs. */
const API_VERSION = "v1";

/*
 * HOW A DOCUMENT REACHES A MEDIA HEADER — NOT YET CONFIRMED ON OUR TENANT.
 *
 * Three of the six messages attach a PDF (document request, cause list,
 * invoice), which means a template with a DOCUMENT header. WATI carries the
 * file's URL in one of two shapes depending on the tenant's API version, and
 * guessing wrong fails at send time with an unhelpful 400.
 *
 * Set this to whichever your dashboard's API docs show, and confirm with one
 * live send before relying on it. Everything else in this file is independent
 * of the answer, which is why it is one switch and not a rewrite.
 */
const MEDIA_MODE = "body"; // "body" — top-level media object | "header-param"

/*
 * The templates approved on the WhatsApp Business Account, and the languages
 * each is approved IN.
 *
 * A template is identified by (name, language). Gujarati is a separate Meta
 * submission from English, separately reviewed and separately rejectable — so
 * a language that is not listed here is a language that cannot be sent, and
 * asking for one falls back to English rather than failing. Add codes here as
 * each approval lands in WATI; nothing else needs to change.
 *
 * Everything starts at English only, because at the time of writing nothing has
 * been submitted. Listing a language before Meta has approved it would turn a
 * clear rejection at submission time into a silent send failure later.
 */
const TEMPLATES = {
  ph_doc_request_v1: { languages: ["en"], media: "document", feature: "docRequest" },
  ph_notice_alert_user_v1: { languages: ["en"], media: null, feature: "noticeAlertUser" },
  // No variables at all — see burstDecision() in whatsappCore.js for why it
  // carries no count.
  ph_notice_burst_user_v1: { languages: ["en"], media: null, feature: "noticeAlertUser" },
  ph_notice_alert_client_v1: { languages: ["en"], media: null, feature: "noticeAlertClient" },
  ph_hearing_reminder_user_v1: { languages: ["en"], media: null, feature: "hearingReminder" },
  ph_cause_list_weekly_v1: { languages: ["en"], media: "document", feature: "causeList" },
  ph_invoice_v1: { languages: ["en"], media: "document", feature: "invoice" },
  ph_invoice_undeliverable_user_v1: { languages: ["en"], media: "document", feature: "invoice" },
};

/* Per-user rolling cap. A practice sends a handful of these a day; this is far
   above normal use and exists so a runaway trigger or a stolen session cannot
   turn the WhatsApp number into a broadcast cannon — which, unlike a mail
   cannon, would cost every OTHER practice on the number its quality rating. */
const WA_WINDOW_MS = 60 * 60 * 1000;
const WA_MAX_PER_WINDOW = 100;

// Delivery states, ranked so a late-arriving earlier event never downgrades
// what we already know. Deliberately the same vocabulary and the same ranks as
// the Resend ladder in index.js where the two overlap: the Communications log
// is one screen and should not need two vocabularies to read.
const STATUS_RANK = {
  Queued: 0, Sent: 1, Delivered: 3, Read: 4,
  Undelivered: 5, Failed: 5,
};

/*
 * WATI's webhook event names, normalised to lower-case with separators removed
 * before lookup — tenants differ on casing and on whether the field is `type`
 * or `eventType`, and a status update silently dropped because of a capital
 * letter is a delivery log that quietly stops moving.
 *
 * Anything unrecognised is logged with its raw name rather than ignored, so a
 * name this list is missing shows up in the logs as something to add instead of
 * as an absence nobody notices.
 */
const EVENT_STATUS = {
  sentmessagesent: "Sent",
  messagesent: "Sent",
  sentmessagedelivered: "Delivered",
  messagedelivered: "Delivered",
  sentmessageread: "Read",
  messageread: "Read",
  sentmessagefailed: "Failed",
  messagefailed: "Failed",
  templatemessagefailed: "Failed",
  sentmessageundelivered: "Undelivered",
  messageundelivered: "Undelivered",
};

const normEvent = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");

/* What a client writes to make it stop.
 *
 * Matched on the whole message, not a prefix: "stop" ends it, "stop sending me
 * the wrong year's papers" is a complaint to the practitioner and must not
 * silently unsubscribe them. Hindi and Gujarati included because the client
 * base writes in them, and an opt-out a person cannot express in their own
 * language is not an opt-out. */
const STOP_WORDS = new Set([
  "stop", "unsubscribe", "optout", "opt out", "cancel",
  "band karo", "bandh karo", "band karo message", "रोको", "बंद करो", "बंद",
  "બંધ કરો", "બંધ",
]);
const START_WORDS = new Set(["start", "unstop", "resume", "subscribe", "shuru karo", "चालू करो", "શરૂ કરો"]);

const E164_RE = /^\+91[6-9]\d{9}$/;
const digitsOf = (e164) => String(e164 || "").replace(/\D/g, "");

exports.build = function build({ REGIONS, PRIMARY_REGION, TRIGGER_REGION, db, recordSpend }) {
  /* ---------------- opt-out, kept globally ----------------
   *
   * Keyed on the number rather than on (practice, number), because a person who
   * says STOP is telling WhatsApp they do not want ProHippo's messages — not
   * that they want them from one firm and not another. They are all on one
   * WhatsApp number and a client cannot tell them apart, so honouring it
   * per-practice would be honouring it in a way the person cannot observe.
   *
   * Top-level and unreadable from any browser: firestore.rules denies
   * everything it does not name, and this is not named. */
  const optOutRef = (mobile) => db.doc(`waOptOut/${digitsOf(mobile)}`);

  async function isOptedOut(mobile) {
    try {
      const snap = await optOutRef(mobile).get();
      return snap.exists && !snap.data().clearedAt;
    } catch (e) {
      /* Fail CLOSED. If we cannot tell whether someone asked us to stop, the
         safe answer is to not send — the cost of a missed reminder is one
         message, the cost of messaging someone who opted out is the number's
         quality rating and, at the far end, the account. */
      console.error("waOptOut lookup failed, refusing send:", e.message || e);
      return true;
    }
  }

  async function setOptOut(mobile, { text = "", source = "inbound" } = {}) {
    const now = new Date().toISOString();
    await optOutRef(mobile).set(
      { mobile, at: now, source, lastMessage: String(text).slice(0, 200), clearedAt: "" },
      { merge: true }
    );
  }

  async function clearOptOut(mobile) {
    await optOutRef(mobile).set({ clearedAt: new Date().toISOString() }, { merge: true });
  }

  /* ---------------- quota ----------------
   *
   * Returns rather than throws, unlike reserveMailQuota in index.js. That one
   * is only ever reached from a callable, where an HttpsError is the response;
   * these sends also come from schedulers and Firestore triggers, where a
   * thrown HttpsError is just a confusing log line. Every caller has to decide
   * what a refusal means anyway — a document request tells the practitioner, a
   * cause list waits a week — so the decision is handed back rather than made
   * here. Transactional, so parallel sends cannot both slip past the cap. */
  async function reserveQuota(uid) {
    const ref = db.collection("whatsappQuota").doc(uid);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const now = Date.now();
      const d = snap.exists ? snap.data() : {};
      const fresh = !d.windowStart || now - d.windowStart >= WA_WINDOW_MS;
      const count = fresh ? 0 : d.count || 0;
      if (count >= WA_MAX_PER_WINDOW) {
        const mins = Math.ceil((WA_WINDOW_MS - (now - d.windowStart)) / 60000);
        return { ok: false, retryInMinutes: mins, message: `${WA_MAX_PER_WINDOW} WhatsApp messages have gone out from this account in the last hour. Try again in about ${mins} minute${mins === 1 ? "" : "s"}.` };
      }
      tx.set(ref, { windowStart: fresh ? now : d.windowStart, count: count + 1, lastSentAt: now }, { merge: true });
      return { ok: true, retryInMinutes: 0, message: "" };
    });
  }

  /* ---------------- language ----------------
   *
   * The practitioner picks a language per client (assessee.messageLanguage) and
   * a default per practice. Meta may not have approved the template in it. This
   * returns what will ACTUALLY be sent plus whether it is what was asked for, so
   * the log can say "sent in English because Gujarati isn't approved yet" —
   * silently sending English while the app shows Gujarati is the bug that costs
   * a client's trust rather than a message. */
  function resolveLanguage(templateName, preferred) {
    const spec = TEMPLATES[templateName];
    const want = String(preferred || "en").trim() || "en";
    if (!spec) return { language: "en", requested: want, substituted: want !== "en" };
    if (spec.languages.includes(want)) return { language: want, requested: want, substituted: false };
    return { language: "en", requested: want, substituted: true };
  }

  /* ---------------- the WATI call ----------------
   *
   * One HTTP POST, metered whatever happens. Returns the provider's message id
   * on success; throws a plain Error with a `code` on failure, because this is
   * called from callables, schedulers and triggers alike and only the callable
   * ones want an HttpsError.
   */
  async function callWati({ uid, to, template, language, params, media, feature }) {
    const started = Date.now();
    let ok = false;
    let errorCode = null;
    try {
      const base = String(watiEndpoint.value() || "").replace(/\/+$/, "");
      if (!base) throw Object.assign(new Error("WATI endpoint is not configured."), { code: "not-configured" });

      const body = {
        template_name: template,
        broadcast_name: `${template}_${new Date().toISOString().slice(0, 10)}`,
        /* WATI takes positional variables as name/value pairs, where the name is
           the number inside the braces: {{1}} is {name:"1"}.

           EMPTY IS NOT ALLOWED. Meta rejects a send whose parameter is an empty
           string, so one missing bench would fail an otherwise perfect hearing
           reminder. Each message builder already substitutes something true —
           "not stated", the authority instead of the bench — and this is the
           backstop under them, logged so a gap surfaces rather than becoming an
           em-dash nobody questions. */
        parameters: (params || []).map((value, i) => {
          const v = String(value ?? "").trim();
          if (!v) console.warn(`WhatsApp ${template}: parameter ${i + 1} was empty`);
          return { name: String(i + 1), value: v || "—" };
        }),
      };
      // Meta requires the language of an approved variant; a template approved
      // only in English must be asked for in English.
      if (language) body.template_language = language;

      if (media && media.url) {
        if (MEDIA_MODE === "header-param") {
          body.parameters.unshift({ name: "header_document", value: media.url });
        } else {
          body.media = { url: media.url, filename: media.fileName || "document.pdf" };
        }
      }

      const url = `${base}/api/${API_VERSION}/sendTemplateMessage?whatsappNumber=${encodeURIComponent(digitsOf(to))}`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: watiToken.value(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const text = await res.text().catch(() => "");
      if (!res.ok) {
        console.error("WATI send failed:", res.status, text.slice(0, 300));
        errorCode = `http_${res.status}`;
        throw Object.assign(new Error("WhatsApp message could not be sent right now."), { code: "unavailable", status: res.status });
      }

      let json = null;
      try { json = JSON.parse(text); } catch { json = null; }
      /* WATI answers 200 with {"result": false} for a rejected send — an
         unapproved template, a number that is not a contact. Treating HTTP 200
         as success would record those as delivered and they never arrive. */
      if (json && json.result === false) {
        const why = String(json.info || json.message || "rejected").slice(0, 200);
        console.error("WATI rejected the send:", why);
        errorCode = "rejected";
        throw Object.assign(new Error(`WhatsApp rejected the message: ${why}`), { code: "failed-precondition" });
      }

      ok = true;
      return String(json?.message?.id || json?.id || json?.messageId || "");
    } catch (e) {
      errorCode = errorCode || String(e?.code || e?.message || "error").slice(0, 80);
      throw e;
    } finally {
      await recordSpend({
        uid: uid || null,
        vendor: "wati",
        sku: "whatsapp-utility",
        feature: feature || "whatsapp",
        units: ok ? 1 : 0,
        ms: Date.now() - started,
        ok,
        errorCode,
      });
    }
  }

  /* ---------------- the one entry point ----------------
   *
   * Everything a message needs doing around the send: refuse what must not go,
   * reserve quota, call WATI, write the delivery log, and index the provider's
   * id so the webhook can find the row again without a query.
   *
   * NEVER THROWS. Every caller is a background job or a batch of clients, and
   * one unreachable group head must not abort the other nine. The result says
   * what happened and the communications row records it either way — a delivery
   * log that only holds successes is the one thing worse than no log, because
   * it is the thing you show a client who says they never received it.
   */
  async function deliver({
    uid,
    to,
    template,
    language = "en",
    params = [],
    media = null,
    assesseeId = "",
    assessee = "",
    requestId = "",
    recipientRole = "user",
    recipientName = "",
    subject = "",
    body = "",
  }) {
    const spec = TEMPLATES[template];
    const now = new Date().toISOString();

    const log = async (status, extra = {}) => {
      const ref = await db.collection(`users/${uid}/communications`).add({
        channel: "WhatsApp",
        to: recipientName ? `${recipientName} (${to})` : to,
        mobile: to,
        assesseeId,
        assessee,
        requestId,
        subject,
        body,
        template: spec ? spec.feature : template,
        waTemplate: template,
        recipientRole,
        status,
        time: now,
        createdAt: now,
        ...extra,
      });
      return ref.id;
    };

    if (!spec) {
      // A template name not in the registry is a programming error, not a
      // delivery failure — say so loudly and write nothing to the log.
      console.error(`deliver(): unknown template "${template}"`);
      return { ok: false, reason: "unknown-template", message: `Unknown WhatsApp template "${template}".` };
    }
    if (!E164_RE.test(String(to))) {
      await log("Failed", { failureReason: "invalid-number" });
      return { ok: false, reason: "invalid-number", message: "That is not a valid Indian mobile number." };
    }
    if (await isOptedOut(to)) {
      await log("Failed", { failureReason: "opted-out" });
      return { ok: false, reason: "opted-out", message: "This number has asked to stop receiving WhatsApp messages." };
    }

    const quota = await reserveQuota(uid);
    if (!quota.ok) {
      await log("Failed", { failureReason: "quota" });
      return { ok: false, reason: "quota", message: quota.message, retryInMinutes: quota.retryInMinutes };
    }

    const lang = resolveLanguage(template, language);

    // No initialiser: the catch below always returns, so this is assigned before
    // anything reads it.
    let messageId;
    try {
      messageId = await callWati({
        uid, to, template,
        language: lang.language,
        params, media,
        feature: spec.feature,
      });
    } catch (e) {
      const message = String(e?.message || e).slice(0, 200);
      await log("Failed", { failureReason: String(e?.code || "error"), error: message });
      return { ok: false, reason: "send-failed", message };
    }

    const commId = await log("Queued", {
      providerId: messageId,
      waLanguage: lang.language,
      // Recorded rather than inferred: six months from now "why is this one in
      // English" is a question the log should answer by itself.
      waLanguageRequested: lang.requested,
      waLanguageSubstituted: lang.substituted,
    });

    /* Index the provider's id so the webhook is a document read rather than a
       collection-group query. Same shape as emailEvents; same reason. */
    if (messageId) {
      await db.collection("waEvents").doc(messageId).set({ uid, commId, createdAt: now }).catch((e) => {
        // The message is already sent. Losing the index costs delivery statuses
        // on this one row, which is not worth failing the send over.
        console.error("waEvents index write failed:", e.message || e);
      });
    }

    return { ok: true, to, messageId, communicationId: commId, language: lang };
  }

  /* ---------------- inbound & delivery webhook ----------------
   *
   * WATI does not sign its webhooks the way Resend does, so there is no
   * signature to verify — the protection is a secret only WATI and this
   * function know, given to WATI either in the URL (?token=…) or as a header.
   * Compared in constant time, because a byte-by-byte comparison of a secret is
   * a byte-by-byte way to learn it.
   */
  function verifyWebhookCaller(req) {
    const expected = String(watiWebhookSecret.value() || "");
    if (!expected || expected === "placeholder") return false;
    const got = String(req.query?.token || req.get("x-wati-token") || "");
    const a = Buffer.from(got);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  const watiWebhook = onRequest(
    // Single region on purpose: WATI calls one fixed URL, and unlike the
    // callables there is no older client pinned to us-central1.
    { region: PRIMARY_REGION, secrets: [watiWebhookSecret], maxInstances: 10 },
    async (req, res) => {
      if (req.method !== "POST") { res.status(405).send("Method not allowed"); return; }
      if (!verifyWebhookCaller(req)) {
        console.warn("WATI webhook: caller verification failed");
        res.status(401).send("Invalid token");
        return;
      }

      const event = req.body || {};
      try {
        const status = EVENT_STATUS[normEvent(event.type || event.eventType)];
        if (status) {
          await applyStatus(event, status);
        } else if (isInbound(event)) {
          await handleInbound(event);
        } else {
          // Not an error — WATI sends event types we have no use for. Logged
          // with its raw name so a type we SHOULD handle shows up as something
          // to add rather than as an absence nobody notices.
          console.log("WATI webhook: unhandled event", String(event.type || event.eventType || "?").slice(0, 60));
        }
      } catch (e) {
        // Log and still return 200: a retry storm will not fix a bad write, and
        // the send itself already succeeded.
        console.error("WATI webhook handling failed:", e.message || e);
      }
      res.status(200).send("ok");
    }
  );

  const isInbound = (event) => {
    const t = normEvent(event.type || event.eventType);
    return (t === "message" || t.startsWith("sessionmessage") || t === "newcontactmessagereceived")
      && (event.owner === false || event.fromMe === false || event.owner === undefined);
  };

  async function applyStatus(event, status) {
    const messageId = String(event.id || event.messageId || event.whatsappMessageId || "");
    if (!messageId) return;

    const idx = await db.collection("waEvents").doc(messageId).get();
    if (!idx.exists) return;
    const { uid, commId } = idx.data();

    const ref = db.doc(`users/${uid}/communications/${commId}`);
    const snap = await ref.get();
    if (!snap.exists) return;

    const current = snap.data().status || "Queued";
    if ((STATUS_RANK[status] ?? 0) > (STATUS_RANK[current] ?? 0)) {
      await ref.set({ status, statusAt: new Date().toISOString() }, { merge: true });
    }
  }

  /*
   * An inbound message. For now this does exactly one thing — honour STOP —
   * and files everything else for the practitioner to read.
   *
   * The bigger prize is deliberately NOT built here: a reply opens a 24-hour
   * window in which free-form messages are unrestricted and free, which is
   * where a client WhatsApping a PDF back should attach itself to the matching
   * docRequests item. That needs the document request flow to exist first.
   */
  async function handleInbound(event) {
    const from = String(event.waId || event.senderPhone || event.from || "");
    const text = String(event.text || event.body || "").trim();
    if (!from) return;

    const mobile = `+${digitsOf(from)}`;
    const word = text.toLowerCase().replace(/[.!]+$/, "").trim();

    if (STOP_WORDS.has(word)) {
      await setOptOut(mobile, { text, source: "inbound" });
      console.log("WATI webhook: opt-out recorded");
      return;
    }
    if (START_WORDS.has(word)) {
      await clearOptOut(mobile);
      console.log("WATI webhook: opt-out cleared");
    }
  }

  /* ---------------- claiming a send, exactly once ----------------
   *
   * `users/{uid}/waSent/{key}` is created transactionally BEFORE the message
   * goes out, and a key that already exists means somebody already sent it.
   *
   * CLAIMED FIRST, AND NOT RELEASED ON FAILURE. The instinct is to delete the
   * claim when a send fails so it can be retried, and it is the wrong instinct
   * here: Cloud Functions delivers a trigger more than once as a matter of
   * course, and a hearing sweep that half-failed will run again tomorrow.
   * Releasing turns "we tried and it failed, and the log says so" into "the
   * client got the same message four times", and only one of those is a
   * problem you can apologise for. The failure is recorded on the
   * communications row either way, which is where a practitioner looks. */
  async function claimOnce(uid, key, meta = {}) {
    const ref = db.doc(`users/${uid}/waSent/${key}`);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return false;
      tx.set(ref, { at: new Date().toISOString(), ...meta });
      return true;
    });
  }

  /* The burst counter lives beside the claims, under a key no hash can collide
     with — every other document here is a hex digest. */
  const BURST_KEY = "_noticeBurst";

  async function claimBurstSlot(uid) {
    const ref = db.doc(`users/${uid}/waSent/${BURST_KEY}`);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const decision = burstDecision(snap.exists ? snap.data() : null, Date.now());
      tx.set(ref, decision.next, { merge: true });
      return decision.action;
    });
  }

  /* ---------------- 1. a notice arrives on the portal ----------------
   *
   * onDocumentCreated, not onDocumentWritten. A re-sync merges into an existing
   * notice and an order summary writes `aiSummary` back onto it — both are
   * updates, and neither is news. Creation is the only event that means "this
   * is new", which is also what removes any need to reason about the other
   * trigger on this same path re-firing this one.
   *
   * Firestore triggers must live in the database's region, so this is pinned to
   * TRIGGER_REGION rather than taking the REGIONS array.
   */
  const onNoticeCreatedWhatsApp = onDocumentCreated(
    {
      document: "users/{uid}/notices/{noticeId}",
      region: TRIGGER_REGION,
      secrets: WATI_SECRETS,
      maxInstances: 10,
    },
    async (event) => {
      const snap = event.data;
      if (!snap || !snap.exists) return;
      const uid = event.params.uid;
      const n = snap.data() || {};

      const verdict = shouldAlertNotice(n, { today: istDate() });
      if (!verdict.alert) return;

      const profile = (await db.doc(`users/${uid}`).get().catch(() => null))?.data() || {};
      if (!whatsAppEnabledFor(profile, "noticeAlertUser")) return;
      const reach = userReachability(profile);
      if (!reach.ok) return;

      /* Keyed on the DIN, not the document id. The same notice can reach us
         twice under two ids — once from the portal sync and once from a PDF a
         practitioner uploaded and had parsed — and the person reading the alert
         does not care which route it took. */
      const identity = n.din || n.docKey || event.params.noticeId;
      const key = "notice_" + crypto.createHash("sha1").update(identity).digest("hex").slice(0, 20);
      if (!(await claimOnce(uid, key, { kind: "noticeAlertUser", noticeId: event.params.noticeId }))) return;

      const action = await claimBurstSlot(uid);
      if (action === "suppress") {
        console.log("WhatsApp notice alert suppressed (burst) for", uid.slice(0, 8));
        return;
      }
      if (action === "burst-notice") {
        await deliver({
          uid,
          to: reach.mobile,
          template: "ph_notice_burst_user_v1",
          params: [],
          recipientRole: "user",
          subject: "More notices than can be sent one by one",
        });
        return;
      }

      await deliver({
        uid,
        to: reach.mobile,
        template: "ph_notice_alert_user_v1",
        params: noticeAlertParams(n),
        assesseeId: n.assesseeId || "",
        assessee: n.assessee || "",
        recipientRole: "user",
        subject: `New notice — ${n.assessee || "assessee"} ${n.section ? `u/s ${n.section}` : ""}`.trim(),
        body: verdict.deadline,
      });
    }
  );

  /* ---------------- 2. tomorrow's hearings ----------------
   *
   * 11:30 IST, the day before. Not 7am: a reminder that lands before the office
   * is open is read in bed and acted on by nobody, and by the time it matters it
   * is above eleven other notifications. Late morning is when a practitioner
   * can still ring a clerk, find the file, or send somebody.
   *
   * ONE MESSAGE PER HEARING, not a digest. Two hearings tomorrow sends two —
   * a merged message hides the second under a "+1 more" that nobody taps.
   */
  const whatsappHearingReminders = onSchedule(
    {
      schedule: "30 11 * * *",
      timeZone: "Asia/Kolkata",
      region: PRIMARY_REGION,
      secrets: WATI_SECRETS,
      timeoutSeconds: 540,
      maxInstances: 1,
    },
    async () => {
      /* Only practices that switched WhatsApp on are read at all. The
         alternative — listing every auth user and reading their profile, the way
         the voice roster does — costs a document read per practice per day for
         an answer that is almost always no. Firestore indexes map subfields
         automatically, so `whatsapp.enabled` needs no composite index. */
      const users = await db.collection("users").where("whatsapp.enabled", "==", true).get();
      if (users.empty) return;

      const tomorrow = istDate(new Date(), 1);
      let sent = 0;

      for (const userDoc of users.docs) {
        const uid = userDoc.id;
        const profile = userDoc.data() || {};
        if (!whatsAppEnabledFor(profile, "hearingReminder")) continue;
        const reach = userReachability(profile);
        if (!reach.ok) continue;

        try {
          const hearings = await db.collection(`users/${uid}/hearings`).where("date", "==", tomorrow).get();
          for (const h of hearings.docs) {
            const hearing = h.data() || {};
            if (!isHearingLive(hearing)) continue;

            // Keyed with the offset so a T-3 sweep can be added later without
            // colliding with the day-before one already sent for this hearing.
            const key = `hearing_${h.id}_1`;
            if (!(await claimOnce(uid, key, { kind: "hearingReminder", hearingId: h.id, date: tomorrow }))) continue;

            await deliver({
              uid,
              to: reach.mobile,
              template: "ph_hearing_reminder_user_v1",
              params: hearingReminderParams(hearing, { when: "tomorrow" }),
              assessee: hearing.assessee || "",
              recipientRole: "user",
              subject: `Hearing tomorrow — ${hearing.assessee || "assessee"}`,
              body: `${hearing.date} ${hearing.time || ""}`.trim(),
            });
            sent += 1;
          }
        } catch (e) {
          // One practice's bad day must not end the sweep for everybody else's.
          console.error("hearing reminders failed for", uid.slice(0, 8), e.message || e);
        }
      }

      console.log(`hearing reminders: ${sent} sent for ${tomorrow}`);
    }
  );

  return {
    watiWebhook,
    onNoticeCreatedWhatsApp,
    whatsappHearingReminders,
    // Used by the message senders in later phases, and by the tests.
    _whatsapp: {
      deliver,
      resolveLanguage,
      reserveQuota,
      claimOnce,
      claimBurstSlot,
      isOptedOut,
      setOptOut,
      clearOptOut,
      TEMPLATES,
      STATUS_RANK,
      EVENT_STATUS,
      WATI_SECRETS,
      REGIONS,
      BURST_MAX,
    },
  };
};

// Exported for tests and for the senders that follow, without building.
exports.TEMPLATES = TEMPLATES;
exports.STATUS_RANK = STATUS_RANK;
exports.EVENT_STATUS = EVENT_STATUS;
exports.normEvent = normEvent;
exports.STOP_WORDS = STOP_WORDS;
exports.START_WORDS = START_WORDS;
exports.WATI_SECRETS = WATI_SECRETS;
exports.WA_MAX_PER_WINDOW = WA_MAX_PER_WINDOW;
