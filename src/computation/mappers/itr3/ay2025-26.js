/*
 * ITR-3, A.Y. 2025-26.
 *
 * The workings are in ./build.js, which this year shares with A.Y. 2024-25 —
 * every schedule they read carries the same fields in both. This module exists
 * so the year is registered explicitly and has somewhere to diverge: when a
 * future Finance Act changes a schedule, the branch belongs here, not behind a
 * condition inside the shared builder.
 */
import { buildItr3 } from "./build.js";

export function mapItr3Ay2025(body, ctx) {
  return buildItr3(body, ctx);
}
