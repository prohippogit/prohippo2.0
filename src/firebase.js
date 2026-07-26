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
// asia-south1 (Mumbai) — co-located with Firestore. Every callable is deployed to
// both asia-south1 and us-central1 under the same name (see REGIONS in
// functions/index.js), and the Mumbai copies went live on 2026-07-26, so this is
// the near end of the wire for Indian users AND for the functions' own Firestore
// calls. The us-central1 copies stay deployed for connectors that predate the
// switch. Background: docs/PERF_AND_REGION.md.
export const functions = getFunctions(app, "asia-south1");

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
  console.info("ProHippo: using Firebase emulators");
}
