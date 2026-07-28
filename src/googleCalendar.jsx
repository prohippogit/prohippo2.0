/* ProHippo — Google Calendar integration, client side.
 *
 * Three jobs:
 *   1. Subscribe to the integration doc so every screen can show live status.
 *   2. Wrap the callables that connect, sync and disconnect.
 *   3. Work out what belongs in users/{uid}/calendarDeadlines — the mirror
 *      CalendarDeadlineMirror.jsx keeps written.
 *
 * (3) is the reason this file exists rather than the backend deriving deadlines
 * itself. Appeal limitation is worked out by src/appeals.js — a module whose own
 * header explains that a limitation date shown one day late is what costs an
 * appeal. Porting that arithmetic into Cloud Functions would mean two copies of
 * it drifting apart. Instead the client mirrors the answers it already computes
 * into a plain { title, date } collection, and the sync engine stays ignorant of
 * where a date came from.
 */
import React from "react";
import { collection, doc, getDocs, onSnapshot, setDoc, writeBatch } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "./firebase";
import { useAuth } from "./auth";
import { todayISO } from "./store";
import { appealableOrders } from "./appeals";

const INTEGRATION = ["integrations", "googleCalendar"];

/* ---------------- live status ---------------- */

export function useCalendarConfig() {
  const { user } = useAuth();
  const uid = user?.uid;
  // The uid the held snapshot belongs to is part of the state, so switching
  // accounts reads as "loading" rather than briefly showing the previous
  // practitioner's connection.
  const [snapshot, setSnapshot] = React.useState({ uid: null, cfg: null });

  React.useEffect(() => {
    if (!uid) return undefined;
    return onSnapshot(
      doc(db, "users", uid, ...INTEGRATION),
      (snap) => setSnapshot({ uid, cfg: snap.exists() ? snap.data() : null }),
      (e) => { console.error("calendar config subscribe:", e); setSnapshot({ uid, cfg: null }); }
    );
  }, [uid]);

  const loading = Boolean(uid) && snapshot.uid !== uid;
  const cfg = loading ? null : snapshot.cfg;
  const status = cfg?.status || "disconnected";
  return {
    cfg,
    loading,
    status,
    connected: status === "connected",
    needsReauth: status === "needsReauth",
  };
}

// "2 minutes ago" while that's meaningful, a date once it isn't.
export const relativeSyncTime = (iso) => {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
};

/* ---------------- actions ---------------- */

export function useCalendarActions() {
  const { user } = useAuth();
  const uid = user?.uid;

  return React.useMemo(() => ({
    // Sends the browser to Google's consent screen. It comes back to the app
    // via the calendarAuthCallback function with ?calendar=… set.
    connect: async (email) => {
      const call = httpsCallable(functions, "calendarAuthUrl");
      const res = await call({ email: String(email || "").trim().toLowerCase() });
      const url = res.data?.url;
      if (!url) throw new Error("Could not start Google sign-in. Please try again.");
      window.location.assign(url);
    },
    syncNow: async () => {
      const call = httpsCallable(functions, "syncCalendarNow");
      const res = await call({});
      return res.data || {};
    },
    disconnect: async (deleteCalendar = false) => {
      const call = httpsCallable(functions, "disconnectGoogleCalendar");
      await call({ deleteCalendar });
    },
    setOption: (patch) => setDoc(doc(db, "users", uid, ...INTEGRATION), patch, { merge: true }),
    feedLink: async (rotate = false) => {
      const call = httpsCallable(functions, "calendarFeedLink");
      const res = await call({ rotate });
      return res.data?.url || "";
    },
  }), [uid]);
}

/* Reads the ?calendar=… the OAuth callback returns with, reports it, and wipes
   it from the address bar so a refresh doesn't replay the message. */
export function useCalendarReturn(onResult) {
  const handled = React.useRef(false);
  React.useEffect(() => {
    if (handled.current) return;
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("calendar");
    if (!outcome) return;
    handled.current = true;

    const messages = {
      connected: ["Google Calendar connected — syncing your hearings now", "check"],
      cancelled: ["Google Calendar connection cancelled", "alert"],
      mismatch: [
        `You approved ${params.get("granted") || "a different account"}, but asked to sync ${params.get("requested") || "another"}. Nothing was connected.`,
        "alert",
      ],
      error: [params.get("reason") || "Google Calendar could not be connected.", "alert"],
    };
    const [message, icon] = messages[outcome] || messages.error;

    ["calendar", "granted", "requested", "reason"].forEach((k) => params.delete(k));
    const query = params.toString();
    window.history.replaceState({}, document.title, window.location.pathname + (query ? `?${query}` : ""));

    onResult({ outcome, message, icon });
  }, [onResult]);
}

/* ---------------- the deadline mirror ---------------- */

const MIRRORED_FIELDS = ["kind", "title", "date", "assessee", "pan", "ay", "detail"];

const panKey = (r) => `${(r.pan || "").toUpperCase()}|${r.ay || ""}|`;

/* Everything with a date the practice must not miss, other than hearings
   (which sync straight from their own collection). */
export function buildDeadlines(data) {
  const today = todayISO();
  const rows = [];

  // Appeal limitation, straight from the appeals engine.
  appealableOrders(data).forEach((a) => {
    if (!a.deadline || a.deadline < today || !a.notice?.id) return;
    rows.push({
      id: `appeal_${a.notice.id}`,
      kind: "appeal",
      title: `${a.route} appeal — last date to file`,
      date: a.deadline,
      assessee: a.notice.assessee || "",
      pan: a.notice.pan || "",
      ay: a.notice.ay || "",
      detail: [a.limitLabel, a.form].filter(Boolean).join(" · "),
    });
  });

  /* Response due dates. A portal-ingested notice already creates a hearing on
     its due date (see ingestPortalNotice), so anything matching a hearing for
     the same party on the same day is skipped — otherwise the practitioner gets
     the same obligation twice in one day of their calendar. */
  const hearingDays = new Set((data.hearings || []).map((h) => panKey(h) + h.date));
  (data.notices || []).forEach((n) => {
    const due = n.responseDueDate || n.hearingDate || "";
    if (!due || due < today || !n.id) return;
    if (n.status === "Submitted") return;
    if (hearingDays.has(panKey(n) + due)) return;
    rows.push({
      id: `notice_${n.id}`,
      kind: "notice",
      title: `Reply due — ${n.authority || "notice"}${n.section ? ` u/s ${n.section}` : ""}`,
      date: due,
      assessee: n.assessee || "",
      pan: n.pan || "",
      ay: n.ay || "",
      detail: n.subject || "",
    });
  });

  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

export const fingerprintDeadlines = (rows) =>
  JSON.stringify(rows.map((r) => [r.id, ...MIRRORED_FIELDS.map((k) => r[k] || "")]));

// Write only what actually differs — every write here fires a Firestore trigger
// and, through it, a Google API call.
export async function writeDeadlineMirror(uid, rows) {
  const col = collection(db, "users", uid, "calendarDeadlines");
  const existing = await getDocs(col);
  const wanted = new Map(rows.map((r) => [r.id, r]));
  const ops = [];

  existing.forEach((snap) => {
    const want = wanted.get(snap.id);
    if (!want) { ops.push({ type: "delete", ref: snap.ref }); return; }
    wanted.delete(snap.id);
    const cur = snap.data() || {};
    const changed = MIRRORED_FIELDS.some((k) => (cur[k] || "") !== (want[k] || ""));
    if (changed) ops.push({ type: "set", ref: snap.ref, data: want });
  });
  wanted.forEach((want) => ops.push({ type: "set", ref: doc(col, want.id), data: want }));

  // Firestore caps a batch at 500 operations.
  for (let i = 0; i < ops.length; i += 400) {
    const batch = writeBatch(db);
    ops.slice(i, i + 400).forEach((op) => {
      if (op.type === "delete") { batch.delete(op.ref); return; }
      const fields = { ...op.data };
      delete fields.id; // the id is the document name, not a field
      batch.set(op.ref, fields, { merge: true });
    });
    await batch.commit();
  }
  return ops.length;
}
