/*
 * The practice the deck is photographed against.
 *
 * It is the app's own `buildSampleData()` — the same fictional Ahmedabad
 * practice a new user gets from "Load sample data" — extended with the three
 * things that sample set has no reason to carry but the deck does: appealable
 * ORDERS (so the Appeals countdowns have something to count), filed RETURNS
 * with CPC orders and their variances (so Intimations and the Returns tab are
 * not empty), and GROUPS (so group billing reads the way it does in practice).
 *
 * Every name, PAN and figure here is invented. Nothing in this file is, or has
 * ever been, anybody's data.
 */
import { buildSampleData } from "../../src/store.jsx";

const base = buildSampleData();

const DAY = 86400000;
const iso = (d) => d.toISOString().slice(0, 10);
const away = (n) => iso(new Date(Date.now() + n * DAY));

// The seed arrives without ids (Firestore would mint them); the harness mints
// stable ones so a screenshot re-taken tomorrow is the same screenshot.
const withIds = (prefix, rows) =>
  rows.map((r, i) => ({ id: `${prefix}-${i + 1}`, createdAt: away(-60 + i), ...r }));

/* ---------------- orders that can be appealed ----------------
   Three, deliberately spread across the urgency bands the Appeals page
   colours: one inside a week, one comfortable, one already lapsed. */
const ORDERS = [
  {
    assessee: "Nirvana Infotech LLP", pan: "AALFN6712M", ay: "2020-21",
    section: "143(3)", authority: "Scrutiny", date: away(-26), isOrder: true,
    din: "ITBA/AST/M/143(3)/2026-27/105512",
    subject: "Assessment order u/s 143(3) — disallowance u/s 40(a)(ia)",
    description: "Assessment Order", docType: "assessmentOrder",
    assessedIncome: 4820000, demand: 1284500,
    storagePath: "seed/orders/nirvana-143-3.pdf",
  },
  {
    assessee: "Vinod Bros. Trading", pan: "AAFFV1209L", ay: "2018-19",
    section: "271(1)(c)", authority: "Penalty", date: away(-9), isOrder: true,
    din: "ITBA/PNL/F/271(1)(c)/2026-27/105890",
    subject: "Penalty order u/s 271(1)(c) — concealment of particulars",
    description: "Penalty Order", docType: "penaltyOrder",
    demand: 462000,
    storagePath: "seed/orders/vinod-271.pdf",
  },
  {
    assessee: "Mehul Patel & Sons HUF", pan: "AAFHM2210C", ay: "2019-20",
    section: "250", authority: "CIT(A)", date: away(-71), isOrder: true,
    din: "ITBA/APL/M/250/2026-27/104512",
    subject: "Appellate order u/s 250 — appeal partly allowed",
    description: "Order of CIT(A)", docType: "appealOrder",
    assessedIncome: 2310000, demand: 318400,
    storagePath: "seed/orders/patel-250.pdf",
  },
];

/* ---------------- filed returns, CPC orders and their variances ----------------
   Sign convention, as everywhere else in the app: POSITIVE is money coming
   back to the assessee, so a negative amount is a red flag. */
const RETURNS = [
  {
    assesseeId: "assessees-5", assessee: "Kavita R. Joshi", pan: "BHJPK4517A", ay: "2023-24",
    form: "ITR-2", filingTypeCd: "O", filedOn: away(-284), verified: true, verifiedMode: "Aadhaar OTP",
    ackNum: "482910284120823", statusDesc: "ITR processed with demand determined",
    computedDemndAmt: "68420", jsonPath: "seed/returns/kavita-2324.json", ackPdfPath: "seed/returns/kavita-2324-itrv.pdf",
    returnPosition: { taxPayable: 0, refundDue: 12300 },
    orders: [{
      commRefNo: "CPC/2324/A9/482910284", section: "143(1)", activityCd: "61",
      orderDate: away(-38), emailedOn: away(-38), statusDesc: "Processed, demand determined",
      demand: 68420, storagePath: "seed/orders/kavita-1431.pdf",
      variance: { flag: "red", amount: -80720, baseline: { kind: "return" }, source: "portal", adjusted: false },
    }],
  },
  {
    assesseeId: "assessees-3", assessee: "Mehul Patel & Sons HUF", pan: "AAFHM2210C", ay: "2022-23",
    form: "ITR-3", filingTypeCd: "R", filedOn: away(-402), verified: true, verifiedMode: "DSC",
    ackNum: "391028471120722", statusDesc: "ITR processed with refund determined",
    computedRefndAmt: "141260", jsonPath: "seed/returns/patel-2223.json", ackPdfPath: "seed/returns/patel-2223-itrv.pdf",
    returnPosition: { taxPayable: 0, refundDue: 141260 },
    orders: [{
      commRefNo: "CPC/2223/B2/391028471", section: "143(1)", activityCd: "60",
      orderDate: away(-96), emailedOn: away(-96), statusDesc: "Processed, refund determined and adjusted u/s 245",
      refund: 141260, storagePath: "seed/orders/patel-1431.pdf",
      variance: { flag: "neutral", amount: 0, baseline: { kind: "return" }, source: "portal", adjusted: true },
    }],
  },
  {
    assesseeId: "assessees-1", assessee: "Rajesh M. Shah", pan: "ABCPS1234F", ay: "2023-24",
    form: "ITR-2", filingTypeCd: "O", filedOn: away(-291), verified: true, verifiedMode: "Aadhaar OTP",
    ackNum: "104829173120823", statusDesc: "Rectification order passed",
    jsonPath: "seed/returns/rajesh-2324.json", ackPdfPath: "seed/returns/rajesh-2324-itrv.pdf",
    formPdfPath: "seed/returns/rajesh-2324-form.pdf",
    returnPosition: { taxPayable: 214300, refundDue: 0 },
    orders: [{
      commRefNo: "CPC/2324/R1/104829173", section: "154", activityCd: "62",
      orderDate: away(-21), emailedOn: away(-20), statusDesc: "Rectification processed, refund determined",
      refund: 47180, storagePath: "seed/orders/rajesh-154.pdf",
      variance: { flag: "green", amount: 47180, baseline: { kind: "order" }, source: "portal", adjusted: false },
    }],
  },
  {
    assesseeId: "assessees-4", assessee: "Nirvana Infotech LLP", pan: "AALFN6712M", ay: "2024-25",
    form: "ITR-5", filingTypeCd: "O", filedOn: away(-172), verified: true, verifiedMode: "DSC",
    ackNum: "772910384120924", statusDesc: "ITR processed, no demand no refund",
    jsonPath: "seed/returns/nirvana-2425.json", ackPdfPath: "seed/returns/nirvana-2425-itrv.pdf",
    returnPosition: { taxPayable: 0, refundDue: 0 },
    orders: [{
      commRefNo: "CPC/2425/N4/772910384", section: "143(1)", activityCd: "59",
      orderDate: away(-64), emailedOn: away(-64), statusDesc: "Processed, no payment due",
      storagePath: "seed/orders/nirvana-1431.pdf",
      variance: { flag: "neutral", amount: 0, baseline: { kind: "return" }, source: "portal", adjusted: false },
    }],
  },
];

const GROUPS = [
  { name: "Shah Group", color: "violet", head: { name: "Rajesh M. Shah", mobile: "+91 98250 11234", assesseeId: "assessees-1" }, headWhatsappOptIn: { optedIn: true, at: away(-120), by: "Priya Mehta", source: "in person" } },
  { name: "Patel Family", color: "amber", head: { name: "Mehul Patel", mobile: "+91 99099 22310", assesseeId: "assessees-3" }, headWhatsappOptIn: { optedIn: true, at: away(-98), by: "Arjun Desai", source: "in person" } },
  { name: "Nirvana Group", color: "teal", head: { name: "Sameer Vora", mobile: "+91 90999 14523", assesseeId: "assessees-4" } },
  { name: "Vinod Bros.", color: "pink", head: { name: "Vinod Chauhan", mobile: "+91 99879 31200", assesseeId: "assessees-6" } },
];

const RECEIPTS = [
  { number: "RC/2026-27/0041", assessee: "Shah Textiles Pvt. Ltd.", date: away(-14), amount: 85000, mode: "Bank transfer", against: [{ number: "PH/2026-27/0123", amount: 85000 }] },
  { number: "RC/2026-27/0040", assessee: "Nirvana Infotech LLP", date: away(-20), amount: 50000, mode: "UPI", against: [{ number: "PH/2026-27/0121", amount: 50000 }] },
  { number: "RC/2026-27/0039", assessee: "Kavita R. Joshi", date: away(-29), amount: 18500, mode: "Cash", against: [{ number: "PH/2026-27/0119", amount: 18500 }] },
];

export const PROFILE = {
  ownerName: "Priya Mehta",
  firmName: "Mehta & Associates",
  email: "priya@mehtaassociates.in",
  phone: "+91 98250 11234",
  phoneVerified: true,
  firmAddress: "402, Shivalik Plaza, Navrangpura, Ahmedabad 380009",
  firmPhone: "+91 79 4004 1200",
  invoiceSeq: 124,
  receiptSeq: 41,
  haptics: true,
  createdAt: away(-420),
};

export const SEED = {
  assessees: withIds("assessees", base.assessees.map((a) => ({ ...a, portalCredSet: true, portalLastSyncedAt: new Date(Date.now() - 3 * 3600000).toISOString(), portalProceedingCount: 4, portalNoticeCount: 11, dob: "1974-08-19" }))),
  matters: withIds("matters", base.matters),
  hearings: withIds("hearings", base.hearings),
  notices: withIds("notices", [...base.notices.map((n) => ({ ...n, source: "portal" })), ...ORDERS.map((o) => ({ ...o, source: "portal" }))]),
  invoices: withIds("invoices", base.invoices),
  communications: withIds("communications", base.communications),
  docRequests: withIds("docRequests", base.docRequests),
  todos: withIds("todos", base.todos),
  receipts: withIds("receipts", RECEIPTS),
  groups: withIds("groups", GROUPS),
  returns: withIds("returns", RETURNS),
};
