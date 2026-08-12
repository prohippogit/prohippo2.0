/*
 * ITR-1, A.Y. 2024-25.
 *
 * The first year the form asks the regime as `OptOutNewTaxRegime`, whose sense is
 * the reverse of the `NewTaxRegime` of the two years before it: "Y" means the
 * assessee has opted OUT of s.115BAC(1A) and is taxed under the OLD regime.
 *
 * Verified on this return's own figures, as §10 requires and as the earlier years
 * could not be: total income 4,90,530, tax at normal rates 12,027. The old table
 * gives 5% of (4,90,530 − 2,50,000) = 12,026.50, which is the 12,027 stated;
 * s.115BAC(1A) for this year exempts the first 3,00,000 and would give 9,527. The
 * standard deduction of 50,000 rather than 75,000 agrees. So "Y" is the old
 * regime, and the Chapter VI-A deduction below it is possible because of that.
 *
 * This year also brings the fields that only an old-regime return exercises: the
 * s.80TTA deduction for savings-bank interest, and the parallel claimed/allowed
 * columns of Chapter VI-A that make it visible when a cap has bitten.
 */
import { buildItr1 } from "./build.js";

export function mapItr1Ay2024(body, ctx) {
  return buildItr1(body, ctx);
}
