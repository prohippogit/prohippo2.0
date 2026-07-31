/*
 * ITR-5 → ComputationDocument. Delegates by assessment year (§9).
 *
 * There is no "nearest year" fallback on purpose. ITD renames and re-shapes
 * fields between years, so a mapper run against a year it was not written for
 * produces a document that looks right and is wrong — exactly the failure §8
 * exists to prevent. An unsupported year raises instead.
 */
import { UnsupportedFormError } from "../../detect.js";
import { mapItr5Ay2025 } from "./ay2025-26.js";

const BY_YEAR = {
  "2025-26": mapItr5Ay2025,
};

export function mapItr5(body, ctx) {
  const fn = BY_YEAR[ctx.ay];
  if (!fn) throw new UnsupportedFormError("ITR5", ctx.ay);
  return fn(body, ctx);
}

export const SUPPORTED_YEARS = Object.keys(BY_YEAR);
