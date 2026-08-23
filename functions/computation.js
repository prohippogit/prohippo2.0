// Computation of Income — HTML → PDF.
//
// docs/computation-spec.md §13. The client builds the whole document (mapping,
// validation, HTML) and posts the finished markup here; this function's only
// job is to turn it into a PDF that looks the way the design says it looks.
//
// WHY A SERVER CALL AT ALL. The design is gradients, rounded cards, decorative
// circles and print-safe page breaks. Reproducing that in a drawing API would be
// a second renderer to keep in step with the first, and §2's "one renderer,
// never forked" applies to output targets as much as to forms. Chromium renders
// the same HTML the practitioner could preview in their own browser.
//
// WHAT THIS FUNCTION DOES NOT DO. It never sees the ITR JSON, maps nothing, and
// decides nothing about the document's contents. Given the same HTML it produces
// the same PDF. The "no tax engine on the server" boundary holds.
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("node:crypto");

const { fontFaceFor } = require("./fonts");
const { PROHIPPO_LOGO_DATA_URI } = require("./assets/prohippoLogo.js");

// Where the @font-face rules belong, IF THE PAGE ARRIVES WITHOUT THEM (§14).
//
// A current client inlines its own faces and the page reaches here complete, so
// this replace finds nothing and does nothing. That is the arrangement, not an
// accident: the browser and this function deploy separately, and every font
// fault this feature has had came out of that gap — a document that carries its
// own faces cannot be set in the wrong one by a function that is a version
// behind. What remains here is the fallback for a client old enough to leave
// the slot empty.
//
// EVERY family goes in when it is used, whatever theme the document was built
// in. The request still carries a `theme` and this function still ignores it
// for the fonts: narrowing by it is what set the first curvy computation in
// Liberation Sans. See fonts/index.js.
const FONT_SLOT = "/*__COMPUTATION_FONT_FACE__*/";

// Chromium renders header/footer templates in their own isolated document: they
// inherit none of the page's styles, cannot reach the network, and default to
// zero font-size. So everything here is inline, absolute, and self-contained —
// including the mark, which travels as a data URI.
//
// Left: the ProHippo attribution, on every page. Right: which document this is
// and where you are in it. Font is the system sans rather than the embedded
// Montserrat, because @font-face in a footer template is not reliably applied
// across Chromium versions and a footer silently falling back mid-print is
// worse than one that never claimed the face to begin with.
const FOOTER = (name, ay) => `
<div style="width:100%;padding:0 11mm;font-family:'Segoe UI',Arial,sans-serif;font-size:7pt;color:#8A93A3;
            display:flex;align-items:center;justify-content:space-between;">
  <span style="display:flex;align-items:center;gap:4px;white-space:nowrap;">
    Generated from
    <img src="${PROHIPPO_LOGO_DATA_URI}" alt="ProHippo" style="height:6.5mm;width:auto;display:block;">
  </span>
  <span style="white-space:nowrap;">
    Computation of Total Income · ${escapeHtml(name)} · A.Y. ${escapeHtml(ay)} ·
    Page <span class="pageNumber"></span> of <span class="totalPages"></span>
  </span>
</div>`;

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* The browser and the page render live in htmlPdf.js — the WhatsApp document
   request needs exactly the same thing, and two Chromium launches would be two
   sets of flags and two memory footprints for one job. What this file keeps is
   everything specific to a computation: its footer, its fonts, its margins. */
const { renderHtmlToPdf, classifyRenderError } = require("./htmlPdf");

/* Turn any failure into an HttpsError.
 *
 * This matters more than it looks. An unhandled throw inside a callable reaches
 * the browser as `internal` with the message stripped — Firebase does that
 * deliberately, so a stack trace cannot leak. The practitioner then sees
 * "internal" and the person debugging it sees nothing at all.
 *
 * HttpsError messages ARE delivered, so anything we can say safely, we say. The
 * full error still goes to the function log for the cases we cannot summarise.
 */
function renderFailure(err, stage) {
  const { kind, detail } = classifyRenderError(err);
  console.error(`renderComputationPdf failed at ${stage}:`, err);

  if (kind === "launch") {
    return new HttpsError(
      "internal",
      `The PDF renderer could not start (${stage}). This is a deployment problem, not a problem with the return — ` +
      `redeploy the functions and try again. Detail: ${detail.slice(0, 200)}`
    );
  }
  if (kind === "timeout") {
    return new HttpsError("deadline-exceeded", `Rendering the computation took too long (${stage}). Please try again.`);
  }
  return new HttpsError("internal", `Couldn't render the computation (${stage}): ${detail.slice(0, 200)}`);
}

function register({ region, storageBucket, db }) {
  return onCall(
    { region, memory: "2GiB", timeoutSeconds: 180, maxInstances: 5 },
    async (request) => {
      const uid = request.auth?.uid;
      if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
      const { assesseeId, ay, html } = request.data || {};
      if (!assesseeId || !ay || typeof html !== "string" || !html.trim()) {
        throw new HttpsError("invalid-argument", "assesseeId, ay and html are required.");
      }
      // A computation for one year is tens of kilobytes. Anything past this is
      // not a document we built.
      if (html.length > 2 * 1024 * 1024) {
        throw new HttpsError("invalid-argument", "That document is too large to render.");
      }

      const aSnap = await db.doc(`users/${uid}/assessees/${assesseeId}`).get();
      const a = aSnap.exists ? aSnap.data() : {};
      const name = a.name || "";
      const pan = (a.pan || "").toUpperCase();

      /* The page is cut off from the network inside renderHtmlToPdf. The
         template is self-contained by construction (§13); that makes it a
         guarantee rather than a convention, so a stray URL fails loudly in
         review instead of quietly fetching from a user's document. */
      let pdf;
      try {
        pdf = await renderHtmlToPdf(html.replace(FONT_SLOT, fontFaceFor()), {
          footer: FOOTER(name, ay),
          margin: { top: "12mm", right: "11mm", bottom: "16mm", left: "11mm" },
        });
      } catch (err) {
        throw renderFailure(err, "rendering the page");
      }

      const storagePath = `users/${uid}/assessees/${assesseeId}/returns/${String(ay).replace(/[^A-Za-z0-9_-]/g, "")}/computation.pdf`;
      try {
        await admin.storage().bucket(storageBucket).file(storagePath).save(Buffer.from(pdf), {
          contentType: "application/pdf",
          // attachment => a browser handed this URL saves the file rather than
          // rendering it. The Returns tab fetches the blob and names it itself
          // (src/downloadFile.js); this covers a URL opened outside the app.
          contentDisposition: "attachment",
          metadata: { cacheControl: "private, max-age=0" },
        });
      } catch (err) {
        throw renderFailure(err, "saving the document");
      }

      // Record it on the return, so the Returns tab can offer the generated
      // document again without re-rendering.
      if (pan) {
        const ayLabel = /^\d{4}$/.test(String(ay))
          ? `${ay}-${String((Number(ay) + 1) % 100).padStart(2, "0")}`
          : String(ay);
        const docId = "ret_" + crypto.createHash("sha1").update(`${pan}|${ayLabel}`).digest("hex").slice(0, 20);
        await db.doc(`users/${uid}/returns/${docId}`)
          .set({ computationPdfPath: storagePath, computationGeneratedAt: new Date().toISOString() }, { merge: true })
          .catch(() => { /* the PDF exists either way; the pointer is a convenience */ });
      }

      return { ok: true, storagePath, bytes: pdf.length };
    }
  );
}

module.exports = { register };
