/* ProHippo — ITAT email ingest, client side.
 *
 * Three jobs, and none of them is parsing: the Tribunal's emails are read in
 * Cloud Functions (functions/itatEmailParse.js) and this file only ever shows
 * what came back.
 *
 *   1. Subscribe to the integration document, so the address, the last email and
 *      Gmail's pending verification code are live on screen.
 *   2. Subscribe to the review queue — the emails waiting for one look.
 *   3. Wrap the callables that mint the address, apply an email and dismiss one.
 *
 * Why nothing here writes a matter directly: applying an email has to resolve an
 * assessee, derive the document IDs that stop a re-sent email creating a second
 * matter, and mark a superseded hearing adjourned. That belongs in one place,
 * server-side, where the webhook can reach it too.
 */
import React from "react";
import { collection, doc, onSnapshot, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "./firebase";
import { useAuth } from "./auth";

const INTEGRATION = ["integrations", "itatEmail"];

/* ---------------- live status ---------------- */

export function useItatEmailConfig() {
  const { user } = useAuth();
  const uid = user?.uid;
  // The uid the snapshot belongs to is part of the state, so switching accounts
  // reads as "loading" rather than briefly showing the previous practice's
  // address — which someone could then paste into a forwarding rule.
  const [snapshot, setSnapshot] = React.useState({ uid: null, cfg: null });

  React.useEffect(() => {
    if (!uid) return undefined;
    return onSnapshot(
      doc(db, "users", uid, ...INTEGRATION),
      (snap) => setSnapshot({ uid, cfg: snap.exists() ? snap.data() : null }),
      (e) => { console.error("itat email config subscribe:", e); setSnapshot({ uid, cfg: null }); }
    );
  }, [uid]);

  const loading = Boolean(uid) && snapshot.uid !== uid;
  const cfg = loading ? null : snapshot.cfg;
  return {
    cfg,
    loading,
    address: cfg?.address || "",
    // True when the address came from the practice's own mail provider rather
    // than being minted on ProHippo's domain. The two are set up differently,
    // so the card has to know which it is looking at.
    provided: Boolean(cfg?.provided),
    connected: Boolean(cfg?.lastReceivedAt),
  };
}

/* Gmail's verification code, while it is still worth showing.
 *
 * It is a one-time code typed straight back into a settings page the user has
 * open in the next tab, so it is only useful for minutes. Leaving a stale code
 * on screen is worse than showing none: someone comes back an hour later, types
 * a dead number, and concludes the feature is broken. */
const CODE_FRESH_MS = 30 * 60 * 1000;

/* The wall clock, as an external store.
 *
 * Whether the code is still worth showing depends on the time of day, which is
 * not a value React can derive from props or state — reading it during a render
 * would make the render impure and its result unstable. useSyncExternalStore is
 * the sanctioned way to read a changing outside source, and it also gets the
 * re-render for free: the snapshot is a whole minute, so subscribing components
 * re-render once a minute rather than on every tick. */
const clock = {
  subscribe(onChange) {
    const id = setInterval(onChange, 60000);
    return () => clearInterval(id);
  },
  now: () => Math.floor(Date.now() / 60000) * 60000,
};

export function usePendingGmailCode() {
  const { cfg } = useItatEmailConfig();
  const pending = cfg?.pendingCode || null;
  const now = React.useSyncExternalStore(clock.subscribe, clock.now, clock.now);

  if (!pending?.at) return null;
  // Either half is enough to be worth showing: the link alone completes the
  // handshake, and the code alone is what Gmail's own settings box wants.
  if (!pending.code && !pending.confirmUrl) return null;
  // A dead code left on screen is worse than none: someone comes back an hour
  // later, types a number Gmail has already forgotten, and concludes the whole
  // feature is broken.
  if (now - new Date(pending.at).getTime() > CODE_FRESH_MS) return null;
  return pending;
}

/* An arrival that produced no card, while it still explains something.
 *
 * The queue counts what is waiting and says nothing about the rest, so forward
 * two emails, see one card, and there is no way to tell a message that was
 * rejected from one that never arrived. Both look like mail going missing, and
 * only one of them is a problem worth chasing. */
const UNFILED_FRESH_MS = 24 * 60 * 60 * 1000;

export const UNFILED_REASON = {
  duplicate: "it was a copy of one already on this list",
  dropped: "it was not from the Tribunal, so it was discarded unread",
};

export function useUnfiledArrival() {
  const { cfg } = useItatEmailConfig();
  const now = React.useSyncExternalStore(clock.subscribe, clock.now, clock.now);

  const at = cfg?.lastUnfiledAt;
  if (!at) return null;
  const ms = new Date(at).getTime();
  // Past a day it stops explaining today's missing email and starts being a
  // notice about something nobody is looking for any more.
  if (!Number.isFinite(ms) || now - ms > UNFILED_FRESH_MS) return null;
  return { at, outcome: cfg.lastUnfiledOutcome || "" };
}

/* Every message the address has taken, by what became of it. Cumulative since
   setup — the point is that the numbers add up, so nothing that arrived is
   unaccounted for. */
export function mailTally(cfg) {
  const n = (v) => Number(v) || 0;
  const filed = n(cfg?.receivedCount);
  const duplicate = n(cfg?.duplicateCount);
  const dropped = n(cfg?.droppedCount);
  return { filed, duplicate, dropped, total: filed + duplicate + dropped };
}

/* ---------------- the review queue ---------------- */

/* Everything the address has received that is still waiting for a decision.
 *
 * Ordered in memory rather than by the query: `where` plus `orderBy` on
 * different fields needs a composite index, and this collection is a handful of
 * documents. */
export function useItatMail() {
  const { user } = useAuth();
  const uid = user?.uid;
  const [state, setState] = React.useState({ uid: null, rows: [] });

  React.useEffect(() => {
    if (!uid) return undefined;
    return onSnapshot(
      query(collection(db, "users", uid, "itatMail"), where("status", "in", ["needs-review", "unrecognised"])),
      (snap) => setState({
        uid,
        rows: snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => String(b.receivedAt || "").localeCompare(String(a.receivedAt || ""))),
      }),
      (e) => { console.error("itat mail subscribe:", e); setState({ uid, rows: [] }); }
    );
  }, [uid]);

  const loading = Boolean(uid) && state.uid !== uid;
  const rows = loading ? [] : state.rows;
  return {
    rows,
    loading,
    // Only the two the Tribunal actually sent are actionable; an unrecognised
    // message is kept so a changed template is visible, not so it can be applied.
    pending: rows.filter((r) => r.status === "needs-review"),
  };
}

/* ---------------- actions ---------------- */

const call = (name) => (payload) => httpsCallable(functions, name)(payload || {}).then((r) => r.data);

export const itatEmailActions = {
  ensureAddress: call("getItatEmailAddress"),
  resetAddress: call("resetItatEmailAddress"),
  useAddress: call("useItatEmailAddress"),
  apply: call("applyItatMail"),
  dismiss: call("dismissItatMail"),
};

/* ---------------- presentation helpers ---------------- */

// "2 minutes ago" while that is what someone wants to know, a date once it is not.
export function relativeTime(iso) {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "never";
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days <= 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export const MAIL_KIND_LABEL = {
  registration: "Appeal registered",
  hearing: "Hearing fixed",
  unrecognised: "Not recognised",
};

/* What this email would create, said as a sentence before anybody presses the
   button. A confirm step that does not say what it is about to do is not a
   confirm step. */
export function describeMail(row) {
  const f = row.parsed || {};
  if (row.kind === "registration") {
    return `Adds an ITAT matter for ${f.appealNo || "this appeal"}${f.ay ? `, AY ${f.ay}` : ""}.`;
  }
  if (row.kind === "hearing") {
    const when = f.date ? new Date(`${f.date}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" }) : "an unread date";
    return `Puts a hearing on ${when}${f.time ? ` at ${f.time}` : ""} in your calendar${f.bench ? `, ${f.bench}` : ""}.`;
  }
  return "Nothing — this email is not one ProHippo recognises.";
}
