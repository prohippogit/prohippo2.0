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

// ---- Passwordless OTP login (Email now via Resend; SMS via 2Factor later) ----
// Resend API key for sending the login email.  firebase functions:secrets:set RESEND_API_KEY
const resendApiKey = defineSecret("RESEND_API_KEY");
// A server-only pepper mixed into every OTP hash, so a Firestore leak never
// exposes a usable code.  Set once to 32 random bytes, base64-encoded:
//   openssl rand -base64 32 | firebase functions:secrets:set OTP_PEPPER
const otpPepper = defineSecret("OTP_PEPPER");

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

// Short, type-aware summary of a portal notice/order for a tax practitioner,
// PLUS a classification of WHICH document this actually is. The portal bundles
// the real order with its computation sheet and notice of demand u/s 156 — only
// the order itself is appealable, so the document type must be read from the PDF.
const DOC_TYPE_ENUM = ["assessmentOrder", "penaltyOrder", "appealOrder", "demandNotice", "computationSheet", "notice", "other"];
const SUMMARY_SCHEMA = {
  type: "OBJECT",
  properties: {
    isOrder: { type: "BOOLEAN" },
    docType: { type: "STRING", enum: DOC_TYPE_ENUM, nullable: true },
    summary: { type: "STRING" },
    items: { type: "ARRAY", items: { type: "STRING" } },
    orderDate: { type: "STRING", nullable: true },
    orderSection: { type: "STRING", nullable: true },
    orderDin: { type: "STRING", nullable: true },
    assessedIncome: { type: "NUMBER", nullable: true },
    disputedDemand: { type: "NUMBER", nullable: true },
  },
  required: ["summary"],
};
function summaryPrompt(authority) {
  return `You are a chartered accountant reading ONE Indian Income-tax document (a notice, an ORDER, or an enclosure that came bundled with an order). Write a VERY SHORT, factual summary for a busy practitioner, and classify exactly WHICH document this is. The operative conclusion is usually on the LAST page(s) — read those carefully.

FIRST classify the document into "docType" — this is critical, because appeals are filed only against the order itself, never against its enclosures:
- "assessmentOrder": an assessment order u/s 143(3)/147/144/153A etc.
- "penaltyOrder": a penalty order (271/270A series).
- "appealOrder": an order of the CIT(A)/JCIT(A)/NFAC u/s 250 (a first-appeal order).
- "demandNotice": a Notice of Demand u/s 156 (the tax/interest/penalty payable slip). NOT an order.
- "computationSheet": a computation of income / tax calculation / ITNS worksheet that accompanies an order. NOT an order.
- "notice": any other notice (not an order).
- "other": anything else.

The proceeding type is "${authority || "Unknown"}". Then summarise per the matching rule:
- assessmentOrder: list EACH addition or disallowance, with the amount and section if stated, e.g. "Addition ₹12,50,000 u/s 68 — unexplained cash credit". Put the total assessed income in "assessedIncome" if printed.
- penaltyOrder: state the section the penalty is levied under and the amount.
- appealOrder: state what was HELD — appeal allowed / dismissed / partly allowed — and the key grounds decided, from the concluding paragraphs.
- demandNotice / computationSheet / notice: one line on what it states or asks for.

Also extract, when clearly printed: "orderDate" (date the order was passed, YYYY-MM-DD), "orderSection" (the section the order is passed under, e.g. "143(3)", "250", "271(1)(c)"), "orderDin" (the DIN), and "disputedDemand" (the demand amount on a demand notice).

Rules: Be terse — a few short points. Put each addition/disallowance/held-point as one entry in "items". Put a one-line overall gist in "summary". Set "isOrder" true ONLY for assessmentOrder/penaltyOrder/appealOrder; false for demandNotice/computationSheet/notice/other. NEVER invent figures, dates or sections — return null / omit anything not clearly printed.`;
}

// Deterministic first-pass classification from the document's own name/section,
// used at ingest before (or instead of) an AI read.
function classifyDocType(name, section, authority) {
  const t = String(name || "");
  const sec = String(section || "");
  if (/notice of demand|demand notice|u\/?s\s*156|\bitns\b/i.test(t)) return "demandNotice";
  if (/comput|tax\s*calculation|calculation sheet/i.test(t)) return "computationSheet";
  if (authority === "CIT(A)" || sec === "250" || /appellate order|order\s*u\/?s\s*250|\b250\b|nfac.*order/i.test(t)) return "appealOrder";
  if (authority === "Penalty" || /penalt|\b27(0a|1)\b/i.test(t)) return "penaltyOrder";
  if (authority === "Scrutiny" || /assessment order|order\s*u\/?s\s*1(4[3479]|53)|\b14[3479]\b|\b144\b/i.test(t)) return "assessmentOrder";
  return "order";
}
async function callGeminiSummary(model, apiKey, files, authority) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ role: "user", parts: [...files.map((f) => ({ inlineData: { mimeType: f.mimeType, data: f.data } })), { text: summaryPrompt(authority) }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: SUMMARY_SCHEMA, temperature: 0 },
  };
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new HttpsError("unavailable", `Gemini API error ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("");
  try { return JSON.parse(text); } catch { throw new HttpsError("internal", "Gemini returned malformed JSON."); }
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

  // Resolve the assessee so matters link by name + PAN (how the app joins).
  const aSnap = await db.doc(`users/${uid}/assessees/${assesseeId}`).get();
  const a = aSnap.exists ? aSnap.data() : {};
  const assesseeName = a.name || "";
  const assesseePan = (a.pan || "").toUpperCase();

  const col = db.collection(`users/${uid}/assessees/${assesseeId}/portalProceedings`);
  const mattersCol = db.collection(`users/${uid}/matters`);
  let added = 0, updated = 0, mattersAdded = 0;
  const closed = []; // proceedings that flipped Active → Closed this sync
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

    // Each proceeding is a Matter (case file). Dedup by proceedingReqId; a
    // conservative merge keeps the practitioner's own edits (status, priority…).
    const prId = String(p.proceedingReqId || "");
    if (prId) {
      const mId = "pcdng_" + crypto.createHash("sha1").update(prId).digest("hex").slice(0, 20);
      const mRef = mattersCol.doc(mId);
      const mSnap = await mRef.get();
      const cur = mSnap.exists ? mSnap.data() : {};
      const base = {
        type: deriveAuthority(p.name, ""),
        assessee: assesseeName || p.assessee || "",
        pan: assesseePan || (p.pan || "").toUpperCase(),
        ay: formatAy(p.ay),
        ref: p.name || "",
        proceedingReqId: prId,
        proceedingName: p.name || "",
        noticeCount: typeof p.viewNoticeCount === "number" ? p.viewNoticeCount : (typeof p.noticeCount === "number" ? p.noticeCount : null),
        source: "portal",
        portalSyncedAt: new Date().toISOString(),
      };
      // "For your Information" = completed/informational → Closed; "For your
      // Action" = still needs action → Active.
      const portalStatus = /information/i.test(p.tab || "") ? "Closed" : "Active";
      if (!mSnap.exists) {
        await mRef.set({ ...base, section: "", bench: "", status: portalStatus, priority: "medium", staff: a.staff || "", createdAt: new Date().toISOString() }, { merge: true });
        mattersAdded++;
      } else {
        // Refresh portal-owned fields only; never overwrite user-set status etc.
        const patch = { proceedingReqId: prId, proceedingName: base.proceedingName, noticeCount: base.noticeCount, source: cur.source || "portal", portalSyncedAt: base.portalSyncedAt };
        for (const k of ["type", "assessee", "pan", "ay", "ref"]) if (!cur[k]) patch[k] = base[k];
        // Track the portal tab only while the status is still an auto value
        // (don't clobber a manually chosen status like "Decided").
        if (cur.status === "Active" || cur.status === "Closed" || !cur.status) patch.status = portalStatus;
        await mRef.set(patch, { merge: true });
        if (cur.status === "Active" && portalStatus === "Closed") {
          closed.push({ proceedingReqId: prId, proceedingName: p.name || "", ay: formatAy(p.ay), type: base.type });
        }
      }
    }
  }
  await db.doc(`users/${uid}/assessees/${assesseeId}`).set(
    { portalLastSyncedAt: new Date().toISOString(), portalProceedingCount: proceedings.length },
    { merge: true }
  );
  return { ok: true, added, updated, mattersAdded, closed, total: proceedings.length };
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
  // Orders (closure orders) have no DIN — dedup them by a stable docKey instead.
  const docKey = (notice.docKey || "").toString().trim();
  const isOrder = Boolean(notice.isOrder);
  const date = parsePortalDate(notice.issuedOn) || parsePortalDate(notice.servedOn);
  const dueDate = parsePortalDate(notice.responseDueDate);
  const ay = formatAy(notice.ay);
  const authority = deriveAuthority(notice.proceedingName, notice.section);
  const fileName = filename || notice.filename || "";
  const today = new Date().toISOString().slice(0, 10);

  const noticesCol = db.collection(`users/${uid}/notices`);

  // Dedup by DIN (notices) or docKey (orders) against ALL notices.
  let existing = null;
  if (din) {
    const q = await noticesCol.where("din", "==", din).limit(1).get();
    if (!q.empty) existing = q.docs[0];
  } else if (docKey) {
    const q = await noticesCol.where("docKey", "==", docKey).limit(1).get();
    if (!q.empty) existing = q.docs[0];
  }

  let noticeId;
  let added;
  if (existing) {
    // Conservative merge: attach the PDF + portal refs, fill only empty fields,
    // never overwrite the practitioner's own edits (status, authority, …).
    const cur = existing.data();
    const patch = { source: cur.source || "portal", din, docKey, isOrder, proceedingReqId: notice.proceedingReqId || "", portalSyncedAt: new Date().toISOString() };
    if (isOrder && !cur.docType) patch.docType = classifyDocType(notice.description || fileName, notice.section, authority);
    if (storagePath) { patch.storagePath = storagePath; if (!cur.fileName) patch.fileName = fileName; }
    const fill = { assessee: assesseeName, pan, ay, section: notice.section || "", authority, date, subject: notice.description || "", responseDueDate: dueDate };
    for (const k of Object.keys(fill)) if (!cur[k] && fill[k]) patch[k] = fill[k];
    await existing.ref.set(patch, { merge: true });
    noticeId = existing.id;
    added = false;
  } else {
    noticeId = din ? "din_" + crypto.createHash("sha1").update(din).digest("hex").slice(0, 20)
      : docKey ? "doc_" + crypto.createHash("sha1").update(docKey).digest("hex").slice(0, 20)
        : noticesCol.doc().id;
    await noticesCol.doc(noticeId).set({
      assessee: assesseeName, pan, ay, authority, section: notice.section || "",
      din, docKey, isOrder, docType: isOrder ? classifyDocType(notice.description || fileName, notice.section, authority) : "",
      date, subject: notice.description || "", status: "Awaiting review",
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
        ita: "", staff: a.staff || "", din, proceedingReqId: notice.proceedingReqId || "",
        source: "portal", createdAt: new Date().toISOString(),
      }, { merge: true });
      hearingAdded = true;
    }
  }

  return { ok: true, noticeId, added, hearingAdded };
});

// On-demand: summarise one portal notice/order's PDF with Gemini and store the
// short, type-aware summary back on the notice. Called from the Matters view.
const STORAGE_BUCKET = "prohippo2.firebasestorage.app";
exports.summarizePortalNotice = onCall(
  { region: "us-central1", secrets: [geminiApiKey], timeoutSeconds: 120, memory: "512MiB", maxInstances: 5 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
    const { noticeId } = request.data || {};
    if (!noticeId) throw new HttpsError("invalid-argument", "noticeId is required.");

    const ref = db.doc(`users/${uid}/notices/${noticeId}`);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "Notice not found.");
    const n = snap.data();
    if (!n.storagePath) throw new HttpsError("failed-precondition", "This notice has no PDF to parse.");

    // Pull the PDF from Storage (admin bypasses rules) and hand it to Gemini.
    let buf;
    try {
      [buf] = await admin.storage().bucket(STORAGE_BUCKET).file(n.storagePath).download();
    } catch (e) {
      throw new HttpsError("not-found", "Couldn't read the PDF from Storage: " + (e.message || e));
    }
    if (buf.length > MAX_TOTAL_BYTES) {
      throw new HttpsError("invalid-argument", "PDF is too large to summarise (over 9 MB).");
    }
    const files = [{ mimeType: "application/pdf", data: buf.toString("base64") }];

    const out = await callGeminiSummary(PRIMARY_MODEL, geminiApiKey.value(), files, n.authority);
    const docType = DOC_TYPE_ENUM.includes(out.docType) ? out.docType : undefined;
    const aiSummary = {
      summary: typeof out.summary === "string" ? out.summary.trim() : "",
      items: Array.isArray(out.items) ? out.items.filter((x) => typeof x === "string" && x.trim()).slice(0, 12) : [],
      isOrder: Boolean(out.isOrder),
      docType: docType || null,
      at: new Date().toISOString(),
    };
    // Persist the parsed order metadata so appeal-matching and the fee use the
    // ORDER's own details (not the demand notice's), and the fee auto-fills.
    const parsed = {
      orderDate: normDate(out.orderDate) || "",
      orderSection: str(out.orderSection),
      orderDin: str(out.orderDin),
      disputedDemand: typeof out.disputedDemand === "number" && out.disputedDemand > 0 ? out.disputedDemand : null,
    };
    const patch = { aiSummary, isOrder: aiSummary.isOrder, parsed };
    // The AI read of the document type wins over the name-based guess.
    if (docType) patch.docType = docType === "notice" ? "" : docType;
    if (typeof out.assessedIncome === "number" && out.assessedIncome > 0 && n.assessedIncome == null) {
      patch.assessedIncome = out.assessedIncome;
    }
    await ref.set(patch, { merge: true });
    return { ok: true, aiSummary, docType: patch.docType, parsed };
  }
);

// Record a response the assessee filed against a notice (remarks text + the
// Storage paths of its attachment PDFs, uploaded client-side). Appended to the
// matching notice's responses[], deduped by responseId.
exports.ingestPortalResponse = onCall({ region: "us-central1", maxInstances: 10 }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  const { noticeKey, response } = request.data || {};
  if (!noticeKey || !response || typeof response !== "object") {
    throw new HttpsError("invalid-argument", "noticeKey and response are required.");
  }
  const q = await db.collection(`users/${uid}/notices`).where("din", "==", noticeKey).limit(1).get();
  if (q.empty) return { ok: false, reason: "notice-not-found" };

  const ref = q.docs[0].ref;
  const cur = q.docs[0].data();
  const responses = Array.isArray(cur.responses) ? cur.responses.slice() : [];
  const rid = String(response.responseId || "");
  if (rid && responses.some((r) => String(r.responseId) === rid)) return { ok: true, dup: true };

  responses.push({
    responseId: rid,
    remarks: (response.remarks || "").toString(),
    submittedOn: (response.submittedOn || "").toString(),
    respType: (response.respType || "").toString(),
    attachments: Array.isArray(response.attachments)
      ? response.attachments.map((a) => ({ storagePath: a.storagePath || "", filename: a.filename || "attachment.pdf", label: (a.label || "").toString() }))
      : [],
  });
  await ref.set({ responses, hasResponse: true }, { merge: true });
  return { ok: true, count: responses.length };
});

// A CIT(A) appeal filed as Form 35 (from the portal's "View Filed Forms").
// Match it to the assessee's First Appeal proceeding by AY (+ corroborate with
// the appealed order's date/DIN/section) and store it as a document under that
// proceeding, so it shows in the Matters dropdown alongside notices/orders.
exports.ingestPortalAppealForm = onCall({ region: "us-central1", maxInstances: 10 }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  const { assesseeId, appeal, attachments } = request.data || {};
  if (!assesseeId || !appeal || typeof appeal !== "object") {
    throw new HttpsError("invalid-argument", "assesseeId and appeal are required.");
  }
  const ackNum = String(appeal.ackNum || "");
  if (!ackNum) return { ok: false, reason: "no-ack" };

  const aSnap = await db.doc(`users/${uid}/assessees/${assesseeId}`).get();
  const a = aSnap.exists ? aSnap.data() : {};
  const assesseeName = a.name || "";
  const pan = (a.pan || "").toUpperCase();
  const ay = formatAy(appeal.ay) || String(appeal.ay || "");
  const dateOrder = parsePortalDate(appeal.dateOrder) || "";
  const orderSection = String(appeal.orderSection || "");

  // Find the matching First Appeal / CIT(A) proceeding for this PAN. Prefer an
  // AY match; when several appeals share an AY, corroborate with the appealed
  // order's date or section (both come from the Form 35). Fall back to the sole
  // appeal proceeding if there's exactly one.
  const mSnap = await db.collection(`users/${uid}/matters`).where("pan", "==", pan).get();
  const appeals = mSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((m) => m.proceedingReqId && (m.type === "CIT(A)" || /appeal/i.test(`${m.proceedingName || ""} ${m.ref || ""}`)));
  const ayMatches = appeals.filter((m) => m.ay && ay && m.ay === ay);
  let pool = ayMatches.length ? ayMatches : appeals;
  let target = null;
  if (pool.length === 1) target = pool[0];
  else if (pool.length > 1) {
    // Disambiguate by an order/notice in the proceeding sharing the order date
    // or section that Form 35 appeals against.
    for (const m of pool) {
      const ns = await db.collection(`users/${uid}/notices`).where("proceedingReqId", "==", m.proceedingReqId).get();
      const hit = ns.docs.map((x) => x.data()).some((n) =>
        (dateOrder && (n.date === dateOrder)) || (orderSection && String(n.section || "") === orderSection));
      if (hit) { target = m; break; }
    }
    if (!target) target = pool[0];
  }
  const proceedingReqId = target ? target.proceedingReqId : "";

  const atts = Array.isArray(attachments)
    ? attachments.map((x) => ({ storagePath: x.storagePath || "", filename: x.filename || "appeal.pdf", label: (x.label || "").toString() }))
    : [];
  const primary = atts.find((x) => x.storagePath) || null;
  const appealMeta = {
    ackNum, ackDt: appeal.ackDt || "", ay,
    orderDin: appeal.orderDin || "", orderSection, appealSection: String(appeal.appealSection || ""),
    dateOrder, dateFiling: parsePortalDate(appeal.dateFiling) || "",
    authorityOrder: appeal.authorityOrder || "",
    amountAssessed: appeal.amountAssessed || "", disputedDemand: appeal.disputedDemand || "",
    formPdfError: (appeal.formPdfError || "").toString().slice(0, 240),
    attachments: atts,
  };
  const docKey = "f35:" + ackNum;
  const noticesCol = db.collection(`users/${uid}/notices`);
  const dup = await noticesCol.where("docKey", "==", docKey).limit(1).get();
  const base = {
    assessee: assesseeName, pan, ay,
    din: "", docKey, isOrder: false, isAppealForm: true, proceedingReqId,
    section: String(appeal.appealSection || "246A"), authority: "CIT(A)",
    subject: `Form 35 — Appeal to CIT(A)${ay ? ` (AY ${ay})` : ""}`,
    date: appealMeta.dateFiling || appealMeta.ackDt || "",
    storagePath: primary ? primary.storagePath : "", fileName: primary ? primary.filename : "",
    appeal: appealMeta, source: "portal", status: "Filed", read: true,
    portalSyncedAt: new Date().toISOString(),
  };
  if (!dup.empty) {
    await dup.docs[0].ref.set(base, { merge: true });
    return { ok: true, updated: true, linked: Boolean(proceedingReqId) };
  }
  const id = "f35_" + crypto.createHash("sha1").update(docKey).digest("hex").slice(0, 20);
  await noticesCol.doc(id).set({ ...base, createdAt: new Date().toISOString() }, { merge: true });
  return { ok: true, added: true, linked: Boolean(proceedingReqId) };
});

/* ============================================================
   Passwordless OTP login  (channel-agnostic engine)

   One engine, two delivery channels:
     • email  → live now, sent via Resend
     • sms    → wired but disabled until the DLT header PRHIPO is active on
                2Factor; enable by flipping CHANNEL_ENABLED.sms and filling in
                sendSmsOtp() (endpoint sketched below).

   Flow:  requestOtp → we generate a 6-digit code, store it HASHED (sha256 with
   a server pepper + per-code salt) in an admin-only `otpChallenges` doc with a
   short expiry, and send it.  verifyOtp → check the hash, attempt cap and
   expiry, then resolve/create the Firebase user and mint a CUSTOM TOKEN. The
   client calls signInWithCustomToken, so Firestore rules and every other
   callable keep working unchanged.

   The `otpChallenges` collection needs no security rule: firestore.rules denies
   everything outside users/{uid}, so only these Admin-SDK functions touch it.
   ============================================================ */

const CHANNEL_ENABLED = { email: true, sms: false };

const OTP_TTL_MS = 10 * 60 * 1000; // a code is valid for 10 minutes
const OTP_MAX_ATTEMPTS = 5; // wrong tries before the challenge is burned
const OTP_RESEND_COOLDOWN_MS = 30 * 1000; // min gap between two sends
const OTP_MAX_SENDS_PER_WINDOW = 5; // sends allowed per rolling window
const OTP_SEND_WINDOW_MS = 60 * 60 * 1000; // the rolling window (1 hour)

// The From address for the login email. Resend requires a VERIFIED domain in
// production — add your domain in the Resend dashboard, complete the DNS
// records, then set this to an address on it (e.g. "ProHippo <login@yourdomain>").
// `onboarding@resend.dev` works out of the box but only delivers to the Resend
// account owner's own email — fine for a first test, not for real users.
const OTP_EMAIL_FROM = "ProHippo <login@prohippo.in>";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normEmail = (v) => String(v || "").trim().toLowerCase();
const isDev = () => process.env.FUNCTIONS_EMULATOR === "true";

function genOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}
function hashOtp(code, salt) {
  return crypto.createHash("sha256").update(`${otpPepper.value()}|${salt}|${code}`).digest("hex");
}
// A stable, non-reversible doc id for a channel+target (peppered so the id
// itself never leaks the email/phone).
function challengeId(channel, target) {
  return crypto.createHash("sha256").update(`${otpPepper.value()}|${channel}|${target}`).digest("hex");
}
function safeEqualHex(a, b) {
  const bufA = Buffer.from(String(a), "hex");
  const bufB = Buffer.from(String(b), "hex");
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function otpEmailHtml(code) {
  return `<!doctype html><html><body style="margin:0;background:#F7F6FB;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F6FB;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:420px;background:#ffffff;border:1px solid #ECE9F5;border-radius:16px;padding:32px;">
        <tr><td style="font-weight:800;font-size:20px;color:#2A1B4A;letter-spacing:-0.02em;">ProHippo</td></tr>
        <tr><td style="padding-top:20px;font-size:14px;color:#6B6480;line-height:1.5;">Use this code to sign in to your ProHippo account:</td></tr>
        <tr><td style="padding:22px 0;">
          <div style="font-size:34px;font-weight:800;letter-spacing:10px;color:#2A1B4A;background:#F3F0FB;border-radius:12px;padding:16px 0;text-align:center;">${code}</div>
        </td></tr>
        <tr><td style="font-size:13px;color:#6B6480;line-height:1.5;">This code expires in 10 minutes. If you didn't request it, you can safely ignore this email — no one can sign in without it.</td></tr>
        <tr><td style="padding-top:22px;border-top:1px solid #ECE9F5;margin-top:10px;font-size:11px;color:#9A93AD;">Income-tax litigation &amp; practice management</td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

async function sendEmailOtp(email, code) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey.value()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: OTP_EMAIL_FROM,
      to: [email],
      subject: `${code} is your ProHippo sign-in code`,
      html: otpEmailHtml(code),
      text: `${code} is your ProHippo sign-in code. It expires in 10 minutes. If you didn't request it, ignore this email.`,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("Resend send failed:", res.status, detail.slice(0, 300));
    throw new HttpsError("unavailable", "We couldn't send the email right now. Please try again in a moment.");
  }
}

// Placeholder for the SMS channel — filled in when the DLT header PRHIPO is
// live on 2Factor. We generate the OTP; 2Factor only transports it, substituting
// it into the approved template's XXXX variable:
//   https://2factor.in/API/V1/{TWOFACTOR_API_KEY}/SMS/{phoneE164}/{code}/ProHippoLoginOTP
// eslint-disable-next-line no-unused-vars
async function sendSmsOtp(_phone, _code) {
  throw new HttpsError("failed-precondition", "SMS login isn't switched on yet.");
}

async function resolveUserByEmail(email) {
  try {
    const u = await admin.auth().getUserByEmail(email);
    if (!u.emailVerified) {
      await admin.auth().updateUser(u.uid, { emailVerified: true }).catch(() => {});
    }
    return u.uid;
  } catch (e) {
    if (e.code === "auth/user-not-found") {
      const u = await admin.auth().createUser({ email, emailVerified: true });
      return u.uid;
    }
    throw e;
  }
}

const OTP_OPTS = { region: "us-central1", secrets: [resendApiKey, otpPepper], maxInstances: 10 };

// Step 1 — generate + send a one-time code.
exports.requestOtp = onCall(OTP_OPTS, async (request) => {
  const channel = String(request.data?.channel || "email");
  if (!CHANNEL_ENABLED[channel]) {
    throw new HttpsError("failed-precondition", channel === "sms" ? "SMS login isn't switched on yet — please use email." : "That sign-in method isn't available.");
  }
  if (channel !== "email") throw new HttpsError("invalid-argument", "Unsupported channel.");

  const email = normEmail(request.data?.target);
  if (!EMAIL_RE.test(email)) throw new HttpsError("invalid-argument", "Please enter a valid email address.");

  const ref = db.collection("otpChallenges").doc(challengeId(channel, email));
  const now = Date.now();
  const snap = await ref.get();
  let sendCount = 1;
  let windowStart = now;
  if (snap.exists) {
    const d = snap.data();
    if (d.lastSentAt && now - d.lastSentAt < OTP_RESEND_COOLDOWN_MS) {
      const wait = Math.ceil((OTP_RESEND_COOLDOWN_MS - (now - d.lastSentAt)) / 1000);
      throw new HttpsError("resource-exhausted", `Please wait ${wait}s before requesting another code.`);
    }
    const withinWindow = d.windowStart && now - d.windowStart < OTP_SEND_WINDOW_MS;
    const priorSends = withinWindow ? d.sendCount || 0 : 0;
    if (priorSends >= OTP_MAX_SENDS_PER_WINDOW) {
      throw new HttpsError("resource-exhausted", "Too many codes requested for this email. Please try again later.");
    }
    sendCount = priorSends + 1;
    windowStart = withinWindow ? d.windowStart : now;
  }

  const code = genOtp();
  const salt = crypto.randomBytes(16).toString("base64");
  await ref.set({
    channel,
    target: email,
    codeHash: hashOtp(code, salt),
    salt,
    expiresAt: now + OTP_TTL_MS,
    attempts: 0,
    consumed: false,
    lastSentAt: now,
    windowStart,
    sendCount,
    updatedAt: new Date().toISOString(),
  });

  try {
    await sendEmailOtp(email, code);
  } catch (e) {
    // In the emulator, don't fail the request if Resend isn't configured —
    // the devCode below lets you complete the flow locally.
    if (!isDev()) throw e;
    console.warn("[dev] email send skipped/failed:", e.message || e);
  }

  const out = { ok: true, channel, cooldownSeconds: OTP_RESEND_COOLDOWN_MS / 1000, ttlSeconds: OTP_TTL_MS / 1000 };
  // In the emulator, return the code so the flow is testable without Resend.
  if (isDev()) { console.info(`[dev] OTP for ${email}: ${code}`); out.devCode = code; }
  return out;
});

// Step 2 — verify a code and mint a Firebase custom token.
exports.verifyOtp = onCall(OTP_OPTS, async (request) => {
  const channel = String(request.data?.channel || "email");
  if (!CHANNEL_ENABLED[channel] || channel !== "email") {
    throw new HttpsError("failed-precondition", "That sign-in method isn't available.");
  }
  const email = normEmail(request.data?.target);
  const code = String(request.data?.code || "").replace(/\D/g, "");
  if (!EMAIL_RE.test(email) || code.length !== 6) {
    throw new HttpsError("invalid-argument", "Enter the 6-digit code we emailed you.");
  }

  const ref = db.collection("otpChallenges").doc(challengeId(channel, email));
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "No code is pending for this email. Please request a new one.");
  }
  const d = snap.data();
  const now = Date.now();
  if (d.consumed) throw new HttpsError("failed-precondition", "That code was already used. Please request a new one.");
  if (now > d.expiresAt) {
    await ref.delete().catch(() => {});
    throw new HttpsError("deadline-exceeded", "That code has expired. Please request a new one.");
  }
  if ((d.attempts || 0) >= OTP_MAX_ATTEMPTS) {
    await ref.delete().catch(() => {});
    throw new HttpsError("resource-exhausted", "Too many incorrect attempts. Please request a new code.");
  }

  if (!safeEqualHex(hashOtp(code, d.salt), d.codeHash)) {
    const attempts = (d.attempts || 0) + 1;
    await ref.set({ attempts }, { merge: true });
    const left = OTP_MAX_ATTEMPTS - attempts;
    if (left <= 0) {
      await ref.delete().catch(() => {});
      throw new HttpsError("resource-exhausted", "Too many incorrect attempts. Please request a new code.");
    }
    throw new HttpsError("permission-denied", `Incorrect code. ${left} ${left === 1 ? "try" : "tries"} left.`);
  }

  // Correct — burn the challenge and mint a token for the resolved account.
  await ref.set({ consumed: true }, { merge: true });
  const uid = await resolveUserByEmail(email);
  const token = await admin.auth().createCustomToken(uid);
  await ref.delete().catch(() => {});
  return { token };
});
