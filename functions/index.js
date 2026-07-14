/*
 * ProHippo — AI notice parsing backend.
 *
 * Flow: Gemini Flash-Lite reads the notice PDF and returns structured JSON →
 * deterministic validation in code (PAN / AY / date rules) → if a critical
 * field is missing or invalid, the same PDF is retried once on a stronger
 * Gemini model. The extracted fields are returned to the app, where the
 * practitioner reviews them before anything is saved.
 *
 * The Gemini API key is stored as a Firebase secret (GEMINI_API_KEY) and
 * never reaches the browser.
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const geminiApiKey = defineSecret("GEMINI_API_KEY");

// Model IDs are config, not code — swap them here if Google renames a model.
// To list the models your key can use, run:
//   curl "https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY"
const PRIMARY_MODEL = "gemini-3.1-flash-lite";
const ESCALATION_MODEL = "gemini-3.1-flash";

const MAX_PDF_BYTES = 9 * 1024 * 1024; // callable request limit is 10 MB

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const AY_RE = /^(\d{4})\s*[-–/]\s*(\d{2}|\d{4})$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const EXTRACTION_PROMPT = `You are reading an Indian Income Tax Department notice (scrutiny notice, demand notice, penalty notice, or appeal/hearing notice from CIT(A) or ITAT).

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

async function callGemini(model, apiKey, pdfBase64) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: "application/pdf", data: pdfBase64 } },
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
    const pdfBase64 = request.data?.pdfBase64;
    if (typeof pdfBase64 !== "string" || pdfBase64.length < 100) {
      throw new HttpsError("invalid-argument", "Send the notice PDF as base64 in { pdfBase64 }.");
    }
    if (pdfBase64.length > (MAX_PDF_BYTES * 4) / 3) {
      throw new HttpsError("invalid-argument", "PDF is too large — maximum 9 MB.");
    }

    const apiKey = geminiApiKey.value();

    const primaryRaw = await callGemini(PRIMARY_MODEL, apiKey, pdfBase64);
    let result = validate(primaryRaw);
    let modelUsed = PRIMARY_MODEL;
    let escalated = false;

    if (result.criticalMissing.length > 0) {
      escalated = true;
      try {
        const strongRaw = await callGemini(ESCALATION_MODEL, apiKey, pdfBase64);
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
