/*
 * Firebase web configuration for ProHippo.
 *
 * These values are NOT secret — Firebase web config is meant to ship in the
 * browser. Your data is protected by Firebase Authentication + Firestore
 * security rules, not by hiding these keys.
 *
 * HOW TO FILL THIS IN (one time):
 *   1. Firebase console → your project (prohippo2) → Project settings (gear icon)
 *   2. Scroll to "Your apps". If there is no Web app (</>) yet, click "Add app"
 *      → Web → give it a nickname → Register app.
 *   3. Copy the values from the "firebaseConfig" object shown there into the
 *      object below (apiKey, authDomain, projectId, storageBucket,
 *      messagingSenderId, appId).
 */
export const firebaseConfig = {
  apiKey: "AIzaSyBgs1cgmwmF0OtT-2HzaPgXS1XuagUoDsU",
  authDomain: "prohippo2.firebaseapp.com",
  projectId: "prohippo2",
  storageBucket: "prohippo2.firebasestorage.app",
  messagingSenderId: "172465235057",
  appId: "1:172465235057:web:cb2718881728d4e8b467d0",
  measurementId: "G-FK13JZ2DND",
};

// When true (set via VITE_USE_EMULATORS=true), the app talks to local
// Firebase emulators instead of the real project. Used only for testing.
export const useEmulators =
  typeof import.meta !== "undefined" &&
  import.meta.env &&
  import.meta.env.VITE_USE_EMULATORS === "true";
