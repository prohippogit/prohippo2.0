// Ingest layer — pushes scraped portal data to the same Cloud Functions the
// extension uses. This is the ONLY place the connector talks to the backend
// about proceedings/notices, so if the fetch source ever moves to ERI/AR, only
// portalWorker.js changes — this module stays the same.
"use strict";

const { callable } = require("./firebaseClient");

// Mirrors the callables in functions/index.js.
async function ingestProceedings(assesseeId, proceedings) {
  return callable("ingestPortalProceedings", { assesseeId, proceedings });
}

async function ingestNotice(assesseeId, notice, storagePath, filename) {
  return callable("ingestPortalNotice", { assesseeId, notice, storagePath, filename });
}

async function ingestResponse(assesseeId, response) {
  return callable("ingestPortalResponse", { assesseeId, response });
}

async function ingestAppealForm(assesseeId, form) {
  return callable("ingestPortalAppealForm", { assesseeId, form });
}

module.exports = {
  ingestProceedings,
  ingestNotice,
  ingestResponse,
  ingestAppealForm,
};
