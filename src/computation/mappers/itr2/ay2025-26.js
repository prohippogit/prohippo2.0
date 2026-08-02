/*
 * ITR-2, A.Y. 2025-26.
 *
 * The year the capital-gains rates changed mid-year: one s.112A gain is split
 * between the rate before 23 July 2024 and the rate after it, and Part B-TI
 * carries both a 10% and a 12.5% long-term bucket. Both are read from the
 * return; see ../individual/heads.js.
 */
import { buildItr2 } from "./build.js";

export function mapItr2Ay2025(body, ctx) {
  return buildItr2(body, ctx);
}
