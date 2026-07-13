/* ProHippo — Firebase app initialization (Auth + Firestore) */
import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator } from "firebase/auth";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
  connectFirestoreEmulator,
} from "firebase/firestore";
import { firebaseConfig, useEmulators } from "./firebaseConfig";

export const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);

// Firestore with an on-device cache so the app keeps working offline and
// writes feel instant (latency compensation).
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }),
});

if (useEmulators) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  // eslint-disable-next-line no-console
  console.info("ProHippo: using Firebase emulators");
}
