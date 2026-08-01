// Filed ITRs + CPC intimations and rectification orders, for every assessment
// year the portal holds.
//
// This is the cheapest pass in the whole sync. `itrStatusService` returns EVERY
// assessment year in a single call — the return, its acknowledgement number,
// its demand/refund position and its full CPC activity timeline — so there is
// no per-year list call to make. Everything after that is per-document.
//
// What we pull for each return:
//
//   returns/downloadfile          the ITR JSON, exactly as filed
//   returns/pdf                   the ITR-V / acknowledgement
//   returns/preview/{ay}          the filed return itself, fully rendered
//   document/intimation           the s.143(1) intimation and any s.154
//                                 rectification order, decrypted on the way in
//
// SIZE, AND WHY THE BIG ONE HAS A WINDOW. The rendered return is 10-12 MB a year
// against a few hundred KB for everything else — downloaded from the portal AND
// uploaded to Storage, so it costs twice over on a residential line. Ten years
// of history for one client is over 200 MB of traffic to fetch documents that a
// practitioner opens perhaps once.
//
// An earlier version rationed it: a few per run, backfilling the whole history
// over successive syncs. That was worse than it sounds. It made EVERY sync slow
// rather than one, and gave no answer to "when does this stop?" — which is
// exactly what a practitioner asks after the third slow run.
//
// So the sync fetches the rendered form only for the FORM_SYNC_RECENT_YEARS most
// recent assessment years. Those are the ones under assessment, under
// rectification, or being compared against this year's filing. Once they are on
// file the pass fetches nothing at all, run after run, and a full sync is back
// to one list call per PAN. Older years are one click away on the Returns tab —
// "Fetch form" pulls any single year on demand, which is the right shape for a
// document that gets opened once a year.
//
// Everything else here — the JSON, the ITR-V, the CPC orders — is small, is
// fetched for every year, and is never deferred. The Computation of Total Income
// reads the JSON, not the rendered form, so every year can produce a computation
// whether or not its form PDF was synced.
//
// This all rests on `knownFormAcks` being tracked separately from
// `knownAckNums`: a return can be on file with its form deliberately absent, and
// the next sync must be able to tell that apart from a return it has never seen.
//
// ORDERS. Every activity row carries a `commRefNo` inside its `activityTxt`
// blob, and that reference is the `refno` the document endpoint wants. The
// portal's own bundle tells us which statuses actually have a document behind
// them (the `dnlIntOrdr` action) — that list is ORDER_ACTIVITIES below. Codes in
// the 60s are s.143(1) intimations; the 70s (and 613) are s.154 rectification
// orders. Reading the list off the portal rather than guessing from the status
// text means a new CPC status shows up as "no order" rather than a wrong label.
"use strict";

const { jsleep, PACE } = require("./pacing");
const { PATHS, ITR_FORM, apiCall, postBinary } = require("./portalApi");
const { ingestSyncMessage } = require("./ingest");
const { derivePassword, unlockPdf } = require("./pdfUnlock");

const MAX_PDF_BYTES = 25 * 1024 * 1024;

// How many of the most recent assessment years get their rendered form pulled by
// a sync. Two covers the year under assessment and the one before it — the pair
// a practitioner actually has open. Older years are fetched on demand.
//
// Raising this makes the FIRST sync longer for every client and does not change
// the steady state; it does not spread the cost over later runs, because there
// is no backfill queue any more. If a practice wants its whole history on file,
// the Returns tab's "Fetch form" button is the tool for that — it pulls one
// named year while they wait for that year, rather than all years while they
// wait for everything.
const FORM_SYNC_RECENT_YEARS = 2;

// itrActivityCd → the section the resulting document is issued under. Taken
// from the statuses the portal marks with a `dnlIntOrdr` download action.
const ORDER_ACTIVITIES = {
  61: "143(1)", // processed, demand determined
  62: "143(1)", // processed, refund determined
  63: "143(1)", // processed, no demand no refund
  64: "143(1)", // processed, refund fully adjusted
  65: "143(1)", // processed, refund partly adjusted
  71: "154", // rectification processed, demand due
  72: "154", // rectification processed, refund due
  73: "154", // rectification processed, no refund due
  74: "154", // rectification processed, refund fully adjusted
  75: "154", // rectification processed, refund partly adjusted
  613: "154", // rectification processed, refund partly adjusted (later variant)
};

// The document endpoint only serves orders from AY 2017-18 onward. Before that
// the portal routes the user through a request-and-email flow instead, which we
// cannot complete unattended — so we record the order and say why it is absent
// rather than silently showing nothing.
const DIRECT_DOWNLOAD_FROM_AY = 2017;

const NO_CLOCK = { time: (_name, fn) => fn(), add: () => {} };

/* Run ingests one behind the fetches instead of in lockstep with them.
 *
 * Uploading a year's documents to Storage and asking the portal for the next
 * year's are unrelated jobs on unrelated connections, but the loop used to wait
 * for the first before starting the second. On a real practice's numbers that
 * was 28 seconds of a 110-second sync spent with the portal side sitting idle.
 *
 * Exactly one ingest is allowed in flight: enough to hide the upload behind the
 * next fetch, and no more, because each pending payload holds an 11 MB document
 * in memory and five of these workers run at once. A failed ingest is reported
 * and does not stop the pass — same contract as before, since the call was
 * already best-effort.
 */
function ingestQueue(emit) {
  let inFlight = null;
  const settle = (p) => p.catch((err) => {
    emit("returns", `Couldn't save one year's documents (${(err && err.message) || err})`, "warn");
  });
  return {
    push(fn) {
      const wait = inFlight || Promise.resolve();
      inFlight = settle(wait.then(fn));
      return wait; // callers await the PREVIOUS one, never their own
    },
    drain() {
      return inFlight || Promise.resolve();
    },
  };
}

// "Tue Nov 25 14:16:09 IST 2025" → "2025-11-25". This is Java's default
// Date.toString(), which JS cannot parse — the timezone abbreviation defeats
// Date.parse on every engine. Pulling the fields out by hand is the only
// reliable read, and the clock time is not information we keep anyway.
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function javaDate(s) {
  const m = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+[\d:]+\s+\S+\s+(\d{4})$/.exec(String(s || "").trim());
  if (!m) return "";
  const mo = MONTHS[m[1].toLowerCase()];
  if (!mo) return "";
  return `${m[3]}-${String(mo).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
}

// Activity rows carry their detail as a JSON *string* inside the row. A row
// without one is normal (most status changes have no detail), so a parse
// failure is an empty object, never an error.
function activityDetail(row) {
  try {
    const parsed = JSON.parse(row && row.activityTxt);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Pull the date of birth / incorporation out of a filed return. Individuals
// carry it under PersonalInfo, non-individuals under the entity block — the key
// differs per form, so we look in all the places rather than branching on form
// type, which would need updating for every new ITR.
function dobFromItrJson(json) {
  if (!json || typeof json !== "object") return "";
  let found = "";
  const KEYS = ["DateOfBirth", "DOB", "DateOFFormOrIncorp", "DateOfIncorporation", "FormationDate"];
  const walk = (node, depth) => {
    if (found || !node || typeof node !== "object" || depth > 8) return;
    for (const [k, v] of Object.entries(node)) {
      if (found) return;
      if (KEYS.includes(k) && typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) { found = v; return; }
      if (v && typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(json, 0);
  return found;
}

// Decrypt an order PDF in place. CPC locks every one of them with
// PAN-lowercase + DDMMYYYY; see pdfUnlock.js. A failure is not fatal — we keep
// the encrypted file and flag it, so the practitioner still has the document
// and the Returns tab can offer to unlock it once the date of birth is known.
async function unlockOrder(got, dobCandidates, pan) {
  const passwords = dobCandidates.map((d) => derivePassword(pan, d)).filter(Boolean);
  const res = await unlockPdf(got.base64, passwords);
  if (res.ok) return { base64: res.base64, bytes: res.bytes, locked: false, lockReason: "" };
  if (res.reason === "not-encrypted") return { base64: got.base64, bytes: got.bytes, locked: false, lockReason: "" };
  return { base64: got.base64, bytes: got.bytes, locked: true, lockReason: res.reason };
}

// Every filed return for one PAN, plus its intimations and rectification
// orders. Incremental against job.knowns: a return whose acknowledgement we
// already hold is skipped unless its timeline has grown a new order.
async function syncReturns(page, job, pan, summary, emit) {
  const t = (job && job.timer) || NO_CLOCK;
  const knownAcks = new Set((job.knowns.knownAckNums || []).map((x) => String(x)));
  const knownOrders = new Set((job.knowns.knownOrderRefs || []).map((x) => String(x)));
  const knownForms = new Set((job.knowns.knownFormAcks || []).map((x) => String(x)));
  // Orders we hold but could not decrypt. Retrying one is the repair path once a
  // date of birth is on file — and pure waste until then, because the password
  // is derived from that date and nothing else.
  const lockedRefs = new Set((job.knowns.lockedOrderRefs || []).map((x) => String(x)));
  let fetched = 0; // anything this run actually pulled, for the closing line
  const ingests = ingestQueue(emit);

  emit("returns", "Fetching filed returns…", "info", 88);

  let list;
  try {
    const res = await t.time("returns-list", () => apiCall(page, {
      path: PATHS.ITR_STATUS,
      serviceName: "itrStatusService",
      payload: { header: ITR_FORM, serviceName: "itrStatusService", entityNum: pan },
    }));
    list = Array.isArray(res.json) ? res.json : [];
  } catch {
    return; // best-effort, like the appeals pass — never fail a whole sync here
  }
  if (!list.length) { emit("returns", "No returns filed on the portal"); return; }

  // Newest year first — the window below is "the first N of these", read off the
  // portal's own list rather than computed from the clock, so a practice syncing
  // in April and one syncing in March get the same answer.
  list.sort((x, y) => Number((y && y.assmentYear) || 0) - Number((x && x.assmentYear) || 0));
  let formsOnDemand = 0;

  // Date of birth / incorporation, for the order passwords. job.dob comes from
  // the assessee record; anything a return tells us is added as we go, so a
  // practice that never filled the field in still gets unlocked PDFs.
  const dobCandidates = [];
  const addDob = (d) => { if (d && !dobCandidates.includes(d)) dobCandidates.push(d); };
  addDob(job.dob);

  for (let i = 0; i < list.length; i++) {
    const r = list[i] || {};
    const ackNum = String(r.ackNum || "").trim();
    const ay = String(r.assmentYear || "").trim();
    if (!ackNum || !ay) continue;

    const isNew = !knownAcks.has(ackNum);
    // The form is tracked on its own, so a year that has its JSON but not its
    // form can still be completed without re-fetching everything else.
    const needsForm = !knownForms.has(ackNum) && i < FORM_SYNC_RECENT_YEARS;
    if (!knownForms.has(ackNum) && !needsForm) formsOnDemand += 1;

    // Only announce a year we are actually going to do something about. A line
    // per year on a run with nothing to do is what makes an instant pass look
    // like a slow one.
    if (isNew || needsForm) {
      emit("returns", `A.Y. ${ay}-${String((Number(ay) + 1) % 100).padStart(2, "0")} — ${i + 1}/${list.length}`, "info", 88);
    }

    // ---- the return itself (only once, it never changes after filing) ------
    let itrJson = null;
    let ackPdf = null;
    let formPdf = null;
    if (isNew) {
      const got = await t.time("itr-json", () => apiCall(page, {
        path: PATHS.ITR_DOWNLOAD_FILE, serviceName: "NA",
        payload: { ackNum, loggedInUserId: pan },
      }));
      if (got && got.ok && got.json) itrJson = got.json;
      await t.time("pacing", () => jsleep(...PACE.betweenDocs));

      const pdf = await t.time("itr-ack", () => postBinary(page, {
        path: PATHS.ITR_PDF, serviceName: "NA",
        payload: { ackNum, ay, loggedInUserId: pan },
      }));
      if (pdf && pdf.ok && pdf.bytes && pdf.bytes <= MAX_PDF_BYTES) ackPdf = pdf;
      await t.time("pacing", () => jsleep(...PACE.betweenDocs));
    }

    // The filed return itself, fully rendered — by far the largest thing this
    // sync fetches, and the one item that is rationed (see the note at the top
    // of this file). Outside the `isNew` branch on purpose: a year recorded on
    // an earlier run with its form deferred is finished off here without
    // re-fetching anything else. Also capped by size: an implausibly large
    // document is skipped rather than allowed to stall the sync.
    if (needsForm) {
      fetched += 1;
      const form = await t.time("itr-form", () => postBinary(page, {
        path: PATHS.ITR_PREVIEW + encodeURIComponent(ay),
        serviceName: "NA",
        payload: { ackNum, loggedInUserId: pan },
        extraHeaders: { ackNum: String(ackNum) },
      }));
      if (form && form.ok && form.bytes && form.bytes <= MAX_PDF_BYTES) formPdf = form;
      await t.time("pacing", () => jsleep(...PACE.betweenDocs));
    }
    addDob(dobFromItrJson(itrJson));

    // ---- intimations and rectification orders ------------------------------
    const orders = [];
    for (const row of r.itrPanDetlList || []) {
      const section = ORDER_ACTIVITIES[Number(row && row.itrActivityCd)];
      if (!section) continue;
      const detail = activityDetail(row);
      const refNo = String(detail.commRefNo || "").trim();
      if (!refNo || knownOrders.has(refNo)) continue;

      // Already downloaded, still encrypted, and we have no date of birth to
      // build a password from: re-downloading it would end in exactly the same
      // place. Leave it as it stands — the Returns tab already asks for the
      // date of birth, and the next sync after that arrives will unlock it.
      if (lockedRefs.has(refNo) && !dobCandidates.length) continue;

      const order = {
        commRefNo: refNo,
        section,
        statusDesc: row.statusDesc || "",
        activityCd: String(row.itrActivityCd || ""),
        orderDate: javaDate(detail.orderDt) || javaDate(detail.intimationDt) || "",
        emailedOn: javaDate(detail.emailDt) || "",
        demand: detail.computedDemndAmt != null ? String(detail.computedDemndAmt) : "",
        refund: detail.computedRefndAmt != null ? String(detail.computedRefndAmt) : "",
        contentBase64: null,
        locked: false,
        lockReason: "",
      };

      if (Number(ay) < DIRECT_DOWNLOAD_FROM_AY) {
        // The portal itself will not serve these directly; it opens a request
        // form and emails the order out. Record it so the year does not look
        // empty, and say why there is no file.
        order.lockReason = "request-only";
        orders.push(order);
        continue;
      }

      const got = await t.time("order-pdf", () => postBinary(page, {
        path: PATHS.DOC_INTIMATION, serviceName: "NA",
        payload: { refno: refNo, year: ay, entityNum: pan },
      }));
      fetched += 1;
      if (got && got.ok && got.bytes && got.bytes <= MAX_PDF_BYTES) {
        const unlocked = await t.time("order-unlock", () => unlockOrder(got, dobCandidates, pan));
        order.contentBase64 = unlocked.base64;
        order.bytes = unlocked.bytes;
        order.locked = unlocked.locked;
        order.lockReason = unlocked.lockReason;
      } else {
        order.lockReason = "unavailable";
      }
      orders.push(order);
      summary.orders = (summary.orders || 0) + 1;
      await t.time("pacing", () => jsleep(...PACE.betweenDocs));
    }

    // A return we already hold, with no new order and no form to attach, is
    // nothing to say.
    if (!isNew && !orders.length && !formPdf) continue;

    // Hand the payload to the queue and carry on. The wait here is for the
    // PREVIOUS year's upload, which has had this year's fetch to finish in.
    await t.time("ingest", () => ingests.push(() => ingestSyncMessage({
      assesseeId: job.assesseeId,
      kind: "return",
      return: {
        pan,
        ay,
        ackNum,
        formTypeCd: r.formTypeCd || "",
        filingTypeCd: r.filingTypeCd || "",
        filedOn: r.ackDt || null,
        efileStatus: r.efileStatus || "",
        statusDesc: (r.itrPanDetlList && r.itrPanDetlList[0] && r.itrPanDetlList[0].statusDesc) || "",
        verified: r.verStatus === "Y",
        verifiedMode: r.verMode || "",
        verifiedOn: r.verDt || null,
        demandAmt: r.demandAmt || "",
        refundAmt: r.refundAmt || "",
        computedDemndAmt: r.computedDemndAmt || "",
        computedRefndAmt: r.computedRefndAmt || "",
        submitBy: r.submitBy || "",
        timeline: (r.itrPanDetlList || []).map((row) => ({
          activityCd: String(row.itrActivityCd || ""),
          statusDesc: row.statusDesc || "",
          activityDt: row.activityDt || null,
        })),
        itrJson: isNew ? itrJson : null,
        ackPdfBase64: ackPdf ? ackPdf.base64 : null,
        formPdfBase64: formPdf ? formPdf.base64 : null,
        orders,
      },
    })));
    if (isNew) summary.returns = (summary.returns || 0) + 1;
    if (isNew) fetched += 1;
    await t.time("pacing", () => jsleep(...PACE.betweenDocs));
  }

  // The last year's upload has nothing after it to hide behind.
  await t.time("ingest", () => ingests.drain());

  // A run that changed nothing should say so. Silence after a list call looks
  // like a stall, which is how "the sync is slow" starts.
  if (!fetched) {
    emit("returns", `Returns already up to date — ${list.length} assessment year${list.length > 1 ? "s" : ""} on file`);
  }

  // Older years without a rendered form are not pending work — they are a
  // deliberate omission, and saying "next sync" about them (as an earlier
  // version did) promises a run that will never come.
  if (formsOnDemand) {
    summary.formsOnDemand = (summary.formsOnDemand || 0) + formsOnDemand;
    emit(
      "returns",
      `${formsOnDemand} older year${formsOnDemand > 1 ? "s" : ""} kept their return PDF off the sync — 10-12 MB each. Use "Fetch form" on the Returns tab to pull one when it is wanted.`
    );
  }
}

// The full ITR form PDF, fetched on demand from the Returns tab rather than on
// every sync — see the note at the top of this file.
async function fetchReturnForm(page, { pan, ackNum, ay }) {
  const res = await postBinary(page, {
    path: PATHS.ITR_PREVIEW + encodeURIComponent(ay),
    serviceName: "NA",
    payload: { ackNum, loggedInUserId: pan },
    extraHeaders: { ackNum: String(ackNum) },
  });
  return res;
}

module.exports = { syncReturns, fetchReturnForm, ORDER_ACTIVITIES, javaDate, dobFromItrJson };
