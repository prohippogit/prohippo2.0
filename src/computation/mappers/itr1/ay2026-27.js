/*
 * ITR-1, A.Y. 2026-27.
 *
 * What differs from A.Y. 2025-26:
 *
 * - The house property total is renamed `TotalIncomeChargeableUnHP`, where every
 *   earlier year calls it `TotalIncomeOfHP`. The builder reads whichever the
 *   return carries; the two never co-occur, so this needs no year branch, and
 *   every earlier year's golden is what proves the change did not reach it.
 * - `PersonalInfo` gains a second contact (`MobileNoSec`, `EmailAddressSec`), a
 *   `SecondaryAdd` flag and an `AlternateAddress` block. None of them is a figure
 *   in the computation; the anonymiser was extended to scrub them, because on the
 *   return that brought this to light the second contact was somebody else's.
 * - `IntrstPay` gains `FeeFurnish234I` alongside the s.234 interest, which the
 *   interest note names when it carries anything.
 * - `FilingStatus` gains `AsseseeRepFlg`, the representative-assessee flag. "N"
 *   in the return we hold; it is a disclosure rather than a figure.
 *
 * The regime reconciles, as §10 requires: `OptOutNewTaxRegime` is "N", total
 * income 5,18,970, tax at normal rates 5,949. s.115BAC(1A) for this year exempts
 * the first 4,00,000 and charges 5% on the next slab — 5% of 1,18,970 is
 * 5,948.50, the 5,949 stated. The old table would give 16,294. The rebate u/s 87A
 * then extinguishes it, which is why the year closes at nil either way.
 */
import { buildItr1 } from "./build.js";

export function mapItr1Ay2026(body, ctx) {
  return buildItr1(body, ctx);
}
