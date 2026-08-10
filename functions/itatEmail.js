/*
 * ProHippo — ITAT email ingest: the address, the webhook, and the writers.
 *
 * The Tribunal already emails a practice everything this app wants to know.
 * itatEmailParse.js reads those two messages; this file is the plumbing around
 * it — one inbound address per practice, the endpoint the mail provider posts
 * to, and the callables that turn a reviewed email into a matter and a hearing.
 * The hearing then reaches the practitioner's Google Calendar through the sync
 * that already exists (googleCalendar.js), so nothing here knows what a calendar
 * is.
 *
 * WHY AN ADDRESS AND NOT A MAILBOX READ. ITAT writes to the ONE address entered
 * on the portal at registration; the portal accepts no second address for the
 * representative. In ordinary practice that address is the practitioner's own,
 * so the common case is not "the mail is out of reach" but "the mail is already
 * in the practitioner's inbox and nothing is reading it". A single forwarding
 * rule on their own mailbox covers every appeal registered that way — every
 * client, past and future. Reading Gmail directly would need a restricted OAuth
 * scope with an annual paid security assessment behind it, and would still only
 * reach whichever one mailbox had been connected. The full reasoning, and the
 * routes for appeals registered under a client's address, are in
 * docs/ITAT_EMAIL_INGEST.md.
 *
 * NOTHING IS APPLIED WITHOUT A HUMAN. An address that receives mail from the
 * internet is an injection surface, and a hearing date written into somebody's
 * diary on the wrong day is the one mistake this application exists to prevent.
 * So the webhook only ever PARSES and STORES. The matter and the hearing are
 * written by applyItatMail, which a signed-in practitioner calls with the parsed
 * fields in front of them.
 *
 * Setup (MX, provider, secret): docs/ITAT_EMAIL_SETUP.md
 */
"use strict";

const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("node:crypto");

const {
  parseItatEmail, originalSenderOf, forwardedByOf, canonicalAppealNo,
  messageKey, matterIdFor, hearingIdFor, MAIL_DOMAIN, fromJson, fromForm,
  normaliseAddress, addressKey, isEmailAddress, emailAddressesIn, statusFromPan,
} = require("./itatEmailParse");

/* The avatar palette the app assigns round-robin as assessees are added, kept
   in step with nextColor() in src/store.jsx. An assessee opened from an email
   should be indistinguishable from one typed in by hand. */
const AVATAR_COLORS = ["violet", "pink", "amber", "mint"];

// Counters are bumped atomically: two emails landing in the same second must
// not read the same value and each write it back plus one.
const countUp = (n = 1) => admin.firestore.FieldValue.increment(n);

/* Shared secret the inbound provider must present, as ?key=… or an
   X-ProHippo-Key header. The alias in the address is already unguessable, but
   this stops anyone who learns one address from reaching the endpoint at all.
     firebase functions:secrets:set ITAT_INBOUND_SECRET   */
const itatInboundSecret = defineSecret("ITAT_INBOUND_SECRET");

const MAX_BODY_CHARS = 200000;

const clean = (v) => (typeof v === "string" ? v.trim() : "");


/* ---------------------------------------------------------------------------
 * Reading whatever the inbound provider posts.
 *
 * The shape each provider uses is flattened by fromJson / fromForm next door in
 * itatEmailParse.js, where they can be unit-tested; what is left here is getting
 * the fields off an HTTP request, which cannot be.
 * ------------------------------------------------------------------------- */

/* Multipart needs busboy, which is required LAZILY and on purpose. Every
   function in this project deploys as one bundle from one node_modules; a
   require at module load that fails takes down the credential vault and OTP
   sign-in alongside this webhook. Confined here, a missing dependency breaks
   multipart delivery only, and says so. */
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    let Busboy;
    try {
      Busboy = require("busboy");
    } catch {
      reject(new Error("multipart delivery needs the busboy dependency; use a JSON-posting provider or deploy with it installed"));
      return;
    }
    const bb = Busboy({ headers: req.headers, limits: { fieldSize: MAX_BODY_CHARS, files: 0 } });
    const fields = {};
    bb.on("field", (name, value) => { fields[name] = value; });
    bb.on("file", (_n, stream) => stream.resume()); // Phase 1 keeps no attachments
    bb.on("error", reject);
    bb.on("close", () => resolve(fields));
    bb.end(req.rawBody);
  });
}

async function readInboundMessage(req) {
  const type = String(req.headers["content-type"] || "").toLowerCase();
  if (type.includes("multipart/form-data")) return fromForm(await parseMultipart(req));
  if (type.includes("application/x-www-form-urlencoded")) return fromForm(req.body || {});
  return fromJson(req.body || {});
}

/* ---------------------------------------------------------------------------
 * The deployed functions.
 * ------------------------------------------------------------------------- */

function build({ PRIMARY_REGION, db }) {
  /* ONE region, and a small ceiling.
   *
   * The rest of this project deploys its callables to both regions because the
   * desktop connector has no auto-update and an installed copy keeps calling
   * us-central1. Nothing here is called by the connector — these five are used
   * by the web app, which pins itself to asia-south1 (src/firebase.js) — so a
   * second copy of each would serve no caller at all.
   *
   * That matters beyond tidiness. Cloud Functions' CPU quota is per region and
   * counts maxInstances, not instances actually running; this project has
   * already had to cut a feature's ceiling to fit inside it once. Deploying
   * four callables at 10 instances across two regions plus a webhook at 20
   * claims a hundred instances' worth of quota for a feature that receives a
   * few emails a day, and a deploy that exceeds the quota fails EVERY function
   * in the project, not just the greedy one.
   *
   * Three is ample: these are one-at-a-time UI actions — read the address,
   * confirm an email — and a practitioner cannot press a button ten times at
   * once. */
  const KEEP = { region: PRIMARY_REGION, maxInstances: 3 };
  const integrationRef = (uid) => db.doc(`users/${uid}/integrations/itatEmail`);
  const aliasRef = (address) => db.doc(`inboundAliases/${addressKey(address)}`);
  const nowISO = () => new Date().toISOString();

  const requireUid = (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
    return uid;
  };

  /* The local part of the address: 8 random bytes as hex. Sixteen unambiguous
     lower-case characters — no case to lose when someone types it off a screen
     into Gmail, and no character that reads as another one. Guessing it is not
     a route in even before the endpoint's own shared secret. */
  const mintToken = () => crypto.randomBytes(8).toString("hex");

  /* Register an address as this practice's, and stand down the one it replaces.
     Registering is what makes mail to it findable at all — the webhook looks the
     recipient up here, so an address nobody claimed simply does not resolve. */
  async function claimAddress(uid, address, extra = {}) {
    const clean_ = normaliseAddress(address);
    const snap = await aliasRef(clean_).get();
    if (snap.exists && snap.data().uid !== uid) {
      throw new HttpsError("already-exists", "Another ProHippo practice is already receiving on that address.");
    }
    const current = await integrationRef(uid).get();
    const previous = normaliseAddress(current.exists ? current.data().address : "");
    const writes = [
      aliasRef(clean_).set({ uid, address: clean_, createdAt: nowISO() }),
      integrationRef(uid).set({ address: clean_, ...extra }, { merge: true }),
    ];
    // Only after the new one is claimed, and never the same document twice.
    if (previous && previous !== clean_) writes.push(aliasRef(previous).delete().catch(() => {}));
    await Promise.all(writes);
    return clean_;
  }

  async function ensureAddress(uid) {
    const snap = await integrationRef(uid).get();
    const existing = snap.exists ? normaliseAddress(snap.data().address) : "";
    if (existing) {
      /* Re-claim an address whose alias has gone missing.
       *
       * The lookup key used to be the token — inboundAliases/<local part> —
       * and became a hash of the whole address when providers that issue their
       * own addresses had to be supported. An address minted before that change
       * still sits on the integration document, and still shows on the Settings
       * card, but has no alias under the new key. Every message to it then
       * resolves to nobody.
       *
       * Silently, which is the part that makes this worth healing rather than
       * detecting: "no alias" is the ordinary outcome for mail we were never
       * meant to receive, so it is answered 200 and logged nowhere the
       * practitioner looks. The provider reports a clean delivery, the app
       * reports nothing at all, and the address simply appears not to work.
       *
       * Settings calls this on mount, so opening the page repairs it. */
      if (!(await aliasRef(existing).get()).exists) {
        console.warn(`itat: re-claiming orphaned alias for ${uid}`);
        await claimAddress(uid, existing, {});
      }
      return snap.data();
    }

    /* Mint one on ProHippo's own mail domain. This is the address a practice
       gets if its provider lets it receive on a domain we control — and the one
       it replaces with useItatEmailAddress if the provider does not. */
    let address = "";
    for (let i = 0; i < 5 && !address; i++) {
      const candidate = `${mintToken()}@${MAIL_DOMAIN}`;
      if (!(await aliasRef(candidate).get()).exists) address = candidate;
    }
    if (!address) throw new HttpsError("internal", "Could not allocate an address. Try again.");

    await integrationRef(uid).set({
      createdAt: nowISO(),
      lastReceivedAt: null,
      receivedCount: 0,
      droppedCount: 0,
      pendingCode: null,
      provided: false,
    }, { merge: true });
    await claimAddress(uid, address, { provided: false });
    return (await integrationRef(uid).get()).data();
  }

  // The address, minting it on first ask. Idempotent, so the Settings screen can
  // simply call it on mount.
  const getItatEmailAddress = onCall(KEEP, async (request) => {
    const uid = requireUid(request);
    const record = await ensureAddress(uid);
    return { address: record.address };
  });

  /* A new address, and the old one stops working immediately. For an address
     that has been forwarded to the wrong person — the same escape hatch the
     calendar's ICS link already has. Every forwarding rule pointing at the old
     address has to be repointed, which the caller is warned about in the UI. */
  const resetItatEmailAddress = onCall(KEEP, async (request) => {
    const uid = requireUid(request);
    let address = "";
    for (let i = 0; i < 5 && !address; i++) {
      const candidate = `${mintToken()}@${MAIL_DOMAIN}`;
      if (!(await aliasRef(candidate).get()).exists) address = candidate;
    }
    if (!address) throw new HttpsError("internal", "Could not allocate an address. Try again.");
    await claimAddress(uid, address, { provided: false });
    return { address };
  });

  /* Receive on an address the practice's own mail provider issued.
   *
   * Whether a practice can have an address on prohippo.info at all is its
   * provider's decision, not ours: CloudMailin's free tier issues one on
   * cloudmailin.net and puts custom domains behind a paid plan, and paying a
   * monthly fee to change the words after the @ is a poor trade for a mailbox
   * that receives a few dozen messages a month. So the practice tells us what
   * to expect instead, and everything downstream is unchanged — the webhook
   * looks up whatever address the mail was addressed to, and never cared which
   * domain it was on.
   *
   * The address is claimed, not merely recorded: a second practice cannot point
   * itself at an address already receiving for someone else, which is the whole
   * of the multi-tenancy guarantee here. */
  const useItatEmailAddress = onCall(KEEP, async (request) => {
    const uid = requireUid(request);
    const address = clean((request.data || {}).address);
    if (!isEmailAddress(address)) {
      throw new HttpsError("invalid-argument", "That does not look like an email address.");
    }
    const claimed = await claimAddress(uid, address, { provided: true });
    return { address: claimed };
  });

  /* Where the mail arrives.
   *
   * Public by necessity, so it trusts nothing: the provider's shared secret, the
   * alias in the recipient, and the sender's domain are all checked before a
   * single byte is written. Anything that fails returns 200 — a provider that
   * retries for hours will not fix a message we have decided not to accept, and
   * a 4xx here just means the same rejected mail arrives ten more times. */
  const itatInboundEmail = onRequest(
    // Single region: the provider is configured with one fixed URL. Five
    // instances, not twenty — the Tribunal sends a practice a few emails a day,
    // and every unit of maxInstances is charged against the region's CPU quota
    // whether or not it ever runs.
    { region: PRIMARY_REGION, secrets: [itatInboundSecret], maxInstances: 5 },
    async (req, res) => {
      if (req.method !== "POST") { res.status(405).send("Method not allowed"); return; }

      /* Compared as BYTES, not as characters. A key with a multi-byte character
         in it has a string length that differs from its buffer length, and
         timingSafeEqual throws on mismatched buffers — which would turn a
         mistyped secret into a 500 and an endless provider retry loop. */
      const expected = Buffer.from(itatInboundSecret.value() || "");
      const offered = Buffer.from(String(req.query.key || req.headers["x-prohippo-key"] || ""));
      const ok = expected.length > 0
        && offered.length === expected.length
        && crypto.timingSafeEqual(offered, expected);
      if (!ok) { console.warn("itatInboundEmail: bad or missing key"); res.status(401).send("Unauthorised"); return; }

      let msg;
      try {
        msg = await readInboundMessage(req);
      } catch (e) {
        console.error("itatInboundEmail: unreadable payload:", e.message || e);
        res.status(200).send("unreadable");
        return;
      }

      /* Which practice this belongs to. Every address the provider offered is
         tried — envelope, To, Cc, Delivered-To — because which one carries the
         practice's address depends on how the mail was forwarded, and a Gmail
         filter forward leaves To: pointing at the practitioner's own mailbox.
         Most of these belong to nobody we know and simply do not resolve.
         Capped, because a mailing list can carry a hundred addresses and each
         one is a read. */
      const candidates = emailAddressesIn(`${msg.to} ${req.query.to || ""}`).slice(0, 10);
      const aliasSnaps = candidates.length ? await db.getAll(...candidates.map(aliasRef)) : [];
      const hit = aliasSnaps.find((snap) => snap.exists);
      const uid = hit ? hit.data().uid : "";
      /* Say WHICH addresses were tried. A bare "no alias matched" is the least
         useful line in the log precisely when it matters most: a provider
         reporting a clean delivery, an app showing nothing, and no way to tell
         a typo in a forwarding rule from an alias that was never registered. */
      if (!uid) {
        console.warn(`itatInboundEmail: no alias matched among [${candidates.join(", ")}]`);
        res.status(200).send("no-alias");
        return;
      }

      msg.originalFrom = originalSenderOf(msg);
      const result = parseItatEmail(msg);

      /* Gmail's verification code. Recorded on the integration document and
         nowhere else — it is not mail about an appeal, it never becomes a
         matter, and it is worthless within the hour. */
      if (result.kind === "gmail-confirmation") {
        await integrationRef(uid).set({
          pendingCode: { ...result.fields, at: nowISO() },
          lastReceivedAt: nowISO(),
        }, { merge: true });
        console.log("itatInboundEmail: code — Gmail's forwarding confirmation, recorded");
        res.status(200).send("code");
        return;
      }

      /* Not from the Tribunal: counted, and dropped. Nothing about the message
         is stored — not the subject, not the sender, not a byte of the body —
         which is the whole basis of telling a client that an over-broad
         forwarding rule costs them nothing. */
      if (result.reason === "sender-not-allowed") {
        await integrationRef(uid).set({ droppedCount: countUp(), lastDroppedAt: nowISO() }, { merge: true });
        /* The outcome and nothing else. Cloud Logging is storage like any
           other, and "not a byte of the message is kept" has to mean the log
           too — otherwise the promise made to a client about an over-broad
           forwarding rule is not one this code actually keeps. */
        console.log("itatInboundEmail: dropped — sender is not the Tribunal");
        res.status(200).send("dropped");
        return;
      }

      const id = messageKey(msg);
      const ref = db.doc(`users/${uid}/itatMail/${id}`);
      if ((await ref.get()).exists) {
        // Named, because this is the one outcome that looks identical to a
        // delivery that never arrived: the provider reports success and the app
        // shows nothing new. Dismissing does not delete the record, so the same
        // message sent twice lands here rather than on the queue.
        console.log(`itatInboundEmail: duplicate — already on file as ${id}`);
        res.status(200).send("duplicate");
        return;
      }

      const match = await matchAssessee(uid, result.fields);

      await Promise.all([
        ref.set({
          receivedAt: nowISO(),
          from: clean(msg.from),
          originalFrom: clean(msg.originalFrom),
          forwardedBy: forwardedByOf(msg.headers),
          subject: clean(msg.subject),
          messageId: clean(msg.messageId),
          kind: result.kind,
          parsed: result.fields,
          reason: result.reason || "",
          ...match,
          status: result.kind === "unrecognised" ? "unrecognised" : "needs-review",
        }),
        integrationRef(uid).set({
          lastReceivedAt: nowISO(),
          lastSubject: clean(msg.subject),
          receivedCount: countUp(),
        }, { merge: true }),
      ]);

      /* What was made of it, in one line. Between them these five outcomes
         account for every delivery, so a provider reporting success and an app
         showing nothing is always explained by the log rather than guessed at
         from the outside. */
      console.log(
        `itatInboundEmail: ok — ${result.kind}`
        + `${result.fields.appealNo ? ` ${result.fields.appealNo}` : ""}`
        + `${result.fields.appellant ? `, appellant read` : ""}`
        + `${match.assesseeId ? `, matched ${match.matchedBy}` : ", no assessee matched"}`
      );
      res.status(200).send("ok");
    }
  );

  const NO_MATCH = { assesseeId: "", assesseeName: "", matchedBy: "" };

  /* Which client this email is about.
   *
   * PAN first, because both of the Tribunal's messages carry it every time and
   * it is exact — one indexed equality query, no scan. Then the appeal number
   * against matters already on file, which catches an appeal entered by hand
   * before any email arrived, and reads the PAN back off it.
   *
   * A miss is a perfectly ordinary outcome, not a failure: the email waits in
   * the review list with an "add this assessee" prompt. An assessee is never
   * created here, because a client's file forked in two by a bad guess is worse
   * than a practitioner spending five seconds choosing from a list. */
  async function matchAssessee(uid, fields) {
    const byPan = async (pan) => {
      if (!pan) return null;
      const snap = await db.collection(`users/${uid}/assessees`).where("pan", "==", pan).limit(1).get();
      return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
    };

    const hit = await byPan(clean(fields.pan).toUpperCase());
    if (hit) return { assesseeId: hit.id, assesseeName: hit.name || "", matchedBy: "pan" };

    const canonical = canonicalAppealNo(fields.appealNo);
    if (!canonical) return NO_MATCH;

    // Matters are read whole rather than queried: what is being compared is the
    // CANONICAL appeal number, and "ITA No. 1244/Ahd/2024" typed by hand is the
    // same appeal as "ITA 1244/AHD/2024" off an email. Firestore cannot express
    // that as a query, and a practice's matters are a small collection.
    const matters = await db.collection(`users/${uid}/matters`).get();
    const m = matters.docs.map((d) => d.data()).find((x) => canonicalAppealNo(x.ref) === canonical);
    if (!m) return NO_MATCH;

    const viaMatter = await byPan(clean(m.pan).toUpperCase());
    return viaMatter
      ? { assesseeId: viaMatter.id, assesseeName: viaMatter.name || "", matchedBy: "appealNo" }
      : NO_MATCH;
  }

  /* Turn a reviewed email into a matter and, for a notice of hearing, a hearing.
   *
   * Called by a signed-in practitioner who has the parsed fields in front of
   * them. The assessee may be overridden here — the match is a suggestion, and
   * the person pressing the button knows better than the PAN on a forwarded
   * message that may have been quoted from the wrong thread. */
  const applyItatMail = onCall(KEEP, async (request) => {
    const uid = requireUid(request);
    const { id, assesseeId } = request.data || {};
    if (!id) throw new HttpsError("invalid-argument", "id is required.");

    const ref = db.doc(`users/${uid}/itatMail/${id}`);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "That email is no longer on file.");
    const mail = snap.data();
    if (mail.status === "applied") return { already: true, ...(mail.applied || {}) };

    const f = mail.parsed || {};
    const pan = clean(f.pan).toUpperCase();

    /* Which client this is for.
     *
     * The practitioner's choice wins, then the PAN match the webhook already
     * made. Failing both, open the file from the email itself — because the PAN
     * is an exact key, not a resemblance. The earlier refusal to create anything
     * here was aimed at matching by NAME, where a near-miss silently forks a
     * client's records in two; a PAN either is on file or it is not.
     *
     * The lookup runs again rather than trusting what the webhook recorded: an
     * assessee added by hand in the minutes between the email arriving and
     * somebody pressing Confirm must be found, not duplicated. */
    let chosenId = clean(assesseeId) || clean(mail.assesseeId);
    let assessee = null;

    if (chosenId) {
      const aSnap = await db.doc(`users/${uid}/assessees/${chosenId}`).get();
      if (!aSnap.exists) throw new HttpsError("not-found", "That assessee is no longer on file.");
      assessee = aSnap.data();
    } else if (pan) {
      const byPan = await db.collection(`users/${uid}/assessees`).where("pan", "==", pan).limit(1).get();
      if (!byPan.empty) {
        chosenId = byPan.docs[0].id;
        assessee = byPan.docs[0].data();
      }
    }

    let createdAssessee = false;
    if (!chosenId) {
      const name = clean(f.appellant);
      if (!pan || !name) {
        throw new HttpsError("failed-precondition", "Choose which assessee this belongs to first.");
      }
      /* Colour by position, the same round-robin the Add assessee form uses, so
         a file opened from an email does not stand out from one typed in. */
      const count = (await db.collection(`users/${uid}/assessees`).count().get()).data().count || 0;
      assessee = {
        name,
        pan,
        // From the fourth character of the PAN — a rule of the Act, so a trust
        // is filed as a trust rather than defaulting to Individual.
        status: statusFromPan(pan),
        group: "",
        mobile: "",
        email: "",
        staff: "",
        address: clean(f.appellantAddress),
        dob: "",
        jurisdiction: null,
        color: AVATAR_COLORS[count % AVATAR_COLORS.length],
        createdAt: nowISO(),
        source: "itat-email",
      };
      const created = await db.collection(`users/${uid}/assessees`).add(assessee);
      chosenId = created.id;
      createdAssessee = true;
    } else if (clean(f.appellantAddress) && !clean(assessee.address)) {
      /* Fill a blank, never overwrite. What a practitioner typed is theirs; the
         Tribunal's copy is only better than nothing. */
      await db.doc(`users/${uid}/assessees/${chosenId}`).set({ address: clean(f.appellantAddress) }, { merge: true });
      assessee = { ...assessee, address: clean(f.appellantAddress) };
    }

    const appealNo = clean(f.appealNo);
    if (!appealNo) throw new HttpsError("failed-precondition", "No appeal number was found in this email.");

    const ay = clean(f.ay);
    const applied = {};
    const writes = [];

    /* The matter, written for BOTH kinds of email. A hearing notice may well be
       the first thing a practice receives about an appeal — the registration
       email predates the integration, or went to a mailbox nobody forwards from
       — and it carries everything the matter needs. */
    const matterId = matterIdFor(appealNo);
    const matterRef = db.doc(`users/${uid}/matters/${matterId}`);
    const matter = {
      type: "ITAT",
      assessee: assessee.name || "",
      pan,
      ay,
      section: "",
      ref: appealNo,
      bench: clean(f.bench),
      status: "Active",
      priority: "medium",
      staff: clean(assessee.staff),
      source: "itat-email",
      sourceMessageId: clean(mail.messageId),
    };
    if (f.filedOn) matter.filedOn = f.filedOn;
    // merge: a hearing notice arriving after registration must not blank the
    // filing date, and a re-run must not undo a practitioner's own edits.
    writes.push(matterRef.set(matter, { merge: true }));
    applied.matterId = matterId;

    if (mail.kind === "hearing" && f.date) {
      const hearingId = hearingIdFor(appealNo, f.date);
      writes.push(db.doc(`users/${uid}/hearings/${hearingId}`).set({
        assessee: assessee.name || "",
        pan,
        ay,
        authority: "ITAT",
        bench: clean(f.bench),
        section: "",
        date: f.date,
        time: clean(f.time) || "10:30",
        mode: "Physical",
        status: "Upcoming",
        ita: appealNo,
        staff: clean(assessee.staff),
        venue: clean(f.venue),
        caseType: clean(f.caseType),
        source: "itat-email",
        sourceMessageId: clean(mail.messageId),
      }, { merge: true }));
      applied.hearingId = hearingId;

      /* An adjournment is a new date for the same appeal, not an edit of the old
         one. The earlier hearing is marked Adjourned rather than deleted, so a
         matter that has been put off four times still reads as four dates —
         which is the history a practitioner is asked about at the hearing.
         Queried by PAN and compared on the CANONICAL appeal number, so a
         hearing someone typed in as "ITA No. 2530/Ahd/2026" is recognised too. */
      const canonical = canonicalAppealNo(appealNo);
      const prior = await db.collection(`users/${uid}/hearings`).where("pan", "==", pan).get();
      prior.docs.forEach((d) => {
        const h = d.data();
        if (d.id === hearingId) return;
        if (canonicalAppealNo(h.ita) !== canonical) return;
        if (h.status !== "Upcoming" || !h.date || h.date >= f.date) return;
        writes.push(d.ref.set({ status: "Adjourned" }, { merge: true }));
      });
    }

    writes.push(ref.set({
      status: "applied",
      appliedAt: nowISO(),
      assesseeId: chosenId,
      assesseeName: assessee.name || "",
      applied,
      createdAssessee,
    }, { merge: true }));

    await Promise.all(writes);
    return { ...applied, assesseeId: chosenId, assesseeName: assessee.name || "", createdAssessee };
  });

  // Not every message needs to become something: a duplicate a client forwarded
  // after their own rule already delivered it, or an appeal handled elsewhere.
  const dismissItatMail = onCall(KEEP, async (request) => {
    const uid = requireUid(request);
    const { id } = request.data || {};
    if (!id) throw new HttpsError("invalid-argument", "id is required.");
    await db.doc(`users/${uid}/itatMail/${id}`).set({ status: "dismissed", dismissedAt: nowISO() }, { merge: true });
    return { ok: true };
  });

  return { getItatEmailAddress, resetItatEmailAddress, useItatEmailAddress, itatInboundEmail, applyItatMail, dismissItatMail };
}

module.exports = { build };
