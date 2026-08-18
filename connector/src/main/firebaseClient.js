// Firebase client for the connector's main process.
//
// Uses the SAME Firebase project and the SAME callable Cloud Functions as the
// web app. The connector signs in as the practitioner — via Email OTP (the same
// passwordless flow the web app uses) or Google — so that getPortalCredential /
// ingestPortal* run with request.auth set; the functions reject unauthenticated
// calls.
//
// Email OTP: requestOtp emails a 6-digit code; verifyOtp checks it and returns a
// Firebase custom token, which we exchange with signInWithCustomToken. Both
// callables are unauthenticated by design — they ARE the login mechanism.
//
// PERSISTENCE: the web SDK's persistence options are all browser-backed, and this
// runs in Electron's main (Node) process — so the Firebase session genuinely dies
// with the process. That used to mean an emailed code on EVERY launch.
//
// Solved with a "remember this device" key rather than a cached Firebase refresh
// token: the SDK has no public way to restore a session from a refresh token in
// Node, and an app-scoped key is revocable by us. After an interactive sign-in we
// ask the backend for a device key and put it in the OS keychain
// (deviceSession.js); on the next launch signInSilently() redeems it for a custom
// token. Sign-out revokes it server-side and deletes it locally.
"use strict";

const { initializeApp } = require("firebase/app");
const {
  getAuth,
  signInWithCustomToken,
  signInWithCredential,
  GoogleAuthProvider,
  signOut,
} = require("firebase/auth");
const { getFunctions, httpsCallable } = require("firebase/functions");
const {
  getFirestore,
  collection,
  query,
  where,
  getDocs,
  getCountFromServer,
  addDoc,
  doc: docRef,
  setDoc,
  getDoc,
  onSnapshot,
  runTransaction,
} = require("firebase/firestore");
const { getStorage, ref: storageRef, uploadString } = require("firebase/storage");
const { firebaseConfig, FUNCTIONS_REGION } = require("./config");
const deviceSession = require("./deviceSession");
const { buildSyncKnowns } = require("./syncKnowns");

let app = null;
let auth = null;
let functions = null;
let firestore = null;
let storage = null;

function init() {
  if (app) return;
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  functions = getFunctions(app, FUNCTIONS_REGION);
  firestore = getFirestore(app);
  storage = getStorage(app);
}

const normEmail = (v) => String(v || "").trim().toLowerCase();
// The backend expects E.164; the web app normalises the same way (Login.jsx).
const normPhone = (v) => "+91" + String(v || "").replace(/\D/g, "").slice(-10);
const normTarget = (channel, v) => (channel === "sms" ? normPhone(v) : normEmail(v));

/* OTP sign-in, on either channel.
 *
 * The callables have supported channel: "sms" since SMS login shipped on the
 * web; the connector was simply still hard-coding "email", so someone who signs
 * in to the web app by mobile had no way in here. Nothing server-side changes. */
async function requestOtp(channel, target) {
  init();
  const { data } = await httpsCallable(functions, "requestOtp")({
    channel,
    target: normTarget(channel, target),
  });
  return data || { ok: true };
}

// Verify the code, then sign in with the returned custom token.
async function verifyOtp(channel, target, code) {
  init();
  const { data } = await httpsCallable(functions, "verifyOtp")({
    channel,
    target: normTarget(channel, target),
    code: String(code || "").replace(/\D/g, ""),
  });
  if (!data || !data.token) throw new Error("Could not verify the code. Please try again.");
  const res = await signInWithCustomToken(auth, data.token);
  await rememberThisDevice();
  return userInfo(res.user);
}

// Ask the backend for a device key and stash it in the OS keychain, so the next
// launch signs in without an emailed code. Best-effort on purpose: a user who has
// just signed in successfully must not be shown an error because we couldn't set
// up a convenience.
async function rememberThisDevice() {
  try {
    const { data } = await httpsCallable(functions, "issueDeviceKey")({ label: deviceSession.deviceLabel() });
    if (data && data.deviceKey) deviceSession.save(data.deviceKey);
  } catch (err) {
    console.warn("[auth] couldn't remember this device:", (err && err.message) || err);
  }
}

// Restore a previous session on launch. Returns the user, or null when there is
// nothing stored, the key was revoked, or it went unused past the idle window —
// in every one of those cases the caller just shows the normal sign-in screen.
async function signInSilently() {
  init();
  const key = deviceSession.load();
  if (!key) return null;
  try {
    const { data } = await httpsCallable(functions, "redeemDeviceKey")({ deviceKey: key });
    if (!data || !data.token) throw new Error("no token");
    const res = await signInWithCustomToken(auth, data.token);
    return userInfo(res.user);
  } catch (err) {
    // The server tells us nothing more specific than "sign in again" by design.
    // A dead key is worthless, so stop carrying it around.
    deviceSession.clear();
    console.info("[auth] stored device session not usable:", (err && err.message) || err);
    return null;
  }
}

// Sign in with a Google ID token obtained via the desktop system-browser flow
// (googleAuth.js). Firebase accepts Google tokens issued to any OAuth client in
// the same project, so this is the same account the web app's Google sign-in
// creates — same uid, same data.
async function signInWithGoogleIdToken(idToken) {
  init();
  const cred = GoogleAuthProvider.credential(idToken);
  const res = await signInWithCredential(auth, cred);
  await rememberThisDevice();
  return userInfo(res.user);
}

// Sign out, and mean it: revoke the device key server-side so a surviving copy on
// disk is dead, then delete it locally. Revoking BEFORE the Firebase sign-out
// because the callable is easier to reason about while still authenticated (it
// only needs the key, but there's no reason to make the ordering subtle).
async function signOutUser() {
  init();
  const key = deviceSession.load();
  if (key) {
    try {
      await httpsCallable(functions, "revokeDeviceKey")({ deviceKey: key });
    } catch (err) {
      // Network trouble mustn't trap the user in a signed-in state. The local key
      // is deleted regardless, so this device stops using it either way; the
      // server record then lapses at the idle window.
      console.warn("[auth] couldn't revoke the device key server-side:", (err && err.message) || err);
    }
  }
  deviceSession.clear();
  if (auth) await signOut(auth);
}

/* What the UI shows for "signed in as". A phone-only account has no email, so
   the header would have gone blank once SMS sign-in was allowed here. */
function userInfo(u) {
  if (!u) return null;
  return {
    uid: u.uid,
    email: u.email || "",
    phoneNumber: u.phoneNumber || "",
    label: u.email || u.phoneNumber || "Signed in",
  };
}

function currentUser() {
  return auth && auth.currentUser ? userInfo(auth.currentUser) : null;
}

// The signed-in user's uid, or null. Used to build per-user Storage paths, the
// same convention the web app uses (users/{uid}/assessees/...).
function uid() {
  return auth && auth.currentUser ? auth.currentUser.uid : null;
}

// Upload a base64 payload to Storage, mirroring the web app's
// uploadString(ref, base64, "base64", { contentType }). Returns the path.
async function uploadBase64(path, base64, contentType) {
  init();
  await uploadString(storageRef(storage, path), base64, "base64", {
    contentType: contentType || "application/pdf",
    // attachment => a browser handed this object's download URL saves it rather
    // than rendering it in a tab. The web app's own buttons fetch the blob and
    // name it themselves (src/downloadFile.js), but a URL opened outside the app
    // has only this header to go on.
    contentDisposition: "attachment",
  });
  return path;
}

// Thin wrapper around httpsCallable so the rest of the app just calls
// callable("ingestPortalNotice", { ... }).
async function callable(name, payload) {
  init();
  const { data } = await httpsCallable(functions, name)(payload);
  return data;
}

// List the signed-in user's assessees that have a stored portal login. Reads
// Firestore directly — firestore.rules already scopes users/{uid}/** to the
// owner, so no extra Cloud Function is needed. Returns the minimum the UI needs.
async function listPortalAssessees() {
  init();
  const user = currentUser();
  if (!user) throw new Error("Sign in first.");
  const col = collection(firestore, `users/${user.uid}/assessees`);
  const snap = await getDocs(query(col, where("portalCredSet", "==", true)));
  return snap.docs.map((d) => {
    const a = d.data() || {};
    return {
      id: d.id,
      name: a.name || a.pan || d.id,
      pan: a.pan || "",
      portalUserId: a.portalUserId || a.pan || "",
      // Carried for the connector's search and filters. Free — the document is
      // already being read; without them the list can only be scrolled.
      group: a.group || "",
      staff: a.staff || "",
      status: a.status || "",
      // Needed by the returns pass to unlock CPC order PDFs (pdfUnlock.js).
      dob: a.dob || "",
      /* When this PAN was last synced — not when it last produced something.
         This used to read portalNoticeSyncedAt, which only moves when a NEW
         notice is stored, so a PAN synced hourly with a clean record showed a
         months-old date or none at all. markSynced() below stamps
         portalLastSyncedAt on every successful run. */
      lastSyncedAt: a.portalLastSyncedAt || "",
    };
  });
}

/* One assessee with this exact PAN, or null.
 *
 * A PAN can only appear once in a practice: every notice, matter, hearing and
 * invoice hangs off it, so two records for one PAN split a client's history in
 * half silently. The web app checks this against the list it already holds in
 * memory; here it is a single equality query, covered by Firestore's automatic
 * index. Note it does NOT filter on portalCredSet — a duplicate of an assessee
 * added by hand in the web app is exactly the case worth catching. */
async function findAssesseeByPan(pan) {
  init();
  const user = currentUser();
  if (!user) throw new Error("Sign in first.");
  const p = String(pan || "").toUpperCase().trim();
  if (!p) return null;
  const col = collection(firestore, `users/${user.uid}/assessees`);
  const snap = await getDocs(query(col, where("pan", "==", p)));
  if (snap.empty) return null;
  const d = snap.docs[0];
  const a = d.data() || {};
  return { id: d.id, name: a.name || "", pan: a.pan || p, group: a.group || "", portalCredSet: Boolean(a.portalCredSet) };
}

/* Create the assessee document, the same shape addAssessee() writes in the web
   app (src/store.jsx) — including the avatar colour, which is picked from how
   many assessees already exist so a practice's list stays evenly coloured.
   Counted server-side rather than by reading every document: a practice with
   800 assessees should not download 800 records to choose a colour. */
const AVATAR_COLORS = ["violet", "pink", "amber", "mint"];

async function createAssesseeDoc(rec) {
  init();
  const user = currentUser();
  if (!user) throw new Error("Sign in first.");
  const col = collection(firestore, `users/${user.uid}/assessees`);
  let color = AVATAR_COLORS[0];
  try {
    const count = (await getCountFromServer(col)).data().count;
    color = AVATAR_COLORS[count % AVATAR_COLORS.length];
  } catch {
    // A colour is a nicety; failing to count one must never block the record.
  }
  const payload = { createdAt: new Date().toISOString(), color, ...rec };
  const ref = await addDoc(col, payload);
  return { id: ref.id, ...payload };
}

/* Record that this PAN synced successfully, just now.
 *
 * ingestPortalProceedings already stamps this field — but only when there ARE
 * proceedings to ingest, and a clean compliance record is the normal state for
 * most assessees. Those PANs synced every six hours and still read "never
 * synced", which is the opposite of what an unattended sync needs to show.
 *
 * Best-effort by design: the sync itself succeeded, and failing to write a
 * timestamp about it must not turn a good run into a failed one. */
async function markSynced(assesseeId, at = new Date().toISOString()) {
  if (!assesseeId) return "";
  try {
    init();
    const user = currentUser();
    if (!user) return "";
    await setDoc(docRef(firestore, `users/${user.uid}/assessees/${assesseeId}`), { portalLastSyncedAt: at }, { merge: true });
    return at;
  } catch (err) {
    console.warn("[sync] couldn't stamp the sync time:", (err && err.message) || err);
    return "";
  }
}

/* ---- documents the practice's OTHER machines also read ------------------
   The connector is installed on more than one computer in a firm, and those
   copies have to agree about who is syncing and what has been synced. These
   three are the whole of that conversation: a transactional read-modify-write
   for the lock, a plain read, and a live subscription. */

// Read-modify-write in one transaction. `decide(current)` returns the document
// to write, or null to leave it alone; the return value says which happened.
async function transactLock(path, decide) {
  init();
  return runTransaction(firestore, async (tx) => {
    const ref = docRef(firestore, path);
    const snap = await tx.get(ref);
    const next = decide(snap.exists() ? snap.data() : null);
    if (!next) return false;
    tx.set(ref, next);
    return true;
  });
}

async function readDoc(path) {
  init();
  const snap = await getDoc(docRef(firestore, path));
  return snap.exists() ? snap.data() : null;
}

async function mergeDoc(path, patch) {
  init();
  await setDoc(docRef(firestore, path), patch, { merge: true });
}

/* Watch one document — the sync lock. Returns an unsubscribe. */
function watchDoc(path, onChange) {
  init();
  return onSnapshot(docRef(firestore, path), (snap) => onChange(snap.exists() ? snap.data() : null),
    (err) => console.warn("[watch]", path, (err && err.message) || err));
}

/* Watch this practice's assessees, so a sync finishing on the SERVER shows up
   on the partner's laptop without anybody pressing Reload. Only the fields the
   list actually paints are forwarded — a snapshot of every assessee document,
   several times an hour, is not something to push through IPC. */
function watchPortalAssessees(onChange) {
  init();
  const user = currentUser();
  if (!user) return () => {};
  const col = collection(firestore, `users/${user.uid}/assessees`);
  return onSnapshot(query(col, where("portalCredSet", "==", true)), (snap) => {
    onChange(snap.docs.map((d) => {
      const a = d.data() || {};
      return { id: d.id, lastSyncedAt: a.portalLastSyncedAt || "" };
    }));
  }, (err) => console.warn("[watch] assessees:", (err && err.message) || err));
}

// Build the incremental-sync hints for ONE PAN — the connector's port of
// buildSyncKnowns() in src/Assessees.jsx. Without these the sync has no idea
// what it already holds, so it re-downloads every notice PDF, every filed reply
// and re-renders every Form 35 on every single run.
//
//   knownDins        DINs + docKeys already on file (a docKey covers closure
//                    orders as "sat:<id>" and filed Form 35s as "f35:<ackNum>")
//   knownByProc      per-proceeding { n: notice count, o: has an order } so a
//                    proceeding whose count hasn't moved is skipped entirely
//   knownResponseIds replies already recorded
//   appealFormsPending filed Form 35s held without a document they should have
//                    — the one thing that brings the appeals pass back to a
//                    form it has already written a docKey for
//   knownActiveProcs proceedingReqIds we hold as Active — lets "eproc" scope
//                    spot which ones just left FYA (i.e. closed) without
//                    scanning the whole FYI list
//   knownAckNums     acknowledgement numbers of returns already on file — a
//                    filed return never changes, so one fetch each is enough
//   knownOrderRefs   CPC commRefNos already downloaded, so a re-sync only pulls
//                    an intimation or rectification order that is genuinely new
//   knownFormAcks    returns whose rendered ITR form PDF is already stored. Kept
//                    apart from knownAckNums because that document is ~11 MB
//                    against a few hundred KB for everything else, so it is
//                    rationed per run (see portalReturns.js) — which only
//                    converges if a later sync can tell "return on file" from
//                    "return on file WITH its form"
//
// Reads Firestore directly with the signed-in user's token; firestore.rules
// already scopes users/{uid}/** to the owner. Both queries are single-field
// equality, so Firestore's automatic indexes cover them — no index to deploy.
async function getSyncKnowns(pan) {
  init();
  const user = currentUser();
  if (!user) throw new Error("Sign in first.");
  const p = String(pan || "").toUpperCase().trim();
  // An assessee with no PAN cannot be diffed against anything, so the sync
  // re-fetches its whole history — every run, for ever. That is a big enough
  // consequence to be an error the caller reports rather than an empty object
  // that looks like "nothing on file yet".
  if (!p) throw new Error("This assessee has no PAN on record, so nothing can be matched against what is already on file.");

  const [noticeSnap, matterSnap, returnSnap] = await Promise.all([
    getDocs(query(collection(firestore, `users/${user.uid}/notices`), where("pan", "==", p))),
    getDocs(query(collection(firestore, `users/${user.uid}/matters`), where("pan", "==", p))),
    getDocs(query(collection(firestore, `users/${user.uid}/returns`), where("pan", "==", p))),
  ]);

  /* The rules themselves live in syncKnowns.js — pure, and tested against the
     web app's copy of them (test/syncKnowns.test.mjs). They were written out
     here once, and drifted: this copy never computed `procNeedsMeta`, so the one
     mechanism that reaches back into a closed proceeding did nothing on the path
     that actually runs. Reading the documents is this function's job; deciding
     what they mean is not. */
  const data = (snap) => { const out = []; snap.forEach((d) => out.push(d.data() || {})); return out; };
  // No date of birth here on purpose: on this side the order-unlock decision is
  // made from `job.dob`, which the worker already carries (portalReturns.js).
  return buildSyncKnowns(data(noticeSnap), p, data(matterSnap), data(returnSnap), false);
}

module.exports = {
  init,
  requestOtp,
  verifyOtp,
  signInWithGoogleIdToken,
  signInSilently,
  signOutUser,
  currentUser,
  uid,
  uploadBase64,
  callable,
  listPortalAssessees,
  findAssesseeByPan,
  createAssesseeDoc,
  markSynced,
  transactLock,
  readDoc,
  mergeDoc,
  watchDoc,
  watchPortalAssessees,
  getSyncKnowns,
};
