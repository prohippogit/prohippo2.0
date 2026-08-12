/*
 * ITR-1, A.Y. 2023-24.
 *
 * Still `NewTaxRegime`, with the sense recorded in ../individual/labels.js: "N"
 * is the old regime. As in 2022-23 this return cannot re-derive it, and §10
 * requires that to be said rather than glossed — at a total income of 4,64,020
 * the two tables coincide (nil to 2,50,000, then 5%), both giving the 10,701 the
 * return states, and the rebate u/s 87A then extinguishes it. No arithmetic on
 * this return distinguishes the regimes; the field's verified sense is all there
 * is, and it is enough.
 *
 * What this year adds over 2022-23 is the other-sources itemisation:
 * `OthersInc.OthersIncDtlsOthSrc[]` arrives with a savings-bank interest line
 * under code `SAV` and a commission receipt under `OTH`, described in the
 * assessee's own words. Both are printed as the return states them.
 */
import { buildItr1 } from "./build.js";

export function mapItr1Ay2023(body, ctx) {
  return buildItr1(body, ctx);
}
