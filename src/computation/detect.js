/*
 * Which form, which year — docs/computation-spec.md §2 and §9.
 *
 * A portal ITR JSON is shaped { ITR: { ITR5: { … } } }, so the form is the sole
 * key under ITR. We read it from there rather than from Form_ITR5.FormName,
 * because the wrapper key is what every schedule actually hangs off.
 */

/** Raised when we have no mapper for a form + year. Never guessed around (§9). */
export class UnsupportedFormError extends Error {
  constructor(form, ay) {
    super(
      form
        ? `Computation of Income isn't available for ${form.replace(/^ITR/, "ITR-")} A.Y. ${ay || "this year"} yet.`
        : "This doesn't look like an ITR JSON downloaded from the portal."
    );
    this.name = "UnsupportedFormError";
    this.form = form;
    this.ay = ay;
  }
}

const FORMS = ["ITR1", "ITR2", "ITR3", "ITR4", "ITR5", "ITR6", "ITR7"];

/**
 * → { form, body, ay, schemaVersion }
 *
 * `body` is the form's own object, so every mapper starts from the same place
 * rather than each re-walking the wrapper.
 */
export function detect(json) {
  const root = json && json.ITR;
  if (!root || typeof root !== "object") throw new UnsupportedFormError("", "");

  const form = FORMS.find((f) => root[f] && typeof root[f] === "object");
  if (!form) throw new UnsupportedFormError("", "");
  const body = root[form];

  // Every form carries its own Form_ITRn block with the assessment year. The
  // portal writes it as the start year alone ("2025").
  const formBlock = body[`Form_${form}`] || {};
  const startYear = Number(formBlock.AssessmentYear || 0);
  const ay = startYear >= 1900 ? `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}` : "";

  return {
    form,
    body,
    ay,
    // Recorded for the document header, never branched on: it reads Ver1.0 in
    // returns whose schemas differ by a year (§9).
    schemaVersion: formBlock.SchemaVer || "",
  };
}
