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
import { mapItr1, SUPPORTED_YEARS as itr1Years } from "./mappers/itr1/index.js";
import { mapItr2, SUPPORTED_YEARS as itr2Years } from "./mappers/itr2/index.js";
import { mapItr3, SUPPORTED_YEARS as itr3Years } from "./mappers/itr3/index.js";
import { mapItr5, SUPPORTED_YEARS as itr5Years } from "./mappers/itr5/index.js";
import { renderHtml } from "./render/template.js";
import { resolveTheme, THEMES, THEME_IDS, DEFAULT_THEME } from "./render/themes/index.js";
import { loadFontFaceCss } from "./render/fonts/index.js";

const MAPPERS = {
  ITR1: mapItr1,
  ITR2: mapItr2,
  ITR3: mapItr3,
  ITR5: mapItr5,
};

/**
 * @param json ITR JSON exactly as downloaded from the portal
 * @param ctx  { assessee, profile, generatedAt, theme, fontCss }
 *
 *   `fontCss` is the theme's @font-face block, from `await fontCssFor(theme)`.
 *   Given one, the HTML leaves here COMPLETE and the render function has
 *   nothing left to inline (§14). Omitted — which is what every test does,
 *   because 80 KB of base64 in a golden file helps nobody — the slot stays and
 *   the server fills it as it always did.
 *
 * @returns { doc, html, theme } — `theme` is the id that was actually used, so
 *          the caller can tell the render function which typeface to inline
 *          without repeating the resolution (§14)
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

  /* THE THEME IS A LOOK, NOT A FIGURE. It reaches the renderer and nothing
     else — no mapper reads it, no validation depends on it, and the same JSON
     produces the same `doc` in either theme. The accent comes from the same
     profile setting that colours the invoices and the ITR-B, so a practice that
     has chosen its colour has chosen it once. */
  const theme = resolveTheme(ctx.theme || (ctx.profile || {}).computationTheme);
  const accent = ((ctx.profile || {}).invoiceSettings || {}).accent;

  return {
    doc,
    theme: theme.id,
    html: renderHtml(doc, { theme: theme.id, accent, fontCss: ctx.fontCss }),
  };
}

/**
 * The @font-face block for whichever theme this setting names — the thing to
 * hand `buildComputation` as `ctx.fontCss` (§14).
 *
 * It is async and separate from `buildComputation` because the faces are
 * dynamically imported: a session that never generates a computation never
 * downloads a typeface, and `buildComputation` itself stays synchronous and
 * pure, which is what every test and every golden depends on.
 *
 * Takes the same value as `ctx.theme` — a theme id, a settings value, or
 * nothing at all — so a caller resolves the theme once, here.
 */
export async function fontCssFor(theme) {
  return loadFontFaceCss(resolveTheme(theme).font);
}

export { detect, validate, UnsupportedFormError, ValidationError };
export { THEMES, THEME_IDS, DEFAULT_THEME, resolveTheme };

/* Which form-and-year combinations produce a document today, as the mappers
   themselves report it. The Returns tab does NOT read this — importing it would
   pull every mapper into the main bundle — it reads ./supported.js, which a test
   asserts against these. */
export const SUPPORTED = { ITR1: itr1Years, ITR2: itr2Years, ITR3: itr3Years, ITR5: itr5Years };
