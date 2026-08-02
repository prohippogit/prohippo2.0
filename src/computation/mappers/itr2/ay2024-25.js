/*
 * ITR-2, A.Y. 2024-25.
 *
 * The last year before the capital-gains rates changed: Part B-TI carries a
 * single 10% long-term bucket and no 12.5% one, and Schedule SI states 10%
 * against s.112A rather than two rows split at 23 July 2024. Nothing here
 * branches on that — the workings in ../individual/heads.js read whichever
 * buckets the return puts a figure against, and take the rate from Schedule SI.
 *
 * It is also the first year on either individual form where the old regime
 * appears: this is the year Chapter VI-A still does real work, so the claimed
 * and allowed columns of Schedule VI-A both matter (§10).
 */
import { buildItr2 } from "./build.js";

export function mapItr2Ay2024(body, ctx) {
  return buildItr2(body, ctx);
}
