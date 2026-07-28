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
} = require("firebase/firestore");
const { getStorage, ref: storageRef, uploadString } = require("firebase/storage");
const { firebaseConfig, FUNCTIONS_REGION } = require("./config");
const deviceSession = require("./deviceSession");

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
      lastSyncedAt: a.portalNoticeSyncedAt || "",
    };
  });
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
//   knownActiveProcs proceedingReqIds we hold as Active — lets "eproc" scope
//                    spot which ones just left FYA (i.e. closed) without
//                    scanning the whole FYI list
//
// Reads Firestore directly with the signed-in user's token; firestore.rules
// already scopes users/{uid}/** to the owner. Both queries are single-field
// equality, so Firestore's automatic indexes cover them — no index to deploy.
async function getSyncKnowns(pan) {
  init();
  const user = currentUser();
  if (!user) throw new Error("Sign in first.");
  const p = String(pan || "").toUpperCase().trim();
  const empty = { knownDins: [], knownByProc: {}, knownResponseIds: [], knownActiveProcs: [] };
  if (!p) return empty;

  const [noticeSnap, matterSnap] = await Promise.all([
    getDocs(query(collection(firestore, `users/${user.uid}/notices`), where("pan", "==", p))),
    getDocs(query(collection(firestore, `users/${user.uid}/matters`), where("pan", "==", p))),
  ]);

  const knownDins = new Set();
  const knownResponseIds = new Set();
  const procNotices = {}; // proceedingReqId -> Set<DIN>
  const procHasOrder = new Set();

  noticeSnap.forEach((d) => {
    const n = d.data() || {};
    if (n.din) knownDins.add(String(n.din));
    if (n.docKey) knownDins.add(String(n.docKey));
    const pid = n.proceedingReqId;
    if (pid) {
      if (n.isOrder) procHasOrder.add(String(pid));
      if (n.din) (procNotices[pid] || (procNotices[pid] = new Set())).add(String(n.din));
    }
    for (const r of n.responses || []) {
      if (r && r.responseId != null) knownResponseIds.add(String(r.responseId));
    }
  });

  const knownByProc = {};
  for (const pid of Object.keys(procNotices)) knownByProc[pid] = { n: procNotices[pid].size };
  for (const pid of procHasOrder) (knownByProc[pid] || (knownByProc[pid] = { n: 0 })).o = true;

  const knownActiveProcs = [];
  matterSnap.forEach((d) => {
    const m = d.data() || {};
    if (m.status === "Active" && m.proceedingReqId) knownActiveProcs.push(String(m.proceedingReqId));
  });

  return {
    knownDins: [...knownDins],
    knownByProc,
    knownResponseIds: [...knownResponseIds],
    knownActiveProcs,
  };
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
  getSyncKnowns,
};
