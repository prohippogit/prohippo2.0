/*
 * ITR-1, A.Y. 2022-23.
 *
 * The oldest year we support on this form, and the one whose blocks are
 * thinnest: there is no `ItrFilingDueDate`, no `IncomeNotified89AType` country
 * split, and no `AnyOthSec80CCH` in the Chapter VI-A block — s.80CCH did not
 * exist. The workings read whatever the return carries, so none of that needs a
 * branch.
 *
 * The regime is asked as `NewTaxRegime`, whose sense is the OPPOSITE of the
 * later `OptOutNewTaxRegime`: "N" means the assessee did NOT opt into s.115BAC
 * and is on the old regime. That reading is verified in
 * ../individual/labels.js against an ITR-3 of this same year with income large
 * enough to separate the two tables.
 *
 * It cannot be re-verified from THIS return, and §10 requires saying so rather
 * than implying a reconciliation that was not done: total income of 2,39,500 is
 * below the basic exemption under either regime, so the return's nil tax is
 * consistent with both. The regime is therefore stated on the strength of the
 * field's verified sense alone, which is the most this return supports.
 *
 * The return is a belated one u/s 139(4), which the particulars card states and
 * a note repeats — s.80 denies the carry-forward of losses on a belated return,
 * so it is not a detail to bury.
 */
import { buildItr1 } from "./build.js";

export function mapItr1Ay2022(body, ctx) {
  return buildItr1(body, ctx);
}
