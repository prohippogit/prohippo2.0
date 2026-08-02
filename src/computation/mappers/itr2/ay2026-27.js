/*
 * ITR-2, A.Y. 2026-27.
 *
 * The first full year on the post-amendment capital-gains rates, so the
 * mid-year split of A.Y. 2025-26 is gone: Part B-TI carries a single 12.5%
 * long-term bucket and no 10% one, and short-term starts at 20% with no 15%
 * bucket. None of that needs a branch — the workings read whichever buckets the
 * return carries a figure against.
 *
 * Verified against a real return field for field. What differs from 2025-26 is
 * data, not structure:
 *
 *   capital gains   one long-term rate (12.5%) instead of two.
 *   Part B-TTI      no `TaxPayableOnDeemedTI` block; the deemed-income figures
 *                   sit directly under PartB_TTI. All nil in the return we hold.
 *   interest        a new `FeeFurnish234I` alongside the s.234 interest.
 *   address         a `SecondaryAdd` flag with an `AlternateAddress` block.
 */
import { buildItr2 } from "./build.js";

export function mapItr2Ay2026(body, ctx) {
  return buildItr2(body, ctx);
}
