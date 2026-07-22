// Firebase client for the connector's main process.
//
// Uses the SAME Firebase project and the SAME callable Cloud Functions as the
// web app. The connector signs in as the practitioner (email/password) so that
// getPortalCredential / ingestPortal* run with request.auth set — the functions
// reject unauthenticated calls.
//
// NOTE ON PERSISTENCE: the web SDK's default auth persistence is browser-only.
// In Electron's main (Node) process we use in-memory persistence and sign in on
// launch. A refresh token can later be cached in the OS keychain (keytar /
// safeStorage) so the user isn't prompted every start — tracked as a TODO.
"use strict";

const { initializeApp } = require("firebase/app");
const {
  getAuth,
  signInWithEmailAndPassword,
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
const { firebaseConfig, FUNCTIONS_REGION } = require("./config");

let app = null;
let auth = null;
let functions = null;
let firestore = null;

function init() {
  if (app) return;
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  functions = getFunctions(app, FUNCTIONS_REGION);
  firestore = getFirestore(app);
}

async function signIn(email, password) {
  init();
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return { uid: cred.user.uid, email: cred.user.email };
}

async function signOutUser() {
  if (auth) await signOut(auth);
}

function currentUser() {
  return auth && auth.currentUser
    ? { uid: auth.currentUser.uid, email: auth.currentUser.email }
    : null;
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
    };
  });
}

module.exports = {
  init,
  signIn,
  signOutUser,
  currentUser,
  callable,
  listPortalAssessees,
};
