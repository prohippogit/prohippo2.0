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

// Callable Cloud Functions live in us-central1 (see functions/index.js).
const FUNCTIONS_REGION = "us-central1";

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

module.exports = { firebaseConfig, FUNCTIONS_REGION, PORTAL, POOL, getGoogleOAuthConfig };
