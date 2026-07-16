/*
 * ProHippo — AI notice parsing backend.
 *
 * Flow: Gemini Flash-Lite reads the notice (a single PDF, or one-or-more page
 * images that together make up one notice) and returns structured JSON →
 * deterministic validation in code (PAN / AY / date rules) → if a critical
 * field is missing or invalid, the same input is retried once on a stronger
 * Gemini model. The extracted fields are returned to the app, where the
 * practitioner reviews them before anything is saved.
 *
 * The Gemini API key is stored as a Firebase secret (GEMINI_API_KEY) and
 * never reaches the browser.
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const crypto = require("crypto");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const geminiApiKey = defineSecret("GEMINI_API_KEY");

// App-managed key for encrypting stored income-tax-portal passwords at rest.
// Set once with:  firebase functions:secrets:set CREDENTIAL_ENC_KEY
// The value must be 32 random bytes, base64-encoded (openssl rand -base64 32).
const credentialEncKey = defineSecret("CREDENTIAL_ENC_KEY");

// Model IDs are config, not code — swap them here if Google renames a model.
// To list the models your key can use, run:
//   curl "https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY"
const PRIMARY_MODEL = "gemini-3.1-flash-lite";
const ESCALATION_MODEL = "gemini-3.1-flash";

// File types Gemini can read for a notice. HEIC (iPhone) is not accepted by
// the API — the app tells the user to share as JPG/PNG instead.
const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const MAX_TOTAL_BYTES = 9 * 1024 * 1024; // callable request limit is 10 MB
const MAX_FILES = 10; // a notice spread across at most this many page images

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const AY_RE = /^(\d{4})\s*[-–/]\s*(\d{2}|\d{4})$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const EXTRACTION_PROMPT = `You are reading a single Indian Income Tax Department notice (scrutiny notice, demand notice, penalty notice, or appeal/hearing notice from CIT(A) or ITAT). The input may be one PDF, or several page images (photos or scans) that together make up ONE notice — read all of them and extract a single combined set of fields, not one per page.

Extract the fields defined in the response schema, following these rules strictly:
- Return null for any field that is not clearly present in the document. NEVER guess or infer a value. A blank field is correct; a wrong deadline or amount is harmful.
- pan: the assessee's Permanent Account Number, format AAAAA9999A.
- assessee: the taxpayer's name exactly as printed (not the officer's name).
- ay: the assessment year in the form "2024-25".
- section: the Income-tax Act section the notice is issued under, e.g. "143(2)", "148", "156", "250", "271(1)(c)". Do not include the words "section" or "u/s".
- din: the Document Identification Number exactly as printed (e.g. ITBA/AST/S/143(2)/2024-25/1234567890(1)).
- noticeDate: the date of issue of the notice, as YYYY-MM-DD.
- hearingDate: the date of hearing or the compliance/response due date, as YYYY-MM-DD. null if none.
- hearingTime: hearing time as HH:MM in 24-hour format. null if none.
- authority: one of "Scrutiny", "CIT(A)", "ITAT", "Penalty", "Other". Use "Scrutiny" for 143(2)/142(1)/148 assessment proceedings, "CIT(A)" for first-appeal notices, "ITAT" for tribunal notices, "Penalty" for 270A/271-series notices, otherwise "Other".
- bench: the bench (for ITAT, e.g. "Ahmedabad 'B' Bench") or the issuing officer/ward/circle designation.
- ita: the ITA / appeal number if this is an appeal notice, else null.
- subject: a one-line subject for the notice, ideally the printed subject line.
- documents: the list of documents/details called for, one array item per document. Empty array if none.`;

// Gemini structured-output schema (REST "responseSchema" format).
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    assessee: { type: "STRING", nullable: true },
    pan: { type: "STRING", nullable: true },
    ay: { type: "STRING", nullable: true },
    section: { type: "STRING", nullable: true },
    din: { type: "STRING", nullable: true },
    noticeDate: { type: "STRING", nullable: true },
    hearingDate: { type: "STRING", nullable: true },
    hearingTime: { type: "STRING", nullable: true },
    authority: {
      type: "STRING",
      nullable: true,
      enum: ["Scrutiny", "CIT(A)", "ITAT", "Penalty", "Other"],
    },
    bench: { type: "STRING", nullable: true },
    ita: { type: "STRING", nullable: true },
    subject: { type: "STRING", nullable: true },
    documents: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["documents"],
};

async function callGemini(model, apiKey, files) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          ...files.map((f) => ({ inlineData: { mimeType: f.mimeType, data: f.data } })),
          { text: EXTRACTION_PROMPT },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (res.status === 404) {
      throw new HttpsError(
        "failed-precondition",
        `Gemini model "${model}" was not found for this API key. ` +
          `Update PRIMARY_MODEL / ESCALATION_MODEL in functions/index.js to a model your key supports.`
      );
    }
    throw new HttpsError("unavailable", `Gemini API error ${res.status}: ${detail.slice(0, 300)}`);
  }

  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("");
  if (!text) throw new HttpsError("internal", "Gemini returned an empty response.");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpsError("internal", "Gemini returned malformed JSON.");
  }
}

/* ---------- deterministic validation & normalisation ---------- */

function normDate(v) {
  if (typeof v !== "string") return null;
  const s = v.trim().slice(0, 10);
  if (!ISO_DATE_RE.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  if (year < 2000 || year > new Date().getUTCFullYear() + 2) return null;
  return s;
}

function normAY(v) {
  if (typeof v !== "string") return null;
  const m = v.replace(/^A\.?Y\.?\s*/i, "").trim().match(AY_RE);
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const endRaw = m[2];
  const end = endRaw.length === 4 ? parseInt(endRaw, 10) % 100 : parseInt(endRaw, 10);
  if ((start + 1) % 100 !== end) return null;
  return `${start}-${String(end).padStart(2, "0")}`;
}

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");

function validate(raw) {
  const warnings = [];
  const fields = {
    assessee: str(raw.assessee),
    pan: str(raw.pan).toUpperCase().replace(/\s/g, ""),
    ay: normAY(raw.ay) || "",
    section: str(raw.section).replace(/^u\/s\.?\s*/i, ""),
    din: str(raw.din),
    date: normDate(raw.noticeDate) || "",
    hearingDate: normDate(raw.hearingDate) || "",
    hearingTime: /^\d{2}:\d{2}$/.test(str(raw.hearingTime)) ? str(raw.hearingTime) : "",
    authority: ["Scrutiny", "CIT(A)", "ITAT", "Penalty", "Other"].includes(raw.authority)
      ? raw.authority
      : "Other",
    bench: str(raw.bench),
    ita: str(raw.ita),
    subject: str(raw.subject),
    documents: Array.isArray(raw.documents) ? raw.documents.map(str).filter(Boolean) : [],
  };

  if (fields.pan && !PAN_RE.test(fields.pan)) {
    warnings.push(`PAN "${fields.pan}" does not match the AAAAA9999A format — verify it.`);
    fields.pan = "";
  }
  if (raw.ay && !fields.ay) warnings.push(`Assessment year "${raw.ay}" could not be read — verify it.`);
  if (raw.noticeDate && !fields.date) warnings.push("Notice date could not be read — verify it.");
  if (fields.date && fields.hearingDate && fields.hearingDate < fields.date) {
    warnings.push("Hearing/response date is before the notice date — verify both dates.");
    fields.hearingDate = "";
  }

  // Critical fields: without these the notice can't be filed against an
  // assessee, so their absence triggers escalation to the stronger model.
  const criticalMissing = [];
  if (!fields.pan && !fields.assessee) criticalMissing.push("assessee/PAN");
  if (!fields.ay) criticalMissing.push("assessment year");
  if (!fields.date) criticalMissing.push("notice date");

  return { fields, warnings, criticalMissing };
}

/* ---------- the callable function ---------- */

exports.parseNotice = onCall(
  {
    region: "us-central1",
    secrets: [geminiApiKey],
    timeoutSeconds: 120,
    memory: "512MiB",
    // Each invocation costs a fraction of a rupee; cap instances so a bug or
    // abuse can't run up a bill.
    maxInstances: 5,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in to use AI notice parsing.");
    }

    // Accept the new multi-file shape { files: [{ mimeType, data }] }, and stay
    // backward-compatible with the original single-PDF shape { pdfBase64 }.
    let files = request.data?.files;
    if (!Array.isArray(files) && typeof request.data?.pdfBase64 === "string") {
      files = [{ mimeType: "application/pdf", data: request.data.pdfBase64 }];
    }
    if (!Array.isArray(files) || files.length === 0) {
      throw new HttpsError("invalid-argument", "Send the notice as { files: [{ mimeType, data }] }.");
    }
    if (files.length > MAX_FILES) {
      throw new HttpsError("invalid-argument", `Too many files — attach at most ${MAX_FILES} pages.`);
    }

    let totalBytes = 0;
    for (const f of files) {
      if (!f || typeof f.data !== "string" || f.data.length < 50 || !ALLOWED_MIME.has(f.mimeType)) {
        throw new HttpsError(
          "invalid-argument",
          "Each file must be a PDF or JPG/PNG/WebP image. iPhone HEIC photos aren't supported — share as JPG."
        );
      }
      totalBytes += (f.data.length * 3) / 4; // approx decoded size of base64
    }
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new HttpsError("invalid-argument", "Files are too large — keep the total under 9 MB.");
    }

    const apiKey = geminiApiKey.value();

    const primaryRaw = await callGemini(PRIMARY_MODEL, apiKey, files);
    let result = validate(primaryRaw);
    let modelUsed = PRIMARY_MODEL;
    let escalated = false;

    if (result.criticalMissing.length > 0) {
      escalated = true;
      try {
        const strongRaw = await callGemini(ESCALATION_MODEL, apiKey, files);
        const strong = validate(strongRaw);
        // Keep whichever attempt reads more of the critical fields.
        if (strong.criticalMissing.length <= result.criticalMissing.length) {
          result = strong;
          modelUsed = ESCALATION_MODEL;
        }
      } catch (err) {
        // Escalation is best-effort: fall back to the primary result rather
        // than failing the whole parse.
        result.warnings.push("Second-pass model was unavailable — showing first-pass extraction.");
        console.error("Escalation to", ESCALATION_MODEL, "failed:", err.message || err);
      }
    }

    if (result.criticalMissing.length > 0) {
      result.warnings.push(
        `Could not read: ${result.criticalMissing.join(", ")}. Fill these in from the notice.`
      );
    }

    return {
      fields: result.fields,
      warnings: result.warnings,
      model: modelUsed,
      escalated,
    };
  }
);

/* ============================================================
   Income-tax portal credential vault (Phase 0)

   Stores each assessee's e-filing portal password encrypted at rest
   (AES-256-GCM with an app-held key). Ciphertext lives in a top-level
   `portalCreds` collection that clients cannot read (Firestore rules deny
   everything outside users/{uid}); only these Cloud Functions, using the
   Admin SDK, can read or write it. A lightweight { portalUserId,
   portalCredSet } flag is mirrored onto the assessee doc for the UI.
   ============================================================ */

function encKeyBuffer() {
  const buf = Buffer.from(credentialEncKey.value(), "base64");
  if (buf.length !== 32) {
    throw new HttpsError(
      "failed-precondition",
      "CREDENTIAL_ENC_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)."
    );
  }
  return buf;
}

function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encKeyBuffer(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptSecret({ iv, ct, tag }) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", encKeyBuffer(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

const credDocPath = (uid, assesseeId) => `portalCreds/${uid}__${assesseeId}`;
const CALLABLE_OPTS = { region: "us-central1", secrets: [credentialEncKey], maxInstances: 10 };

// Save (or replace) an assessee's portal login.
exports.savePortalCredential = onCall(CALLABLE_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  const { assesseeId, portalUserId, portalPassword } = request.data || {};
  if (!assesseeId || !portalUserId || !portalPassword) {
    throw new HttpsError("invalid-argument", "assesseeId, portalUserId and portalPassword are required.");
  }
  const enc = encryptSecret(portalPassword);
  await db.doc(credDocPath(uid, assesseeId)).set({
    uid,
    assesseeId,
    portalUserId: String(portalUserId).trim(),
    ...enc,
    updatedAt: new Date().toISOString(),
  });
  // Mirror a non-secret flag onto the assessee doc for the UI.
  await db.doc(`users/${uid}/assessees/${assesseeId}`).set(
    { portalUserId: String(portalUserId).trim(), portalCredSet: true },
    { merge: true }
  );
  return { ok: true };
});

// Return the decrypted login (called by the app, which hands it to the
// extension at login time). Logs each access for the owner's audit.
exports.getPortalCredential = onCall(CALLABLE_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  const { assesseeId } = request.data || {};
  if (!assesseeId) throw new HttpsError("invalid-argument", "assesseeId is required.");
  const snap = await db.doc(credDocPath(uid, assesseeId)).get();
  if (!snap.exists) throw new HttpsError("not-found", "No portal login saved for this assessee.");
  const d = snap.data();
  let portalPassword;
  try {
    portalPassword = decryptSecret(d);
  } catch {
    throw new HttpsError("internal", "Could not decrypt the stored password — was CREDENTIAL_ENC_KEY changed?");
  }
  db.collection(`users/${uid}/portalCredLogs`)
    .add({ assesseeId, at: new Date().toISOString() })
    .catch(() => {});
  return { portalUserId: d.portalUserId, portalPassword };
});

// Remove a saved portal login.
exports.deletePortalCredential = onCall({ region: "us-central1", maxInstances: 10 }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  const { assesseeId } = request.data || {};
  if (!assesseeId) throw new HttpsError("invalid-argument", "assesseeId is required.");
  await db.doc(credDocPath(uid, assesseeId)).delete();
  await db.doc(`users/${uid}/assessees/${assesseeId}`).set({ portalCredSet: false }, { merge: true });
  return { ok: true };
});

/* ============================================================
   Portal e-Proceedings sync (Phase 2, step 1: proceedings list)

   The extension scrapes the logged-in e-Proceedings list and posts it here
   (relayed through the authenticated app). Proceedings are stored under the
   assessee and deduped by a stable content hash so repeat syncs only add
   what's new. Notice-level detail (deduped by DIN) and PDFs come next.
   ============================================================ */
exports.ingestPortalProceedings = onCall({ region: "us-central1", maxInstances: 10 }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  const { assesseeId, proceedings } = request.data || {};
  if (!assesseeId || !Array.isArray(proceedings)) {
    throw new HttpsError("invalid-argument", "assesseeId and proceedings[] are required.");
  }

  const col = db.collection(`users/${uid}/assessees/${assesseeId}/portalProceedings`);
  let added = 0, updated = 0;
  for (const p of proceedings) {
    const key = [p.name, p.ay, p.fy, p.pan, p.statusDate].map((x) => (x || "")).join("|");
    const id = crypto.createHash("sha1").update(key).digest("hex").slice(0, 24);
    const ref = col.doc(id);
    const snap = await ref.get();
    if (snap.exists) updated++; else added++;
    await ref.set(
      {
        name: p.name || "",
        ay: p.ay || "",
        fy: p.fy || "",
        pan: p.pan || "",
        assessee: p.assessee || "",
        act: p.act || "",
        statusDate: p.statusDate || "",
        noticeCount: typeof p.noticeCount === "number" ? p.noticeCount : null,
        tab: p.tab || "",
        syncedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  }
  await db.doc(`users/${uid}/assessees/${assesseeId}`).set(
    { portalLastSyncedAt: new Date().toISOString(), portalProceedingCount: proceedings.length },
    { merge: true }
  );
  return { ok: true, added, updated, total: proceedings.length };
});

// --- helpers for mapping portal notice data into the app's own entities ---

// Portal dates are epoch-millis (numbers/numeric strings); also tolerate ISO and
// "DD-MMM-YYYY". Returns "YYYY-MM-DD" or "".
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function parsePortalDate(v) {
  if (v == null || v === "") return "";
  if (typeof v === "number" || /^\d{10,}$/.test(String(v))) {
    const d = new Date(Number(v));
    return isNaN(d) ? "" : d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()] != null) {
    const d = new Date(Date.UTC(Number(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1])));
    return isNaN(d) ? "" : d.toISOString().slice(0, 10);
  }
  return "";
}

// The portal gives the AY start year ("2013", "0"). The app uses "2013-14".
function formatAy(v) {
  const s = String(v || "").trim();
  const m = /^(\d{4})$/.exec(s);
  if (!m || s === "0") return /^\d{4}-\d{2}$/.test(s) ? s : "";
  const y = Number(m[1]);
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}

// Map proceeding name + section to the app's authority buckets.
function deriveAuthority(proceedingName, section) {
  const n = (proceedingName || "").toLowerCase();
  const sec = String(section || "");
  if (/penalty/.test(n)) return "Penalty";
  if (/itat|tribunal/.test(n)) return "ITAT";
  if (/appeal/.test(n) || sec === "250") return "CIT(A)";
  if (/143|142|147|148|scrutiny|assessment/.test(n + " " + sec)) return "Scrutiny";
  return "Other";
}

// Record one portal notice/order as a real app notice (deduped by DIN), attach
// its Storage PDF, and — when its response is due in the future — create a
// hearing/calendar entry. The PDF bytes never pass through this function.
exports.ingestPortalNotice = onCall({ region: "us-central1", maxInstances: 10 }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  const { assesseeId, notice, storagePath, filename } = request.data || {};
  if (!assesseeId || !notice || typeof notice !== "object") {
    throw new HttpsError("invalid-argument", "assesseeId and notice are required.");
  }

  // Resolve the assessee so the notice links by name + PAN (how the app joins).
  const aSnap = await db.doc(`users/${uid}/assessees/${assesseeId}`).get();
  const a = aSnap.exists ? aSnap.data() : {};
  const assesseeName = a.name || notice.assessee || "";
  const pan = (a.pan || notice.pan || "").toUpperCase();

  const din = (notice.din || "").toString().trim();
  const date = parsePortalDate(notice.issuedOn) || parsePortalDate(notice.servedOn);
  const dueDate = parsePortalDate(notice.responseDueDate);
  const ay = formatAy(notice.ay);
  const authority = deriveAuthority(notice.proceedingName, notice.section);
  const fileName = filename || notice.filename || "";
  const today = new Date().toISOString().slice(0, 10);

  const noticesCol = db.collection(`users/${uid}/notices`);

  // Dedup by DIN against ALL notices (portal-created or hand-entered).
  let existing = null;
  if (din) {
    const q = await noticesCol.where("din", "==", din).limit(1).get();
    if (!q.empty) existing = q.docs[0];
  }

  let noticeId;
  let added;
  if (existing) {
    // Conservative merge: attach the PDF + portal refs, fill only empty fields,
    // never overwrite the practitioner's own edits (status, authority, …).
    const cur = existing.data();
    const patch = { source: cur.source || "portal", din, proceedingReqId: notice.proceedingReqId || "", portalSyncedAt: new Date().toISOString() };
    if (storagePath) { patch.storagePath = storagePath; if (!cur.fileName) patch.fileName = fileName; }
    const fill = { assessee: assesseeName, pan, ay, section: notice.section || "", authority, date, subject: notice.description || "", responseDueDate: dueDate };
    for (const k of Object.keys(fill)) if (!cur[k] && fill[k]) patch[k] = fill[k];
    await existing.ref.set(patch, { merge: true });
    noticeId = existing.id;
    added = false;
  } else {
    noticeId = din ? "din_" + crypto.createHash("sha1").update(din).digest("hex").slice(0, 20) : noticesCol.doc().id;
    await noticesCol.doc(noticeId).set({
      assessee: assesseeName, pan, ay, authority, section: notice.section || "",
      din, date, subject: notice.description || "", status: "Awaiting review",
      mode: "e-Proceeding", bench: "", ita: "", hearingDate: "", hearingTime: "",
      documents: [], responseDueDate: dueDate,
      source: "portal", proceedingReqId: notice.proceedingReqId || "",
      storagePath: storagePath || "", fileName,
      createdAt: new Date().toISOString(), portalSyncedAt: new Date().toISOString(),
    }, { merge: true });
    added = true;
    await db.doc(`users/${uid}/assessees/${assesseeId}`).set(
      { portalNoticeCount: admin.firestore.FieldValue.increment(1), portalNoticeSyncedAt: new Date().toISOString() },
      { merge: true }
    );
  }

  // Future response-due date → a hearing/calendar entry (deduped, once).
  let hearingAdded = false;
  if (dueDate && dueDate >= today) {
    const hId = "portal_" + crypto.createHash("sha1").update([pan, ay, authority, dueDate].join("|")).digest("hex").slice(0, 20);
    const hRef = db.doc(`users/${uid}/hearings/${hId}`);
    if (!(await hRef.get()).exists) {
      await hRef.set({
        assessee: assesseeName, pan, ay, authority, bench: "", section: notice.section || "",
        date: dueDate, time: "11:00", mode: "e-Proceeding", status: "Upcoming",
        ita: "", staff: a.staff || "", din, source: "portal", createdAt: new Date().toISOString(),
      }, { merge: true });
      hearingAdded = true;
    }
  }

  return { ok: true, noticeId, added, hearingAdded };
});
