/*
 * ProHippo — Google Calendar sync.
 *
 * Pushes hearings and deadlines into a calendar ProHippo creates inside the
 * practitioner's own Google account. One-way on purpose: ProHippo is the record
 * of truth, and an event dragged in Google must never silently move an ITAT date.
 *
 * Shape of the thing:
 *   • The user names the Google account they want to sync, then approves it on
 *     Google's own consent screen. The typed address is a login_hint and a
 *     check — after consent we compare it against the account Google actually
 *     granted and refuse a mismatch.
 *   • Scope is calendar.app.created: we can only see and change calendars this
 *     app made. Personal events are out of reach even if this file is wrong.
 *   • The refresh token is encrypted at rest in a top-level `googleTokens`
 *     collection that Firestore rules deny to clients (same trust boundary as
 *     portalCreds). Only these functions, via the Admin SDK, can read it.
 *   • Event IDs are derived from the Firestore document ID, so a retried insert
 *     updates instead of duplicating — the classic calendar-sync failure, gone
 *     by construction rather than by cleanup.
 *   • Each source doc carries `gcal: { eventId, hash, syncedAt }`. If the hash
 *     of the synced fields hasn't changed we make no API call at all, which is
 *     what keeps the nightly pass over a 500-hearing practice cheap.
 *
 * This module owns no tax law. Appeal limitation dates are computed by
 * src/appeals.js on the client and mirrored into users/{uid}/calendarDeadlines
 * as plain { title, date } rows; the sync engine here is deliberately dumb
 * about where a date came from, so there is only ever one copy of the
 * limitation arithmetic in the codebase.
 */
"use strict";

const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const crypto = require("crypto");

// OAuth client for the "ProHippo" web application, from Google Cloud Console →
// APIs & Services → Credentials. See docs/GOOGLE_CALENDAR_SETUP.md.
//   firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_ID
//   firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_SECRET
const googleClientId = defineSecret("GOOGLE_OAUTH_CLIENT_ID");
const googleClientSecret = defineSecret("GOOGLE_OAUTH_CLIENT_SECRET");

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/* Narrow by design: "See and change only the calendars ProHippo creates."
   Full calendar access would let a bug here touch a personal diary, and it
   reads far worse on the consent screen.

   It also turned out to be the difference between shipping and waiting: Google
   classifies calendar.app.created as NON-sensitive, so it needs no verification
   review, carries no 100-user cap and shows no "unverified app" warning.
   `calendar` and `calendar.events` are both sensitive. Widening this string
   would quietly put all three of those back. */
const SCOPE = "https://www.googleapis.com/auth/calendar.app.created openid email";

const CALENDAR_SUMMARY = "ProHippo — Hearings";
const CALENDAR_DESCRIPTION =
  "Hearings and statutory deadlines pushed from ProHippo. Changes made here are not sent back to ProHippo.";

// India has no daylight saving, so the zone is a constant and needs no zone
// database at event-build time.
const TZ = "Asia/Kolkata";

/* The practice's own address, used for the "Open in ProHippo" link inside every
   event. Firebase's default domains stay live alongside it, which is why the
   OAuth return address is not this constant — see ALLOWED_ORIGINS. */
const APP_ORIGIN = "https://prohippo.in";

/* Where the user is sent back to after Google's consent screen. Whichever of
   these domains they STARTED on is where they return, so someone who connects
   from prohippo.in is not silently handed off to a Firebase URL halfway through.
   An allowlist rather than trusting the value: an open redirect on the OAuth
   callback would be a genuine hole. */
const ALLOWED_ORIGINS = new Set([
  "https://prohippo.in",
  "https://www.prohippo.in",
  "https://prohippo2.web.app",
  "https://prohippo2.firebaseapp.com",
  "http://localhost:5173", // vite dev
]);

const safeOrigin = (value) => (ALLOWED_ORIGINS.has(clean(value)) ? clean(value) : APP_ORIGIN);

// A consent link the user never used is a loose end, not a state to keep.
const AUTH_STATE_TTL_MS = 15 * 60 * 1000;

/* Google's event colour palette (calendar/v3 colors.event), picked to match the
   authority colours the app already uses on the week and month views. */
const AUTHORITY_COLOR = {
  "ITAT": "3",       // Grape — the app's violet
  "CIT(A)": "4",     // Flamingo — the app's pink
  "Scrutiny": "6",   // Tangerine — the app's amber
  "Penalty": "11",   // Tomato
};
const DEADLINE_COLOR = "5"; // Banana

const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Only sync what someone might still turn up to. A five-year backlog of closed
// hearings in a calendar is noise, and it is a lot of API calls to keep it there.
const BACKFILL_DAYS = 90;

const clean = (v) => (typeof v === "string" ? v.trim() : "");

/* ---------------- event model ----------------
   Pure: these turn a ProHippo record into the JSON Google wants, and know
   nothing about Firestore or OAuth. Kept at module scope so the unit test
   can reach them without standing up a Firebase context. */

/* Google accepts a caller-supplied event ID in base32hex (a-v, 0-9), which
   hex satisfies. Deriving it from the source document ID makes every write
   idempotent: a retry after a timeout patches the event it already created
   instead of adding a second one. */
const eventIdFor = (kind, docId) =>
  "ph" + crypto.createHash("sha1").update(`${kind}:${docId}`).digest("hex").slice(0, 26);

const hashOf = (event) => crypto.createHash("sha1").update(JSON.stringify(event)).digest("hex").slice(0, 16);

/* When a hearing ends, as { date, time }. It returns the date as well as the
   clock because an 11:30pm listing plus an hour lands tomorrow — wrapping the
   clock alone would give Google an end that precedes its own start, and it
   rejects that. */
const endOf = (date, time, minutes) => {
  const m = HHMM.exec(time);
  if (!m) return { date, time: "12:00" };
  const total = Number(m[1]) * 60 + Number(m[2]) + minutes;
  const days = Math.floor(total / (24 * 60));
  const mins = total % (24 * 60);
  let endDate = date;
  if (days > 0) {
    const d = new Date(`${date}T00:00:00`);
    d.setDate(d.getDate() + days);
    endDate = isoDate(d);
  }
  return { date: endDate, time: `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}` };
};

// Kept identical to titleCase in src/shared.jsx so a name reads the same in
// Google as it does on the hearing card it came from.
const titleCase = (s) =>
  (s || "").toLowerCase().replace(/(^|[\s\-'./])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());

const deepLink = (page) => `${APP_ORIGIN}/?page=${page}`;

/* What the practitioner sees in Google. `detailed` is the Settings switch:
   off, nothing that identifies a client leaves ProHippo. */
function hearingEvent(hearing, { detailed }) {
  const authority = clean(hearing.authority) || "Hearing";
  const ay = clean(hearing.ay);
  const adjourned = hearing.status === "Adjourned";

  const summary = detailed
    ? `${authority} hearing — ${titleCase(hearing.assessee)}`
    : `${authority} hearing${ay ? ` — AY ${ay}` : ""}`;

  const lines = [];
  if (detailed) {
    const facts = [
      clean(hearing.pan) && `PAN ${hearing.pan}`,
      ay && `AY ${ay}`,
      clean(hearing.section) && `u/s ${hearing.section}`,
    ].filter(Boolean);
    if (facts.length) lines.push(facts.join(" · "));
    const refs = [clean(hearing.ita), clean(hearing.staff) && `Staff: ${hearing.staff}`].filter(Boolean);
    if (refs.length) lines.push(refs.join(" · "));
  } else if (ay) {
    lines.push(`AY ${ay}`);
  }
  if (clean(hearing.mode)) lines.push(`Mode: ${hearing.mode}`);
  lines.push(`Open in ProHippo: ${deepLink("hearings")}`);

  /* All-day, not an appointment.
   *
   * The listed time is when the bench rises, not when the practitioner is free
   * again: a matter listed at 10.30 can be called at noon, and the day is spent
   * at the Tribunal either way. Booking it as a one-hour slot leaves the rest of
   * the day looking available, which is how a second commitment gets made for
   * an afternoon that was never going to be free.
   *
   * The time is not lost — it leads the description, because it is the thing
   * that decides when to leave. An all-day event's `end` is exclusive, so a
   * one-day hearing ends the morning after; get that wrong and every hearing
   * reads as two days long. */
  if (clean(hearing.time)) lines.unshift(`Listed at ${hearing.time}`);
  const next = new Date(`${hearing.date}T00:00:00`);
  next.setDate(next.getDate() + 1);

  return {
    summary: adjourned ? `[Adjourned] ${summary}` : summary,
    location: detailed ? clean(hearing.bench) : "",
    description: lines.join("\n"),
    start: { date: hearing.date },
    end: { date: isoDate(next) },
    colorId: AUTHORITY_COLOR[authority] || "10",
    /* Measured from midnight on the day, because that is where an all-day event
       starts — so these land at 6 pm two evenings before and 6 pm the evening
       before, which is when a hearing is actually prepared for. Google will not
       take a reminder AFTER the start, so there is no morning-of option here. */
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 30 * 60 }, { method: "popup", minutes: 6 * 60 }] },
  };
}

/* Deadlines arrive pre-computed from the client (see the module note) — this
   only decides how they look. All-day, because a limitation date is a day,
   not an appointment. */
function deadlineEvent(deadline, { detailed }) {
  const title = clean(deadline.title) || "Deadline";
  const summary = detailed && clean(deadline.assessee)
    ? `${title} — ${titleCase(deadline.assessee)}`
    : title;

  const lines = [];
  if (detailed) {
    const facts = [
      clean(deadline.pan) && `PAN ${deadline.pan}`,
      clean(deadline.ay) && `AY ${deadline.ay}`,
    ].filter(Boolean);
    if (facts.length) lines.push(facts.join(" · "));
  }
  if (clean(deadline.detail)) lines.push(deadline.detail);
  lines.push(`Open in ProHippo: ${deepLink(deadline.kind === "appeal" ? "appeals" : "notices")}`);

  // An all-day event's `end` is exclusive, so a one-day deadline ends the
  // morning after — get this wrong and every deadline reads as two days long.
  const next = new Date(`${deadline.date}T00:00:00`);
  next.setDate(next.getDate() + 1);

  return {
    summary,
    description: lines.join("\n"),
    start: { date: deadline.date },
    end: { date: isoDate(next) },
    colorId: DEADLINE_COLOR,
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 3 * 24 * 60 }, { method: "popup", minutes: 24 * 60 }] },
  };
}

const icsEscape = (s) => clean(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
const icsDate = (iso) => iso.replace(/-/g, "");
const icsDateTime = (date, time) => `${icsDate(date)}T${time.replace(":", "")}00`;

// RFC 5545 caps lines at 75 octets; longer ones are folded with a leading
// space. Calendars that reject unfolded lines do so silently, which is a
// miserable thing to debug.
const fold = (line) => {
  if (line.length <= 74) return line;
  const parts = [line.slice(0, 74)];
  for (let i = 74; i < line.length; i += 73) parts.push(" " + line.slice(i, i + 73));
  return parts.join("\r\n");
};

// Exposed for googleCalendar.test.mjs — not a Cloud Function, and not exported
// from build(), so `firebase deploy` never sees it.
module.exports.helpers = { eventIdFor, hashOf, endOf, hearingEvent, deadlineEvent, icsEscape, icsDateTime, fold };

module.exports.build = function build(ctx) {
  const { REGIONS, PRIMARY_REGION, TRIGGER_REGION, db, credentialEncKey, encryptSecret, decryptSecret } = ctx;

  const CALLABLE_OPTS = {
    region: REGIONS,
    secrets: [googleClientId, googleClientSecret, credentialEncKey],
    maxInstances: 10,
  };

  const integrationRef = (uid) => db.doc(`users/${uid}/integrations/googleCalendar`);
  const tokenRef = (uid) => db.doc(`googleTokens/${uid}`);
  const authStateRef = (state) => db.doc(`calendarAuthStates/${state}`);

  /* The redirect URI Google sends the user back to. Deterministic so it can be
     pasted into the Cloud Console once and never revisited — it must match
     there character for character or Google refuses the exchange. */
  const callbackUrl = () => {
    const project = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "prohippo2";
    return `https://${PRIMARY_REGION}-${project}.cloudfunctions.net/calendarAuthCallback`;
  };

  /* ---------------- OAuth ---------------- */

  async function tokenRequest(params) {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error_description || body.error || `Google token endpoint returned ${res.status}`);
      err.googleError = body.error || "";
      throw err;
    }
    return body;
  }

  /* The id_token comes straight from Google's token endpoint over TLS in
     response to a code we just minted, so its payload is trustworthy without a
     signature check — the usual reason to verify (the token arrived via the
     browser) doesn't apply here. */
  function emailFromIdToken(idToken) {
    try {
      const payload = JSON.parse(Buffer.from(String(idToken).split(".")[1], "base64").toString("utf8"));
      return { email: clean(payload.email).toLowerCase(), verified: payload.email_verified !== false };
    } catch {
      return { email: "", verified: false };
    }
  }

  // Swap the stored refresh token for a short-lived access token. A revoked or
  // expired grant surfaces as `needsReauth` on the integration doc so the app
  // can ask for a reconnect instead of failing quietly every night.
  async function accessTokenFor(uid) {
    const snap = await tokenRef(uid).get();
    if (!snap.exists) throw new HttpsError("failed-precondition", "Google Calendar isn't connected.");

    let refreshToken;
    try {
      refreshToken = decryptSecret(snap.data());
    } catch {
      throw new HttpsError("internal", "Could not decrypt the stored Google token — was CREDENTIAL_ENC_KEY changed?");
    }

    try {
      const tokens = await tokenRequest({
        client_id: googleClientId.value(),
        client_secret: googleClientSecret.value(),
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      });
      return tokens.access_token;
    } catch (e) {
      if (e.googleError === "invalid_grant") {
        await integrationRef(uid).set(
          { status: "needsReauth", lastError: "Google access was revoked or expired. Reconnect to resume syncing.", lastErrorAt: new Date().toISOString() },
          { merge: true }
        );
      }
      throw e;
    }
  }

  /* ---------------- Calendar API ---------------- */

  async function gcal(accessToken, method, path, body) {
    const res = await fetch(`${CALENDAR_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 204) return {};
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json.error?.message || `Calendar API ${method} ${path} returned ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  // Create the dedicated calendar, or confirm the one we already made is still
  // there. A user who deletes it in Google gets a fresh one on the next sync
  // rather than a wall of 404s.
  async function ensureCalendar(uid, accessToken, existingId) {
    if (existingId) {
      try {
        await gcal(accessToken, "GET", `/calendars/${encodeURIComponent(existingId)}`);
        return existingId;
      } catch (e) {
        if (e.status !== 404 && e.status !== 403) throw e;
      }
    }
    const created = await gcal(accessToken, "POST", "/calendars", {
      summary: CALENDAR_SUMMARY,
      description: CALENDAR_DESCRIPTION,
      timeZone: TZ,
    });
    await integrationRef(uid).set({ calendarId: created.id }, { merge: true });
    return created.id;
  }

  /* ---------------- sync engine ---------------- */

  // Everything ProHippo should have in Google right now, as { kind, id, ref,
  // event } rows. Anything outside this set that carries our marker is an
  // orphan and gets removed on a full reconcile.
  async function desiredEvents(uid, cfg) {
    const detailed = cfg.includeClientDetails !== false;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - BACKFILL_DAYS);
    const from = isoDate(cutoff);
    const rows = [];

    if (cfg.syncHearings !== false) {
      const snap = await db.collection(`users/${uid}/hearings`).get();
      snap.docs.forEach((doc) => {
        const h = doc.data() || {};
        if (h.gcalSkip) return;
        if (!ISO_DATE.test(h.date || "") || !HHMM.test(h.time || "")) return;
        if (h.date < from) return;
        rows.push({ kind: "hearing", id: doc.id, ref: doc.ref, prior: h.gcal || null, event: hearingEvent(h, { detailed }) });
      });
    }

    if (cfg.syncDeadlines !== false) {
      const snap = await db.collection(`users/${uid}/calendarDeadlines`).get();
      snap.docs.forEach((doc) => {
        const d = doc.data() || {};
        if (!ISO_DATE.test(d.date || "")) return;
        if (d.date < from) return;
        rows.push({ kind: "deadline", id: doc.id, ref: doc.ref, prior: d.gcal || null, event: deadlineEvent(d, { detailed }) });
      });
    }

    return rows;
  }

  // Write one row through to Google. Returns "created" | "updated" | "skipped".
  async function pushEvent(uid, accessToken, calendarId, row, prior) {
    const eventId = eventIdFor(row.kind, row.id);
    const hash = hashOf(row.event);
    if (prior && prior.eventId === eventId && prior.hash === hash) return "skipped";

    const payload = {
      ...row.event,
      id: eventId,
      extendedProperties: { private: { prohippo: "1", uid, kind: row.kind, docId: row.id } },
    };

    const path = `/calendars/${encodeURIComponent(calendarId)}`;
    let outcome = "updated";
    try {
      await gcal(accessToken, "PUT", `${path}/events/${eventId}`, payload);
    } catch (e) {
      // 404 is the normal "first time we've seen this hearing" case.
      if (e.status !== 404 && e.status !== 400) throw e;
      try {
        await gcal(accessToken, "POST", `${path}/events`, payload);
        outcome = "created";
      } catch (e2) {
        // 409 means the ID is taken by an event the update couldn't see — a
        // recently deleted one. Updating it revives it, which is what we want.
        if (e2.status !== 409) throw e2;
        await gcal(accessToken, "PUT", `${path}/events/${eventId}`, { ...payload, status: "confirmed" });
      }
    }

    await row.ref.set({ gcal: { eventId, hash, syncedAt: new Date().toISOString() } }, { merge: true });
    return outcome;
  }

  async function deleteEvent(accessToken, calendarId, eventId) {
    try {
      await gcal(accessToken, "DELETE", `/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`);
    } catch (e) {
      // Already gone — the user deleted it in Google, which is the outcome we
      // wanted anyway.
      if (e.status !== 404 && e.status !== 410) throw e;
    }
  }

  /* Full pass: push everything that changed, then remove events we own that no
     longer correspond to anything in ProHippo. That second half is what repairs
     drift — a hearing deleted while the trigger was failing, a deadline that
     lapsed, a switch turned off in Settings. */
  async function reconcile(uid) {
    const cfgSnap = await integrationRef(uid).get();
    const cfg = cfgSnap.exists ? cfgSnap.data() : null;
    if (!cfg || cfg.status === "disconnected" || !cfg.calendarId) {
      throw new HttpsError("failed-precondition", "Google Calendar isn't connected.");
    }

    const accessToken = await accessTokenFor(uid);
    const calendarId = await ensureCalendar(uid, accessToken, cfg.calendarId);
    const rows = await desiredEvents(uid, cfg);

    const counts = { created: 0, updated: 0, skipped: 0, removed: 0 };
    const keep = new Set();

    for (const row of rows) {
      const outcome = await pushEvent(uid, accessToken, calendarId, row, row.prior);
      counts[outcome] += 1;
      keep.add(eventIdFor(row.kind, row.id));
    }

    // Orphan sweep, over our own events only.
    let pageToken;
    do {
      const query = new URLSearchParams({
        privateExtendedProperty: "prohippo=1",
        showDeleted: "false",
        maxResults: "250",
        ...(pageToken ? { pageToken } : {}),
      });
      const page = await gcal(accessToken, "GET", `/calendars/${encodeURIComponent(calendarId)}/events?${query}`);
      for (const ev of page.items || []) {
        if (keep.has(ev.id)) continue;
        await deleteEvent(accessToken, calendarId, ev.id);
        counts.removed += 1;
      }
      pageToken = page.nextPageToken;
    } while (pageToken);

    await integrationRef(uid).set(
      {
        status: "connected",
        lastSyncAt: new Date().toISOString(),
        lastError: "",
        eventCount: rows.length,
      },
      { merge: true }
    );
    return counts;
  }

  /* ---------------- callables ---------------- */

  // Step one of connecting: hand the app a consent URL for the account the user
  // named. The state nonce ties Google's callback back to this uid — without it
  // anyone could complete someone else's connection.
  const calendarAuthUrl = onCall(CALLABLE_OPTS, async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
    const email = clean(request.data?.email).toLowerCase();
    if (!EMAIL_RE.test(email)) throw new HttpsError("invalid-argument", "Enter the Google account you want to sync.");

    const state = crypto.randomBytes(24).toString("hex");
    // Remember where they set off from so the callback can put them back there.
    await authStateRef(state).set({
      uid,
      email,
      origin: safeOrigin(request.data?.origin),
      createdAt: Date.now(),
    });

    const url = new URL(AUTH_ENDPOINT);
    url.searchParams.set("client_id", googleClientId.value());
    url.searchParams.set("redirect_uri", callbackUrl());
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPE);
    url.searchParams.set("access_type", "offline");
    // Without this Google returns a refresh token only on the very first
    // consent, so a user who reconnects after disconnecting would get an
    // access token we cannot renew.
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set("login_hint", email);
    url.searchParams.set("state", state);

    return { url: url.toString() };
  });

  // Push everything now. Also the backfill on first connect, and the repair
  // anyone reaches for when Google and ProHippo have drifted apart.
  const syncCalendarNow = onCall(
    { ...CALLABLE_OPTS, timeoutSeconds: 300, memory: "512MiB" },
    async (request) => {
      const uid = request.auth?.uid;
      if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
      try {
        return await reconcile(uid);
      } catch (e) {
        if (e instanceof HttpsError) throw e;
        const message = String(e.message || e).slice(0, 300);
        await integrationRef(uid).set({ lastError: message, lastErrorAt: new Date().toISOString() }, { merge: true });
        throw new HttpsError("internal", message);
      }
    }
  );

  // Revoke the grant, forget the token, and optionally take the calendar with
  // it. Leaving the calendar behind is the default — those events are a record
  // of what was scheduled, and deleting someone's diary on a disconnect is
  // never the polite assumption.
  const disconnectGoogleCalendar = onCall(CALLABLE_OPTS, async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
    const deleteCalendar = request.data?.deleteCalendar === true;

    const cfgSnap = await integrationRef(uid).get();
    const cfg = cfgSnap.exists ? cfgSnap.data() : {};

    if (deleteCalendar && cfg.calendarId) {
      try {
        const accessToken = await accessTokenFor(uid);
        await gcal(accessToken, "DELETE", `/calendars/${encodeURIComponent(cfg.calendarId)}`);
      } catch (e) {
        // A calendar we can't delete shouldn't block the disconnect — the point
        // of the button is to end our access, and that still happens below.
        console.warn("calendar delete failed on disconnect:", e.message || e);
      }
    }

    const tokenSnap = await tokenRef(uid).get();
    if (tokenSnap.exists) {
      try {
        const refreshToken = decryptSecret(tokenSnap.data());
        await fetch(REVOKE_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: refreshToken }).toString(),
        });
      } catch (e) {
        console.warn("token revoke failed on disconnect:", e.message || e);
      }
      await tokenRef(uid).delete();
    }

    await integrationRef(uid).set(
      { status: "disconnected", calendarId: "", email: "", lastError: "", disconnectedAt: new Date().toISOString() },
      { merge: true }
    );
    await clearSyncMarks(uid);
    return { ok: true };
  });

  // Drop every gcal marker so a later reconnect rebuilds from scratch rather
  // than trusting hashes that describe events in a calendar we no longer own.
  async function clearSyncMarks(uid) {
    for (const name of ["hearings", "calendarDeadlines"]) {
      const snap = await db.collection(`users/${uid}/${name}`).get();
      for (let i = 0; i < snap.docs.length; i += 400) {
        const batch = db.batch();
        snap.docs.slice(i, i + 400).forEach((doc) => {
          if (doc.data().gcal) batch.set(doc.ref, { gcal: null }, { merge: true });
        });
        await batch.commit();
      }
    }
  }

  /* ---------------- OAuth callback ---------------- */

  const redirect = (res, origin, params) => {
    const url = new URL(safeOrigin(origin));
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    res.redirect(303, url.toString());
  };

  const calendarAuthCallback = onRequest(
    // One fixed URL registered with Google, so one region — unlike the
    // callables there is no older client pinned elsewhere.
    { region: PRIMARY_REGION, secrets: [googleClientId, googleClientSecret, credentialEncKey], maxInstances: 10 },
    async (req, res) => {
      const state = clean(req.query.state);
      const code = clean(req.query.code);
      const denied = clean(req.query.error);

      const stateSnap = state ? await authStateRef(state).get() : null;
      if (!stateSnap || !stateSnap.exists) {
        // No state means no record of where they came from, so this one lone
        // case has to fall back to the default origin.
        redirect(res, APP_ORIGIN, { calendar: "error", reason: "This sign-in link has expired. Please try connecting again." });
        return;
      }
      const { uid, email: requested, createdAt, origin } = stateSnap.data();
      await authStateRef(state).delete().catch(() => {});

      if (Date.now() - (createdAt || 0) > AUTH_STATE_TTL_MS) {
        redirect(res, origin, { calendar: "error", reason: "This sign-in link has expired. Please try connecting again." });
        return;
      }
      if (denied || !code) {
        redirect(res, origin, { calendar: "cancelled" });
        return;
      }

      try {
        const tokens = await tokenRequest({
          code,
          client_id: googleClientId.value(),
          client_secret: googleClientSecret.value(),
          redirect_uri: callbackUrl(),
          grant_type: "authorization_code",
        });

        const granted = emailFromIdToken(tokens.id_token);
        // The whole point of asking which account to sync: approve the wrong
        // one on a machine with five Googles signed in and you would otherwise
        // never find out.
        if (granted.email && granted.email !== requested) {
          redirect(res, origin, { calendar: "mismatch", granted: granted.email, requested });
          return;
        }
        if (!tokens.refresh_token) {
          redirect(res, origin, { calendar: "error", reason: "Google didn't return a renewable token. Remove ProHippo at myaccount.google.com/permissions and connect again." });
          return;
        }

        const calendarId = await ensureCalendar(uid, tokens.access_token, "");

        await tokenRef(uid).set({
          uid,
          ...encryptSecret(tokens.refresh_token),
          updatedAt: new Date().toISOString(),
        });

        const existing = await integrationRef(uid).get();
        await integrationRef(uid).set(
          {
            email: granted.email || requested,
            calendarId,
            calendarSummary: CALENDAR_SUMMARY,
            status: "connected",
            connectedAt: new Date().toISOString(),
            lastError: "",
            // Only seed the switches on a first connect — a reconnect must not
            // silently re-enable something the user turned off.
            ...(existing.exists ? {} : { autoSync: true, syncHearings: true, syncDeadlines: true, includeClientDetails: true }),
          },
          { merge: true }
        );

        redirect(res, origin, { calendar: "connected" });
      } catch (e) {
        console.error("calendarAuthCallback failed:", e.message || e);
        redirect(res, origin, { calendar: "error", reason: String(e.message || e).slice(0, 200) });
      }
    }
  );

  /* ---------------- automatic sync ---------------- */

  // Push a single changed document. Deliberately narrow: the full reconcile is
  // for repair, this is for "save a hearing, it's in Google seconds later".
  async function syncOneDoc(uid, kind, docId, before, after) {
    const cfgSnap = await integrationRef(uid).get();
    const cfg = cfgSnap.exists ? cfgSnap.data() : null;
    if (!cfg || cfg.status !== "connected" || !cfg.calendarId) return;
    if (cfg.autoSync === false) return;
    if (kind === "hearing" && cfg.syncHearings === false) return;
    if (kind === "deadline" && cfg.syncDeadlines === false) return;

    const detailed = cfg.includeClientDetails !== false;
    const eventId = eventIdFor(kind, docId);
    const accessToken = await accessTokenFor(uid);
    const calendarId = cfg.calendarId;

    const gone = !after;
    const skipped = after && after.gcalSkip;
    const datedOut = after && (!ISO_DATE.test(after.date || "") || (kind === "hearing" && !HHMM.test(after.time || "")));

    if (gone || skipped || datedOut) {
      if (before?.gcal?.eventId || gone) await deleteEvent(accessToken, calendarId, eventId);
      if (after && after.gcal) {
        await db.doc(`users/${uid}/${kind === "hearing" ? "hearings" : "calendarDeadlines"}/${docId}`)
          .set({ gcal: null }, { merge: true });
      }
      return;
    }

    const event = kind === "hearing" ? hearingEvent(after, { detailed }) : deadlineEvent(after, { detailed });
    const ref = db.doc(`users/${uid}/${kind === "hearing" ? "hearings" : "calendarDeadlines"}/${docId}`);
    await pushEvent(uid, accessToken, calendarId, { kind, id: docId, ref, event }, after.gcal);
  }

  // Shared body for both source collections. Writing `gcal` back re-fires the
  // trigger; the hash comparison inside pushEvent is what stops that from
  // looping — the second pass sees an unchanged hash and does nothing.
  const triggerFor = (collection, kind) =>
    onDocumentWritten(
      {
        document: `users/{uid}/${collection}/{docId}`,
        region: TRIGGER_REGION,
        secrets: [googleClientId, googleClientSecret, credentialEncKey],
        maxInstances: 10,
      },
      async (event) => {
        const { uid, docId } = event.params;
        const before = event.data?.before?.exists ? event.data.before.data() : null;
        const after = event.data?.after?.exists ? event.data.after.data() : null;
        try {
          await syncOneDoc(uid, kind, docId, before, after);
        } catch (e) {
          const message = String(e.message || e).slice(0, 300);
          console.error(`calendar auto-sync failed for ${collection}/${docId}:`, message);
          await integrationRef(uid).set({ lastError: message, lastErrorAt: new Date().toISOString() }, { merge: true }).catch(() => {});
        }
      }
    );

  const onHearingWrittenSync = triggerFor("hearings", "hearing");
  const onCalendarDeadlineWritten = triggerFor("calendarDeadlines", "deadline");

  /* The safety net. Triggers can be missed, tokens expire overnight, and a user
     can delete events in Google without telling anyone — this is what makes the
     morning's calendar right regardless. */
  const nightlyCalendarReconcile = onSchedule(
    {
      schedule: "30 2 * * *",
      timeZone: TZ,
      region: PRIMARY_REGION,
      secrets: [googleClientId, googleClientSecret, credentialEncKey],
      timeoutSeconds: 540,
      memory: "512MiB",
    },
    async () => {
      // Driven off googleTokens rather than a collection-group query on the
      // integration docs: a token existing IS the definition of "connected",
      // and a top-level collection needs no extra index to walk.
      const snap = await db.collection("googleTokens").get();
      let ok = 0;
      let failed = 0;
      for (const doc of snap.docs) {
        const uid = doc.id;
        const cfg = await integrationRef(uid).get();
        if (!cfg.exists || cfg.data().status !== "connected" || cfg.data().autoSync === false) continue;
        try {
          await reconcile(uid);
          ok += 1;
        } catch (e) {
          failed += 1;
          console.error("nightly calendar reconcile failed for", uid, String(e.message || e).slice(0, 200));
        }
      }
      console.info(`nightly calendar reconcile: ${ok} synced, ${failed} failed`);
    }
  );

  /* ---------------- ICS subscription feed ----------------
     The no-OAuth path: one unguessable URL the practitioner pastes into Google
     Calendar's "From URL", Apple Calendar or Outlook. Read-only and refreshed
     lazily by the subscriber (Google is often 8-24 hours behind), so it is the
     weaker product — but it works before Google finishes verifying the app, and
     it keeps working for staff who only need to see the cause list. */

  const feedRef = (uid) => db.doc(`users/${uid}/integrations/calendarFeed`);

  const feedUrl = (uid, token) => {
    const project = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "prohippo2";
    return `https://${PRIMARY_REGION}-${project}.cloudfunctions.net/calendarFeed?u=${uid}&t=${token}`;
  };

  // Mint the link, or rotate it. Rotating is the only way to cut off a link
  // that has been forwarded to the wrong person.
  const calendarFeedLink = onCall({ region: REGIONS, maxInstances: 10 }, async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");

    const snap = await feedRef(uid).get();
    const rotate = request.data?.rotate === true;
    let token = snap.exists ? snap.data().token : "";
    if (!token || rotate) {
      token = crypto.randomBytes(24).toString("hex");
      await feedRef(uid).set({ token, updatedAt: new Date().toISOString() }, { merge: true });
    }
    return { url: feedUrl(uid, token) };
  });


  const calendarFeed = onRequest({ region: PRIMARY_REGION, maxInstances: 10 }, async (req, res) => {
    const uid = clean(req.query.u);
    const token = clean(req.query.t);
    if (!uid || !token) { res.status(400).send("Missing parameters."); return; }

    const snap = await feedRef(uid).get();
    const stored = snap.exists ? String(snap.data().token || "") : "";
    const a = Buffer.from(token);
    const b = Buffer.from(stored);
    if (!stored || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      res.status(403).send("This calendar link is no longer valid.");
      return;
    }

    const cfgSnap = await integrationRef(uid).get();
    const detailed = cfgSnap.exists ? cfgSnap.data().includeClientDetails !== false : true;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - BACKFILL_DAYS);
    const from = isoDate(cutoff);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";

    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//ProHippo//Hearings//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      `X-WR-CALNAME:${icsEscape(CALENDAR_SUMMARY)}`,
      `X-WR-TIMEZONE:${TZ}`,
    ];

    const hearings = await db.collection(`users/${uid}/hearings`).get();
    hearings.docs.forEach((doc) => {
      const h = doc.data() || {};
      if (h.gcalSkip || !ISO_DATE.test(h.date || "") || !HHMM.test(h.time || "") || h.date < from) return;
      const ev = hearingEvent(h, { detailed });
      lines.push(
        "BEGIN:VEVENT",
        `UID:${eventIdFor("hearing", doc.id)}@prohippo`,
        `DTSTAMP:${stamp}`,
        // All-day here too, or a practice subscribing by link would see a
        // different diary from one connected to Google.
        `DTSTART;VALUE=DATE:${icsDate(ev.start.date)}`,
        `DTEND;VALUE=DATE:${icsDate(ev.end.date)}`,
        fold(`SUMMARY:${icsEscape(ev.summary)}`),
        fold(`DESCRIPTION:${icsEscape(ev.description)}`),
        ...(ev.location ? [fold(`LOCATION:${icsEscape(ev.location)}`)] : []),
        "END:VEVENT"
      );
    });

    const deadlines = await db.collection(`users/${uid}/calendarDeadlines`).get();
    deadlines.docs.forEach((doc) => {
      const d = doc.data() || {};
      if (!ISO_DATE.test(d.date || "") || d.date < from) return;
      const ev = deadlineEvent(d, { detailed });
      lines.push(
        "BEGIN:VEVENT",
        `UID:${eventIdFor("deadline", doc.id)}@prohippo`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${icsDate(ev.start.date)}`,
        `DTEND;VALUE=DATE:${icsDate(ev.end.date)}`,
        fold(`SUMMARY:${icsEscape(ev.summary)}`),
        fold(`DESCRIPTION:${icsEscape(ev.description)}`),
        "END:VEVENT"
      );
    });

    lines.push("END:VCALENDAR");

    res.set("Content-Type", "text/calendar; charset=utf-8");
    res.set("Cache-Control", "public, max-age=1800");
    res.status(200).send(lines.join("\r\n"));
  });

  return {
    calendarAuthUrl,
    calendarAuthCallback,
    syncCalendarNow,
    disconnectGoogleCalendar,
    onHearingWrittenSync,
    onCalendarDeadlineWritten,
    nightlyCalendarReconcile,
    calendarFeedLink,
    calendarFeed,
  };
};
