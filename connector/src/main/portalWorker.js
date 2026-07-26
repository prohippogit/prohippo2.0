// Per-PAN portal worker — the Playwright equivalent of the extension's
// portal-login.js + portal-net.js, running inside one isolated BrowserContext.
//
// The sequence, in order:
//
//   1. KNOWNS        Read what we already hold for this PAN (getSyncKnowns) so
//                    the fetch below is genuinely incremental. Kicked off before
//                    the login and awaited after it, so it costs no wall time.
//   2. LOGIN         The User ID → [confirm] → Password → Dashboard state
//                    machine, plus Dual Login and session-expiry handling.
//   3. SCOPE + DIFF  "all" | "eproc" | "appeals", FYA/FYI tabs, diffed against
//                    the knowns from step 1 so we fetch only what's new.
//   4. PDFs          Download only NEW documents, upload to Storage.
//   5. INGEST        ingestPortalProceedings / Notice / Response / AppealForm.
"use strict";

const fb = require("./firebaseClient");
const { withCredential } = require("./credentials");
const { login, startLogoutGuard } = require("./portalLogin");
const { syncPortalData } = require("./portalFetch");
const { makeTimer } = require("./timing");

// Log in the given context to the portal for one PAN, then run the scoped sync.
// Returns { proceedings, notices, responses, appeals, timing }.
async function runPanSync({ context, job, scope, emit }) {
  const page = await context.newPage();

  const summary = { proceedings: 0, notices: 0, responses: 0, appeals: 0 };
  // Shared stopwatch. Hung off the job the same way `knowns`/`scope` are, so the
  // fetch layer can charge its phases without threading a new parameter through
  // every signature.
  const timer = makeTimer();
  job.timer = timer;

  // ---- STEP 1: KNOWNS (started now, awaited after login) -------------------
  // Two Firestore equality queries — a few hundred milliseconds against a login
  // that takes seconds, so running them concurrently makes them free. If this
  // fails we fall back to an empty set: correct, just slower, and we say so.
  const knownsPromise = fb.getSyncKnowns(job.pan).catch((err) => {
    emit(
      "fetch",
      `Couldn't read what's already on file (${(err && err.message) || err}) — fetching everything this run`,
      "warn"
    );
    return null;
  });

  await withCredential(job.assesseeId, async (cred) => {
    // ---- STEP 2: LOGIN -----------------------------------------------------
    // cred.portalPassword stays in this closure only; never logged or stored.
    await timer.time("login", () => login(page, cred, emit));

    // Keep the portal's "disabled Back/Forward — Logout?" guard dismissed for
    // the whole sync. Installs one MutationObserver; no polling.
    const stopGuard = await startLogoutGuard(page);

    // ---- STEPS 3-5: SCOPED, INCREMENTAL FETCH + INGEST ---------------------
    try {
      job.knowns = (await knownsPromise) || job.knowns || {};
      Object.assign(summary, await syncPortalData(page, job, scope, emit, summary));
    } finally {
      await stopGuard();
    }
  });

  await page.close().catch(() => {});
  summary.timing = timer.report();
  return summary;
}

module.exports = { runPanSync };
