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

// job = { assesseeId, pan, label, scope, knowns }
// onEvent(evt) receives { assesseeId, phase, message, level } for the UI log.
async function runPool(jobs, onEvent, opts = {}) {
  const maxConcurrent = opts.maxConcurrent || POOL.maxConcurrent;
  const scope = opts.scope || "eproc";

  // One shared browser process; each job opens its own isolated context.
  const browser = await chromium.launch({
    headless: opts.headless === true, // default: visible, so the user can watch/step in
  });

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

      const emit = (phase, message, level = "info") =>
        onEvent && onEvent({ assesseeId: job.assesseeId, pan: job.pan, phase, message, level });

      try {
        emit("start", `Sync started (${scope})`);
        const r = await runPanSync({ context, job, scope, emit });
        results.push({ assesseeId: job.assesseeId, ok: true, ...r });
        emit("done", "Sync complete", "success");
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
