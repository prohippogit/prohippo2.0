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
