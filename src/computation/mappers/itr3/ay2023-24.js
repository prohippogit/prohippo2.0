/*
 * ITR-3, A.Y. 2023-24.
 *
 * The widest return we hold on any form: salary, a proprietary business with
 * full books, capital gains including virtual digital assets, a partner's
 * income from a firm, and other sources — all on one return, which is exactly
 * the case the head builders were written not to assume away.
 *
 * It shares A.Y. 2022-23's regime question (`NewTaxRegime`, whose sense runs
 * the opposite way to the later years' opt-out field) and its flat Schedule CG
 * blocks. See ../individual/labels.js and ../individual/heads.js.
 */
import { buildItr3 } from "./build.js";

export function mapItr3Ay2023(body, ctx) {
  return buildItr3(body, ctx);
}
