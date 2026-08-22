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

/* A SCHEDULE — a grid with a column per thing and a line per figure.
 *
 * The three-column working states one figure per line, and for almost every head
 * that is the right shape: the reader is following an argument down the page.
 *
 * A property sale is not that shape. The reader is comparing one asset against
 * another — this consideration against that one, this indexed cost against that
 * one, this exemption against that one — and a working interleaves them into a
 * ribbon of "property 1 / property 2 / property 1" that cannot be read across.
 * An assessee who sold two plots and claimed six deductions under s.54B against
 * them gets twenty-odd rows in no discernible order.
 *
 * So the model gains a kind rather than the renderer a branch (§2, §3): a matrix
 * carries its own column headings and its own lines, and the renderer rules it
 * like the schedule it is. A cell is a number (formatted as an amount, 0 being
 * an em dash), a string (a date, a name, a PAN — printed as given), or null
 * (structurally blank, the same distinction §3 draws for `amount`).
 *
 * `lines[].kind` is the same vocabulary as a row's: 'sub' by default, with
 * 'subtotal' and 'total' banded as they are anywhere else.
 */
export const matrix = (label, opts = {}) => clean({
  kind: "matrix",
  label,
  // A matrix has no single amount: every figure in it sits in a cell. Stated
  // explicitly because the renderer and finalise() both read `amount` on every
  // row, and a missing key is not the same as a declared null (§3).
  amount: null,
  ref: opts.ref,
  note: opts.note,
  // Cleaned like any other row: a column built as `{ label, note: undefined }`
  // is not deep-equal to the one that comes back from a golden file, where
  // JSON.stringify dropped the key (see `clean` above).
  columns: (opts.columns || []).filter(Boolean).map((c) => clean({ ...c })),
  lines: (opts.lines || []).filter(Boolean),
});

/** One line of a matrix. `cells` is positional against `columns`.
 *
 * `span: true` makes the line a BANNER instead: one cell across the whole
 * schedule, carrying no figures. It exists because two of a property sale's
 * particulars are long strings — the address, and three joint buyers with their
 * PANs and their shares — and in a column narrow enough for the figures to fit
 * beside them they set fourteen lines apiece. Given the width of the page they
 * set one or two, and they are what a reader identifies the line below by.
 */
export const matrixLine = (label, cells, opts = {}) => clean({ label, cells: cells || [], ...opts });

/* A section of the computation. `letter` is assigned later — see finalise().
 *
 * `layout` says what SHAPE the section is, not what it looks like — the look is
 * the renderer's business (§2, §6). Two shapes exist:
 *
 *   (absent)  a working. Rows are steps in an argument: a figure, then what is
 *             added to it, then what is taken off it, then the result. The
 *             middle column is a source reference and most rows do not use it.
 *   'table'   a ledger. Every row is a record of the same kind, and all three
 *             columns carry data on every one of them — losses carried forward
 *             are an assessment year, a filing date and an amount.
 *
 * A mapper marks the shape; the renderer decides that a ledger gets ruled
 * columns and a working does not. Neither of them knows which FORM it is
 * looking at, which is the rule §2 exists to keep. */
export const section = (id, title, rows, opts = {}) => clean({
  id,
  letter: "",
  title,
  tone: opts.tone || "navy",
  layout: opts.layout,
  rows: rows.filter(Boolean),
  footnote: opts.footnote || "",
  omitIfAllNil: opts.omitIfAllNil !== false,
});

/* The order sections are emitted in (§4). TI, TAX and TAXES_PAID are always
   present; the head-specific workings above them only appear when that head has
   something to show. */
const SECTION_ORDER = ["SALARY", "HP", "BP", "CG", "OS", "VIA", "TI", "TAX", "TAXES_PAID", "CFL"];
const ALWAYS = new Set(["TI", "TAX", "TAXES_PAID"]);

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const isNil = (v) => v === null || v === undefined || Number(v) === 0;

/* Does this row put a figure on the page? What decides whether a head-specific
   section is dropped for having nothing to say.

   A matrix declares `amount: null` — every figure it carries is in a cell — so
   reading `amount` alone would drop a capital gains section holding a two-crore
   property schedule. Only NUMERIC cells count: a matrix whose only content is
   dates and buyers' names has no figure in it, and the same rule that drops a
   nil head should drop that too. */
const rowHasFigure = (r) => (r.kind === "matrix"
  ? (r.lines || []).some((l) => (l.cells || []).some((c) => typeof c === "number" && c !== 0))
  : !isNil(r.amount));

/* An id missing from SECTION_ORDER sorts LAST, not first. indexOf returns -1
   for an unknown id, which would put a newly added section ahead of every head
   — silently, and only visibly wrong to someone who knows what the order
   should be. Sorting it to the end makes the omission obvious instead. */
const order = (id) => {
  const i = SECTION_ORDER.indexOf(id);
  return i === -1 ? SECTION_ORDER.length : i;
};

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
    .filter((s) => ALWAYS.has(s.id) || !s.omitIfAllNil || s.rows.some(rowHasFigure))
    .sort((a, b) => order(a.id) - order(b.id));
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
