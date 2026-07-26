/* ProHippo — Firebase app initialization (Auth + Firestore + Functions) */
import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator } from "firebase/auth";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
  connectFirestoreEmulator,
} from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator } from "firebase/functions";
import { getStorage, connectStorageEmulator } from "firebase/storage";
import { firebaseConfig, useEmulators } from "./firebaseConfig";

export const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);

// Cloud Functions. Which region's copy this build calls.
//
// Firestore is in asia-south1 (Mumbai) and the functions now deploy to BOTH
// asia-south1 and us-central1 under the same names (see REGIONS in
// functions/index.js), so this is a free switch — once the Mumbai copies exist.
//
// STILL "us-central1" ON PURPOSE: deploying hosting with "asia-south1" before
// the functions are live in Mumbai takes the live web app down. Deploy functions
// first, then flip this. Ordered runbook: docs/PERF_AND_REGION.md.
export const functions = getFunctions(app, "us-central1");

// Storage for downloaded notice/order PDFs (per-user paths).
export const storage = getStorage(app);

// Firestore with an on-device cache so the app keeps working offline and
// writes feel instant (latency compensation).
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }),
});

if (useEmulators) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  connectStorageEmulator(storage, "127.0.0.1", 9199);
  // eslint-disable-next-line no-console
  console.info("ProHippo: using Firebase emulators");
}
