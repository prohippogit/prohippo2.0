/*
 * ITR-3 → ComputationDocument. Delegates by assessment year (§9).
 *
 * No "nearest year" fallback, for the same reason as ITR-2 and ITR-5: a mapper
 * run against a year it was not written for produces a document that looks right
 * and is wrong.
 */
import { UnsupportedFormError } from "../../detect.js";
import { mapItr3Ay2026 } from "./ay2026-27.js";
import { mapItr3Ay2025 } from "./ay2025-26.js";
import { mapItr3Ay2024 } from "./ay2024-25.js";
import { mapItr3Ay2022 } from "./ay2022-23.js";

const BY_YEAR = {
  "2026-27": mapItr3Ay2026,
  "2025-26": mapItr3Ay2025,
  "2024-25": mapItr3Ay2024,
  "2022-23": mapItr3Ay2022,
};

export function mapItr3(body, ctx) {
  const fn = BY_YEAR[ctx.ay];
  if (!fn) throw new UnsupportedFormError("ITR3", ctx.ay);
  return fn(body, ctx);
}

export const SUPPORTED_YEARS = Object.keys(BY_YEAR);
