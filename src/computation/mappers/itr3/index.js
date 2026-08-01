/*
 * ITR-3 → ComputationDocument. Delegates by assessment year (§9).
 *
 * No "nearest year" fallback, for the same reason as ITR-2 and ITR-5: a mapper
 * run against a year it was not written for produces a document that looks right
 * and is wrong.
 */
import { UnsupportedFormError } from "../../detect.js";
import { mapItr3Ay2025 } from "./ay2025-26.js";

const BY_YEAR = {
  "2025-26": mapItr3Ay2025,
};

export function mapItr3(body, ctx) {
  const fn = BY_YEAR[ctx.ay];
  if (!fn) throw new UnsupportedFormError("ITR3", ctx.ay);
  return fn(body, ctx);
}

export const SUPPORTED_YEARS = Object.keys(BY_YEAR);
