/*
 * ProHippo — inbound voice agent (Sarvam).
 *
 * A practitioner rings a number and gets a colleague who knows the app: where
 * everything is, what is listed this week, which client hasn't paid. Nothing
 * more. The agent itself — voice, language, turn-taking — is Sarvam's; this
 * file is the only thing it can reach into ProHippo with, and it is
 * deliberately a narrow one.
 *
 *   inbound call → Sarvam agent → HTTPS webhook (this file) → users/{uid}/…
 *
 * FOUR RULES, ENFORCED HERE RATHER THAN IN THE PROMPT
 *
 *   1. Identity is the caller's number, resolved against Firebase Auth. No
 *      match, no data — not a partial answer, not a "here's what I can say",
 *      nothing. See identifyCaller().
 *   2. Every read is scoped to users/{uid}. This module never touches
 *      `accounts`, `spend`, `plans`, `adminAudit` or any secret, and there is
 *      no code path that could — the only Firestore handle it builds is a
 *      subcollection of the identified user's own document.
 *   3. Everything is READ-ONLY except the call log. A misheard word must never
 *      become a changed hearing date.
 *   4. Company internals are refused in code, not just in the prompt — on the
 *      way in (the caller's words and the model's own tool arguments) and on
 *      the way out (scrub). voiceKnowledge.js holds the list; a prompt can be
 *      argued with, a regex cannot.
 *
 * The pure logic — phone normalisation, the guardrail, name matching, spoken
 * formatting, signature checking, the Sarvam payload adapter — lives in
 * voiceAgentCore.js and is unit-tested in voiceAgentCore.test.mjs.
 *
 * Setup, including what to configure on the Sarvam side:
 *   docs/VOICE_AGENT_SETUP.md
 */
"use strict";

const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const { VOICE_AGENT_CONFIG, missingConfig, isConfigured } = require("./voiceAgentConfig");

const {
  maskPhone,
  maskPan,
  restrictedTopic,
  argsAreRestricted,
  istToday,
  addDays,
  spokenDate,
  spokenAmount,
  spokenList,
  isKnownTool,
  greeting,
  withinRateLimit,
  dayKey,
  verifyWebhook,
  parseRequest,
  toolResponse,
  matchAssessee,
  findFeature,
  mintSessionToken,
  verifySessionToken,
  outboundUrl,
  buildOutboundCall,
  RESTRICTED_REPLY,
} = require("./voiceAgentCore");

/*
 * The shared secret Sarvam signs each webhook with. Set once:
 *   openssl rand -base64 32 | firebase functions:secrets:set SARVAM_WEBHOOK_SECRET
 * and paste the same value into the agent's webhook configuration.
 *
 * There is no fallback for a missing secret. An unset secret means every
 * request is rejected, which is the correct failure for an endpoint that reads
 * a practitioner's client list aloud.
 */
const sarvamWebhookSecret = defineSecret("SARVAM_WEBHOOK_SECRET");

/*
 * The Sarvam platform key, for placing outbound calls (the "Call me" button).
 * From the Sarvam console; store it with
 *   firebase functions:secrets:set SARVAM_API_KEY
 * It never reaches the browser — the callable holds it and the browser only
 * ever asks ProHippo to place a call, never Sarvam directly.
 */
const sarvamApiKey = defineSecret("SARVAM_API_KEY");

/* A practice is hundreds of rows, not millions, and a phone call cannot read
   out more than a handful. Bounding the read keeps a runaway document count
   from turning one call into a large bill, and lets the filtering happen in
   memory where it needs no composite index. */
const READ_CAP = 800;
const SPEAK_CAP = 5; // how many items get read out before we offer the rest

module.exports.build = function build({ REGIONS, PRIMARY_REGION, db, recordSpend }) {
  /* ---------------- identity ---------------- */

  /*
   * Turn a number on the line into an account, or into nothing.
   *
   * getUserByPhoneNumber is the same lookup SMS login uses (verifyOtp →
   * resolveUserByPhone), so a number that can sign in is a number that can
   * call, with no second index to drift out of step. The one difference: this
   * path NEVER creates a user. An unrecognised caller stays unrecognised.
   */
  async function loadProfile(uid, fallbackName = "") {
    let profile = {};
    try {
      const snap = await db.doc(`users/${uid}`).get();
      profile = snap.exists ? snap.data() || {} : {};
    } catch (e) {
      console.error("voice: profile read failed", e.message || e);
    }
    return {
      known: true,
      uid,
      name: profile.ownerName || fallbackName || "",
      firmName: profile.firmName || "",
    };
  }

  /*
   * TWO WAYS IN, AND THEY ARE NOT EQUALLY GOOD.
   *
   *   1. A signed session token. ProHippo authenticated the user in the app,
   *      minted this, and asked Sarvam to dial them. Cryptographic, expiring,
   *      and the path the "Call me" button uses.
   *   2. The number on the wire. Only as good as caller ID, which is to say
   *      spoofable — but it is all an inbound call gives us.
   *
   * The token is checked first and wins outright. It is checked against the
   * same secret that authenticated the webhook itself, so a request that got
   * this far with a valid token was signed by Sarvam AND carries a uid this
   * server vouched for within the last fifteen minutes.
   */
  async function identifyCaller(parsed, secret) {
    if (parsed.sessionToken) {
      const claim = verifySessionToken({ token: parsed.sessionToken, secret });
      if (claim.ok) return { ...(await loadProfile(claim.uid)), via: "token" };
      // A token that was sent and didn't verify is worth a line in the log: it
      // is either a clock problem, a rotated secret, or someone trying it on.
      console.warn("voice: session token rejected —", claim.reason);
    }

    if (!parsed.phone) return { known: false };
    let user;
    try {
      user = await admin.auth().getUserByPhoneNumber(parsed.phone);
    } catch (e) {
      if (e.code !== "auth/user-not-found") {
        console.error("voice: caller lookup failed", e.code || e.message);
      }
      return { known: false };
    }
    return { ...(await loadProfile(user.uid, user.displayName)), via: "caller-id" };
  }

  /* The ONLY way this module reaches Firestore. Everything is a subcollection
     of the identified user's own document — there is no argument you can pass
     that walks out of users/{uid}. */
  async function readOwn(uid, name, cap = READ_CAP) {
    const snap = await db.collection("users").doc(uid).collection(name).limit(cap).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  /* ---------------- rate limiting ---------------- */

  /*
   * Two counters per account per day, in a top-level collection that Firestore
   * rules deny to every client (the catch-all `allow read, write: if false`).
   * Voice minutes cost real money and a wedged agent can loop; this is the
   * ceiling that keeps one bad afternoon off the card.
   */
  async function consumeRateLimit(uid, kind) {
    const ref = db.doc(`voiceRateLimits/${uid}`);
    const today = dayKey(Date.now());
    try {
      return await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const state = withinRateLimit(snap.exists ? snap.data() : null, today);
        const allowed = kind === "call" ? state.callAllowed : state.toolAllowed;
        if (!allowed) return { allowed: false };
        tx.set(ref, { ...state.next(kind), updatedAt: new Date().toISOString() }, { merge: true });
        return { allowed: true };
      });
    } catch (e) {
      // A failed counter must not take the line down; log it and let the call
      // through. The cost of one uncounted call is a rounding error next to a
      // help line that stops answering.
      console.error("voice: rate limit check failed", e.message || e);
      return { allowed: true };
    }
  }

  /* ---------------- the tools ---------------- */

  /* Hearings that haven't happened yet and haven't been called off, soonest
     first. `status` is free text in the UI, so the exclusion list is by what a
     practitioner types, not by an enum that doesn't exist. */
  const DEAD_STATUSES = ["disposed", "cancelled", "adjourned sine die", "closed", "decided"];
  const isLive = (row) => !DEAD_STATUSES.includes(String(row.status || "").toLowerCase());

  async function upcomingHearings(uid, { days = 30, assessee } = {}) {
    const today = istToday();
    const until = addDays(today, Math.max(1, Math.min(365, Number(days) || 30)));
    let rows = (await readOwn(uid, "hearings"))
      .filter((h) => h.date && h.date >= today && h.date <= until && isLive(h))
      .sort((a, b) => (a.date === b.date ? String(a.time || "").localeCompare(String(b.time || "")) : a.date.localeCompare(b.date)));

    if (assessee) {
      const all = await readOwn(uid, "assessees");
      const { assessee: hit, confident, alternatives } = matchAssessee(all, assessee);
      if (!hit) {
        return toolResponse(`I couldn't find a client called ${assessee} on your list. Could you say the name again, or give me the PAN?`);
      }
      if (!confident) {
        return toolResponse(
          `I have more than one client that could be — ${spokenList(alternatives.map((a) => a.name))}. Which one did you mean?`
        );
      }
      const pan = String(hit.pan || "").toUpperCase();
      rows = rows.filter((h) => String(h.pan || "").toUpperCase() === pan || h.assessee === hit.name);
      if (!rows.length) {
        return toolResponse(`Nothing is listed for ${hit.name} in the next ${days} days.`);
      }
    }

    if (!rows.length) {
      return toolResponse(`You have no hearings in the next ${days} days.`);
    }

    const shown = rows.slice(0, SPEAK_CAP);
    const lines = shown.map((h) => {
      const when = spokenDate(h.date, today);
      const time = h.time ? ` at ${h.time}` : "";
      const where = h.bench ? `, ${h.bench}` : "";
      const mode = h.mode ? ` — ${h.mode}` : "";
      return `${h.assessee}, ${h.authority || "hearing"}${where}, ${when}${time}${mode}`;
    });
    const more = rows.length > shown.length ? ` There are ${rows.length - shown.length} more after that.` : "";
    return toolResponse(
      `${rows.length === 1 ? "One hearing" : `${rows.length} hearings`} coming up. ${lines.join(". ")}.${more}`,
      { count: rows.length, hearings: shown.map((h) => ({ assessee: h.assessee, pan: maskPan(h.pan), date: h.date, time: h.time || "", authority: h.authority || "", bench: h.bench || "", mode: h.mode || "" })) }
    );
  }

  /* Notices still needing work. Anything already submitted is done as far as a
     phone call is concerned. */
  const OPEN_NOTICE_STATUSES = ["awaiting review", "reply drafted", "pending", "in progress", ""];

  async function pendingNotices(uid, { assessee } = {}) {
    const today = istToday();
    let rows = (await readOwn(uid, "notices"))
      .filter((n) => OPEN_NOTICE_STATUSES.includes(String(n.status || "").toLowerCase()))
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));

    if (assessee) {
      const all = await readOwn(uid, "assessees");
      const { assessee: hit, confident, alternatives } = matchAssessee(all, assessee);
      if (!hit) return toolResponse(`I couldn't find a client called ${assessee}. Could you say it again, or give me the PAN?`);
      if (!confident) return toolResponse(`Did you mean ${spokenList(alternatives.map((a) => a.name))}?`);
      const pan = String(hit.pan || "").toUpperCase();
      rows = rows.filter((n) => String(n.pan || "").toUpperCase() === pan || n.assessee === hit.name);
      if (!rows.length) return toolResponse(`Nothing is pending for ${hit.name} — no open notices.`);
    }

    if (!rows.length) return toolResponse("Nothing is pending — every notice on your file has been dealt with.");

    const shown = rows.slice(0, SPEAK_CAP);
    const lines = shown.map((n) => {
      const sec = n.section ? ` under section ${n.section}` : "";
      const ay = n.ay ? ` for assessment year ${n.ay}` : "";
      const hearing = n.hearingDate ? `, hearing ${spokenDate(n.hearingDate, today)}` : "";
      return `${n.assessee}${sec}${ay}, ${String(n.status || "awaiting review").toLowerCase()}${hearing}`;
    });
    const more = rows.length > shown.length ? ` And ${rows.length - shown.length} more.` : "";
    return toolResponse(
      `${rows.length === 1 ? "One notice is" : `${rows.length} notices are`} still open. ${lines.join(". ")}.${more}`,
      { count: rows.length, notices: shown.map((n) => ({ assessee: n.assessee, pan: maskPan(n.pan), section: n.section || "", ay: n.ay || "", status: n.status || "", hearingDate: n.hearingDate || "" })) }
    );
  }

  async function assesseeSummary(uid, { assessee } = {}) {
    if (!assessee) return toolResponse("Which client would you like me to look up?");
    const today = istToday();
    const all = await readOwn(uid, "assessees");
    const { assessee: hit, confident, alternatives } = matchAssessee(all, assessee);
    if (!hit) return toolResponse(`I couldn't find ${assessee} on your client list. Could you say the name again, or give me the PAN?`);
    if (!confident) return toolResponse(`I have a few that sound like that — ${spokenList(alternatives.map((a) => a.name))}. Which one?`);

    const pan = String(hit.pan || "").toUpperCase();
    const mine = (row) => String(row.pan || "").toUpperCase() === pan || row.assessee === hit.name;

    const [matters, hearings, notices, invoices] = await Promise.all([
      readOwn(uid, "matters"),
      readOwn(uid, "hearings"),
      readOwn(uid, "notices"),
      readOwn(uid, "invoices"),
    ]);

    const openMatters = matters.filter((m) => mine(m) && isLive(m));
    const nextHearing = hearings
      .filter((h) => mine(h) && isLive(h) && h.date && h.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    const openNotices = notices.filter((n) => mine(n) && OPEN_NOTICE_STATUSES.includes(String(n.status || "").toLowerCase()));
    const outstanding = invoices
      .filter((i) => i.assessee === hit.name)
      .reduce((sum, i) => sum + Math.max(0, (Number(i.amount) || 0) - (Number(i.received) || 0)), 0);

    const parts = [`${hit.name}${hit.status ? `, ${hit.status}` : ""}, PAN ${maskPan(hit.pan)}.`];
    parts.push(
      openMatters.length
        ? `${openMatters.length} open ${openMatters.length === 1 ? "proceeding" : "proceedings"} — ${spokenList([...new Set(openMatters.map((m) => `${m.type}${m.ay ? ` for ${m.ay}` : ""}`))].slice(0, 4))}.`
        : "No open proceedings."
    );
    if (nextHearing) {
      parts.push(`Next hearing ${spokenDate(nextHearing.date, today)}${nextHearing.time ? ` at ${nextHearing.time}` : ""}${nextHearing.bench ? `, ${nextHearing.bench}` : ""}.`);
    } else {
      parts.push("Nothing listed for hearing.");
    }
    if (openNotices.length) parts.push(`${openNotices.length} ${openNotices.length === 1 ? "notice" : "notices"} still open.`);
    if (outstanding > 0) parts.push(`Fees outstanding: ${spokenAmount(outstanding)}.`);

    return toolResponse(parts.join(" "), {
      name: hit.name,
      pan: maskPan(hit.pan),
      openMatters: openMatters.length,
      openNotices: openNotices.length,
      nextHearingDate: nextHearing ? nextHearing.date : null,
      outstanding,
    });
  }

  async function outstandingInvoices(uid, { assessee, overdueOnly } = {}) {
    const today = istToday();
    let rows = (await readOwn(uid, "invoices"))
      .map((i) => ({ ...i, outstanding: Math.max(0, (Number(i.amount) || 0) - (Number(i.received) || 0)) }))
      .filter((i) => i.outstanding > 0);

    if (assessee) {
      const all = await readOwn(uid, "assessees");
      const { assessee: hit, confident, alternatives } = matchAssessee(all, assessee);
      if (!hit) return toolResponse(`I couldn't find a client called ${assessee}.`);
      if (!confident) return toolResponse(`Did you mean ${spokenList(alternatives.map((a) => a.name))}?`);
      rows = rows.filter((i) => i.assessee === hit.name);
      if (!rows.length) return toolResponse(`${hit.name} has nothing outstanding — all clear.`);
    }
    if (overdueOnly) rows = rows.filter((i) => i.due && i.due < today);
    if (!rows.length) {
      return toolResponse(overdueOnly ? "Nothing is overdue." : "Nothing is outstanding — every invoice is settled.");
    }

    rows.sort((a, b) => String(a.due || "9999").localeCompare(String(b.due || "9999")));
    const total = rows.reduce((s, i) => s + i.outstanding, 0);
    const overdue = rows.filter((i) => i.due && i.due < today);
    const shown = rows.slice(0, SPEAK_CAP);
    const lines = shown.map((i) => `${i.assessee}, ${spokenAmount(i.outstanding)}${i.due ? `, due ${spokenDate(i.due, today)}` : ""}`);
    const overdueLine = overdue.length ? ` ${overdue.length} of ${overdue.length === 1 ? "them is" : "those are"} already past the due date.` : "";
    const more = rows.length > shown.length ? ` And ${rows.length - shown.length} more.` : "";

    return toolResponse(
      `${spokenAmount(total)} outstanding across ${rows.length} ${rows.length === 1 ? "invoice" : "invoices"}.${overdueLine} ${lines.join(". ")}.${more}`,
      { total, count: rows.length, overdueCount: overdue.length }
    );
  }

  async function openTasks(uid) {
    const rows = (await readOwn(uid, "todos")).filter((t) => !t.done && t.text);
    if (!rows.length) return toolResponse("Your list is clear — nothing pending.");
    const shown = rows.slice(0, SPEAK_CAP);
    const more = rows.length > shown.length ? ` And ${rows.length - shown.length} more on the list.` : "";
    return toolResponse(
      `${rows.length} ${rows.length === 1 ? "task" : "tasks"} open. ${shown.map((t) => t.text).join(". ")}.${more}`,
      { count: rows.length }
    );
  }

  /* The read-out someone wants when they ring on the way to the office. */
  async function todayBrief(uid, caller) {
    const today = istToday();
    const weekEnd = addDays(today, 7);
    const [hearings, notices, todos, invoices] = await Promise.all([
      readOwn(uid, "hearings"),
      readOwn(uid, "notices"),
      readOwn(uid, "todos"),
      readOwn(uid, "invoices"),
    ]);

    const live = hearings.filter((h) => h.date && isLive(h));
    const todayList = live.filter((h) => h.date === today);
    const tomorrowList = live.filter((h) => h.date === addDays(today, 1));
    const weekList = live.filter((h) => h.date > addDays(today, 1) && h.date <= weekEnd);
    const openNotices = notices.filter((n) => OPEN_NOTICE_STATUSES.includes(String(n.status || "").toLowerCase()));
    const openTodos = todos.filter((t) => !t.done);
    const overdue = invoices.filter((i) => i.due && i.due < today && (Number(i.amount) || 0) > (Number(i.received) || 0));

    const parts = [];
    const first = String(caller?.name || "").trim().split(/\s+/)[0];
    parts.push(first ? `Here's your day, ${first}.` : "Here's your day.");

    if (todayList.length) {
      parts.push(`Today: ${spokenList(todayList.slice(0, 3).map((h) => `${h.assessee}${h.time ? ` at ${h.time}` : ""}${h.authority ? `, ${h.authority}` : ""}`))}.`);
    } else {
      parts.push("Nothing listed today.");
    }
    if (tomorrowList.length) {
      parts.push(`Tomorrow: ${spokenList(tomorrowList.slice(0, 3).map((h) => `${h.assessee}${h.time ? ` at ${h.time}` : ""}`))}.`);
    }
    if (weekList.length) parts.push(`${weekList.length} more this week.`);
    if (openNotices.length) parts.push(`${openNotices.length} ${openNotices.length === 1 ? "notice" : "notices"} waiting on you.`);
    if (openTodos.length) parts.push(`${openTodos.length} open ${openTodos.length === 1 ? "task" : "tasks"}.`);
    if (overdue.length) parts.push(`${overdue.length} ${overdue.length === 1 ? "invoice is" : "invoices are"} overdue.`);
    parts.push("Want me to go through any of those?");

    return toolResponse(parts.join(" "), {
      today: todayList.length,
      tomorrow: tomorrowList.length,
      thisWeek: weekList.length,
      openNotices: openNotices.length,
      openTasks: openTodos.length,
      overdueInvoices: overdue.length,
    });
  }

  /*
   * Navigation. The one tool an unidentified caller may use — it reads the
   * product manual in voiceKnowledge.js and touches no account data at all,
   * so someone ringing from a number we don't know can still be told what the
   * app does and where things are.
   */
  function featureAnswer({ query } = {}) {
    const matches = findFeature(query || "");
    if (!matches.length) {
      return toolResponse(
        "I'm not sure which part of the app you mean. Could you tell me what you're trying to do — add a client, check a hearing date, raise a bill, read a notice?"
      );
    }
    const best = matches[0];
    const alt = matches.length > 1 ? ` If you meant ${matches[1].label} instead, tell me and I'll take you there.` : "";
    return toolResponse(
      `${best.label}. ${best.what} ${best.where} ${best.steps.join(" Then ")}${alt}`,
      { route: best.route, label: best.label, steps: best.steps }
    );
  }

  /* ---------------- dispatch ---------------- */

  /*
   * A closed table. The model names a tool; if the name isn't a key here,
   * nothing runs. `needsAccount: false` is the whole of the public surface —
   * everything else requires an identified caller, checked before dispatch.
   */
  const TOOL_HANDLERS = {
    find_feature: { needsAccount: false, run: (_uid, args) => featureAnswer(args) },
    upcoming_hearings: { needsAccount: true, run: (uid, args) => upcomingHearings(uid, args) },
    pending_notices: { needsAccount: true, run: (uid, args) => pendingNotices(uid, args) },
    assessee_summary: { needsAccount: true, run: (uid, args) => assesseeSummary(uid, args) },
    outstanding_invoices: { needsAccount: true, run: (uid, args) => outstandingInvoices(uid, args) },
    open_tasks: { needsAccount: true, run: (uid) => openTasks(uid) },
    today_brief: { needsAccount: true, run: (uid, _args, caller) => todayBrief(uid, caller) },
  };

  const NOT_REGISTERED =
    "I can only look up records for a registered ProHippo account calling from its registered mobile number. " +
    "If you've signed up with a different number, open Settings in the app and link this mobile — then call back and I'll have everything ready.";

  async function dispatchTool(name, args, caller) {
    if (!isKnownTool(name) || !TOOL_HANDLERS[name]) {
      console.warn("voice: refused unknown tool", String(name).slice(0, 60));
      return toolResponse("I can't do that from this line. I can help with your hearings, notices, clients, invoices, or with finding your way around the app.");
    }
    // The model chooses these arguments from what it heard, so they are caller
    // input by another name — and get the same guardrail.
    const smuggled = argsAreRestricted(args);
    if (smuggled) {
      console.warn("voice: restricted subject in tool arguments —", smuggled);
      return toolResponse(RESTRICTED_REPLY);
    }
    const handler = TOOL_HANDLERS[name];
    if (handler.needsAccount && !caller.known) return toolResponse(NOT_REGISTERED);
    if (handler.needsAccount) {
      const { allowed } = await consumeRateLimit(caller.uid, "tool");
      if (!allowed) {
        return toolResponse("I've hit the limit on look-ups for today on this account. Everything is still there in the app — please have a look there, or try again tomorrow.");
      }
    }
    return handler.run(caller.uid, args, caller);
  }

  /* ---------------- the call log ---------------- */

  /*
   * The one write in this module, and it goes under users/{uid} so the
   * practitioner can see what was said on their own line — the same place the
   * rest of their data lives, covered by the same rule.
   *
   * The caller's number is masked even here: the account already knows its own
   * number, and an unmasked one in a document adds a copy for no benefit.
   *
   * `patch` is NOT passed through scrub(): it may carry a FieldValue sentinel
   * (arrayUnion), which a deep walk would rebuild into a plain object and
   * silently break. Nothing untrusted reaches this function unsanitised — the
   * call sites clean their own fields, which is where the type is still known.
   */
  async function logCall(uid, callId, patch) {
    if (!uid || !callId) return;
    try {
      await db.doc(`users/${uid}/voiceCalls/${callId}`).set(
        { ...patch, updatedAt: new Date().toISOString() },
        { merge: true }
      );
    } catch (e) {
      console.error("voice: call log write failed", e.message || e);
    }
  }

  /* A language tag off the wire, reduced to something safe to store. */
  const safeTag = (value) => String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 20) || null;

  /* ---------------- the webhook ---------------- */

  /*
   * Single region on purpose: Sarvam is configured with one URL, and unlike the
   * callables there is no older client pinned elsewhere. Same reasoning as
   * resendWebhook in index.js.
   */
  const sarvamVoiceWebhook = onRequest(
    { region: PRIMARY_REGION, secrets: [sarvamWebhookSecret], maxInstances: 20 },
    async (req, res) => {
      if (req.method !== "POST") { res.status(405).send("Method not allowed"); return; }

      const rawBody = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body || {});
      const auth = verifyWebhook({
        headers: req.headers,
        rawBody,
        secret: sarvamWebhookSecret.value(),
      });
      if (!auth.ok) {
        console.warn("voice: webhook rejected —", auth.reason);
        res.status(401).json({ error: "invalid signature" });
        return;
      }

      let body;
      try {
        body = typeof req.body === "object" && req.body !== null ? req.body : JSON.parse(rawBody);
      } catch {
        res.status(400).json({ error: "bad json" });
        return;
      }

      const started = Date.now();
      // req.path carries the per-tool suffix the agent was configured with —
      // .../sarvamVoiceWebhook/find_feature — which is how a flat body gets
      // matched to a tool. See parseRequest().
      const parsed = parseRequest(body, req.path || req.url || "");
      const caller = await identifyCaller(parsed, sarvamWebhookSecret.value());

      try {
        if (parsed.kind === "session-start") {
          // Count the call itself, then hand the agent everything it needs for
          // the first turn: who this is, what to say, and the prompt variables
          // that make it speak as this caller's colleague rather than a
          // stranger.
          if (caller.known) {
            const { allowed } = await consumeRateLimit(caller.uid, "call");
            if (!allowed) {
              res.status(200).json(
                toolResponse("This account has already used its calls for today. Everything is still in the app — please have a look there, or call back tomorrow.")
              );
              return;
            }
            // No call id means no way to attach the end of the call to the
            // start of it, so there is nothing coherent to log — and a
            // half-written history row is worse than none.
            await logCall(caller.uid, parsed.callId, {
              startedAt: new Date().toISOString(),
              from: maskPhone(parsed.phone),
              language: safeTag(parsed.language),
              tools: [],
            });
          } else {
            console.info("voice: unrecognised caller", maskPhone(parsed.phone || parsed.from || ""));
          }
          res.status(200).json({
            ok: true,
            known: caller.known,
            speech: greeting(caller),
            first_message: greeting(caller),
            // Prompt variables, for a Sarvam agent configured with placeholders.
            variables: {
              caller_name: caller.name || "",
              caller_firm: caller.firmName || "",
              caller_known: caller.known ? "yes" : "no",
            },
          });
          return;
        }

        if (parsed.kind === "session-end") {
          if (caller.known && parsed.callId) {
            await logCall(caller.uid, parsed.callId, {
              endedAt: new Date().toISOString(),
              durationSec: parsed.durationSec || 0,
            });
          }
          // Voice minutes are the billed unit. `units` is minutes; the rate is
          // unconfirmed, so functions/pricing.js records these as unpriced and
          // the Costs page shows them as a visible gap rather than a silent ₹0.
          await recordSpend({
            uid: caller.known ? caller.uid : null,
            vendor: "sarvam",
            sku: "voice-agent",
            feature: "voice-agent",
            units: parsed.durationSec ? parsed.durationSec / 60 : 0,
            ms: Date.now() - started,
            ok: true,
          });
          res.status(200).json({ ok: true });
          return;
        }

        if (parsed.kind === "tool") {
          // The caller's own words, before the model got to choose a tool.
          const asked = restrictedTopic(parsed.utterance);
          if (asked) {
            console.warn("voice: restricted subject asked —", asked);
            res.status(200).json(toolResponse(RESTRICTED_REPLY));
            return;
          }
          const answer = await dispatchTool(parsed.toolName, parsed.args, caller);
          // Only names off the closed list get logged; an unknown one was
          // refused, and writing the string an attacker chose into the
          // practitioner's own history serves nobody.
          if (caller.known && parsed.callId && isKnownTool(parsed.toolName)) {
            await logCall(caller.uid, parsed.callId, {
              tools: admin.firestore.FieldValue.arrayUnion(parsed.toolName),
            });
          }
          res.status(200).json(answer);
          return;
        }

        // Anything else Sarvam sends — a transcript fragment, a status ping.
        // 200 with nothing to say: an unknown event is not an error worth
        // making a telephony platform retry over.
        res.status(200).json({ ok: true });
      } catch (e) {
        console.error("voice: handler failed", e.message || e);
        // Still 200. A 500 here becomes dead air or a retry storm mid-call;
        // a spoken apology is a better outcome for the person holding the phone.
        res.status(200).json(
          toolResponse("Sorry, something went wrong at my end just now. Could you try that again, or have a look in the app?")
        );
      }
    }
  );

  /* ---------------- the "Call me" button ---------------- */

  /*
   * THE STRONGEST IDENTITY PATH IN THE FEATURE, and the reason it exists.
   *
   * The inbound line has to take the caller's word for who they are, via a
   * number that can be spoofed. This one doesn't: the request arrives on an
   * authenticated callable, so Firebase has already proved the uid before a
   * line of this function runs. ProHippo then dials the number THAT ACCOUNT
   * HAS VERIFIED — not a number supplied in the request — and sends a signed
   * token along for the webhook to check.
   *
   * Note what is NOT a parameter: the number to call. Accepting one would turn
   * this into a free outbound-dialler for anyone with an account, billed to us.
   * The only number this will ever ring is the one already on the Firebase user
   * record, put there by linkPhone after an OTP proved possession.
   */
  const requestVoiceCallback = onCall(
    { region: REGIONS, secrets: [sarvamApiKey, sarvamWebhookSecret], maxInstances: 10 },
    async (request) => {
      const uid = request.auth?.uid;
      if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");

      if (!isConfigured()) {
        console.error("voice: callback requested but config is incomplete —", missingConfig().join(", "));
        throw new HttpsError("failed-precondition", "The voice assistant isn't switched on yet. Please try again later.");
      }

      // The verified number on the account, and nothing the client sent.
      let user;
      try {
        user = await admin.auth().getUser(uid);
      } catch (e) {
        console.error("voice: callback user lookup failed", e.message || e);
        throw new HttpsError("internal", "Couldn't start the call. Please try again.");
      }
      const toNumber = user.phoneNumber;
      if (!toNumber) {
        throw new HttpsError(
          "failed-precondition",
          "Link your mobile number first — go to Settings, Account, Link mobile. That's the number I'll call you on."
        );
      }

      const { allowed } = await consumeRateLimit(uid, "call");
      if (!allowed) {
        throw new HttpsError("resource-exhausted", "You've used today's calls. Everything is still in the app — please have a look there, or try again tomorrow.");
      }

      const profile = await loadProfile(uid, user.displayName);
      const callId = `cb-${uid.slice(0, 8)}-${Date.now()}`;
      const token = mintSessionToken({ uid, secret: sarvamWebhookSecret.value() });
      const payload = buildOutboundCall({
        config: VOICE_AGENT_CONFIG,
        toNumber,
        callerName: profile.name,
        firmName: profile.firmName,
        token,
        callId,
      });

      const started = Date.now();
      let ok = false;
      let errorCode = null;
      try {
        const res = await fetch(outboundUrl(VOICE_AGENT_CONFIG), {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": sarvamApiKey.value() },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          // Sarvam's message can quote our own request back; it goes to the log,
          // never to the browser.
          const detail = await res.text().catch(() => "");
          console.error("voice: outbound rejected", res.status, detail.slice(0, 300));
          errorCode = `http-${res.status}`;
          throw new HttpsError("unavailable", "Couldn't place the call just now. Please try again in a moment.");
        }
        ok = true;
      } catch (e) {
        if (e instanceof HttpsError) throw e;
        console.error("voice: outbound request failed", e.message || e);
        errorCode = "network";
        throw new HttpsError("unavailable", "Couldn't place the call just now. Please try again in a moment.");
      } finally {
        // Metered whether or not it connected: a rejected trigger costs no
        // minutes, and `units: 0` says exactly that without hiding the attempt.
        await recordSpend({
          uid, vendor: "sarvam", sku: "voice-agent", feature: "voice-callback",
          units: 0, ms: Date.now() - started, ok, errorCode,
        });
      }

      await logCall(uid, callId, {
        startedAt: new Date().toISOString(),
        direction: "outbound",
        from: maskPhone(toNumber),
        tools: [],
      });

      return { ok: true, callId, calling: maskPhone(toNumber) };
    }
  );

  return { sarvamVoiceWebhook, requestVoiceCallback };
};
