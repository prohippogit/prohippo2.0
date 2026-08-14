// Shared configuration for the connector.
//
// The Firebase project is the SAME one the web app and Cloud Functions use, so
// the connector calls the identical ingest / credential callables. Keep this in
// sync with ../../../src/firebaseConfig.js.
"use strict";

const fs = require("fs");
const path = require("path");

const firebaseConfig = {
  apiKey: "AIzaSyBgs1cgmwmF0OtT-2HzaPgXS1XuagUoDsU",
  authDomain: "prohippo2.firebaseapp.com",
  projectId: "prohippo2",
  storageBucket: "prohippo2.firebasestorage.app",
  messagingSenderId: "172465235057",
  appId: "1:172465235057:web:cb2718881728d4e8b467d0",
};

// Which region's copy of the callables this build talks to.
//
// asia-south1 (Mumbai) — co-located with Firestore. Every callable is deployed to
// both asia-south1 and us-central1 under the same name (see REGIONS in
// functions/index.js), and the Mumbai copies went live on 2026-07-26. This cuts
// both legs of every ingest call: the hop from the user's machine, and the
// functions' own Firestore round trips. The us-central1 copies stay deployed so
// connectors built before this change keep working. See docs/PERF_AND_REGION.md.
const FUNCTIONS_REGION = "asia-south1";

// The income-tax e-filing portal.
const PORTAL = {
  origin: "https://eportal.incometax.gov.in",
  loginPath: "/iec/foservices/#/login",
  dashboardHash: "#/dashboard",
};

// Worker pool. Keep the cap conservative — this is the single most important
// IP-safety lever. More than ~5 concurrent portal sessions from one home IP
// starts to look non-human. Do not raise without the user's explicit consent.
const POOL = {
  maxConcurrent: 5,
  // stagger the START of each worker so N sessions never appear in the same
  // instant. Randomised — never a fixed cadence.
  startStagger: { min: 1500, max: 4200 }, // ms between launching workers
};

/* DEADLINES.
 *
 * THE REASON THIS EXISTS: every portal call in this app is a `fetch` made
 * inside the page (see portalApi.js), and a browser fetch has no timeout. When
 * the portal stalled part-way through handing over a document — which it does —
 * nothing anywhere gave up. The call never returned, the PAN never finished,
 * the pool held its slot for ever, and the window sat at the same percentage
 * with a browser open behind it. From the outside that is indistinguishable
 * from a crashed app, and the only way out was to kill it.
 *
 * So every call now has a ceiling, and so does every PAN. They are deliberately
 * generous: the portal is genuinely slow, a rendered return is genuinely 11 MB
 * on a home connection, and a deadline that fires on a working sync is worse
 * than no deadline at all. These are "something has gone wrong" numbers, not
 * "this is taking a while" numbers.
 *
 * A call that times out is RETRIED once, after a jittered pause, before it is
 * given up on — a portal that stalls on one request usually answers the next.
 * Nothing here is destructive: every portal call this app makes is a read, and
 * a document it fails to fetch is simply fetched by the next sync. */
const TIMEOUTS = {
  api: 45000,        // one JSON service call
  doc: 90000,        // one document download by id
  binary: 150000,    // a rendered form or an intimation (can be tens of MB)
  retries: 1,        // one more go before a call is given up on
  retryPause: { min: 1200, max: 2800 },
  /* One PAN, end to end. A first sync of a heavy file — years of returns, a
     set of s.148 documents — runs into minutes legitimately, so this sits well
     past that; it is there to stop ONE assessee holding a pool slot for the
     rest of the evening, not to hurry anything along. */
  pan: 15 * 60 * 1000,
};

// Google sign-in (system-browser loopback flow) needs a Google OAuth "Desktop
// app" client. Its id + secret live in connector/google-oauth.json, which is
// git-ignored (never committed). Shape:
//   { "clientId": "....apps.googleusercontent.com", "clientSecret": "..." }
// Returns null when not configured (Google button then shows a setup hint).
function getGoogleOAuthConfig() {
  try {
    const p = path.join(__dirname, "..", "..", "google-oauth.json");
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    if (j && j.clientId && j.clientSecret) return { clientId: j.clientId, clientSecret: j.clientSecret };
  } catch { /* not configured */ }
  return null;
}

module.exports = { firebaseConfig, FUNCTIONS_REGION, PORTAL, POOL, TIMEOUTS, getGoogleOAuthConfig };
