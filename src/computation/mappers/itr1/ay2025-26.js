/*
 * ITR-1, A.Y. 2025-26.
 *
 * Two things arrive this year.
 *
 * `GrossTotIncomeIncLTCG112A`, because this is the year ITR-1 was first allowed
 * to carry a long-term capital gain u/s 112A within the s.112A exemption. The
 * return we hold states it EQUAL to `GrossTotIncome`, so there is no gain in it;
 * the builder prints a capital-gains head row only where the two differ, and
 * takes the difference from the return's own two figures rather than looking for
 * a field whose name it would be guessing at. §11 records that the gain itself is
 * an unexercised path.
 *
 * And the new regime, in a return that reconciles: `OptOutNewTaxRegime` is "N",
 * total income 4,64,760, tax at normal rates 8,238. s.115BAC(1A) for this year
 * exempts the first 3,00,000 and charges 5% on the next slab: 5% of 1,64,760 is
 * exactly 8,238. The old table would give 10,738. The standard deduction of
 * 75,000 rather than 50,000 agrees. That is the reconciliation §10 asks for, and
 * it is the first year on this form where the two regimes are far enough apart to
 * permit one.
 */
import { buildItr1 } from "./build.js";

export function mapItr1Ay2025(body, ctx) {
  return buildItr1(body, ctx);
}
