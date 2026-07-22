// Human-paced, randomised timing helpers.
//
// Ported from extension/portal-login.js. EVERY delay is drawn from a range —
// there are no fixed intervals anywhere in the sync path. Fixed cadences are
// the single easiest signal for the portal to fingerprint as automation, so
// randomisation here is a safety requirement, not a nicety.
"use strict";

// Inclusive random integer in [min, max].
function rand(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// Sleep a jittered number of milliseconds in [min, max].
function jsleep(min, max) {
  return new Promise((resolve) => setTimeout(resolve, rand(min, max)));
}

// Pacing profiles. `bg` = background workers (faster, no human watching);
// `fg` = the foreground/visible worker (paced slower to mimic a real user).
// Mirrors PACE/POLL in portal-login.js so the connector and the extension keep
// the same portal-facing rhythm.
const PACE = {
  betweenDocs: [120, 320], // gap between fetching successive PDFs/metadata
  bgPreLogout: [180, 360],
  bgPostLogout: [360, 620],
  fgPreLogout: [1200, 1800],
  fgPostLogout: [700, 1100],
};

const POLL = { min: 360, max: 680, firstMin: 800, firstMax: 1400 };

module.exports = { rand, jsleep, PACE, POLL };
