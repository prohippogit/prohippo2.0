/*
 * ITR-3, A.Y. 2022-23.
 *
 * The earliest year we support, and the one furthest from the current schema.
 * Three things it does differently, all read from the return:
 *
 *   - the regime is asked as `NewTaxRegime`, whose sense is the OPPOSITE of the
 *     `OptOutNewTaxRegime` field of the middle years — "N" here means the old
 *     regime (../individual/labels.js);
 *   - Schedule CG carries the "other assets" and slump-sale blocks flat, before
 *     the wrappers the later years put round them (../individual/heads.js);
 *   - the capital-gains rate buckets are the pre-2024 ones: 15% short-term,
 *     10% and 20% long-term, with no 12.5% bucket anywhere.
 *
 * Nothing here branches on any of that. The workings read whichever fields the
 * return carries, and this module exists so the year is registered and tested
 * rather than run against code nobody checked it against (§9).
 */
import { buildItr3 } from "./build.js";

export function mapItr3Ay2022(body, ctx) {
  return buildItr3(body, ctx);
}
