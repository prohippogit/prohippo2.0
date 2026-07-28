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
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const crypto = require("crypto");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

/* ---------- where these functions run ----------------------------------------
 * Firestore for this project lives in asia-south1 (Mumbai) — but these functions
 * were originally pinned to us-central1 (Iowa), Google's default. That split them
 * from the database by ~250ms PER OPERATION, and a single ingest call makes
 * dozens to hundreds of sequential Firestore calls. Co-locating with the database
 * is worth more than any other change in this file.
 *
 * v2 HTTP/callable functions accept an ARRAY of regions and deploy one copy per
 * region under the SAME name, so both are served at once. That matters because
 * the desktop connector has no auto-update: an already-installed copy keeps
 * calling us-central1 and must keep working. Clients pick their region at the
 * SDK level (getFunctions(app, region)).
 *
 * MIGRATION ORDER — see docs/PERF_AND_REGION.md. In short:
 *   1. Deploy this file (both regions live).            ← safe, nothing breaks
 *   2. Flip the clients to asia-south1 and redeploy.
 *   3. Much later, once no old connector is in the wild, drop "us-central1"
 *      below and redeploy to retire the Iowa copies.
 *
 * Do NOT reorder: flipping a client to a region that has no deployed function
 * takes that client down until step 1 lands.
 * -------------------------------------------------------------------------- */
const PRIMARY_REGION = "asia-south1"; // co-located with Firestore
const REGIONS = [PRIMARY_REGION, "us-central1"];

// Firestore triggers are bound to the database's own region — there is no choice
// to make and no array to pass.
const TRIGGER_REGION = PRIMARY_REGION;

// Keeping one instance warm removes a 1-3s cold start from the first sync of the
// day. NOTE: this is applied PER REGION, so while REGIONS holds two entries you
// are paying for two warm instances. Step 3 of the migration halves that.
const KEEP_WARM = 1;

const geminiApiKey = defineSecret("GEMINI_API_KEY");

// App-managed key for encrypting stored income-tax-portal passwords at rest.
// Set once with:  firebase functions:secrets:set CREDENTIAL_ENC_KEY
// The value must be 32 random bytes, base64-encoded (openssl rand -base64 32).
const credentialEncKey = defineSecret("CREDENTIAL_ENC_KEY");

// ---- Passwordless OTP login (Email via Resend; SMS via 2Factor) ----
// Resend API key for sending the login email.  firebase functions:secrets:set RESEND_API_KEY
const resendApiKey = defineSecret("RESEND_API_KEY");
// A server-only pepper mixed into every OTP hash, so a Firestore leak never
// exposes a usable code.  Set once to 32 random bytes, base64-encoded:
//   openssl rand -base64 32 | firebase functions:secrets:set OTP_PEPPER
const otpPepper = defineSecret("OTP_PEPPER");
// 2Factor API key for sending/verifying the login SMS OTP (AUTOGEN flow).
// From the 2Factor CP panel → Account Summary.  firebase functions:secrets:set TWOFACTOR_API_KEY
const twofactorApiKey = defineSecret("TWOFACTOR_API_KEY");
// Signing secret for the Resend delivery webhook (Resend dashboard → Webhooks →
// the endpoint's "Signing Secret", a whsec_… value).
//   firebase functions:secrets:set RESEND_WEBHOOK_SECRET
const resendWebhookSecret = defineSecret("RESEND_WEBHOOK_SECRET");

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
    region: REGIONS,
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
const CALLABLE_OPTS = { region: REGIONS, secrets: [credentialEncKey], maxInstances: 10 };

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
exports.deletePortalCredential = onCall({ region: REGIONS, maxInstances: 10 }, async (request) => {
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
// db.getAll() takes refs as varargs and rejects an empty call; it is also worth
// keeping each batch bounded. Returns snapshots in the order the refs came in.
async function getAllChunked(refs, size = 300) {
  if (!refs.length) return [];
  const out = [];
  for (let i = 0; i < refs.length; i += size) {
    out.push(...(await db.getAll(...refs.slice(i, i + size))));
  }
  return out;
}

exports.ingestPortalProceedings = onCall({ region: REGIONS, maxInstances: 10, minInstances: KEEP_WARM }, async (request) => {
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

  // This used to run FOUR sequential Firestore round trips per proceeding
  // (proceeding get + set, matter get + set). At 40 proceedings that is ~160
  // calls one after another, and every one of them crossed from us-central1 to
  // the Mumbai database — roughly 40 seconds of pure waiting, paid on EVERY
  // sync including ones where nothing changed. Now: read everything in one
  // batch, decide in memory, write in one batch.
  //
  // A payload should never list the same proceeding twice, but dedupe by target
  // document id anyway — batched reads all see the pre-sync state, so a repeat
  // would otherwise be counted (and "closed"-detected) more than once.
  const byProcDoc = new Map(); // portalProceedings doc id -> row
  const byMatterDoc = new Map(); // matters doc id -> { row, prId }
  for (const p of proceedings) {
    const key = [p.name, p.ay, p.fy, p.pan, p.statusDate].map((x) => (x || "")).join("|");
    byProcDoc.set(crypto.createHash("sha1").update(key).digest("hex").slice(0, 24), p);
    const prId = String(p.proceedingReqId || "");
    if (prId) {
      const mId = "pcdng_" + crypto.createHash("sha1").update(prId).digest("hex").slice(0, 20);
      byMatterDoc.set(mId, { row: p, prId });
    }
  }

  const procIds = [...byProcDoc.keys()];
  const matterIds = [...byMatterDoc.keys()];
  const [procSnaps, matterSnaps] = await Promise.all([
    getAllChunked(procIds.map((id) => col.doc(id))),
    getAllChunked(matterIds.map((id) => mattersCol.doc(id))),
  ]);
  const matterById = new Map(matterIds.map((id, i) => [id, matterSnaps[i]]));

  const now = new Date().toISOString();
  const writer = db.bulkWriter();
  let added = 0, updated = 0, mattersAdded = 0;
  const closed = []; // proceedings that flipped Active → Closed this sync

  // BulkWriter applies its own retry policy, but each set() returns a promise —
  // leaving those unattached turns a permanently-failed write into an unhandled
  // rejection AND loses the row silently. Collect failures and report them.
  const writeErrors = [];
  const track = (p) => {
    p.catch((e) => writeErrors.push(String((e && e.message) || e)));
    return p;
  };

  procIds.forEach((id, i) => {
    const p = byProcDoc.get(id);
    if (procSnaps[i].exists) updated++; else added++;
    track(writer.set(
      col.doc(id),
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
        syncedAt: now,
      },
      { merge: true }
    ));
  });

  // Each proceeding is a Matter (case file). Dedup by proceedingReqId; a
  // conservative merge keeps the practitioner's own edits (status, priority…).
  for (const [mId, { row: p, prId }] of byMatterDoc) {
    const mSnap = matterById.get(mId);
    const cur = mSnap && mSnap.exists ? mSnap.data() : {};
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
      portalSyncedAt: now,
    };
    // "For your Information" = completed/informational → Closed; "For your
    // Action" = still needs action → Active.
    const portalStatus = /information/i.test(p.tab || "") ? "Closed" : "Active";
    if (!mSnap || !mSnap.exists) {
      track(writer.set(
        mattersCol.doc(mId),
        { ...base, section: "", bench: "", status: portalStatus, priority: "medium", staff: a.staff || "", createdAt: now },
        { merge: true }
      ));
      mattersAdded++;
    } else {
      // Refresh portal-owned fields only; never overwrite user-set status etc.
      const patch = { proceedingReqId: prId, proceedingName: base.proceedingName, noticeCount: base.noticeCount, source: cur.source || "portal", portalSyncedAt: base.portalSyncedAt };
      for (const k of ["type", "assessee", "pan", "ay", "ref"]) if (!cur[k]) patch[k] = base[k];
      // Track the portal tab only while the status is still an auto value
      // (don't clobber a manually chosen status like "Decided").
      if (cur.status === "Active" || cur.status === "Closed" || !cur.status) patch.status = portalStatus;
      track(writer.set(mattersCol.doc(mId), patch, { merge: true }));
      if (cur.status === "Active" && portalStatus === "Closed") {
        closed.push({ proceedingReqId: prId, proceedingName: p.name || "", ay: formatAy(p.ay), type: base.type });
      }
    }
  }

  track(writer.set(
    db.doc(`users/${uid}/assessees/${assesseeId}`),
    { portalLastSyncedAt: now, portalProceedingCount: proceedings.length },
    { merge: true }
  ));
  await writer.close();

  if (writeErrors.length) {
    throw new HttpsError(
      "internal",
      `Saved ${procIds.length - writeErrors.length} of ${procIds.length} proceedings; ` +
      `${writeErrors.length} write(s) failed: ${writeErrors[0]}`
    );
  }
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
exports.ingestPortalNotice = onCall({ region: REGIONS, maxInstances: 10, minInstances: KEEP_WARM }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  const { assesseeId, notice, storagePath, filename } = request.data || {};
  if (!assesseeId || !notice || typeof notice !== "object") {
    throw new HttpsError("invalid-argument", "assesseeId and notice are required.");
  }

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
  //
  // Anything this function created lives at a DETERMINISTIC id derived from the
  // same DIN/docKey (see `newId` below), so try that document directly first —
  // one keyed read instead of a collection query. The query is still needed as a
  // fallback: a notice uploaded by hand and parsed by AI can carry a DIN under a
  // random id, and skipping the fallback would duplicate it.
  const newId = din
    ? "din_" + crypto.createHash("sha1").update(din).digest("hex").slice(0, 20)
    : docKey
      ? "doc_" + crypto.createHash("sha1").update(docKey).digest("hex").slice(0, 20)
      : null;

  // Resolve the assessee (the notice links by name + PAN, which is how the app
  // joins) alongside the dedup read rather than before it.
  const [aSnap, fastSnap] = await Promise.all([
    db.doc(`users/${uid}/assessees/${assesseeId}`).get(),
    newId ? noticesCol.doc(newId).get() : Promise.resolve(null),
  ]);
  const a = aSnap.exists ? aSnap.data() : {};
  const assesseeName = a.name || notice.assessee || "";
  const pan = (a.pan || notice.pan || "").toUpperCase();

  let existing = null;
  if (fastSnap && fastSnap.exists) {
    existing = fastSnap;
  } else if (din) {
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
    noticeId = newId || noticesCol.doc().id;
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

const STORAGE_BUCKET = "prohippo2.firebasestorage.app";

// Read one notice's PDF, summarise it with Gemini, and write the result back.
// Shared by the on-demand callable (a practitioner pressing re-parse in the
// Matters view) and by the Firestore trigger that runs automatically for orders.
// Returns the patch it applied.
async function summariseNoticeDoc(ref, n, apiKey) {
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

  const out = await callGeminiSummary(PRIMARY_MODEL, apiKey, files, n.authority);
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
  const patch = { aiSummary, isOrder: aiSummary.isOrder, parsed, aiSummaryError: "" };
  // The AI read of the document type wins over the name-based guess.
  if (docType) patch.docType = docType === "notice" ? "" : docType;
  if (typeof out.assessedIncome === "number" && out.assessedIncome > 0 && n.assessedIncome == null) {
    patch.assessedIncome = out.assessedIncome;
  }
  await ref.set(patch, { merge: true });
  return patch;
}

// On-demand: summarise one portal notice/order's PDF. Called from the Matters
// view, and the way to retry an order whose automatic parse failed.
exports.summarizePortalNotice = onCall(
  { region: REGIONS, secrets: [geminiApiKey], timeoutSeconds: 120, memory: "512MiB", maxInstances: 5 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
    const { noticeId } = request.data || {};
    if (!noticeId) throw new HttpsError("invalid-argument", "noticeId is required.");

    const ref = db.doc(`users/${uid}/notices/${noticeId}`);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "Notice not found.");
    const patch = await summariseNoticeDoc(ref, snap.data(), geminiApiKey.value());
    return { ok: true, aiSummary: patch.aiSummary, docType: patch.docType, parsed: patch.parsed };
  }
);

/* ---------- documents called for ----------------------------------------------
 * Notices that arrive through the portal sync are written with `documents: []`
 * (see ingestPortalNotice above) — the portal's JSON carries no such list, it is
 * only in the PDF's prose. So the document request had nothing to work from on
 * exactly the notices that arrive automatically.
 *
 * This reads the PDF and extracts ONLY the list of documents/details called for.
 * Deliberately not the full EXTRACTION_PROMPT used for uploaded notices: for a
 * portal notice the PAN, AY, section, DIN and dates already came from the source
 * system and are authoritative. Re-reading them with an AI can only make them
 * worse. Extract the one thing that is genuinely missing.
 * ---------------------------------------------------------------------------- */

const DOCUMENTS_PROMPT = `You are a chartered accountant reading ONE Indian Income-tax notice. Your only job is to list what the assessee has been asked to PRODUCE.

Return, in "documents", one entry per document, record, explanation or detail the notice calls for. Rules:
- Copy the substance of what is asked, in plain words a client would understand. Expand cross-references ("the details in Annexure A" → the actual items, if the annexure is in this PDF).
- One asked-for thing per entry. If the notice asks for "bank statements and confirmations from creditors", that is TWO entries.
- Include the year/period/party when the notice specifies one, e.g. "Bank statements of all accounts for FY 2016-17", "Confirmation from M/s ABC Traders with PAN".
- Do NOT include procedural instructions that are not documents (how to respond, e-filing steps, consequences of non-compliance, the officer's contact details).
- Do NOT invent standard items that this notice does not actually ask for. An empty list is correct if the notice calls for nothing.
- Keep each entry under 160 characters. At most 25 entries.

Also extract, ONLY if clearly printed:
- "complianceDueDate": the date by which the response/documents must be filed, as YYYY-MM-DD.
- "hearingDate": the date of hearing, as YYYY-MM-DD.
Return null for either if not clearly printed. NEVER guess a date.`;

const DOCUMENTS_SCHEMA = {
  type: "OBJECT",
  properties: {
    documents: { type: "ARRAY", items: { type: "STRING" } },
    complianceDueDate: { type: "STRING", nullable: true },
    hearingDate: { type: "STRING", nullable: true },
  },
  required: ["documents"],
};

async function callGeminiDocuments(model, apiKey, files) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ role: "user", parts: [...files.map((f) => ({ inlineData: { mimeType: f.mimeType, data: f.data } })), { text: DOCUMENTS_PROMPT }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: DOCUMENTS_SCHEMA, temperature: 0 },
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

exports.extractNoticeDocuments = onCall(
  { region: REGIONS, secrets: [geminiApiKey], timeoutSeconds: 120, memory: "512MiB", maxInstances: 5 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
    const { noticeId } = request.data || {};
    if (!noticeId) throw new HttpsError("invalid-argument", "noticeId is required.");

    const ref = db.doc(`users/${uid}/notices/${noticeId}`);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "Notice not found.");
    const n = snap.data();
    if (!n.storagePath) {
      throw new HttpsError("failed-precondition", "This notice has no PDF to read — add the documents by hand.");
    }

    let buf;
    try {
      [buf] = await admin.storage().bucket(STORAGE_BUCKET).file(n.storagePath).download();
    } catch (e) {
      throw new HttpsError("not-found", "Couldn't read the PDF from Storage: " + (e.message || e));
    }
    if (buf.length > MAX_TOTAL_BYTES) {
      throw new HttpsError("invalid-argument", "PDF is too large to read (over 9 MB).");
    }

    let out;
    try {
      out = await callGeminiDocuments(PRIMARY_MODEL, geminiApiKey.value(), [{ mimeType: "application/pdf", data: buf.toString("base64") }]);
    } catch (e) {
      // Record the failure so the UI can say what happened rather than silently
      // opening an empty checklist.
      await ref.set({ documentsError: String((e && e.message) || e).slice(0, 200) }, { merge: true }).catch(() => {});
      throw e;
    }

    const documents = Array.isArray(out.documents)
      ? out.documents.map((d) => str(d).slice(0, 160)).filter(Boolean).slice(0, 25)
      : [];

    const patch = { documents, documentsAt: new Date().toISOString(), documentsError: "" };
    // Dates are filled in only where nothing is on file. Anything the portal or
    // the practitioner already recorded wins over the AI's read.
    const due = normDate(out.complianceDueDate);
    const hearing = normDate(out.hearingDate);
    if (due && !n.responseDueDate) patch.responseDueDate = due;
    if (hearing && !n.hearingDate) patch.hearingDate = hearing;

    await ref.set(patch, { merge: true });
    return { ok: true, documents, responseDueDate: patch.responseDueDate || n.responseDueDate || "", hearingDate: patch.hearingDate || n.hearingDate || "" };
  }
);

// Auto-parse order PDFs as they land, so the real document type (order vs demand
// notice vs computation sheet) and the order's own metadata — which drive appeal
// detection and the Form 35 match — are known without anyone asking.
//
// This used to be an awaited call at the END of the connector's per-notice ingest:
// a 5-25s Gemini read of the PDF, capped at 5 concurrent instances shared across
// every worker, sitting on the sync's critical path. As a trigger it runs on
// Google's side after the sync has moved on, and still completes if the user
// closes the connector the moment the sync ends.
//
// Firestore triggers must live in the database's region, so this one is pinned to
// TRIGGER_REGION rather than taking the REGIONS array.
exports.onPortalOrderWritten = onDocumentWritten(
  {
    document: "users/{uid}/notices/{noticeId}",
    region: TRIGGER_REGION,
    secrets: [geminiApiKey],
    timeoutSeconds: 120,
    memory: "512MiB",
    maxInstances: 5,
  },
  async (event) => {
    const after = event.data && event.data.after;
    if (!after || !after.exists) return; // deleted
    const n = after.data() || {};

    // Orders only, and only when there's a PDF to read.
    if (!n.isOrder || !n.storagePath) return;
    // Exactly one automatic attempt per document. `aiSummary` stops the re-fire
    // caused by our own write-back; `aiSummaryError` stops a failing PDF from
    // retrying forever (and running up a Gemini bill). Either way the
    // practitioner can still retry by hand via summarizePortalNotice.
    if (n.aiSummary || n.aiSummaryError) return;

    try {
      await summariseNoticeDoc(after.ref, n, geminiApiKey.value());
    } catch (err) {
      const message = String((err && err.message) || err).slice(0, 300);
      console.error("onPortalOrderWritten failed", event.params.noticeId, message);
      // Surface the failure on the document instead of losing it silently.
      await after.ref.set({ aiSummaryError: message }, { merge: true }).catch(() => {});
    }
  }
);

// Record a response the assessee filed against a notice (remarks text + the
// Storage paths of its attachment PDFs, uploaded client-side). Appended to the
// matching notice's responses[], deduped by responseId.
exports.ingestPortalResponse = onCall({ region: REGIONS, maxInstances: 10 }, async (request) => {
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
exports.ingestPortalAppealForm = onCall({ region: REGIONS, maxInstances: 10 }, async (request) => {
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
     • email → we generate a 6-digit code, store it HASHED, and send via Resend;
       verify by comparing the hash locally.
     • sms   → 2Factor's AUTOGEN generates + holds the code and returns a session
       id (stored on the challenge); verify by calling 2Factor VERIFY. Uses the
       DLT-approved header PRHIPO + template "ProHippo Login OTP v3".

   Both paths share the same challenge store (rate-limiting, cooldown, attempt
   cap, expiry) and, on success, resolve/create the Firebase user and mint a
   CUSTOM TOKEN. The client calls signInWithCustomToken, so Firestore rules and
   every other callable keep working unchanged.

   The `otpChallenges` collection needs no security rule: firestore.rules denies
   everything outside users/{uid}, so only these Admin-SDK functions touch it.
   ============================================================ */

const CHANNEL_ENABLED = { email: true, sms: true };

// 2Factor AUTOGEN endpoint template name, URL-encoded exactly as 2Factor
// registered it (spaces as "+"). 2Factor substitutes the OTP into the approved
// "{#var#} is your OTP to log in to ProHippo (a product of MEHTAJI BIZCON LLP)…".
const TWOFACTOR_TEMPLATE = "ProHippo+Login+OTP+v3";
const PHONE_RE = /^[6-9]\d{9}$/; // 10-digit Indian mobile

// Reduce any user-typed phone to the bare 10 national digits (drops +91 / 0 / spaces).
function normPhoneDigits(v) {
  const d = String(v || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) return d.slice(2);
  if (d.length === 11 && d.startsWith("0")) return d.slice(1);
  return d;
}
const toE164 = (ten) => "+91" + ten;

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

/* Brand mark for the sign-in email.
 *
 * Served from Firebase Hosting's default domain, which is always live — the
 * custom domain may or may not be pointed at Hosting, and a broken image on a
 * sign-in email is worse than a plainer URL. Kept in step with LOGO_URL in
 * src/messageTemplates.js.
 *
 * Note this sits at the TOP here, unlike the client document request where it
 * is a footer credit. This email really is from ProHippo; that one is from the
 * practitioner's firm, and leading it with our logo would confuse their client
 * about who is writing. */
const LOGO_URL = "https://prohippo2.web.app/prohippo-logo.png";

function otpEmailHtml(code) {
  return `<!doctype html><html><body style="margin:0;background:#F7F6FB;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F6FB;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:420px;background:#ffffff;border:1px solid #ECE9F5;border-radius:16px;padding:32px;">
        <tr><td>
          <img src="${LOGO_URL}" alt="ProHippo" width="89" height="44" style="display:block;border:0;outline:none;width:89px;height:44px;"/>
        </td></tr>
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

// SMS channel via 2Factor AUTOGEN: 2Factor generates + sends the OTP using the
// DLT-approved template, and returns a session id we keep for verification.
async function sendSmsOtp(phoneTen) {
  const url = `https://2factor.in/API/V1/${twofactorApiKey.value()}/SMS/${phoneTen}/AUTOGEN/${TWOFACTOR_TEMPLATE}`;
  let json;
  try {
    const res = await fetch(url);
    json = await res.json();
  } catch (e) {
    console.error("2Factor AUTOGEN request failed:", e.message || e);
    throw new HttpsError("unavailable", "We couldn't send the SMS right now. Please try again in a moment.");
  }
  if (!json || json.Status !== "Success" || !json.Details) {
    console.error("2Factor AUTOGEN error:", JSON.stringify(json).slice(0, 300));
    throw new HttpsError("unavailable", "We couldn't send the SMS right now. Please try again in a moment.");
  }
  return json.Details; // session id
}

// Ask 2Factor whether the entered code matches the session's OTP.
async function checkSmsOtp(sessionId, code) {
  const url = `https://2factor.in/API/V1/${twofactorApiKey.value()}/SMS/VERIFY/${encodeURIComponent(sessionId)}/${encodeURIComponent(code)}`;
  try {
    const res = await fetch(url);
    const json = await res.json();
    return { ok: !!json && json.Status === "Success", details: json && json.Details };
  } catch (e) {
    console.error("2Factor VERIFY failed:", e.message || e);
    return { ok: false, details: "network" };
  }
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

async function resolveUserByPhone(phoneE164) {
  try {
    const u = await admin.auth().getUserByPhoneNumber(phoneE164);
    return u.uid;
  } catch (e) {
    if (e.code === "auth/user-not-found") {
      const u = await admin.auth().createUser({ phoneNumber: phoneE164 });
      return u.uid;
    }
    throw e;
  }
}

const OTP_OPTS = { region: REGIONS, secrets: [resendApiKey, otpPepper, twofactorApiKey], maxInstances: 10 };

// Resolve + validate the (channel, target) the client sent. Returns the
// normalised target used both for the challenge id and for delivery.
function resolveTarget(channel, raw) {
  if (channel === "email") {
    const email = normEmail(raw);
    if (!EMAIL_RE.test(email)) throw new HttpsError("invalid-argument", "Please enter a valid email address.");
    return { target: email };
  }
  if (channel === "sms") {
    const ten = normPhoneDigits(raw);
    if (!PHONE_RE.test(ten)) throw new HttpsError("invalid-argument", "Please enter a valid 10-digit mobile number.");
    return { target: toE164(ten), phoneTen: ten };
  }
  throw new HttpsError("invalid-argument", "Unsupported channel.");
}

// Step 1 — generate/send a one-time code on the chosen channel.
exports.requestOtp = onCall(OTP_OPTS, async (request) => {
  const channel = String(request.data?.channel || "email");
  if (!CHANNEL_ENABLED[channel]) throw new HttpsError("failed-precondition", "That sign-in method isn't available.");
  const { target, phoneTen } = resolveTarget(channel, request.data?.target);

  const ref = db.collection("otpChallenges").doc(challengeId(channel, target));
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
      throw new HttpsError("resource-exhausted", "Too many codes requested. Please try again later.");
    }
    sendCount = priorSends + 1;
    windowStart = withinWindow ? d.windowStart : now;
  }

  // Channel-specific: build the record that lets verifyOtp check the code.
  const base = {
    channel, target,
    expiresAt: now + OTP_TTL_MS,
    attempts: 0,
    consumed: false,
    lastSentAt: now,
    windowStart,
    sendCount,
    updatedAt: new Date().toISOString(),
  };
  const out = { ok: true, channel, cooldownSeconds: OTP_RESEND_COOLDOWN_MS / 1000, ttlSeconds: OTP_TTL_MS / 1000 };

  if (channel === "email") {
    const code = genOtp();
    const salt = crypto.randomBytes(16).toString("base64");
    await ref.set({ ...base, codeHash: hashOtp(code, salt), salt });
    try {
      await sendEmailOtp(target, code);
    } catch (e) {
      if (!isDev()) throw e; // in the emulator, devCode lets you finish without Resend
      console.warn("[dev] email send skipped/failed:", e.message || e);
    }
    if (isDev()) { console.info(`[dev] OTP for ${target}: ${code}`); out.devCode = code; }
  } else {
    // SMS: 2Factor generates + sends the OTP and hands back a session id.
    const sessionId = await sendSmsOtp(phoneTen);
    await ref.set({ ...base, sessionId });
  }

  return out;
});

// Step 2 — verify a code and mint a Firebase custom token.
exports.verifyOtp = onCall(OTP_OPTS, async (request) => {
  const channel = String(request.data?.channel || "email");
  if (!CHANNEL_ENABLED[channel]) throw new HttpsError("failed-precondition", "That sign-in method isn't available.");
  const { target } = resolveTarget(channel, request.data?.target);
  const code = String(request.data?.code || "").replace(/\D/g, "");
  if (code.length < 4 || code.length > 8) {
    throw new HttpsError("invalid-argument", "Enter the code we sent you.");
  }

  const ref = db.collection("otpChallenges").doc(challengeId(channel, target));
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "No code is pending. Please request a new one.");
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

  // Channel-specific correctness check.
  let correct;
  if (channel === "email") {
    correct = !!d.codeHash && safeEqualHex(hashOtp(code, d.salt), d.codeHash);
  } else {
    if (!d.sessionId) throw new HttpsError("failed-precondition", "Please request a new code.");
    correct = (await checkSmsOtp(d.sessionId, code)).ok;
  }

  if (!correct) {
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
  const uid = channel === "email" ? await resolveUserByEmail(target) : await resolveUserByPhone(target);
  const token = await admin.auth().createCustomToken(uid);
  await ref.delete().catch(() => {});
  return { token };
});

// Link a mobile number to the ALREADY-signed-in account (account unification).
// The user (signed in via email/Google) requests an SMS OTP to the mobile they
// want to attach (requestOtp channel:"sms"), then calls this with the code. We
// verify with 2Factor, ensure the number isn't on someone else's account, then
// attach it to THIS Firebase user — so a later SMS login lands on the same uid.
// Verifying proves ownership, so a mistyped digit can't hand the account to a
// stranger who happens to own that number.
exports.linkPhone = onCall(OTP_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  const { target } = resolveTarget("sms", request.data?.target);
  const code = String(request.data?.code || "").replace(/\D/g, "");
  if (code.length < 4 || code.length > 8) throw new HttpsError("invalid-argument", "Enter the code we sent you.");

  const ref = db.collection("otpChallenges").doc(challengeId("sms", target));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "No code is pending. Please request a new one.");
  const d = snap.data();
  const now = Date.now();
  if (d.consumed) throw new HttpsError("failed-precondition", "That code was already used. Please request a new one.");
  if (now > d.expiresAt) { await ref.delete().catch(() => {}); throw new HttpsError("deadline-exceeded", "That code has expired. Please request a new one."); }
  if ((d.attempts || 0) >= OTP_MAX_ATTEMPTS) { await ref.delete().catch(() => {}); throw new HttpsError("resource-exhausted", "Too many incorrect attempts. Please request a new code."); }
  if (!d.sessionId) throw new HttpsError("failed-precondition", "Please request a new code.");

  if (!(await checkSmsOtp(d.sessionId, code)).ok) {
    const attempts = (d.attempts || 0) + 1;
    await ref.set({ attempts }, { merge: true });
    const left = OTP_MAX_ATTEMPTS - attempts;
    if (left <= 0) { await ref.delete().catch(() => {}); throw new HttpsError("resource-exhausted", "Too many incorrect attempts. Please request a new code."); }
    throw new HttpsError("permission-denied", `Incorrect code. ${left} ${left === 1 ? "try" : "tries"} left.`);
  }

  // Never move a number that's already attached to a different account.
  try {
    const other = await admin.auth().getUserByPhoneNumber(target);
    if (other.uid !== uid) throw new HttpsError("already-exists", "This mobile number is already linked to another ProHippo account.");
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    if (e.code !== "auth/user-not-found") throw e;
  }

  await admin.auth().updateUser(uid, { phoneNumber: target });
  await ref.delete().catch(() => {});
  return { ok: true, phone: target };
});

/* ============================================================
   "Remember this device" — silent sign-in for the desktop connector

   The connector runs Firebase Auth in Electron's MAIN (Node) process, where the
   web SDK's persistence options are all browser-backed, so its session died with
   the process and the practitioner had to enter an emailed code on every single
   launch.

   Caching the Firebase refresh token isn't a real option: the JS SDK has no
   public way to restore a session from one in Node, so it would mean hand-rolling
   calls to Google's token endpoint and still minting a custom token at the end.
   Instead we issue an app-scoped device key and redeem it the same way an OTP is
   redeemed — validate, mint a custom token, signInWithCustomToken. Same shape as
   the code above, and unlike a refresh token it is revocable by us.

   Stored like the OTP codes: only a peppered, salted hash reaches Firestore, so a
   database leak yields nothing usable. The plaintext key lives solely in the OS
   keychain on the user's machine (Electron safeStorage).

   `deviceSessions` needs no security rule — firestore.rules denies everything
   outside users/{uid}, so only these Admin-SDK functions can reach it.

   NO ROTATION, deliberately. Rotating on every launch would mean a client that
   fails to persist the new key gets signed out, which is exactly the annoyance
   this feature exists to remove. The key sits in the OS keychain, so a stolen
   copy implies the machine is already compromised — at which point rotation buys
   very little. What we do instead: an idle expiry, and server-side revocation on
   sign-out.
   ============================================================ */

const DEVICE_IDLE_MS = 90 * 24 * 60 * 60 * 1000; // unused for 90 days → sign in again

function newDeviceKey() {
  return crypto.randomBytes(32).toString("base64url");
}
function hashDeviceKey(key, salt) {
  return crypto.createHash("sha256").update(`${otpPepper.value()}|dev|${salt}|${key}`).digest("hex");
}
// Doc id derived from the key, so redemption is one keyed read rather than a
// query — while the stored hash still can't be reversed into the key.
function deviceDocId(key) {
  return crypto.createHash("sha256").update(`${otpPepper.value()}|devid|${key}`).digest("hex");
}

const DEVICE_OPTS = { region: REGIONS, secrets: [otpPepper], maxInstances: 10 };

// Issue a device key for the signed-in user. Called by the connector straight
// after a successful interactive sign-in. Requires auth — this is the only one of
// the three that does.
exports.issueDeviceKey = onCall(DEVICE_OPTS, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");

  const key = newDeviceKey();
  const salt = crypto.randomBytes(16).toString("base64");
  const now = Date.now();
  await db.collection("deviceSessions").doc(deviceDocId(key)).set({
    uid,
    keyHash: hashDeviceKey(key, salt),
    salt,
    label: String(request.data?.label || "").slice(0, 80), // e.g. the hostname
    createdAt: now,
    lastUsedAt: now,
  });
  return { deviceKey: key, idleDays: DEVICE_IDLE_MS / 86400000 };
});

// Redeem a device key for a Firebase custom token. Unauthenticated by design —
// it IS a sign-in mechanism, exactly like verifyOtp.
exports.redeemDeviceKey = onCall(DEVICE_OPTS, async (request) => {
  const key = String(request.data?.deviceKey || "");
  if (!key) throw new HttpsError("invalid-argument", "deviceKey is required.");

  const ref = db.collection("deviceSessions").doc(deviceDocId(key));
  const snap = await ref.get();
  // Deliberately vague: a caller guessing keys learns nothing about which of
  // "wrong key" / "expired" / "revoked" applies.
  if (!snap.exists) throw new HttpsError("unauthenticated", "This device needs to sign in again.");

  const d = snap.data();
  const now = Date.now();
  if (!safeEqualHex(hashDeviceKey(key, d.salt), d.keyHash)) {
    throw new HttpsError("unauthenticated", "This device needs to sign in again.");
  }
  if (now - (d.lastUsedAt || d.createdAt || 0) > DEVICE_IDLE_MS) {
    await ref.delete().catch(() => {});
    throw new HttpsError("unauthenticated", "This device needs to sign in again.");
  }
  // Confirm the account still exists (deleted user → dead session).
  try {
    await admin.auth().getUser(d.uid);
  } catch {
    await ref.delete().catch(() => {});
    throw new HttpsError("unauthenticated", "This device needs to sign in again.");
  }

  await ref.set({ lastUsedAt: now }, { merge: true }); // rolling idle window
  const token = await admin.auth().createCustomToken(d.uid);
  return { token };
});

// Forget this device. Called on an explicit sign-out, so the key on disk stops
// working even if a copy of it survives. Holding the key is the authorisation —
// there is nothing to escalate by revoking your own session.
exports.revokeDeviceKey = onCall(DEVICE_OPTS, async (request) => {
  const key = String(request.data?.deviceKey || "");
  if (!key) return { ok: true }; // nothing stored client-side; not an error
  await db.collection("deviceSessions").doc(deviceDocId(key)).delete().catch(() => {});
  return { ok: true };
});

/* ============================================================
   Client email delivery (document requests)

   The app renders the message (src/messageTemplates.js) and stores it on the
   request; this function only DELIVERS what was stored, so what the
   practitioner previewed is exactly what the client receives.

   Two things are deliberately not taken from the caller:
     • the recipient — resolved server-side from the assessee record, so a
       stolen session can't use this as an open relay to arbitrary addresses
       without also writing to the practitioner's own assessee list;
     • the From address — fixed below.
   Reply-To is set to the practitioner's own email so client replies land in
   their inbox, not in a black hole.
   ============================================================ */

/* Client mail goes out on the SAME verified domain as the login OTPs.
 *
 * Best practice is a separate subdomain (send.prohippo.in), so that a client
 * marking a document request as spam can't dent the deliverability of the
 * emails people need in order to sign in. Resend's free plan allows only ONE
 * verified domain, though, and prohippo.in is already it — a second domain is a
 * paid upgrade that isn't worth it at this volume.
 *
 * The risk of sharing is low here: these are solicited emails to the firm's own
 * clients, who are expecting them, at a few per day. This is not cold outreach.
 * If deliverability ever wobbles, moving to a subdomain is this one line plus a
 * DNS verification.
 */
const CLIENT_EMAIL_FROM = "ProHippo <notices@prohippo.in>";

// Per-user send caps. A practising firm sends a handful of these a day; these
// bounds are far above normal use and exist purely so a bug or a stolen session
// can't turn the account into a mail cannon.
const MAIL_WINDOW_MS = 60 * 60 * 1000;
const MAIL_MAX_PER_WINDOW = 50;

const EMAIL_ADDR_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* Reserve one send against the user's rolling hourly window. Throws if the
   window is exhausted. Transactional so parallel sends can't both slip past
   the cap on the same read. */
async function reserveMailQuota(uid) {
  const ref = db.collection("clientMailQuota").doc(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const d = snap.exists ? snap.data() : {};
    const fresh = !d.windowStart || now - d.windowStart >= MAIL_WINDOW_MS;
    const count = fresh ? 0 : (d.count || 0);
    if (count >= MAIL_MAX_PER_WINDOW) {
      const mins = Math.ceil((MAIL_WINDOW_MS - (now - d.windowStart)) / 60000);
      throw new HttpsError(
        "resource-exhausted",
        `You've sent ${MAIL_MAX_PER_WINDOW} client emails in the last hour. Try again in about ${mins} minute${mins === 1 ? "" : "s"}.`
      );
    }
    tx.set(ref, { windowStart: fresh ? now : d.windowStart, count: count + 1, lastSentAt: now }, { merge: true });
  });
}

async function sendViaResend({ to, replyTo, subject, html, text }) {
  const payload = {
    from: CLIENT_EMAIL_FROM,
    to: [to],
    subject,
    html,
    text,
  };
  if (replyTo && EMAIL_ADDR_RE.test(replyTo)) payload.reply_to = replyTo;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey.value()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await res.text().catch(() => "");
  if (!res.ok) {
    console.error("Resend client send failed:", res.status, body.slice(0, 300));
    throw new HttpsError("unavailable", "We couldn't send the email right now. Please try again in a moment.");
  }
  try {
    return JSON.parse(body).id || "";
  } catch {
    return "";
  }
}

exports.sendClientMessage = onCall(
  { region: REGIONS, secrets: [resendApiKey], maxInstances: 10 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");

    const requestId = String(request.data?.requestId || "");
    const channel = String(request.data?.channel || "email");
    if (!requestId) throw new HttpsError("invalid-argument", "requestId is required.");
    // WhatsApp is delivered from the browser as a wa.me hand-off for now; only
    // email has a server-side sender. See docs/COMMUNICATIONS_DELIVERY.md.
    if (channel !== "email") throw new HttpsError("invalid-argument", "Only the email channel is sent server-side.");

    const reqRef = db.doc(`users/${uid}/docRequests/${requestId}`);
    const reqSnap = await reqRef.get();
    if (!reqSnap.exists) throw new HttpsError("not-found", "That document request no longer exists.");
    const docReq = reqSnap.data();

    const msg = docReq.message || {};
    if (!msg.subject || !msg.emailHtml) {
      throw new HttpsError("failed-precondition", "This request has no rendered message — open it and save it again.");
    }

    // Recipient comes from the assessee record, never from the caller.
    if (!docReq.assesseeId) {
      throw new HttpsError("failed-precondition", "This request isn't linked to an assessee.");
    }
    const aSnap = await db.doc(`users/${uid}/assessees/${docReq.assesseeId}`).get();
    if (!aSnap.exists) throw new HttpsError("failed-precondition", "The assessee for this request no longer exists.");
    const to = String(aSnap.data().email || "").trim();
    if (!EMAIL_ADDR_RE.test(to)) {
      throw new HttpsError("failed-precondition", "No valid email address on file for this assessee — add one on their profile.");
    }

    const profile = (await db.doc(`users/${uid}`).get()).data() || {};

    await reserveMailQuota(uid);

    let providerId = "";
    let sendError = null;
    try {
      providerId = await sendViaResend({
        to,
        replyTo: profile.email || "",
        subject: msg.subject,
        html: msg.emailHtml,
        text: msg.emailText || "",
      });
    } catch (e) {
      sendError = e;
    }

    const now = new Date().toISOString();
    // The communications row is the delivery log — one per send attempt,
    // successful or not, so a failure is visible rather than silent.
    const commRef = await db.collection(`users/${uid}/communications`).add({
      channel: "Email",
      to,
      assesseeId: docReq.assesseeId,
      assessee: docReq.assessee || "",
      requestId,
      subject: msg.subject,
      body: msg.emailText || "",
      template: "Document request",
      status: sendError ? "Failed" : "Queued",
      providerId,
      time: now,
      createdAt: now,
    });

    if (sendError) {
      await reqRef.set({ status: "failed", lastError: String(sendError.message || sendError).slice(0, 200) }, { merge: true });
      throw sendError;
    }

    // Index the provider's id so the webhook can find this row without a query.
    if (providerId) {
      await db.collection("emailEvents").doc(providerId).set({
        uid, commId: commRef.id, requestId, createdAt: now,
      });
    }

    await reqRef.set({
      status: "sent",
      sentAt: docReq.sentAt || now,
      lastSentAt: now,
      lastEmailId: providerId,
      lastError: "",
    }, { merge: true });

    return { ok: true, to, providerId, communicationId: commRef.id };
  }
);

/* ---------- Resend delivery webhook ----------
   Turns "we handed it to Resend" into "the client's server accepted it" /
   "it bounced" / "they opened it". That distinction is the whole point of
   sending server-side rather than through a mailto: link.

   Configure in the Resend dashboard → Webhooks, pointing at this function's
   URL, subscribed to the email.* events. Resend signs with Svix; the
   verification below is the Svix scheme implemented directly so the functions
   package needs no new dependency. */

const EMAIL_EVENT_STATUS = {
  "email.sent": "Sent",
  "email.delivered": "Delivered",
  "email.delivery_delayed": "Delayed",
  "email.opened": "Opened",
  "email.clicked": "Opened",
  "email.bounced": "Bounced",
  "email.complained": "Complained",
};

// Events can arrive out of order (an "opened" before its "delivered"). Rank
// them so a late-arriving earlier event never downgrades what we already know.
const STATUS_RANK = {
  Queued: 0, Sent: 1, Delayed: 2, Delivered: 3, Opened: 4,
  Bounced: 5, Complained: 5, Failed: 5,
};

const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

function verifySvixSignature(headers, rawBody) {
  const id = headers["svix-id"];
  const timestamp = headers["svix-timestamp"];
  const signature = headers["svix-signature"];
  if (!id || !timestamp || !signature) return false;

  const ts = Number(timestamp) * 1000;
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > WEBHOOK_TOLERANCE_MS) return false;

  const raw = resendWebhookSecret.value() || "";
  const key = Buffer.from(raw.startsWith("whsec_") ? raw.slice(6) : raw, "base64");
  const expected = crypto
    .createHmac("sha256", key)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest("base64");

  // The header carries a space-separated list of "v1,<sig>" — any one matching
  // is a pass (Svix sends several during a secret rotation).
  return String(signature).split(" ").some((part) => {
    const sig = part.split(",")[1];
    if (!sig) return false;
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

exports.resendWebhook = onRequest(
  // Single region on purpose: Resend calls one fixed URL, and unlike the
  // callables there is no older client pinned to us-central1.
  { region: PRIMARY_REGION, secrets: [resendWebhookSecret], maxInstances: 10 },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).send("Method not allowed"); return; }

    const rawBody = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body || {});
    if (!verifySvixSignature(req.headers, rawBody)) {
      console.warn("Resend webhook: signature verification failed");
      res.status(401).send("Invalid signature");
      return;
    }

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      res.status(400).send("Bad JSON");
      return;
    }

    const status = EMAIL_EVENT_STATUS[event?.type];
    const emailId = event?.data?.email_id || event?.data?.id || "";
    // 200 on anything we can't act on — an unknown event type or an id we never
    // recorded is not an error worth making Resend retry for hours.
    if (!status || !emailId) { res.status(200).send("ok"); return; }

    try {
      const idxSnap = await db.collection("emailEvents").doc(emailId).get();
      if (!idxSnap.exists) { res.status(200).send("ok"); return; }
      const { uid, commId } = idxSnap.data();

      const commRef = db.doc(`users/${uid}/communications/${commId}`);
      const commSnap = await commRef.get();
      if (commSnap.exists) {
        const current = commSnap.data().status || "Queued";
        if ((STATUS_RANK[status] ?? 0) > (STATUS_RANK[current] ?? 0)) {
          await commRef.set({ status, statusAt: new Date().toISOString() }, { merge: true });
        }
      }
    } catch (e) {
      // Log and still return 200: a retry storm won't fix a bad write here, and
      // the send itself already succeeded.
      console.error("Resend webhook handling failed:", e.message || e);
    }
    res.status(200).send("ok");
  }
);
