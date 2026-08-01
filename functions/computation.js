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

const { FONT_FACE_CSS } = require("./fonts/montserrat.js");
const { PROHIPPO_LOGO_DATA_URI } = require("./assets/prohippoLogo.js");

// The template leaves this marker where the @font-face rules belong; the fonts
// live here rather than in the browser bundle so no user pays 42 KB of woff2 to
// load a page they may never generate a computation from.
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

// One browser per warm instance. Launching Chromium costs 1-2 seconds, and a
// practitioner working through a client's years generates several computations
// in a row — paying that once per instance rather than once per document is the
// difference between "instant" and "why is this slow".
let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const chromium = require("@sparticuz/chromium");
      const puppeteer = require("puppeteer-core");
      return puppeteer.launch({
        args: chromium.args,
        executablePath: await chromium.executablePath(),
        headless: true,
      });
    })().catch((err) => { browserPromise = null; throw err; });
  }
  const browser = await browserPromise;
  // A browser that died between invocations must not poison every later call.
  if (!browser.connected) { browserPromise = null; return getBrowser(); }
  return browser;
}

function register({ region, storageBucket, db }) {
  return onCall(
    { region, memory: "1GiB", timeoutSeconds: 120, maxInstances: 5 },
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

      const page = await (await getBrowser()).newPage();
      let pdf;
      try {
        // Cut the page off from the network before it loads. The template is
        // self-contained by construction (§13); this makes that a guarantee
        // rather than a convention, so a stray URL fails loudly in review
        // instead of quietly fetching from a user's document.
        await page.setRequestInterception(true);
        page.on("request", (req) => {
          if (req.url().startsWith("data:") || req.url() === "about:blank") req.continue();
          else req.abort();
        });

        await page.setContent(html.replace(FONT_SLOT, FONT_FACE_CSS), { waitUntil: "load", timeout: 30000 });
        await page.evaluateHandle("document.fonts.ready");

        pdf = await page.pdf({
          format: "A4",
          printBackground: true, // without this every gradient and card renders white
          displayHeaderFooter: true,
          headerTemplate: "<div></div>",
          footerTemplate: FOOTER(name, ay),
          margin: { top: "12mm", right: "11mm", bottom: "16mm", left: "11mm" },
        });
      } finally {
        await page.close().catch(() => {});
      }

      const storagePath = `users/${uid}/assessees/${assesseeId}/returns/${String(ay).replace(/[^A-Za-z0-9_-]/g, "")}/computation.pdf`;
      await admin.storage().bucket(storageBucket).file(storagePath).save(Buffer.from(pdf), {
        contentType: "application/pdf",
        // attachment => a browser handed this URL saves the file rather than
        // rendering it. The Returns tab fetches the blob and names it itself
        // (src/downloadFile.js); this covers a URL opened outside the app.
        contentDisposition: "attachment",
        metadata: { cacheControl: "private, max-age=0" },
      });

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
