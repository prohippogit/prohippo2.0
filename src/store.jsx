/* ProHippo — per-user data store backed by Cloud Firestore */
import React from "react";
import {
  collection,
  doc,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  setDoc,
  getDocs,
  writeBatch,
  runTransaction,
} from "firebase/firestore";
import { db } from "./firebase";
import { useAuth } from "./auth";

/* ---------------- date / money helpers (pure) ---------------- */

export const toISO = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const todayISO = () => toISO(new Date());

export const daysAway = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return toISO(d);
};

export const fyOf = (iso) => {
  const d = new Date(iso + "T00:00:00");
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${String(y).slice(2)}-${String(y + 1).slice(2)}`;
};

export const invoiceStatus = (inv) => {
  const received = inv.received || 0;
  if (received >= inv.amount) return "Paid";
  if (received > 0) return "Partial";
  if (inv.due && inv.due < todayISO()) return "Overdue";
  return "Outstanding";
};

export const invoiceOutstanding = (inv) => Math.max(0, inv.amount - (inv.received || 0));

const COLLECTIONS = ["assessees", "matters", "hearings", "notices", "invoices", "communications", "todos"];

const AVATAR_COLORS = ["violet", "pink", "amber", "mint"];
export const nextColor = (assessees) => AVATAR_COLORS[assessees.length % AVATAR_COLORS.length];

/* ---------------- sample data (dates relative to today) ---------------- */

export function buildSampleData() {
  const assessees = [
    { name: "Rajesh M. Shah", pan: "ABCPS1234F", status: "Individual", group: "Shah Group", mobile: "+91 98250 11234", email: "rajesh.shah@example.com", staff: "Priya Mehta", color: "violet", address: "B-204, Mahalaxmi Heights, Navrangpura, Ahmedabad 380009" },
    { name: "Shah Textiles Pvt. Ltd.", pan: "AABCS9821K", status: "Company", group: "Shah Group", mobile: "+91 98245 88210", email: "accounts@shahtextiles.in", staff: "Priya Mehta", color: "pink", address: "Plot 12, GIDC Naroda, Ahmedabad 382330" },
    { name: "Mehul Patel & Sons HUF", pan: "AAFHM2210C", status: "HUF", group: "Patel Family", mobile: "+91 99099 22310", email: "mehul.patel@example.com", staff: "Arjun Desai", color: "amber", address: "7, Shantinagar Society, Maninagar, Ahmedabad 380008" },
    { name: "Nirvana Infotech LLP", pan: "AALFN6712M", status: "LLP", group: "Nirvana Group", mobile: "+91 90999 14523", email: "ca@nirvanainfotech.com", staff: "Arjun Desai", color: "violet", address: "801, Titanium City Centre, Prahladnagar, Ahmedabad 380015" },
    { name: "Kavita R. Joshi", pan: "BHJPK4517A", status: "Individual", group: "", mobile: "+91 98980 09812", email: "kavita.j@example.com", staff: "Priya Mehta", color: "mint", address: "22, Suryakiran Bungalows, Bopal, Ahmedabad 380058" },
    { name: "Vinod Bros. Trading", pan: "AAFFV1209L", status: "Firm", group: "Vinod Bros.", mobile: "+91 99879 31200", email: "vinodbros@example.in", staff: "Riya Kapoor", color: "pink", address: "34, New Cloth Market, Sarangpur, Ahmedabad 380002" },
    { name: "Hari Om Charitable Trust", pan: "AAATH7621J", status: "Trust", group: "", mobile: "+91 98765 43210", email: "trust@hariomtrust.org", staff: "Riya Kapoor", color: "amber", address: "Hari Om Bhavan, Ashram Road, Ahmedabad 380009" },
  ];
  const matters = [
    { type: "ITAT", assessee: "Rajesh M. Shah", pan: "ABCPS1234F", ay: "2017-18", section: "", ref: "ITA No. 1244/Ahd/2024", bench: "Ahmedabad 'A' Bench", status: "Active", priority: "high", staff: "Priya Mehta" },
    { type: "Scrutiny", assessee: "Shah Textiles Pvt. Ltd.", pan: "AABCS9821K", ay: "2021-22", section: "142(1)", ref: "", bench: "Circle 4(1), Ahmedabad", status: "Pending", priority: "medium", staff: "Priya Mehta" },
    { type: "CIT(A)", assessee: "Mehul Patel & Sons HUF", pan: "AAFHM2210C", ay: "2019-20", section: "250", ref: "Appeal 1029/AHD/CIT(A)/2024-25", bench: "NFAC", status: "Submitted", priority: "medium", staff: "Arjun Desai" },
    { type: "Scrutiny", assessee: "Nirvana Infotech LLP", pan: "AALFN6712M", ay: "2020-21", section: "143(2)", ref: "", bench: "Circle 2(2), Surat", status: "Active", priority: "low", staff: "Arjun Desai" },
    { type: "Penalty", assessee: "Vinod Bros. Trading", pan: "AAFFV1209L", ay: "2018-19", section: "271(1)(c)", ref: "", bench: "Circle 3, Mumbai", status: "Pending", priority: "high", staff: "Riya Kapoor" },
    { type: "ITAT", assessee: "Vinod Bros. Trading", pan: "AAFFV1209L", ay: "2018-19", section: "", ref: "ITA No. 0987/Mum/2024", bench: "Mumbai 'C' Bench", status: "Active", priority: "high", staff: "Riya Kapoor" },
    { type: "Rectification", assessee: "Kavita R. Joshi", pan: "BHJPK4517A", ay: "2023-24", section: "154", ref: "", bench: "CPC, Bengaluru", status: "Submitted", priority: "low", staff: "Priya Mehta" },
    { type: "Scrutiny", assessee: "Hari Om Charitable Trust", pan: "AAATH7621J", ay: "2022-23", section: "143(2)", ref: "", bench: "Exemption Ward, Ahmedabad", status: "Active", priority: "low", staff: "Riya Kapoor" },
  ];
  const hearings = [
    { assessee: "Rajesh M. Shah", pan: "ABCPS1234F", ay: "2017-18", authority: "ITAT", bench: "Ahmedabad 'A' Bench", section: "", date: daysAway(1), time: "11:30", mode: "Physical", status: "Upcoming", priority: "high", ita: "ITA No. 1244/Ahd/2024", staff: "Priya Mehta" },
    { assessee: "Shah Textiles Pvt. Ltd.", pan: "AABCS9821K", ay: "2021-22", authority: "Scrutiny", bench: "Circle 4(1), Ahmedabad", section: "142(1)", date: daysAway(2), time: "14:00", mode: "e-Proceeding", status: "Upcoming", priority: "medium", ita: "", staff: "Priya Mehta" },
    { assessee: "Mehul Patel & Sons HUF", pan: "AAFHM2210C", ay: "2019-20", authority: "CIT(A)", bench: "NFAC", section: "250", date: daysAway(6), time: "10:30", mode: "Video Conference", status: "Upcoming", priority: "medium", ita: "", staff: "Arjun Desai" },
    { assessee: "Nirvana Infotech LLP", pan: "AALFN6712M", ay: "2020-21", authority: "Scrutiny", bench: "Circle 2(2), Surat", section: "143(2)", date: daysAway(8), time: "11:00", mode: "e-Proceeding", status: "Upcoming", priority: "low", ita: "", staff: "Arjun Desai" },
    { assessee: "Vinod Bros. Trading", pan: "AAFFV1209L", ay: "2018-19", authority: "ITAT", bench: "Mumbai 'C' Bench", section: "", date: daysAway(13), time: "15:00", mode: "Physical", status: "Upcoming", priority: "high", ita: "ITA No. 0987/Mum/2024", staff: "Riya Kapoor" },
    { assessee: "Hari Om Charitable Trust", pan: "AAATH7621J", ay: "2022-23", authority: "Scrutiny", bench: "Exemption Ward, Ahmedabad", section: "143(2)", date: daysAway(15), time: "12:30", mode: "e-Proceeding", status: "Upcoming", priority: "low", ita: "", staff: "Riya Kapoor" },
  ];
  const notices = [
    { assessee: "Rajesh M. Shah", pan: "ABCPS1234F", ay: "2017-18", section: "142(1)", authority: "ITAT", date: daysAway(-15), din: "ITBA/AST/F/142(1)/2026-27/103412", status: "Awaiting review", subject: "Appeal hearing — addition u/s 68 of unexplained cash credits", bench: "Ahmedabad 'A' Bench", mode: "Physical", hearingDate: daysAway(1), hearingTime: "11:30", ita: "ITA No. 1244/Ahd/2024", documents: ["Copy of audited financial statements for AY 2017-18", "Bank statements of all accounts for FY 2016-17", "Confirmations from unsecured lenders with PAN & ITR copies", "Source of cash deposits exceeding ₹2 lakh", "Ledger copies for sundry creditors", "Computation of income and ITR acknowledgement"] },
    { assessee: "Nirvana Infotech LLP", pan: "AALFN6712M", ay: "2020-21", section: "143(2)", authority: "Scrutiny", date: daysAway(-8), din: "ITBA/AST/F/143(2)/2026-27/103299", status: "Reply drafted", subject: "Notice for scrutiny assessment", bench: "Circle 2(2), Surat", mode: "e-Proceeding", hearingDate: "", hearingTime: "", ita: "", documents: [] },
    { assessee: "Mehul Patel & Sons HUF", pan: "AAFHM2210C", ay: "2019-20", section: "250", authority: "CIT(A)", date: daysAway(-6), din: "ITBA/APL/F/250/2026-27/104088", status: "Submitted", subject: "Appeal fixed for hearing before NFAC", bench: "NFAC", mode: "Video Conference", hearingDate: daysAway(6), hearingTime: "10:30", ita: "", documents: [] },
    { assessee: "Hari Om Charitable Trust", pan: "AAATH7621J", ay: "2022-23", section: "143(2)", authority: "Scrutiny", date: daysAway(-5), din: "ITBA/AST/F/143(2)/2026-27/104201", status: "Awaiting review", subject: "Scrutiny — exemption claimed u/s 11", bench: "Exemption Ward, Ahmedabad", mode: "e-Proceeding", hearingDate: daysAway(15), hearingTime: "12:30", ita: "", documents: ["Trust deed and registration certificate u/s 12A", "Audited accounts with Form 10B"] },
  ];
  const invoices = [
    { number: `PH/${fyOf(daysAway(-12))}/0124`, assessee: "Rajesh M. Shah", date: daysAway(-12), ay: "2017-18", service: "ITAT appeal — Drafting & hearing fees", amount: 125000, received: 0, due: daysAway(18) },
    { number: `PH/${fyOf(daysAway(-15))}/0123`, assessee: "Shah Textiles Pvt. Ltd.", date: daysAway(-15), ay: "2021-22", service: "Scrutiny assessment professional fees", amount: 85000, received: 85000, due: daysAway(15) },
    { number: `PH/${fyOf(daysAway(-19))}/0122`, assessee: "Mehul Patel & Sons HUF", date: daysAway(-19), ay: "2019-20", service: "CIT(A) appeal drafting", amount: 65000, received: 0, due: daysAway(11) },
    { number: `PH/${fyOf(daysAway(-22))}/0121`, assessee: "Nirvana Infotech LLP", date: daysAway(-22), ay: "2020-21", service: "Scrutiny assessment + Penalty reply", amount: 132000, received: 50000, due: daysAway(8) },
    { number: `PH/${fyOf(daysAway(-28))}/0120`, assessee: "Vinod Bros. Trading", date: daysAway(-28), ay: "2018-19", service: "ITAT appeal filing", amount: 54200, received: 0, due: daysAway(-2) },
    { number: `PH/${fyOf(daysAway(-31))}/0119`, assessee: "Kavita R. Joshi", date: daysAway(-31), ay: "2023-24", service: "ITR filing + consultation", amount: 18500, received: 18500, due: daysAway(-1) },
  ];
  const communications = [
    { channel: "WhatsApp", to: "Rajesh M. Shah", subject: "Documents required for AY 2017-18 — ITAT hearing", body: "", time: new Date().toISOString(), template: "Document request", status: "Sent" },
    { channel: "Email", to: "ca@nirvanainfotech.com", subject: "Income Tax Notice u/s 143(2) — submission of details", body: "", time: new Date(Date.now() - 86400000).toISOString(), template: "Reminder", status: "Sent" },
    { channel: "WhatsApp", to: "Mehul Patel & Sons HUF", subject: "CIT(A) appeal hearing — please confirm attendance", body: "", time: new Date(Date.now() - 3 * 86400000).toISOString(), template: "Hearing confirmation", status: "Sent" },
  ];
  const todos = [
    { text: "Submit Form 35 for Patel HUF appeal", done: true },
    { text: "Draft reply for Nirvana Infotech u/s 143(2)", done: false, tag: "Due tomorrow", tagColor: "danger" },
    { text: "Send document request — Rajesh Shah (AY 17-18)", done: false, tag: "WhatsApp", tagColor: "info" },
    { text: "Reconcile receipts ₹85,000 from Shah Textiles", done: false, tag: "₹85,000", tagColor: "success" },
  ];
  return { assessees, matters, hearings, notices, invoices, communications, todos, invoiceSeq: 124 };
}

/* ---------------- context ---------------- */

const emptyData = () => ({
  assessees: [], matters: [], hearings: [], notices: [], invoices: [], communications: [], todos: [],
  profile: { ownerName: "", firmName: "" },
  invoiceSeq: 120,
});

const DataCtx = React.createContext(null);
export const useData = () => React.useContext(DataCtx);

export function DataProvider({ children }) {
  const { user } = useAuth();
  const uid = user?.uid;

  const [data, setData] = React.useState(emptyData);
  const [profile, setProfile] = React.useState(null); // full users/{uid} doc, or null if none yet
  const [profileLoading, setProfileLoading] = React.useState(true);
  const [ready, setReady] = React.useState(false);
  const [toast, setToast] = React.useState(null);

  React.useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const userRef = React.useCallback(() => doc(db, "users", uid), [uid]);
  const colRef = React.useCallback((name) => collection(db, "users", uid, name), [uid]);

  // Subscribe to profile + all collections for this user.
  React.useEffect(() => {
    if (!uid) return;
    setProfileLoading(true);
    setReady(false);
    setData(emptyData());
    const loaded = new Set();

    const unsubProfile = onSnapshot(doc(db, "users", uid), (snap) => {
      if (snap.exists()) {
        const p = snap.data();
        setProfile({ id: uid, ...p });
        setData((d) => ({ ...d, profile: { ownerName: p.ownerName || "", firmName: p.firmName || "" }, invoiceSeq: p.invoiceSeq || 120 }));
      } else {
        setProfile(null);
      }
      setProfileLoading(false);
    });

    const unsubs = COLLECTIONS.map((name) =>
      onSnapshot(colRef(name), (snap) => {
        const rows = snap.docs.map((doc_) => ({ id: doc_.id, ...doc_.data() }));
        rows.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
        setData((d) => ({ ...d, [name]: rows }));
        loaded.add(name);
        if (loaded.size === COLLECTIONS.length) setReady(true);
      })
    );

    return () => { unsubProfile(); unsubs.forEach((u) => u()); };
  }, [uid, colRef]);

  const api = React.useMemo(() => {
    const notify = (msg, icon = "check") => setToast({ msg, icon });
    const fail = (e) => { console.error(e); notify("Couldn't save — check your connection", "alert"); };

    const addTo = (name) => async (rec) => {
      const payload = { createdAt: new Date().toISOString(), ...rec };
      try {
        const r = await addDoc(colRef(name), payload);
        return { id: r.id, ...payload };
      } catch (e) { fail(e); return null; }
    };
    const updateIn = (name) => (id, patch) => updateDoc(doc(db, "users", uid, name, id), patch).catch(fail);
    const removeFrom = (name) => (id) => deleteDoc(doc(db, "users", uid, name, id)).catch(fail);

    return {
      notify,
      // profile
      createProfile: async ({ ownerName, firmName }) => {
        await setDoc(userRef(), {
          ownerName: (ownerName || "").trim(),
          firmName: (firmName || "").trim(),
          email: user?.email || "",
          invoiceSeq: 120,
          createdAt: new Date().toISOString(),
        }, { merge: true });
      },
      setProfile: (patch) => updateDoc(userRef(), patch).catch(fail),
      // collections
      addAssessee: addTo("assessees"), updateAssessee: updateIn("assessees"),
      /* The app is assessee-centric: deleting an assessee also removes every
         record linked to them. Returns the number of linked records removed,
         or null on failure. */
      removeAssessee: async (a) => {
        try {
          const linkedBy = {
            matters: (r) => (a.pan && r.pan === a.pan) || r.assessee === a.name,
            hearings: (r) => (a.pan && r.pan === a.pan) || r.assessee === a.name,
            notices: (r) => (a.pan && r.pan === a.pan) || r.assessee === a.name,
            invoices: (r) => r.assessee === a.name,
            communications: (r) => r.to === a.name || (a.email && r.to === a.email) || (a.mobile && r.to === a.mobile),
          };
          const refs = [doc(db, "users", uid, "assessees", a.id)];
          for (const [name, isLinked] of Object.entries(linkedBy)) {
            const snap = await getDocs(colRef(name));
            snap.docs.forEach((d) => { if (isLinked(d.data())) refs.push(d.ref); });
          }
          // Firestore batches are capped at 500 ops; chunk to be safe.
          for (let i = 0; i < refs.length; i += 450) {
            const batch = writeBatch(db);
            refs.slice(i, i + 450).forEach((ref) => batch.delete(ref));
            await batch.commit();
          }
          return refs.length - 1;
        } catch (e) { fail(e); return null; }
      },
      addMatter: addTo("matters"), updateMatter: updateIn("matters"), removeMatter: removeFrom("matters"),
      addHearing: addTo("hearings"), updateHearing: updateIn("hearings"), removeHearing: removeFrom("hearings"),
      addNotice: addTo("notices"), updateNotice: updateIn("notices"), removeNotice: removeFrom("notices"),
      addCommunication: addTo("communications"),
      addTodo: addTo("todos"), updateTodo: updateIn("todos"), removeTodo: removeFrom("todos"),
      addInvoice: async (rec) => {
        try {
          const invRef = doc(colRef("invoices"));
          let number = rec.number;
          await runTransaction(db, async (tx) => {
            const snap = await tx.get(userRef());
            const seq = ((snap.data()?.invoiceSeq) || 120) + 1;
            number = rec.number || `PH/${fyOf(rec.date || todayISO())}/${String(seq).padStart(4, "0")}`;
            tx.set(invRef, { received: 0, ...rec, number, createdAt: new Date().toISOString() });
            tx.update(userRef(), { invoiceSeq: seq });
          });
          return { id: invRef.id, received: 0, ...rec, number };
        } catch (e) { fail(e); return null; }
      },
      updateInvoice: updateIn("invoices"), removeInvoice: removeFrom("invoices"),
      loadSampleData: async () => {
        try {
          const sample = buildSampleData();
          const batch = writeBatch(db);
          COLLECTIONS.forEach((name) => {
            (sample[name] || []).forEach((rec, i) => {
              const ref = doc(colRef(name));
              batch.set(ref, { createdAt: new Date(Date.now() + i).toISOString(), ...rec });
            });
          });
          batch.update(userRef(), { invoiceSeq: sample.invoiceSeq });
          await batch.commit();
          notify("Sample data loaded — replace it with your own records anytime");
        } catch (e) { fail(e); }
      },
      clearAllData: async () => {
        try {
          for (const name of COLLECTIONS) {
            const snap = await getDocs(colRef(name));
            // Firestore batches are capped at 500 ops; chunk to be safe.
            for (let i = 0; i < snap.docs.length; i += 450) {
              const batch = writeBatch(db);
              snap.docs.slice(i, i + 450).forEach((d) => batch.delete(d.ref));
              await batch.commit();
            }
          }
          await updateDoc(userRef(), { invoiceSeq: 120 });
          notify("All practice data cleared");
        } catch (e) { fail(e); }
      },
    };
  }, [uid, colRef, userRef, user]);

  const value = React.useMemo(
    () => ({ data, profile, profileLoading, ready, ...api, toast }),
    [data, profile, profileLoading, ready, api, toast]
  );

  return <DataCtx.Provider value={value}>{children}</DataCtx.Provider>;
}

/* ---------------- derived helpers (pure functions over data) ---------------- */

export const upcomingHearings = (data) =>
  data.hearings
    .filter((h) => h.date >= todayISO() && h.status !== "Adjourned")
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

export const assesseeStats = (data, a) => {
  const matters = data.matters.filter((m) => m.pan === a.pan && !["Closed", "Decided"].includes(m.status));
  const hearings = upcomingHearings(data).filter((h) => h.pan === a.pan);
  const invoices = data.invoices.filter((i) => i.assessee === a.name);
  const outstanding = invoices.reduce((s, i) => s + invoiceOutstanding(i), 0);
  return { matters: matters.length, hearings, outstanding, invoices };
};

export const totalOutstanding = (data) => data.invoices.reduce((s, i) => s + invoiceOutstanding(i), 0);

export const overdueAmount = (data) =>
  data.invoices.filter((i) => invoiceStatus(i) === "Overdue").reduce((s, i) => s + invoiceOutstanding(i), 0);

// Notices worth surfacing for review on the dashboard. A freshly added
// assessee pulls in years of history, so we do NOT show every unreviewed
// notice — only those that are actually actionable now: issued within the
// last 10 days, OR carrying a hearing / response-due date still in the future.
// Notices the user has ticked "read" drop off regardless.
export const awaitingNotices = (data) => {
  const today = todayISO();
  const tenDaysAgo = toISO(new Date(Date.now() - 10 * 86400000));
  return data.notices.filter((n) => {
    if (n.read) return false;
    if (n.status && n.status !== "Awaiting review") return false;
    const recent = n.date && n.date >= tenDaysAgo && n.date <= today;
    const due = n.responseDueDate || n.hearingDate || "";
    const future = due && due >= today;
    return recent || future;
  });
};

export function downloadCSV(filename, headers, rows) {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers, ...rows].map((r) => r.map(esc).join(",")).join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
