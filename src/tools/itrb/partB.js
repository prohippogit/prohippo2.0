/*
 * Part B of Form ITR-B — the break-up of a part period's income.
 *
 * Source: Notification No. 30/2025, G.S.R. 221(E). The heading is the form's:
 * "Break-up of income as per section 158BB(1A)(c)(ii) and 158BB(1A)(c)(iii)
 * pertaining to the Assessment Year Y0 (part year) or Y+1 (part year, if
 * applicable)".
 *
 * WHICH ROW IT BELONGS TO. Exactly one — whichever of the block period is the
 * PART year. Where the search began and ended in the same previous year that is
 * Y0; where the last authorisation was executed later, Y0 is a complete year and
 * the part year is Y+1. Part B is not a per-year schedule and asking it of seven
 * rows would be asking it six times too often.
 *
 * "ENTER NIL IF LOSS". The form carries that instruction on nine of its rows,
 * and it is not a rounding convention — it is the whole reason a head that lost
 * money in the part period cannot shelter income in another head of the same
 * period. It is applied here rather than left to the practitioner, and every
 * row it bites on is reported, because a figure silently replaced by nil is a
 * figure nobody can reconcile.
 *
 * The subtotals (3v, 4av, 4biv, 4c, 4e, 5d, 6) are computed, never typed. The
 * form prints their formulae and a transcription sheet that lets them be keyed
 * independently is a sheet that can disagree with itself.
 */

/* The rows, in the form's order, with the form's numbering and wording.
 *
 *   heading      a band, no figure of its own
 *   key          a figure. With `of`, it is a subtotal of those keys; without,
 *                it is keyed by the practitioner.
 *   nilIfLoss    the form's instruction on that row
 *   indent       how deep it sits, for the form's own visual nesting
 */
export const PART_B_ROWS = [
  { no: "1", key: "salaries", label: "Salaries" },
  { no: "2", key: "houseProperty", label: "Income from house property", nilIfLoss: true },

  { no: "3", heading: "Profits and gains from business or profession" },
  { no: "3i", key: "bpNonSpec", indent: 1, nilIfLoss: true,
    label: "Profits and gains from business other than speculative business and specified business" },
  { no: "3ii", key: "bpSpeculative", indent: 1, nilIfLoss: true, label: "Profits and gains from speculative business" },
  { no: "3iii", key: "bpSpecified", indent: 1, nilIfLoss: true, label: "Profits and gains from specified business" },
  { no: "3iv", key: "bpSpecialRate", indent: 1, label: "Income chargeable to tax at special rates" },
  { no: "3v", key: "bpTotal", indent: 1, of: ["bpNonSpec", "bpSpeculative", "bpSpecified", "bpSpecialRate"],
    label: "Total (3i + 3ii + 3iii + 3iv)" },

  { no: "4", heading: "Capital gains" },
  { no: "4a", heading: "Short term", indent: 1 },
  { no: "ai", key: "stcg20", indent: 2, label: "Short-term chargeable @ 20%" },
  { no: "aii", key: "stcg30", indent: 2, label: "Short-term chargeable @ 30%" },
  { no: "aiii", key: "stcgApplicable", indent: 2, label: "Short-term chargeable at applicable rate" },
  { no: "aiv", key: "stcgDtaa", indent: 2, label: "Short-term chargeable at special rates in India as per DTAA" },
  { no: "4av", key: "stcgTotal", indent: 2, nilIfLoss: true, of: ["stcg20", "stcg30", "stcgApplicable", "stcgDtaa"],
    label: "Total Short-term (ai + aii + aiii + aiv)" },
  { no: "4b", heading: "Long term", indent: 1 },
  { no: "bi", key: "ltcg125", indent: 2, label: "Long-term chargeable @ 12.5%" },
  { no: "bii", key: "ltcg20", indent: 2, label: "Long-term chargeable @ 20%" },
  { no: "biii", key: "ltcgDtaa", indent: 2, label: "Long-term chargeable at special rates in India as per DTAA" },
  { no: "4biv", key: "ltcgTotal", indent: 2, nilIfLoss: true, of: ["ltcg125", "ltcg20", "ltcgDtaa"],
    label: "Total Long-term (bi + bii + biii)" },
  { no: "4c", key: "cgSum", indent: 1, nilIfLoss: true, of: ["stcgTotal", "ltcgTotal"],
    label: "Sum of Short-term / Long-term capital gains (4av + 4biv)" },
  { no: "4d", key: "cg115BBH", indent: 1, label: "Capital gain chargeable @ 30% u/s 115BBH" },
  { no: "4e", key: "cgTotal", indent: 1, of: ["cgSum", "cg115BBH"], label: "Total capital gains (4c + 4d)" },

  { no: "5", heading: "Income from other sources" },
  { no: "5a", key: "osNormal", indent: 1, nilIfLoss: true,
    label: "Net income from other sources chargeable to tax at normal applicable rates" },
  { no: "5b", key: "osSpecial", indent: 1, label: "Income chargeable to tax at special rate" },
  { no: "5c", key: "osRaceHorses", indent: 1, nilIfLoss: true,
    label: "Income from the activity of owning and maintaining race horses" },
  { no: "5d", key: "osTotal", indent: 1, of: ["osNormal", "osSpecial", "osRaceHorses"], label: "Total (5a + 5b + 5c)" },

  { no: "6", key: "total", grand: true, of: ["salaries", "houseProperty", "bpTotal", "cgTotal", "osTotal"],
    label: "Total of head wise income (1 + 2 + 3v + 4e + 5d)" },
];

/** The rows a practitioner types into. */
export const PART_B_LEAVES = PART_B_ROWS.filter((r) => r.key && !r.of);

const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/**
 * Which row of the block period Part B belongs to.
 *
 * @returns the year row, or null before the block period is known
 */
export const partBYear = (years, spansYears) =>
  (years || []).find((y) => y.part && (spansYears ? y.slot !== "Y0" : y.slot === "Y0")) || null;

/**
 * Work the schedule out.
 *
 * @param values  { [key]: string | number } as keyed by the practitioner
 * @returns { rows, total, floored }
 *          `rows` is keyed by row key and holds every figure, computed or keyed.
 *          `floored` names the rows where "enter nil if loss" bit, so the UI can
 *          say which loss was disregarded and by how much.
 */
export function computePartB(values = {}) {
  const rows = {};
  const floored = [];

  for (const row of PART_B_ROWS) {
    if (!row.key) continue;
    const raw = row.of
      ? row.of.reduce((sum, k) => sum + (rows[k] || 0), 0)
      : n(values[row.key]);
    if (row.nilIfLoss && raw < 0) {
      floored.push({ no: row.no, label: row.label, was: raw });
      rows[row.key] = 0;
    } else {
      rows[row.key] = raw;
    }
  }

  return { rows, total: rows.total || 0, floored };
}

/**
 * Does Part B agree with what Part C says about the same period?
 *
 * The form asks for it in as many words: the total of Part C's part-period
 * columns "should be equal to value from row 6 of PART-B". Two schedules
 * describing one period is one more place for them to disagree, and this is
 * where that shows up rather than on the portal.
 *
 * `entered` is false when nothing has been keyed into either — plenty of drafts
 * never reach Part B, and an untouched schedule is not a discrepancy.
 */
export function tiesToPartC(partBTotal, partCTotal) {
  const entered = partBTotal !== 0 || partCTotal !== 0;
  return { entered, ties: !entered || partBTotal === partCTotal, partBTotal, partCTotal };
}
