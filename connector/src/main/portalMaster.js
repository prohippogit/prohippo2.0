// Master data for ONE PAN — the taxpayer's own profile, their jurisdiction /
// Assessing Officer, and their contact details.
//
// Playwright port of syncMaster() in extension/portal-login.js, plus the
// formatting the web app's AssesseeModal does to the raw fields (name join,
// address assembly, date parsing, entity type from the PAN). Both halves live
// here because the connector has no browser extension streaming a payload to a
// React form: it fetches and maps in one process, and hands the UI a record
// that is ready to review and save.
//
// All three services are plain cookie-authenticated calls where the "sn" header
// is just the serviceName (see portalApi.js), so this needs no token capture and
// no UI navigation — the context only has to be logged in.
"use strict";

const { apiCall, PATHS } = require("./portalApi");

// Income-tax state codes → names, from the portal's own master table. Kept in
// step with src/AssesseeModal.jsx.
const STATE_CODES = { "1": "Andaman And Nicobar Islands", "2": "Andhra Pradesh", "3": "Arunachal Pradesh", "4": "Assam", "5": "Bihar", "6": "Chandigarh", "7": "Dadra & Nagar Haveli", "8": "Daman and Diu", "9": "Delhi", "10": "Goa", "11": "Gujarat", "12": "Haryana", "13": "Himachal Pradesh", "14": "Jammu and Kashmir", "15": "Karnataka", "16": "Kerala", "17": "Lakshadweep", "18": "Madhya Pradesh", "19": "Maharashtra", "20": "Manipur", "21": "Meghalaya", "22": "Mizoram", "23": "Nagaland", "24": "Odisha", "25": "Puducherry", "26": "Punjab", "27": "Rajasthan", "28": "Sikkim", "29": "Tamil Nadu", "30": "Tripura", "31": "Uttar Pradesh", "32": "West Bengal", "33": "Chhattisgarh", "34": "Uttarakhand", "35": "Jharkhand", "36": "Telangana", "37": "Ladakh", "99": "Foreign" };

const MONTHS = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

// The portal's 4th PAN character encodes the holder type.
function entityFromPan(pan) {
  const p = String(pan || "").toUpperCase();
  if (!/^[A-Z]{4}/.test(p)) return "";
  return { P: "Individual", C: "Company", H: "HUF", F: "Firm", A: "AOP/BOI", B: "AOP/BOI", T: "Trust" }[p[3]] || "";
}

/* Date of birth / incorporation → YYYY-MM-DD, which is what the app stores and
   what pdfUnlock.js builds a CPC order password from.

   Prefer the portal's "10-Mar-1978" string over its epoch: the epoch is
   midnight IST, so reading it in any other timezone lands on the previous day —
   and a date of birth that is one day out unlocks nothing. */
function itdDate(m) {
  const s = String((m && m.incorporateDate) || "").trim();
  const mm = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  if (mm && MONTHS[mm[2]]) return `${mm[3]}-${MONTHS[mm[2]]}-${mm[1].padStart(2, "0")}`;
  if (m && m.dobEpoch) {
    const d = new Date(Number(m.dobEpoch) + 5.5 * 3600 * 1000);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return "";
}

/* The taxpayer's primary email + mobile, without hard-coding field names: the
   profile service spells them priEmailId / primEmailId / priMobileNum and more,
   so match by key hint plus value shape and prefer the primary one. Ported from
   pickContact() in extension/portal-login.js. */
function pickContact(j) {
  const emails = [], mobiles = [];
  const rank = (k) => (/^pri(m)?/i.test(k) ? 0 : /prim/i.test(k) ? 1 : 2);
  for (const k of Object.keys(j || {})) {
    const v = j[k];
    if (typeof v !== "string" && typeof v !== "number") continue;
    const s = String(v).trim();
    if (/e[-]?mail/i.test(k) && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) emails.push([k, s]);
    if (/mob|phone|cell/i.test(k)) {
      const digits = s.replace(/\D/g, "");
      if (digits.length >= 10 && digits.length <= 13) mobiles.push([k, s.replace(/\s+/g, "")]);
    }
  }
  emails.sort((a, b) => rank(a[0]) - rank(b[0]));
  mobiles.sort((a, b) => rank(a[0]) - rank(b[0]));
  return { email: emails[0] ? emails[0][1] : "", mobile: mobiles[0] ? mobiles[0][1] : "" };
}

/* Raw service JSON → the assessee record the UI shows for review.
 *
 * Every field is optional on purpose. The portal answers all three services for
 * some PANs and one for others, and a half-filled form somebody completes by
 * hand is a far better outcome than an error — so anything missing simply comes
 * back empty, and `filled` says which fields genuinely came from the portal.
 */
function mapMaster({ pan, panDetails, jurisdiction, profile }) {
  const p = String(pan || "").toUpperCase().trim();
  const d = panDetails || {};
  const filled = {};

  const name = [d.firstNm, d.midNm, d.surname].map((s) => String(s || "").trim()).filter(Boolean).join(" ");
  const stateName = STATE_CODES[String(d.commnState)] || "";
  const address = [d.commnLine1, d.commnLine2, d.commnLine3, d.commnLine4, d.commnLine5]
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .concat([stateName, d.commnPin != null ? String(d.commnPin) : ""].filter(Boolean))
    .join(", ");
  const dob = itdDate({ incorporateDate: d.incorporateDate, dobEpoch: d.dob });
  const contact = pickContact(profile);

  const rec = {
    pan: p,
    name,
    status: entityFromPan(p) || "Individual",
    dob,
    address,
    email: contact.email || "",
    mobile: contact.mobile || "",
    jurisdiction: null,
  };
  if (name) filled.name = true;
  if (dob) filled.dob = true;
  if (address) filled.address = true;
  if (rec.email) filled.email = true;
  if (rec.mobile) filled.mobile = true;

  const j = jurisdiction || {};
  const ward = String(j.aoPplrName || "").trim();
  const aoEmail = String(j.aoEmailId || "").trim();
  if (ward || aoEmail) {
    rec.jurisdiction = {
      ward,
      aoEmail,
      building: j.aoBldgDesc || "",
      area: j.areaDesc || "",
      areaCd: j.areaCd || "",
      range: j.rangeCd || "",
      aoNo: j.aoNo || "",
      aoType: j.aoType || "",
    };
    filled.jurisdiction = true;
  }

  return { record: rec, filled: Object.keys(filled) };
}

// A service answered only if it came back with JSON and no errors array — the
// portal returns 200 with `errors: [...]` for a service it declined.
function usable(res) {
  return res && res.json && !(Array.isArray(res.json.errors) && res.json.errors.length) ? res.json : null;
}

/* Fetch all three services for a logged-in PAN and map them.
 *
 * The calls run in sequence rather than in parallel: this is the same portal
 * session a human would be using, and three simultaneous service calls from one
 * session is exactly the shape the pacing everywhere else in this app exists to
 * avoid. It is three round trips, not thirty. */
async function fetchMaster(page, pan) {
  const p = String(pan || "").toUpperCase().trim();
  if (!PAN_RE.test(p)) throw new Error(`"${pan}" is not a valid PAN.`);

  const panDetails = usable(await apiCall(page, {
    path: PATHS.SERVICES_SAVE,
    serviceName: "myPanDetailsService",
    payload: { serviceName: "myPanDetailsService", contactPan: p, userId: p },
  }));

  const jurisdiction = usable(await apiCall(page, {
    path: PATHS.SERVICES_SAVE,
    serviceName: "jurisdictionDetailsService",
    payload: { serviceName: "jurisdictionDetailsService", loggedInUserId: p },
  }));

  const profile = usable(await apiCall(page, {
    path: PATHS.SERVICES_SAVE,
    serviceName: "userProfileService",
    payload: { serviceName: "userProfileService", userId: p },
  }));

  return mapMaster({ pan: p, panDetails, jurisdiction, profile });
}

module.exports = { fetchMaster, mapMaster, entityFromPan, itdDate, pickContact, PAN_RE, STATE_CODES };
