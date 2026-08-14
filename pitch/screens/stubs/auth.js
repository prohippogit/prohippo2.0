/*
 * firebase/auth stand-in for the screenshot harness. See ./firestore.js.
 *
 * The harness signs in as the seed practice immediately — except on
 * `?screen=landing`, where it reports nobody, so the real public landing page
 * renders exactly as a first-time visitor sees it.
 */
const SIGNED_OUT = new URLSearchParams(window.location.search).get("screen") === "landing";

const USER = {
  uid: "seed-practice",
  email: "priya@mehtaassociates.in",
  displayName: "Priya Mehta",
  phoneNumber: "+919825011234",
  getIdTokenResult: async () => ({ claims: {} }),
  getIdToken: async () => "seed-token",
};

export const getAuth = () => ({ currentUser: SIGNED_OUT ? null : USER });
export const connectAuthEmulator = () => {};
export const onAuthStateChanged = (auth, cb) => {
  queueMicrotask(() => cb(SIGNED_OUT ? null : USER));
  return () => {};
};
export class GoogleAuthProvider { static credential() { return {}; } }
export const signInWithPopup = async () => ({ user: USER });
export const signInWithRedirect = async () => {};
export const signInWithCustomToken = async () => ({ user: USER });
export const sendSignInLinkToEmail = async () => {};
export const isSignInWithEmailLink = () => false;
export const signInWithEmailLink = async () => ({ user: USER });
export const signOut = async () => {};
