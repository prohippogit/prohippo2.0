/*
 * ProHippo — HTML to PDF, once.
 *
 * Extracted from computation.js when the WhatsApp document request needed the
 * same thing: a headless Chromium, a page cut off from the network, and an A4
 * PDF out of it. Two copies of a browser launch is two sets of flags, two
 * memory footprints and two places for a Chromium upgrade to break — and the
 * launch itself is the expensive part, so sharing one browser across both
 * features is also the faster arrangement.
 *
 * WHAT LIVES HERE: starting Chromium and rendering a page.
 * WHAT DOES NOT: what the document says. Each caller brings its own HTML,
 * footer, margins and fonts, because a computation of income and a letter to a
 * client have nothing in common but the renderer.
 */
"use strict";

/*
 * One browser per warm instance. Launching Chromium costs 1-2 seconds, and both
 * callers work in bursts — a practitioner generating a client's years, or a
 * document request going out to several members of a group — so paying that
 * once per instance rather than once per document is the difference between
 * "instant" and "why is this slow".
 */
let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const chromium = require("@sparticuz/chromium");
      const puppeteer = require("puppeteer-core");
      // No WebGL, no canvas acceleration. These documents are text, rules and
      // gradients; the graphics stack it would otherwise start costs memory we
      // would rather give to the page.
      chromium.setGraphicsMode = false;
      return puppeteer.launch({
        args: chromium.args,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
      });
    })().catch((err) => { browserPromise = null; throw err; });
  }
  const browser = await browserPromise;
  // A browser that died between invocations must not poison every later call.
  if (!browser.connected) { browserPromise = null; return getBrowser(); }
  return browser;
}

/*
 * Render one self-contained HTML document to an A4 PDF.
 *
 * THE PAGE HAS NO NETWORK. Every request except `data:` is aborted before it
 * leaves. Both documents are self-contained by construction — fonts and logos
 * travel as data URIs — and this makes that a guarantee rather than a
 * convention, so a stray URL fails loudly in review instead of quietly fetching
 * from somebody's document at render time.
 *
 * @param html     the complete document
 * @param footer   Chromium footer template, or "" for none. Rendered in its own
 *                 isolated document that inherits none of the page's styles.
 * @param margin   page margins; the default suits a letter, not a form
 * @param timeout  ms to wait for `load`
 */
async function renderHtmlToPdf(html, { footer = "", margin, timeout = 30000 } = {}) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (req.url().startsWith("data:") || req.url() === "about:blank") req.continue();
      else req.abort();
    });

    await page.setContent(html, { waitUntil: "load", timeout });
    // Without this, text can be measured and laid out against a fallback face
    // and then repainted in the real one, mid-render.
    await page.evaluateHandle("document.fonts.ready");

    return await page.pdf({
      format: "A4",
      printBackground: true, // without this every gradient and card renders white
      displayHeaderFooter: Boolean(footer),
      headerTemplate: "<div></div>",
      footerTemplate: footer || "<div></div>",
      margin: margin || { top: "12mm", right: "11mm", bottom: "16mm", left: "11mm" },
    });
  } finally {
    await page.close().catch(() => {});
  }
}

/* Which stage of a render failed, in words that tell the reader whether it is
   their problem or ours. A launch failure is a deployment problem and says so;
   a timeout is worth retrying; anything else is reported as it came. */
function classifyRenderError(err) {
  const detail = String((err && err.message) || err);
  if (/executablePath|ENOENT|spawn|Failed to launch|Target closed|Protocol error/i.test(detail)) {
    return { kind: "launch", detail };
  }
  if (/timeout|Navigation timeout/i.test(detail)) return { kind: "timeout", detail };
  return { kind: "other", detail };
}

module.exports = { getBrowser, renderHtmlToPdf, classifyRenderError };
