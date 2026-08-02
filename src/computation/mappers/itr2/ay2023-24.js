/*
 * ITR-2, A.Y. 2023-24.
 *
 * One of the two earliest years supported on this form. Both ask the regime as
 * `NewTaxRegime`, whose sense runs the opposite way to the `OptOutNewTaxRegime`
 * of the middle years — "N" here is the OLD regime (../individual/labels.js) —
 * and both carry Schedule CG's blocks flat, before the wrappers the later years
 * put round them (../individual/heads.js).
 *
 * The capital-gains rate buckets are the pre-2024 ones: 15% short-term, 10% and
 * 20% long-term, with no 12.5% bucket anywhere.
 */
import { buildItr2 } from "./build.js";

export function mapItr2Ay2023(body, ctx) {
  return buildItr2(body, ctx);
}
