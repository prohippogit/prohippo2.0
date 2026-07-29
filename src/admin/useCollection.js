/*
 * A live Firestore query as React state, for the admin console's read-only
 * tables. Deliberately thin — the console reads a handful of collections and
 * never writes through this path.
 *
 * Callers build `constraints` fresh on every render, so the query is memoised
 * against an explicit `key` describing it rather than against the array's
 * identity; otherwise the listener would be torn down and re-opened on every
 * keystroke in a search box.
 */
import React from "react";
import { collection, onSnapshot, query } from "firebase/firestore";
import { db } from "../firebase";

export function useCollection(path, constraints = [], key = "") {
  const [state, setState] = React.useState({ rows: [], loading: true, error: null });

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` describes `constraints`
  const q = React.useMemo(() => query(collection(db, path), ...constraints), [path, key]);

  React.useEffect(() => {
    return onSnapshot(
      q,
      (snap) => setState({ rows: snap.docs.map((d) => ({ id: d.id, ...d.data() })), loading: false, error: null }),
      (error) => {
        console.error(`admin: listening to ${path} failed`, error);
        // Almost always a missing `admin` claim or a composite index Firestore
        // wants building — both worth showing rather than swallowing.
        setState({ rows: [], loading: false, error });
      }
    );
  }, [q, path]);

  return state;
}
