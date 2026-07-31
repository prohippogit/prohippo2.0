/*
 * Computation of Income — public API.
 *
 *     const { doc, html } = buildComputation(itrJson, { assessee, profile });
 *
 * docs/computation-spec.md is authoritative. If this code and the spec disagree,
 * the spec wins and this code is wrong.
 *
 * Everything here is pure: same JSON in, same HTML out, no network, no AI. The
 * only server call in the feature is the HTML→PDF render (§13), and that happens
 * after this function has returned.
 */
import { detect, UnsupportedFormError } from "./detect.js";
import { validate, ValidationError } from "./validate.js";
import { mapItr5 } from "./mappers/itr5/index.js";
import { renderHtml } from "./render/template.js";

const MAPPERS = {
  ITR5: mapItr5,
};

/**
 * @param json ITR JSON exactly as downloaded from the portal
 * @param ctx  { assessee, profile, generatedAt }
 * @returns { doc, html }
 * @throws  UnsupportedFormError — no mapper for this form/year
 * @throws  ValidationError      — the document does not tie to the return (§7)
 */
export function buildComputation(json, ctx = {}) {
  const { form, body, ay, schemaVersion } = detect(json);

  const map = MAPPERS[form];
  if (!map) throw new UnsupportedFormError(form, ay);

  const doc = map(body, {
    ay,
    schemaVersion,
    // Pinned by the caller in tests so a golden comparison is stable.
    generatedAt: ctx.generatedAt || new Date().toISOString(),
    assessee: ctx.assessee || {},
    profile: ctx.profile || {},
  });

  // §7: a computation that does not reconcile with the return it was built from
  // is worse than no computation. This raises rather than warns, and the Returns
  // tab reports it instead of issuing a document that does not tie.
  const result = validate(doc, body);
  if (!result.ok) throw new ValidationError(result.failures);

  return { doc, html: renderHtml(doc) };
}

export { detect, validate, UnsupportedFormError, ValidationError };
export { SUPPORTED_YEARS } from "./mappers/itr5/index.js";
