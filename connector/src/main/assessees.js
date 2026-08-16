/* Adding an assessee from the connector.
 *
 * WHY THIS EXISTS. Creating an assessee used to be the web app's job, and the
 * web app creates one by handing the PAN and password to the Chrome extension,
 * which logs in and reads the master data. Someone who has not installed the
 * extension — which is everybody on their first day — therefore had to type
 * every field by hand before the connector could do anything at all, and the
 * connector's own list stayed empty until they did.
 *
 * The connector already drives a real portal login for the sync. This reuses
 * exactly that machinery for a single PAN: log in, read the profile, hand the
 * fields back for review, then write the assessee and store the login. From
 * there the PAN appears in the list and syncs like any other.
 *
 * The password lives in memory for the length of the login and is then handed
 * to savePortalCredential, which encrypts it server-side (AES-256-GCM). It is
 * never written to disk here, never logged, and never kept in connector state.
 */
"use strict";

const fb = require("./firebaseClient");
const { login, startLogoutGuard } = require("./portalLogin");
const { fetchMaster, PAN_RE } = require("./portalMaster");
const { launchHardenedBrowser, newStealthContext } = require("./pool");

const clean = (v) => String(v == null ? "" : v).trim();
const normPan = (v) => clean(v).toUpperCase();

/* Sign in as this PAN and read its master data.
 *
 * Nothing is saved: the caller gets a record to review, and the user can still
 * correct every field before it becomes an assessee. A password that turns out
 * to be wrong therefore costs a failed login and nothing else.
 *
 * Its own browser process, not the sync pool's: this runs while the user is
 * looking at a form, and a sync running at the same time must not be able to
 * close the browser out from under it.
 */
async function fetchMasterForPan({ pan, portalUserId, portalPassword, headless = true, emit = () => {} }) {
  const p = normPan(pan);
  if (!PAN_RE.test(p)) throw new Error("Enter a valid PAN, e.g. ABCPS1234F.");
  if (!clean(portalPassword)) throw new Error("Enter the e-filing password for this PAN.");

  // "Starting…", not what is being started: progress messages on this screen
  // say where the work has got to, never what it is driving.
  emit("start", "Starting…");
  const browser = await launchHardenedBrowser(headless !== false); // hidden unless told otherwise
  let context = null;
  try {
    context = await newStealthContext(browser);
    const page = await context.newPage();
    const cred = { portalUserId: clean(portalUserId) || p, portalPassword: clean(portalPassword) };

    // login() emits its own (phase, message, level, pct) progress — pass it
    // straight through so the form narrates the same steps a sync row does.
    await login(page, cred, emit);

    const stopGuard = await startLogoutGuard(page);
    try {
      emit("master", "Reading name, address and jurisdiction…");
      const { record, filled } = await fetchMaster(page, p);
      if (!filled.length) {
        // Logged in, but the portal answered none of the three services. Worth
        // saying plainly: the fields are blank because the portal gave nothing,
        // not because the fetch failed silently.
        emit("master", "Signed in, but the portal returned no profile for this PAN — fill the details in by hand.", "warn");
      } else {
        emit("master", `Fetched ${filled.length} field${filled.length === 1 ? "" : "s"} from the portal.`, "success");
      }
      return { record, filled };
    } finally {
      await stopGuard();
    }
  } finally {
    if (context) await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/* Create the assessee, then store its portal login.
 *
 * In that order, and not in one step, because savePortalCredential needs an
 * assesseeId to encrypt against. If it fails the assessee still exists and the
 * caller is told the login was not saved — a record that is missing a password
 * is fixable in seconds; a password saved against a record that was never
 * created is orphaned ciphertext.
 */
async function createAssessee({ form = {}, portalPassword = "", saveLogin = true }) {
  const pan = normPan(form.pan);
  const name = clean(form.name);
  if (!PAN_RE.test(pan)) throw new Error("Enter a valid PAN, e.g. ABCPS1234F.");
  if (!name) throw new Error("Enter the assessee's name.");

  const existing = await fb.findAssesseeByPan(pan);
  if (existing) {
    throw new Error(
      `${pan} is already on your list${existing.name ? ` as "${existing.name}"` : ""}. ` +
      "A PAN can only appear once — open that assessee instead."
    );
  }

  const record = {
    name,
    pan,
    status: clean(form.status) || "Individual",
    group: clean(form.group),
    staff: clean(form.staff),
    mobile: clean(form.mobile),
    email: clean(form.email),
    address: clean(form.address),
    dob: clean(form.dob),
    // The jurisdiction / Assessing Officer block, when the portal returned one.
    jurisdiction: form.jurisdiction && (form.jurisdiction.ward || form.jurisdiction.aoEmail) ? form.jurisdiction : null,
    // Where this record came from, for the same reason the web app stamps
    // createdAt: a practice that later wonders why an assessee has no group or
    // staff can see it was created from the connector's own form.
    createdVia: "connector",
  };

  const saved = await fb.createAssesseeDoc(record);

  let credSaved = false;
  let credError = "";
  if (saveLogin && clean(portalPassword)) {
    try {
      await fb.callable("savePortalCredential", {
        assesseeId: saved.id,
        portalUserId: clean(form.portalUserId) || pan,
        portalPassword: clean(portalPassword),
      });
      credSaved = true;
    } catch (err) {
      credError = String((err && err.message) || err);
    }
  }

  return { id: saved.id, name: saved.name, pan: saved.pan, credSaved, credError };
}

module.exports = { fetchMasterForPan, createAssessee };
