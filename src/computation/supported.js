/*
 * Which form-and-year combinations a Computation of Income exists for.
 *
 * Kept apart from index.js on purpose. The Returns tab has to answer "can this
 * year be generated?" while it draws the table, and importing index.js to find
 * out would pull every mapper and the renderer into the main bundle — the
 * feature is deliberately code-split behind a dynamic import (§13). This module
 * is a table and two pure functions, so importing it costs nothing.
 *
 * It is the single place the UI reads. test/computation/supported.test.mjs
 * asserts it matches the mappers' own year lists, so adding a mapper without
 * updating this fails loudly rather than leaving a button that says "coming
 * soon" for a year that works.
 */

/** Form key (as detect() reports it) → assessment years with a mapper. */
export const SUPPORTED = {
  ITR2: ["2026-27", "2025-26"],
  ITR3: ["2025-26", "2024-25"],
  ITR5: ["2025-26"],
};

/** "ITR-3" → "ITR3"; also accepts "ITR3" and "itr 3". */
export function formKey(form) {
  const m = /(\d)/.exec(String(form || ""));
  return m ? `ITR${m[1]}` : "";
}

const readable = (key) => key.replace(/^ITR/, "ITR-");
const list = (items) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}` : items[0] || "");

/**
 * Can a computation be generated for this return?
 *
 * @param form an ITR form as stored on the return ("ITR-3"), or "" if unknown
 * @param ay   "2025-26"
 * @returns { ok, reason } — `reason` is shown to the practitioner as it stands,
 *          so it says what is available rather than only what is not.
 *
 * An unknown form is treated as available: the form is only certain once the
 * JSON is read, and detect() raises a plain sentence of its own if there is no
 * mapper. Refusing up front on a missing code would hide a year that works.
 */
export function computationAvailability(form, ay) {
  const key = formKey(form);
  if (!key) return { ok: true, reason: "" };

  const years = SUPPORTED[key];
  if (!years) {
    return {
      ok: false,
      reason: `A Computation of Income for ${readable(key)} isn't built yet. Available today: ${list(Object.keys(SUPPORTED).map(readable))}.`,
    };
  }
  if (!years.includes(String(ay))) {
    return {
      ok: false,
      reason: `A Computation of Income for ${readable(key)} is built for A.Y. ${list(years)} only. Each year's schema differs, and a mapper run against a year it was not written for produces a document that looks right and is wrong.`,
    };
  }
  return { ok: true, reason: "" };
}
