/*
 * ITR-2 → ComputationDocument. Delegates by assessment year (§9).
 *
 * No "nearest year" fallback, for the same reason as ITR-5: a mapper run
 * against a year it was not written for produces a document that looks right
 * and is wrong.
 */
import { UnsupportedFormError } from "../../detect.js";
import { mapItr2Ay2024 } from "./ay2024-25.js";
import { mapItr2Ay2023 } from "./ay2023-24.js";
import { mapItr2Ay2022 } from "./ay2022-23.js";
import { mapItr2Ay2025 } from "./ay2025-26.js";
import { mapItr2Ay2026 } from "./ay2026-27.js";

const BY_YEAR = {
  "2026-27": mapItr2Ay2026,
  "2025-26": mapItr2Ay2025,
  "2024-25": mapItr2Ay2024,
  "2023-24": mapItr2Ay2023,
  "2022-23": mapItr2Ay2022,
};

export function mapItr2(body, ctx) {
  const fn = BY_YEAR[ctx.ay];
  if (!fn) throw new UnsupportedFormError("ITR2", ctx.ay);
  return fn(body, ctx);
}

export const SUPPORTED_YEARS = Object.keys(BY_YEAR);
