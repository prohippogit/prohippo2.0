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
const { POOL } = require("./config");
const { rand, jsleep } = require("./pacing");
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

async function launchHardenedBrowser(headless) {
  const opts = { headless, args: STEALTH_ARGS, ignoreDefaultArgs: IGNORE_DEFAULT_ARGS };
  try {
    return await chromium.launch({ ...opts, channel: "chrome" }); // real Google Chrome
  } catch {
    return await chromium.launch(opts); // fall back to bundled Chromium
  }
}

// job = { assesseeId, pan, label, scope, knowns }
// onEvent(evt) receives { assesseeId, phase, message, level } for the UI log.
async function runPool(jobs, onEvent, opts = {}) {
  const maxConcurrent = opts.maxConcurrent || POOL.maxConcurrent;
  const scope = opts.scope || "eproc";

  // One shared browser process; each job opens its own isolated context.
  const browser = await launchHardenedBrowser(opts.headless === true);

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

      const context = await browser.newContext({
        viewport: { width: 1280, height: 860 },
        // A stable, ordinary desktop UA. Do NOT randomise the UA per-run — a
        // rotating fingerprint is MORE suspicious than a consistent one.
      });
      // Mask the automation signal the WAF checks. Runs before any page script.
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      });

      const emit = (phase, message, level = "info", pct) =>
        onEvent && onEvent({ assesseeId: job.assesseeId, pan: job.pan, phase, message, level, pct });

      try {
        emit("start", `Sync started (${scope})`, "info", 3);
        const r = await runPanSync({ context, job, scope, emit });
        results.push({ assesseeId: job.assesseeId, ok: true, ...r });
        const parts = [];
        if (r.proceedings) parts.push(`${r.proceedings} proceedings`);
        if (r.notices) parts.push(`${r.notices} docs`);
        if (r.responses) parts.push(`${r.responses} replies`);
        if (r.appeals) parts.push(`${r.appeals} appeals`);
        emit("done", parts.length ? `Done — ${parts.join(", ")}` : "Done — up to date", "success", 100);
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

module.exports = { runPool };
