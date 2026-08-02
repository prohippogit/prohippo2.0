/*
 * ITR-3, A.Y. 2026-27.
 *
 * The first year on either individual form where a return we hold keeps full
 * books of account — a balance sheet, a trading and profit & loss account, and
 * block-wise depreciation. None of that is restated here: a Computation of Total
 * Income takes net profit before tax from Schedule BP, which is where the return
 * itself carries it, and the accounts are filed alongside (see ignore-paths.js).
 *
 * Three things this year states differently from 2025-26, all read from the
 * return rather than branched on:
 *
 *   - the regime is asked as Form 10-IEA flags rather than an opt-out field
 *     (../individual/labels.js);
 *   - Schedule CG wraps the "other assets" block one level deeper, and the
 *     mid-year _BE / _AE split of 2025-26 is gone (../individual/heads.js);
 *   - Part B-TI carries a 20% short-term and a 12.5% long-term bucket only.
 */
import { buildItr3 } from "./build.js";

export function mapItr3Ay2026(body, ctx) {
  return buildItr3(body, ctx);
}
