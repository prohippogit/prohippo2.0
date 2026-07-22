// Per-PAN portal worker — the Playwright equivalent of the extension's
// portal-login.js + portal-net.js, running inside one isolated BrowserContext.
//
// PORTING PLAN (this is the scaffold — the marked steps port existing, working
// logic out of the extension rather than writing anything new):
//
//   1. LOGIN         ← extension/portal-login.js login state machine
//                      (enter loginId, password from the in-memory credential,
//                       handle the "Dual Login Detected" dialog, land on
//                       #/dashboard).
//   2. CAPTURE APIs  ← extension/portal-net.js. In the extension this runs in
//                      the MAIN world to observe the portal's own fetch/XHR.
//                      In Playwright we do the same with page.route / page.on
//                      ("response") to capture the e-Proceedings JSON, or call
//                      the JSON endpoints directly with the page's session
//                      cookies (page.request / context.request).
//   3. SCOPE + DIFF  ← the scoped/incremental logic already in portal-login.js
//                      (tryDirectApi): "all" | "eproc" | "appeals", FYA/FYI
//                      tabs, and the knowns (knownDins / knownByProc /
//                      knownResponseIds / knownActiveProcs) so we fetch only
//                      what's new.
//   4. PDFs          ← download only NEW documents (context.request.get on the
//                      document URL), upload to Storage, then call the ingest
//                      callables.
//   5. INGEST        ← ingest.js (ingestPortalProceedings / Notice / Response /
//                      AppealForm) — unchanged from the extension's contract.
"use strict";

const { PORTAL } = require("./config");
const { jsleep, PACE } = require("./pacing");
const { withCredential } = require("./credentials");
// const ingest = require("./ingest"); // wired in step 5

// Log in the given context to the portal for one PAN, then run the scoped sync.
// Returns a small summary { proceedings, notices, responses, appeals }.
async function runPanSync({ context, job, scope, emit }) {
  const page = await context.newPage();

  const summary = { proceedings: 0, notices: 0, responses: 0, appeals: 0 };

  await withCredential(job.assesseeId, async (cred) => {
    // ---- STEP 1: LOGIN (port from portal-login.js) ---------------------------
    emit("login", "Opening portal login");
    await page.goto(PORTAL.origin + PORTAL.loginPath, { waitUntil: "domcontentloaded" });
    await jsleep(...PACE.betweenDocs);

    // TODO(port): drive the login state machine from portal-login.js:
    //   - fill loginId = cred.loginId (PAN), continue
    //   - fill password = cred.password, submit
    //   - if "Dual Login Detected" dialog appears, click "Login Here"
    //   - wait until the SPA renders the dashboard (PORTAL.dashboardHash)
    // cred.password stays in this closure only; it is never logged or stored.
    emit("login", `TODO: authenticate ${job.pan} and reach dashboard`, "warn");

    // ---- STEP 2/3: CAPTURE + SCOPED DIFF (port from portal-net.js) -----------
    // TODO(port): using job.scope (${scope}) and job.knowns, fetch only new
    // e-Proceedings rows. Prefer context.request against the JSON endpoints with
    // the live session cookies over UI scraping; fall back to page.on("response")
    // capture. Space every call with jsleep(...PACE.betweenDocs).
    emit("fetch", `TODO: scoped fetch (${scope}) with incremental knowns`, "warn");

    // ---- STEP 4/5: DOWNLOAD NEW PDFs + INGEST --------------------------------
    // TODO(port): for each NEW document, context.request.get(url) -> upload to
    // Storage -> ingest.ingestPortalNotice(...); ingest proceedings/responses/
    // appeal forms via ingest.js. Increment `summary` counters as we go.
    emit("ingest", "TODO: download new PDFs and ingest", "warn");
  });

  await page.close().catch(() => {});
  return summary;
}

module.exports = { runPanSync };
