// Worker pool.
//
// Runs at most POOL.maxConcurrent PAN syncs at once. Each worker gets an
// isolated Playwright BrowserContext (own cookies/storage) so portal sessions
// never collide — the desktop equivalent of the portal's own Dual Login rule,
// but here every PAN is a truly separate session.
//
// Launches are STAGGERED with a randomised gap so N sessions never appear from
// the residential IP in the same instant. This staggering + the per-request
// jitter in pacing.js is what keeps the traffic looking human.
"use strict";

const { chromium } = require("playwright");
const fb = require("./firebaseClient");
const { POOL } = require("./config");
const { jsleep } = require("./pacing");
const { runPanSync } = require("./portalWorker");

// The portal sits behind a bot-filtering WAF that rejects obviously-automated
// browsers with a "Permission Denied!!" page. Two things trip it: the
// --enable-automation flag Playwright adds, and navigator.webdriver === true.
// We remove the flag at launch and mask the property per-context. We also
// prefer the user's REAL Google Chrome (channel: "chrome") over Playwright's
// bundled "Chrome for Testing" — a genuine Chrome fingerprint is far less likely
// to be flagged than the testing build.
const STEALTH_ARGS = ["--disable-blink-features=AutomationControlled"];
const IGNORE_DEFAULT_ARGS = ["--enable-automation"];

/* "Run hidden" means hidden, and we say so ourselves.
 *
 * Playwright's own `headless: true` only ever adds a BARE `--headless` — that
 * is still true in the current release, not just the version pinned here — and
 * what a bare flag means is then up to the browser it lands on. For Playwright's
 * bundled build that is the dedicated headless shell and it is unambiguous. For
 * the user's REAL Google Chrome, which this app deliberately prefers for its
 * fingerprint, it depends on the Chrome version: the old headless mode was
 * removed in Chrome 132, and a practitioner on Windows reported five browser
 * windows opening with the box ticked.
 *
 * So the mode is stated explicitly rather than inherited. `--headless=new` is
 * the mode every Chrome since 112 understands, and it wins over Playwright's
 * bare flag because our arguments are appended after its defaults.
 *
 * The off-screen position is a belt-and-braces, not a diagnosis: if some future
 * Chrome ignores the flag again, its windows open where nobody has to watch
 * them rather than in front of whoever is using the machine. A truly headless
 * browser has no window for it to apply to, so it costs nothing.
 */
const HIDDEN_ARGS = ["--headless=new", "--window-position=-32000,-32000"];

// Both the sync pool and the one-off "add assessee" login go through these two
// helpers, so a WAF workaround only ever has to be fixed in one place.
async function launchHardenedBrowser(headless) {
  const args = headless ? [...STEALTH_ARGS, ...HIDDEN_ARGS] : [...STEALTH_ARGS];
  const opts = { headless, args, ignoreDefaultArgs: IGNORE_DEFAULT_ARGS };
  let browser;
  let via = "chrome";
  try {
    browser = await chromium.launch({ ...opts, channel: "chrome" }); // real Google Chrome
  } catch {
    try {
      via = "bundled";
      browser = await chromium.launch(opts); // bundled Chromium (present in dev only)
    } catch {
      // Reached from a sync AND from adding an assessee, so the sentence
      // names the portal rather than either one of them.
      throw new Error(
        "Google Chrome is required to reach the income-tax portal. Please " +
        "install it from google.com/chrome, then try again."
      );
    }
  }
  /* WHAT STARTED, AND WHAT WE ASKED OF IT.
   *
   * Windows appearing with "Run hidden" ticked was reported on both Windows and
   * macOS, and could not be reproduced: a current Chromium honours even the bare
   * flag Playwright adds. So the next report has to arrive with evidence rather
   * than with a symptom — which browser (the user's Chrome, or the bundled
   * build), which version, what was asked, and the exact flags handed over. All
   * four are needed to tell "the flag was ignored" from "the flag never got
   * there". None of it is sensitive. */
  try {
    console.info(
      `[browser] ${via} · ${browser.version()} · hidden requested: ${Boolean(headless)} · ` +
      `args: ${args.join(" ")}`
    );
  } catch { /* a version we cannot read is not worth failing a sync over */ }
  return browser;
}

// One isolated session: its own cookie jar, and the automation signal the WAF
// checks masked before any page script runs.
async function newStealthContext(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    // A stable, ordinary desktop UA. Do NOT randomise the UA per-run — a
    // rotating fingerprint is MORE suspicious than a consistent one.
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  return context;
}

// job = { assesseeId, pan, label, scope, knowns }
// onEvent(evt) receives { assesseeId, phase, message, level } for the UI log.
async function runPool(jobs, onEvent, opts = {}) {
  const maxConcurrent = opts.maxConcurrent || POOL.maxConcurrent;
  // "all" is the default: with the incremental knowns in place it costs barely
  // more than "eproc" on an already-synced PAN (two extra list calls), and
  // choosing "eproc" quietly leaves filed Form 35s and the FYI tab unsynced.
  const scope = opts.scope || "all";

  // One shared browser process; each job opens its own isolated context.
  /* `!== false`, not `=== true`: a caller that forgets to pass the flag gets a
     HIDDEN browser rather than five visible windows. That exact strictness is
     what turned one missing key upstream into a practitioner watching browsers
     open across their screen. */
  const browser = await launchHardenedBrowser(opts.headless !== false);

  const queue = [...jobs];
  const results = [];
  let launched = 0;

  async function worker() {
    while (queue.length) {
      const job = queue.shift();
      if (!job) break;

      // Randomised launch stagger — spread session starts across the IP.
      if (launched > 0) await jsleep(POOL.startStagger.min, POOL.startStagger.max);
      launched++;

      const context = await newStealthContext(browser);

      const emit = (phase, message, level = "info", pct) =>
        onEvent && onEvent({ assesseeId: job.assesseeId, pan: job.pan, phase, message, level, pct });

      try {
        emit("start", `Sync started (${scope})`, "info", 3);
        const r = await runPanSync({ context, job, scope, emit });
        /* Stamped here rather than inside the fetch, because "synced" means the
           whole PAN came back clean — and because a PAN with nothing new to
           fetch reaches this line without any ingest having run. */
        const syncedAt = await fb.markSynced(job.assesseeId);
        results.push({ assesseeId: job.assesseeId, ok: true, syncedAt, ...r });
        if (syncedAt) emit("synced", syncedAt, "info");
        const parts = [];
        if (r.proceedings) parts.push(`${r.proceedings} proceedings`);
        if (r.notices) parts.push(`${r.notices} docs`);
        if (r.responses) parts.push(`${r.responses} replies`);
        if (r.appeals) parts.push(`${r.appeals} appeals`);
        if (r.returns) parts.push(`${r.returns} returns`);
        if (r.orders) parts.push(`${r.orders} CPC orders`);
        // Where the time actually went, per PAN. This is how the remaining
        // tuning calls (does the PDF bucket need moving to asia-south1? is the
        // per-document pacing earning its keep?) get settled with real numbers
        // from real practices instead of estimates.
        if (r.timing) {
          const secs = (r.timing.totalMs / 1000).toFixed(1);
          // The returns diagnostic rides with the timing, because the two
          // questions are the same one: a pass that re-downloads what it
          // already holds is slow BECAUSE it did not recognise it.
          const diag = r.returnsDiag ? `\n${r.returnsDiag}` : "";
          emit("timing", `${secs}s total — ${r.timing.line}${diag}`, "info");
        }
        /* Put the two heaviest phases on the visible "Done" line, not only in
           the tooltip. "The sync feels slow" is unanswerable without them, and a
           practitioner should not have to hover a row or open a console to find
           out that eleven of thirteen seconds went on one 11 MB document. */
        const heaviest = r.timing
          ? Object.entries(r.timing.buckets)
            .filter(([name]) => name !== "pacing")
            .sort((a, b) => b[1] - a[1])
            .slice(0, 2)
            .filter(([, ms]) => ms >= 1000)
            .map(([name, ms]) => `${name} ${(ms / 1000).toFixed(1)}s`)
          : [];
        const took = r.timing ? ` · ${(r.timing.totalMs / 1000).toFixed(1)}s` : "";
        const where = heaviest.length ? ` (${heaviest.join(", ")})` : "";
        emit("done", (parts.length ? `Done — ${parts.join(", ")}` : "Done — up to date") + took + where, "success", 100);
      } catch (err) {
        results.push({ assesseeId: job.assesseeId, ok: false, error: String(err && err.message || err) });
        emit("error", String(err && err.message || err), "error");
      } finally {
        await context.close().catch(() => {});
      }
    }
  }

  // Spin up min(cap, jobs) workers pulling from the shared queue.
  const n = Math.min(maxConcurrent, jobs.length);
  const workers = Array.from({ length: n }, () => worker());
  await Promise.all(workers);

  await browser.close().catch(() => {});
  return results;
}

module.exports = { runPool, launchHardenedBrowser, newStealthContext };
