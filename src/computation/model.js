/*
 * The normalised ComputationDocument — docs/computation-spec.md §3 and §4.
 *
 * Mappers build one of these; the renderer consumes it and nothing else. That
 * separation is the whole point: a new ITR form is a new mapper, never a branch
 * inside render/ (§2).
 */

/* Row constructors. `amount` is deliberately three-valued (§3):
     a number  → print it
     0         → print an em dash in a greyed row (the head exists, income is nil)
     null      → print nothing (the cell is structural)
   Do not collapse 0 and null. In a tax document they mean different things. */

/* Drop keys whose value is undefined.
 *
 * A row built as `{ isLoss: x < 0 ? true : undefined }` is not the same object
 * as the one you get back from JSON.parse(JSON.stringify(row)) — stringify
 * omits the key entirely. The golden tests (§11) compare a freshly built model
 * against a stored one, so a model that does not survive a JSON round trip
 * cannot be tested. Keeping the constructors clean is cheaper than teaching
 * every test to be lenient about it. Note the deliberate exception: `amount`
 * keeps an explicit null, because null and absent mean different things (§3). */
const clean = (row) => {
  for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
  return row;
};

export const head = (label, amount, opts = {}) => clean({ kind: "head", label, amount, ...opts });
export const sub = (label, amount, opts = {}) => clean({ kind: "sub", label, amount, ...opts });
export const subtotal = (label, amount, opts = {}) => clean({ kind: "subtotal", label, amount, ...opts });
export const total = (label, amount, opts = {}) => clean({ kind: "total", label, amount, ...opts });
export const columnHeader = (label, cols) => clean({ kind: "columnHeader", label, amount: null, cols });

/** A section of the computation. `letter` is assigned later — see finalise(). */
export const section = (id, title, rows, opts = {}) => ({
  id,
  letter: "",
  title,
  tone: opts.tone || "navy",
  rows: rows.filter(Boolean),
  footnote: opts.footnote || "",
  omitIfAllNil: opts.omitIfAllNil !== false,
});

/* The order sections are emitted in (§4). TI, TAX and TAXES_PAID are always
   present; the head-specific workings above them only appear when that head has
   something to show. */
const SECTION_ORDER = ["SALARY", "HP", "BP", "CG", "OS", "TI", "TAX", "TAXES_PAID", "CFL"];
const ALWAYS = new Set(["TI", "TAX", "TAXES_PAID"]);

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const isNil = (v) => v === null || v === undefined || Number(v) === 0;

/**
 * Drop empty sections, put the rest in spec order, and letter them A, B, C…
 *
 * Lettering happens AFTER the drop, so a computation with no capital gains runs
 * A, B, C with no gap where D would have been (§4). Hard-coding letters in the
 * mappers would produce exactly that gap the first time a head came out nil.
 */
export function finalise(sections) {
  const kept = sections
    .filter(Boolean)
    .filter((s) => ALWAYS.has(s.id) || !s.omitIfAllNil || s.rows.some((r) => !isNil(r.amount)))
    .sort((a, b) => SECTION_ORDER.indexOf(a.id) - SECTION_ORDER.indexOf(b.id));
  kept.forEach((s, i) => { s.letter = LETTERS[i] || String(i + 1); });
  return kept;
}

/** Assemble the document. Mappers call this last. */
export function document({ meta, assessee, sections, refund, payable, notes, signatory, unmapped }) {
  return {
    meta,
    assessee,
    sections: finalise(sections),
    refund: refund || null,
    payable: payable || null,
    notes: notes || [],
    signatory,
    unmapped: unmapped || [],
  };
}

/** Find a row by its label across every section — used by validate() (§7). */
export function findRow(doc, sectionId, labelStartsWith) {
  const s = doc.sections.find((x) => x.id === sectionId);
  if (!s) return null;
  return s.rows.find((r) => r.label.startsWith(labelStartsWith)) || null;
}
