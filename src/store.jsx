/* ProHippo — central data store (React context + localStorage persistence) */
import React from 'react';

const STORAGE_KEY = "prohippo-data-v1";

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const toISO = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const todayISO = () => toISO(new Date());

export const daysAway = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return toISO(d);
};

// Indian financial year label for an ISO date, e.g. "26-27"
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

const EMPTY = {
  assessees: [],
  matters: [],
  hearings: [],
  notices: [],
  invoices: [],
  communications: [],
  todos: [],
  invoiceSeq: 120,
  profile: { ownerName: "", firmName: "" },
};

const AVATAR_COLORS = ["violet", "pink", "amber", "mint"];

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...EMPTY, ...JSON.parse(raw) };
  } catch {
    // corrupted storage — start fresh
  }
  return EMPTY;
}

export function buildSampleData() {
  const assessees = [
    { id: "a1", name: "Rajesh M. Shah", pan: "ABCPS1234F", status: "Individual", group: "Shah Group", mobile: "+91 98250 11234", email: "rajesh.shah@example.com", staff: "Priya Mehta", color: "violet", address: "B-204, Mahalaxmi Heights, Navrangpura, Ahmedabad 380009" },
    { id: "a2", name: "Shah Textiles Pvt. Ltd.", pan: "AABCS9821K", status: "Company", group: "Shah Group", mobile: "+91 98245 88210", email: "accounts@shahtextiles.in", staff: "Priya Mehta", color: "pink", address: "Plot 12, GIDC Naroda, Ahmedabad 382330" },
    { id: "a3", name: "Mehul Patel & Sons HUF", pan: "AAFHM2210C", status: "HUF", group: "Patel Family", mobile: "+91 99099 22310", email: "mehul.patel@example.com", staff: "Arjun Desai", color: "amber", address: "7, Shantinagar Society, Maninagar, Ahmedabad 380008" },
    { id: "a4", name: "Nirvana Infotech LLP", pan: "AALFN6712M", status: "LLP", group: "Nirvana Group", mobile: "+91 90999 14523", email: "ca@nirvanainfotech.com", staff: "Arjun Desai", color: "violet", address: "801, Titanium City Centre, Prahladnagar, Ahmedabad 380015" },
    { id: "a5", name: "Kavita R. Joshi", pan: "BHJPK4517A", status: "Individual", group: "", mobile: "+91 98980 09812", email: "kavita.j@example.com", staff: "Priya Mehta", color: "mint", address: "22, Suryakiran Bungalows, Bopal, Ahmedabad 380058" },
    { id: "a6", name: "Vinod Bros. Trading", pan: "AAFFV1209L", status: "Firm", group: "Vinod Bros.", mobile: "+91 99879 31200", email: "vinodbros@example.in", staff: "Riya Kapoor", color: "pink", address: "34, New Cloth Market, Sarangpur, Ahmedabad 380002" },
    { id: "a7", name: "Hari Om Charitable Trust", pan: "AAATH7621J", status: "Trust", group: "", mobile: "+91 98765 43210", email: "trust@hariomtrust.org", staff: "Riya Kapoor", color: "amber", address: "Hari Om Bhavan, Ashram Road, Ahmedabad 380009" },
  ];
  const matters = [
    { id: "m1", type: "ITAT", assessee: "Rajesh M. Shah", pan: "ABCPS1234F", ay: "2017-18", section: "", ref: "ITA No. 1244/Ahd/2024", bench: "Ahmedabad 'A' Bench", status: "Active", priority: "high", staff: "Priya Mehta" },
    { id: "m2", type: "Scrutiny", assessee: "Shah Textiles Pvt. Ltd.", pan: "AABCS9821K", ay: "2021-22", section: "142(1)", ref: "", bench: "Circle 4(1), Ahmedabad", status: "Pending", priority: "medium", staff: "Priya Mehta" },
    { id: "m3", type: "CIT(A)", assessee: "Mehul Patel & Sons HUF", pan: "AAFHM2210C", ay: "2019-20", section: "250", ref: "Appeal 1029/AHD/CIT(A)/2024-25", bench: "NFAC", status: "Submitted", priority: "medium", staff: "Arjun Desai" },
    { id: "m4", type: "Scrutiny", assessee: "Nirvana Infotech LLP", pan: "AALFN6712M", ay: "2020-21", section: "143(2)", ref: "", bench: "Circle 2(2), Surat", status: "Active", priority: "low", staff: "Arjun Desai" },
    { id: "m5", type: "Penalty", assessee: "Vinod Bros. Trading", pan: "AAFFV1209L", ay: "2018-19", section: "271(1)(c)", ref: "", bench: "Circle 3, Mumbai", status: "Pending", priority: "high", staff: "Riya Kapoor" },
    { id: "m6", type: "ITAT", assessee: "Vinod Bros. Trading", pan: "AAFFV1209L", ay: "2018-19", section: "", ref: "ITA No. 0987/Mum/2024", bench: "Mumbai 'C' Bench", status: "Active", priority: "high", staff: "Riya Kapoor" },
    { id: "m7", type: "Rectification", assessee: "Kavita R. Joshi", pan: "BHJPK4517A", ay: "2023-24", section: "154", ref: "", bench: "CPC, Bengaluru", status: "Submitted", priority: "low", staff: "Priya Mehta" },
    { id: "m8", type: "Scrutiny", assessee: "Hari Om Charitable Trust", pan: "AAATH7621J", ay: "2022-23", section: "143(2)", ref: "", bench: "Exemption Ward, Ahmedabad", status: "Active", priority: "low", staff: "Riya Kapoor" },
  ];
  const hearings = [
    { id: "h1", assessee: "Rajesh M. Shah", pan: "ABCPS1234F", ay: "2017-18", authority: "ITAT", bench: "Ahmedabad 'A' Bench", section: "", date: daysAway(1), time: "11:30", mode: "Physical", status: "Upcoming", priority: "high", ita: "ITA No. 1244/Ahd/2024", staff: "Priya Mehta" },
    { id: "h2", assessee: "Shah Textiles Pvt. Ltd.", pan: "AABCS9821K", ay: "2021-22", authority: "Scrutiny", bench: "Circle 4(1), Ahmedabad", section: "142(1)", date: daysAway(2), time: "14:00", mode: "e-Proceeding", status: "Upcoming", priority: "medium", ita: "", staff: "Priya Mehta" },
    { id: "h3", assessee: "Mehul Patel & Sons HUF", pan: "AAFHM2210C", ay: "2019-20", authority: "CIT(A)", bench: "NFAC", section: "250", date: daysAway(6), time: "10:30", mode: "Video Conference", status: "Upcoming", priority: "medium", ita: "", staff: "Arjun Desai" },
    { id: "h4", assessee: "Nirvana Infotech LLP", pan: "AALFN6712M", ay: "2020-21", authority: "Scrutiny", bench: "Circle 2(2), Surat", section: "143(2)", date: daysAway(8), time: "11:00", mode: "e-Proceeding", status: "Upcoming", priority: "low", ita: "", staff: "Arjun Desai" },
    { id: "h5", assessee: "Vinod Bros. Trading", pan: "AAFFV1209L", ay: "2018-19", authority: "ITAT", bench: "Mumbai 'C' Bench", section: "", date: daysAway(13), time: "15:00", mode: "Physical", status: "Upcoming", priority: "high", ita: "ITA No. 0987/Mum/2024", staff: "Riya Kapoor" },
    { id: "h6", assessee: "Hari Om Charitable Trust", pan: "AAATH7621J", ay: "2022-23", authority: "Scrutiny", bench: "Exemption Ward, Ahmedabad", section: "143(2)", date: daysAway(15), time: "12:30", mode: "e-Proceeding", status: "Upcoming", priority: "low", ita: "", staff: "Riya Kapoor" },
  ];
  const notices = [
    { id: "n1", assessee: "Rajesh M. Shah", pan: "ABCPS1234F", ay: "2017-18", section: "142(1)", authority: "ITAT", date: daysAway(-15), din: "ITBA/AST/F/142(1)/2026-27/103412", status: "Awaiting review", subject: "Appeal hearing — addition u/s 68 of unexplained cash credits", bench: "Ahmedabad 'A' Bench", mode: "Physical", hearingDate: daysAway(1), hearingTime: "11:30", ita: "ITA No. 1244/Ahd/2024", documents: ["Copy of audited financial statements for AY 2017-18", "Bank statements of all accounts for FY 2016-17", "Confirmations from unsecured lenders with PAN & ITR copies", "Source of cash deposits exceeding ₹2 lakh", "Ledger copies for sundry creditors", "Computation of income and ITR acknowledgement"] },
    { id: "n2", assessee: "Nirvana Infotech LLP", pan: "AALFN6712M", ay: "2020-21", section: "143(2)", authority: "Scrutiny", date: daysAway(-8), din: "ITBA/AST/F/143(2)/2026-27/103299", status: "Reply drafted", subject: "Notice for scrutiny assessment", bench: "Circle 2(2), Surat", mode: "e-Proceeding", hearingDate: "", hearingTime: "", ita: "", documents: [] },
    { id: "n3", assessee: "Mehul Patel & Sons HUF", pan: "AAFHM2210C", ay: "2019-20", section: "250", authority: "CIT(A)", date: daysAway(-6), din: "ITBA/APL/F/250/2026-27/104088", status: "Submitted", subject: "Appeal fixed for hearing before NFAC", bench: "NFAC", mode: "Video Conference", hearingDate: daysAway(6), hearingTime: "10:30", ita: "", documents: [] },
    { id: "n4", assessee: "Hari Om Charitable Trust", pan: "AAATH7621J", ay: "2022-23", section: "143(2)", authority: "Scrutiny", date: daysAway(-5), din: "ITBA/AST/F/143(2)/2026-27/104201", status: "Awaiting review", subject: "Scrutiny — exemption claimed u/s 11", bench: "Exemption Ward, Ahmedabad", mode: "e-Proceeding", hearingDate: daysAway(15), hearingTime: "12:30", ita: "", documents: ["Trust deed and registration certificate u/s 12A", "Audited accounts with Form 10B"] },
  ];
  const invoices = [
    { id: "i1", number: `PH/${fyOf(daysAway(-12))}/0124`, assessee: "Rajesh M. Shah", date: daysAway(-12), ay: "2017-18", service: "ITAT appeal — Drafting & hearing fees", amount: 125000, received: 0, due: daysAway(18) },
    { id: "i2", number: `PH/${fyOf(daysAway(-15))}/0123`, assessee: "Shah Textiles Pvt. Ltd.", date: daysAway(-15), ay: "2021-22", service: "Scrutiny assessment professional fees", amount: 85000, received: 85000, due: daysAway(15) },
    { id: "i3", number: `PH/${fyOf(daysAway(-19))}/0122`, assessee: "Mehul Patel & Sons HUF", date: daysAway(-19), ay: "2019-20", service: "CIT(A) appeal drafting", amount: 65000, received: 0, due: daysAway(11) },
    { id: "i4", number: `PH/${fyOf(daysAway(-22))}/0121`, assessee: "Nirvana Infotech LLP", date: daysAway(-22), ay: "2020-21", service: "Scrutiny assessment + Penalty reply", amount: 132000, received: 50000, due: daysAway(8) },
    { id: "i5", number: `PH/${fyOf(daysAway(-28))}/0120`, assessee: "Vinod Bros. Trading", date: daysAway(-28), ay: "2018-19", service: "ITAT appeal filing", amount: 54200, received: 0, due: daysAway(-2) },
    { id: "i6", number: `PH/${fyOf(daysAway(-31))}/0119`, assessee: "Kavita R. Joshi", date: daysAway(-31), ay: "2023-24", service: "ITR filing + consultation", amount: 18500, received: 18500, due: daysAway(-1) },
  ];
  const communications = [
    { id: "c1", channel: "WhatsApp", to: "Rajesh M. Shah", subject: "Documents required for AY 2017-18 — ITAT hearing", body: "", time: new Date().toISOString(), template: "Document request", status: "Sent" },
    { id: "c2", channel: "Email", to: "ca@nirvanainfotech.com", subject: "Income Tax Notice u/s 143(2) — submission of details", body: "", time: new Date(Date.now() - 86400000).toISOString(), template: "Reminder", status: "Sent" },
    { id: "c3", channel: "WhatsApp", to: "Mehul Patel & Sons HUF", subject: "CIT(A) appeal hearing — please confirm attendance", body: "", time: new Date(Date.now() - 3 * 86400000).toISOString(), template: "Hearing confirmation", status: "Sent" },
  ];
  const todos = [
    { id: "t1", text: "Submit Form 35 for Patel HUF appeal", done: true },
    { id: "t2", text: "Draft reply for Nirvana Infotech u/s 143(2)", done: false, tag: "Due tomorrow", tagColor: "danger" },
    { id: "t3", text: "Send document request — Rajesh Shah (AY 17-18)", done: false, tag: "WhatsApp", tagColor: "info" },
    { id: "t4", text: "Reconcile receipts ₹85,000 from Shah Textiles", done: false, tag: "₹85,000", tagColor: "success" },
  ];
  return { ...EMPTY, assessees, matters, hearings, notices, invoices, communications, todos, invoiceSeq: 124, profile: { ownerName: "Jayesh Vyas", firmName: "Jayesh Vyas & Co." } };
}

const DataCtx = React.createContext(null);

export const useData = () => React.useContext(DataCtx);

export function DataProvider({ children }) {
  const [data, setData] = React.useState(load);
  const [toast, setToast] = React.useState(null);

  React.useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // storage full / unavailable — app keeps working in memory
    }
  }, [data]);

  React.useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const api = React.useMemo(() => {
    const notify = (msg, icon = "check") => setToast({ msg, icon });
    const addTo = (key) => (rec) => {
      const r = { id: uid(), createdAt: new Date().toISOString(), ...rec };
      setData((d) => ({ ...d, [key]: [r, ...d[key]] }));
      return r;
    };
    const updateIn = (key) => (id, patch) =>
      setData((d) => ({ ...d, [key]: d[key].map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
    const removeFrom = (key) => (id) =>
      setData((d) => ({ ...d, [key]: d[key].filter((x) => x.id !== id) }));

    return {
      notify,
      addAssessee: addTo("assessees"),
      updateAssessee: updateIn("assessees"),
      removeAssessee: removeFrom("assessees"),
      addMatter: addTo("matters"),
      updateMatter: updateIn("matters"),
      removeMatter: removeFrom("matters"),
      addHearing: addTo("hearings"),
      updateHearing: updateIn("hearings"),
      removeHearing: removeFrom("hearings"),
      addNotice: addTo("notices"),
      updateNotice: updateIn("notices"),
      removeNotice: removeFrom("notices"),
      addCommunication: addTo("communications"),
      addTodo: addTo("todos"),
      updateTodo: updateIn("todos"),
      removeTodo: removeFrom("todos"),
      addInvoice: (rec) => {
        const r = { id: uid(), createdAt: new Date().toISOString(), received: 0, ...rec };
        setData((d) => {
          const seq = (d.invoiceSeq || 0) + 1;
          r.number = r.number || `PH/${fyOf(r.date || todayISO())}/${String(seq).padStart(4, "0")}`;
          return { ...d, invoiceSeq: seq, invoices: [r, ...d.invoices] };
        });
        return r;
      },
      updateInvoice: updateIn("invoices"),
      removeInvoice: removeFrom("invoices"),
      setProfile: (patch) => setData((d) => ({ ...d, profile: { ...d.profile, ...patch } })),
      loadSampleData: () => {
        setData(buildSampleData());
        notify("Sample data loaded — replace it with your own records anytime");
      },
      clearAllData: () => {
        setData(EMPTY);
        notify("All data cleared");
      },
    };
  }, []);

  const value = React.useMemo(() => ({ data, ...api, toast }), [data, api, toast]);
  return <DataCtx.Provider value={value}>{children}</DataCtx.Provider>;
}

/* ---------- derived helpers (pure functions over data) ---------- */

export const nextColor = (assessees) => AVATAR_COLORS[assessees.length % AVATAR_COLORS.length];

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

export const awaitingNotices = (data) => data.notices.filter((n) => n.status === "Awaiting review");

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
