/*
 * ITR-3, A.Y. 2024-25.
 *
 * Shares ./build.js with A.Y. 2025-26 — verified field by field against a real
 * return of each year. The two years differ in what the figures MEAN, not in
 * where they live, and every one of those differences is read from the return
 * rather than assumed:
 *
 *   capital gains   2024-25 taxes short-term u/s 111A at 15% and long-term u/s
 *                   112 at 20%; 2025-26 has 20% short-term and a 12.5% long-term
 *                   bucket, and splits one gain across a mid-year rate change.
 *                   The rates are read off Schedule SI either way.
 *   salary          the standard deduction under the new regime is 50,000 here
 *                   and 75,000 in 2025-26. Read from the return.
 *   the slabs       differ, and are never recomputed — Part B-TTI states the tax.
 *
 * The regime field also differs: this year's return asks it as
 * `OptOutNewTaxRegime`, 2025-26's as `No_OptOutNewTaxReg`. regimeLabel() reads
 * whichever is present.
 */
import { buildItr3 } from "./build.js";

export function mapItr3Ay2024(body, ctx) {
  return buildItr3(body, ctx);
}
