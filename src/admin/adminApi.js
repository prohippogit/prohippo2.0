/*
 * ProHippo admin console — the callable surface.
 *
 * Reads go straight to Firestore (admins have read on `accounts`,
 * `referralCodes`, `referralRedemptions`, `adminAudit`, `growthDaily`), so the
 * console gets live snapshots for free. Everything that CHANGES something is
 * here, because every one of these is audited server-side.
 */
import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase";

const call = (name) => async (data) => (await httpsCallable(functions, name)(data || {})).data;

/* Accounts */
export const adminOverview = call("adminOverview");
export const adminLookupUser = call("adminLookupUser");
export const adminUpdateAccount = call("adminUpdateAccount");
export const adminSetRole = call("adminSetRole");

/* Referral codes */
export const adminCreateReferralCode = call("adminCreateReferralCode");
export const adminUpdateReferralCode = call("adminUpdateReferralCode");
export const adminReverseRedemption = call("adminReverseRedemption");

/* Voice help line — rebuild Sarvam's known-callers list on demand.
   It also runs nightly; this is for the moment right after onboarding someone,
   when waiting until 03:10 for them to be able to ring the line is silly. */
export const syncVoiceKnownCallers = call("syncVoiceKnownCallersNow");

/* Costs */
export const adminCostSummary = call("adminCostSummary");
export const adminSetManualCost = call("adminSetManualCost");
export const adminRecentFailures = call("adminRecentFailures");

/* Cost is stored as integer micro-rupees — a single Gemini call is a fraction
   of a paisa, and floats accumulate error over a month of them. Rupees are for
   display only. */
export const inrFromMicro = (m) => (m || 0) / 1e6;
export const fmtInrMicro = (m, decimals = 2) =>
  "₹" + inrFromMicro(m).toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
/* Table cells and totals read better without paise once the numbers grow. */
export const fmtInrMicroShort = (m) => {
  const v = inrFromMicro(m);
  if (v === 0) return "₹0";
  if (v < 1) return "₹" + v.toFixed(3);
  if (v < 1000) return "₹" + v.toFixed(2);
  return "₹" + Math.round(v).toLocaleString("en-IN");
};

export const VENDOR_LABEL = {
  gemini: "Gemini",
  "2factor": "2Factor SMS",
  resend: "Resend email",
  firebase: "Firebase (manual)",
};

export const FEATURE_LABEL = {
  // Retired with the AI Parser screen. Kept because spend records are written
  // once and never rewritten: drop the label and every historical row would
  // render its raw key instead of a name.
  parseNotice: "Notice parsing (retired)",
  summarizeNotice: "Order summaries",
  readIntimation: "Intimation breakdowns",
  readIntimationAuto: "Intimation breakdowns (automatic)",
  extractDocuments: "Document extraction",
  clientMessage: "Client messages",
  translateMessage: "Message translation",
  login: "Login & signup",
};

/* Shared formatting — the console shows money the way the invoices do. */
export const fromPaise = (p) => Math.round((p || 0) / 100);
export const fmtPaise = (p) => "₹" + new Intl.NumberFormat("en-IN").format(fromPaise(p));

export const benefitLabel = (benefit) => {
  const b = benefit || {};
  const v = Number(b.value) || 0;
  if (b.type === "percent") return `${v}% off`;
  if (b.type === "flat") return `${fmtPaise(v)} off`;
  if (b.type === "free_days") return `${v} days free`;
  if (b.type === "plan_grant") return "Free plan grant";
  return "—";
};

export const STATUS_PILL = {
  trial: "info",
  active: "success",
  past_due: "warning",
  cancelled: "muted",
  suspended: "danger",
  deleted: "muted",
};

export const STATUS_LABEL = {
  trial: "Trial",
  active: "Active",
  past_due: "Past due",
  cancelled: "Cancelled",
  suspended: "Suspended",
  deleted: "Deleted",
};
