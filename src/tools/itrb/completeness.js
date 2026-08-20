/*
 * What is still blank, part by part.
 *
 * WHY THIS EXISTS. The form is nine parts over eight rows, and readiness() —
 * which came first — returns one flat list of everything wrong with a draft.
 * That was the right shape when the tool modelled three parts. It is the wrong
 * shape now: a practitioner keying the portal works down it part by part and
 * needs to know which part they can leave, not that there are eleven problems
 * somewhere.
 *
 * So this reports per part, and each part answers one question: can I key this
 * one from the sheet, or is there a hole in it? A hole nobody can see is the
 * failure mode a transcription sheet has that a computation does not — the
 * computation is visibly wrong when a figure is missing, and the sheet just
 * looks finished.
 *
 * ADVISORY, LIKE readiness(). Nothing here stops a document being produced.
 * "Not started" is a perfectly good state for Part B on the day the block period
 * is first cut.
 */
import { missingFor } from "./partA.js";

const DONE = "done";
const PARTIAL = "partial";
const EMPTY = "empty";
const NA = "na";

const has = (v) => v !== "" && v !== null && v !== undefined;

/**
 * @param draft   the draft as edited
 * @param result  computeItrB(draft)
 * @returns [{ id, title, status, detail }]
 */
export function completeness(draft, result) {
  const d = draft || {};
  const years = result?.years || [];
  const out = [];

  /* ---- Part A, the general half ---- */
  const generalWants = [
    [/^[A-Z]{5}\d{4}[A-Z]$/.test((d.pan || "").toUpperCase()), "PAN"],
    [has(d.assessee), "name"],
    [has(d.searchDate), "date of first authorisation (A19)"],
    [has(d.noticeDin), "DIN of the notice (A23)"],
    [has(d.serviceDate), "date of service"],
    [has(d.dueDate), "due date (A24)"],
  ].filter(([ok]) => !ok).map(([, name]) => name);
  out.push({
    id: "A", title: "Part A — general information",
    status: generalWants.length === 0 ? DONE : generalWants.length >= 5 ? EMPTY : PARTIAL,
    detail: generalWants.length ? `Still wants the ${generalWants.join(", ")}.` : "",
  });

  /* ---- Part A, the per-year half ---- */
  const perYear = years
    .map((y) => ({ slot: y.slot, missing: missingFor(y, result?.spansYears) }))
    .filter((x) => x.missing.length);
  out.push({
    id: "A25", title: "Part A — the return for each year (A25–A34)",
    status: !years.length ? EMPTY : perYear.length === 0 ? DONE : perYear.length === years.length ? EMPTY : PARTIAL,
    detail: perYear.length
      ? `${perYear.map((x) => x.slot).join(", ")} still incomplete — ${perYear[0].slot} wants the ${perYear[0].missing.join(", ")}.`
      : "",
  });

  /* ---- Part B ---- */
  const partBRow = result?.partBRow;
  out.push({
    id: "B", title: "Part B — the part period, head by head",
    status: !partBRow ? NA
      : !result.partBTie.entered ? EMPTY
        : result.partBTie.ties ? DONE : PARTIAL,
    detail: !partBRow ? "No part period until the search dates are in."
      : !result.partBTie.entered ? `Nothing entered for ${partBRow.slot} yet.`
        : result.partBTie.ties ? ""
          : `Row 6 is ${result.partBTie.partBTotal.toLocaleString("en-IN")} against Part C's ${result.partBTie.partCTotal.toLocaleString("en-IN")}.`,
  });

  /* ---- Part C ---- */
  const withUndisclosed = years.filter((y) => y.totalUndisclosed > 0).length;
  const withContext = years.filter((y) => Object.keys(y.partC || {}).some((k) => !k.endsWith("Applies") && !k.endsWith("Section") && !k.endsWith("Misplaced") && y.partC[k])).length;
  out.push({
    id: "C", title: "Part C — undisclosed income and what is already on record",
    status: !result?.hasContent ? EMPTY
      : result.misplacedPartC?.length ? PARTIAL
        : withContext ? DONE : PARTIAL,
    detail: !result?.hasContent ? "No undisclosed income declared in column [A] yet."
      : result.misplacedPartC?.length ? `Figures sit in columns that do not belong to their rows: ${result.misplacedPartC.map((m) => `[${m.letter}] against ${m.slot}`).join(", ")}.`
        : withContext ? "" : `Column [A] is in for ${withUndisclosed} year(s); columns [B] to [H] are still blank.`,
  });

  /* ---- Part D ---- */
  out.push({
    id: "D", title: "Part D — head-wise and item-wise break-up",
    status: !result?.hasContent ? EMPTY
      : !result.itemsEntered ? PARTIAL
        : result.itemsTie ? DONE : PARTIAL,
    detail: !result?.hasContent ? "Nothing to break up yet."
      : !result.itemsEntered ? "Part D-I is in; Part D-II has not been started."
        : result.itemsTie ? ""
          : `Part D-II totals ${result.totalByItem.toLocaleString("en-IN")} against Part D-I's ${result.totalUndisclosed.toLocaleString("en-IN")}.`,
  });

  /* ---- Part E. Computed throughout, so it is only ever waiting on Part C. ---- */
  out.push({
    id: "E", title: "Part E — tax payable",
    status: result?.hasContent ? DONE : EMPTY,
    detail: result?.hasContent ? "" : "Computed as soon as there is undisclosed income to charge.",
  });

  /* ---- Parts F, G and H ---- */
  const paid = (result?.blockTaxPaidTotal || 0) + (result?.credits?.total || 0);
  out.push({
    id: "FGH", title: "Parts F, G and H — taxes paid and credit claimed",
    status: paid > 0 ? DONE : EMPTY,
    detail: paid > 0 ? "" : "Nothing claimed. Leave it if there is nothing to claim — the form does not require a figure.",
  });

  /* ---- Verification ---- */
  const vWants = [
    [has(d.verifierName), "name"],
    [has(d.verifierCapacity), "capacity"],
    [has(d.verifierPan), "PAN"],
    [has(d.verificationPlace), "place"],
    [has(d.verificationDate), "date"],
  ].filter(([ok]) => !ok).map(([, name]) => name);
  out.push({
    id: "V", title: "Verification",
    status: vWants.length === 0 ? DONE : vWants.length >= 4 ? EMPTY : PARTIAL,
    detail: vWants.length ? `Still wants the ${vWants.join(", ")}.` : "",
  });

  return out;
}

/** One line for the top of the panel. Counts only the parts that apply. */
export function summarise(parts) {
  const live = parts.filter((p) => p.status !== NA);
  const done = live.filter((p) => p.status === DONE).length;
  return { done, total: live.length, complete: done === live.length && live.length > 0 };
}

export const STATUS = { DONE, PARTIAL, EMPTY, NA };
