/*
 * A Firestore stand-in for the deck's screenshot harness.
 *
 * The app is photographed as it really is: nothing in `src/` is stubbed,
 * mocked or forked for this. Only the Firebase SDK underneath it is replaced,
 * so the real DataProvider runs its real subscriptions and the real screens
 * render from them — they simply resolve against the seed in `../seed.js`
 * instead of somebody's live practice.
 *
 * That boundary is the whole point. A harness that reimplemented the screens
 * would photograph the harness.
 */
/* The seed is pulled in LAZILY, and that is not a style choice.
 *
 * seed.js reuses the app's own buildSampleData(), so it imports src/store.jsx
 * — which imports firebase/firestore, which under this config is this file. A
 * static import here closes that ring and the module graph deadlocks on
 * whichever const is evaluated first. Deferring it to the first read breaks
 * the cycle: by the time anything calls onSnapshot, every module has finished
 * initialising. */
let seedPromise = null;
const seed = () => (seedPromise ||= import("../seed.js"));

/* Refs are inert descriptors — a path and a kind. Everything below dispatches
   on the path, which is what makes one `onSnapshot` able to serve the profile
   document, eleven collections, and the integration documents that have no
   seed behind them. */
const refOf = (kind, segments) => ({ __ref: true, kind, path: segments.filter(Boolean).join("/") });

export const doc = (dbOrRef, ...rest) =>
  dbOrRef && dbOrRef.__ref
    ? refOf("doc", [dbOrRef.path, ...rest])
    : refOf("doc", rest);

export const collection = (dbOrRef, ...rest) =>
  dbOrRef && dbOrRef.__ref
    ? refOf("collection", [dbOrRef.path, ...rest])
    : refOf("collection", rest);

// Constraints do not narrow anything here: the seed is already the answer.
export const query = (ref) => ref;
export const where = () => ({ __constraint: "where" });
export const orderBy = () => ({ __constraint: "orderBy" });
export const limit = () => ({ __constraint: "limit" });

const docSnap = (data) => ({
  id: (data && data.id) || "seed",
  exists: () => Boolean(data),
  data: () => data || undefined,
});

const querySnap = (rows) => ({
  docs: rows.map((r) => ({ id: r.id, data: () => r, ref: refOf("doc", [r.id]) })),
  size: rows.length,
  empty: rows.length === 0,
  forEach(fn) { this.docs.forEach(fn); },
});

/* users/{uid}/assessees -> "assessees". Anything that is not a collection
   directly under the signed-in user has no seed and reads as empty, which is
   how an unconnected integration is meant to look. */
const collectionName = (path) => {
  const parts = path.split("/");
  return parts.length === 3 && parts[0] === "users" ? parts[2] : null;
};

const isProfileDoc = (path) => /^users\/[^/]+$/.test(path);

export function onSnapshot(ref, next) {
  const cb = typeof next === "function" ? next : next && next.next;
  if (cb) {
    // Asynchronously, like the real thing — a synchronous first emission would
    // paper over loading states the screens genuinely have.
    seed().then(({ SEED, PROFILE }) => {
      if (ref.kind === "doc") {
        cb(docSnap(isProfileDoc(ref.path) ? PROFILE : null));
      } else {
        cb(querySnap(SEED[collectionName(ref.path)] || []));
      }
    });
  }
  return () => {};
}

export const getDoc = async (ref) => {
  const { PROFILE } = await seed();
  return docSnap(isProfileDoc(ref.path) ? PROFILE : null);
};

export const getDocs = async (ref) => {
  const { SEED } = await seed();
  return querySnap(SEED[collectionName(ref.path)] || []);
};

/* Writes. The harness never clicks anything that saves, but a screen may call
   one on mount (the session stamp does), so they resolve rather than throw. */
export const addDoc = async (ref, data) => refOf("doc", [ref.path, "new"]) && { id: "new", ...data };
export const setDoc = async () => {};
export const updateDoc = async () => {};
export const deleteDoc = async () => {};
export const writeBatch = () => ({ set() {}, update() {}, delete() {}, commit: async () => {} });
export const runTransaction = async (db, fn) =>
  fn({ get: async (ref) => getDoc(ref), set() {}, update() {} });

export const initializeFirestore = () => ({ __db: true });
export const persistentLocalCache = () => ({});
export const persistentSingleTabManager = () => ({});
export const connectFirestoreEmulator = () => {};
export const serverTimestamp = () => new Date().toISOString();
