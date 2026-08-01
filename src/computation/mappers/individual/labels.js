/*
 * Label tables for the individual/HUF family of returns — ITR-2 and ITR-3.
 * docs/computation-spec.md §9; anything year-specific belongs in ayNNNN-NN.js.
 *
 * ITR-2 and ITR-3 are the same return with one difference: ITR-3 carries a
 * business head. Their Schedule S, HP, CG, OS, VIA, SI, TDS and Part B-TTI
 * blocks are the same schema, field for field, so the captions live here once
 * rather than being copied into each form's directory and drifting apart.
 *
 * ITR-5 is deliberately NOT served from here. A firm's return has no salary,
 * no regime choice, no s.16 deductions and a differently-sensed regime field;
 * sharing a table with it would mean one table trying to satisfy two audiences.
 */

/* Schedule SI drives the special-rate rows in the tax section. The section codes
   are ITD's own; an unrecognised one prints as itself rather than being guessed
   at, because a wrong statutory reference on a signed document is worse than a
   bare code a reader can look up. */
const SI_SECTIONS = {
  "1A": "Short-term capital gains u/s 111A",
  "21": "Short-term capital gains u/s 111A",
  "2A": "Long-term capital gains u/s 112A",
  "2A_BE": "Long-term capital gains u/s 112A",
  22: "Long-term capital gains u/s 112",
  "5AC": "Income u/s 115AC",
  "5ACA": "Income u/s 115ACA",
  "5AD1b i": "Income u/s 115AD",
  "1BB": "Winnings from lotteries, crossword puzzles etc. u/s 115BB",
  "1BBE": "Income u/s 115BBE",
  "1BBJ": "Winnings from online games u/s 115BBJ",
  DTAA: "Income taxable at DTAA rates",
};

/** A readable caption for a Schedule SI row. */
export function specialRateLabel(code) {
  const c = String(code || "").trim();
  return SI_SECTIONS[c] || `Income taxable at a special rate (code ${c})`;
}

/* The regime, which every deduction below it depends on — so the computation
   states it rather than leaving a reader to infer it from whether 80C appears.
   Both fields read backwards: they ask whether the assessee opted OUT.

   ITR-2 asks it once, as `OptOutNewTaxRegime`. ITR-3 asks it as
   `No_OptOutNewTaxReg` alongside `OptOutNewTaxRegime_Method` (how the option was
   exercised, e.g. BY10IEA = by filing Form 10-IEA). The reading of
   `No_OptOutNewTaxReg` is not guessed: in the ITR-3 fixture it is "N", and the
   return's own tax at normal rates reconciles to the rupee against the
   s.115BAC(1A) slabs and to nothing else — see §10. */
export function regimeLabel(filingStatus) {
  const fs = filingStatus && typeof filingStatus === "object" ? filingStatus : {};
  const raw = fs.OptOutNewTaxRegime ?? fs.No_OptOutNewTaxReg;
  const v = String(raw ?? "").trim().toUpperCase();
  if (v === "Y") return "Old regime — opted out of s.115BAC(1A)";
  if (v === "N") return "New regime u/s 115BAC(1A) (default)";
  return "";
}

/* Chapter VI-A. The return carries what was claimed and what is allowed after
   the statutory caps in two parallel blocks; these are the sections we know how
   to caption. Anything else in the block is still shown, under its own field
   name, rather than dropped — see §8. */
const VIA_SECTIONS = {
  Section80C: "u/s 80C — life insurance, provident fund, tuition fees etc.",
  Section80CCC: "u/s 80CCC — contribution to a pension fund",
  Section80CCDEmployee: "u/s 80CCD(1) — employee's contribution to NPS",
  Section80CCD1B: "u/s 80CCD(1B) — additional contribution to NPS",
  Section80CCDEmployer: "u/s 80CCD(2) — employer's contribution to NPS",
  Section80D: "u/s 80D — health insurance premium",
  Section80DD: "u/s 80DD — maintenance of a dependant with disability",
  Section80DDB: "u/s 80DDB — medical treatment of specified diseases",
  Section80E: "u/s 80E — interest on a loan for higher education",
  Section80EE: "u/s 80EE — interest on a housing loan",
  Section80EEA: "u/s 80EEA — interest on a housing loan",
  Section80EEB: "u/s 80EEB — interest on a loan for an electric vehicle",
  Section80G: "u/s 80G — donations to certain funds and institutions",
  Section80GG: "u/s 80GG — rent paid",
  Section80GGA: "u/s 80GGA — donations for scientific research or rural development",
  Section80GGC: "u/s 80GGC — contribution to a political party",
  Section80TTA: "u/s 80TTA — interest on deposits in a savings account",
  Section80TTB: "u/s 80TTB — interest on deposits (senior citizens)",
  Section80U: "u/s 80U — person with disability",
};

export function viaLabel(key) {
  return VIA_SECTIONS[key] || `Deduction under ${String(key).replace(/^Section/, "u/s ")}`;
}

/** The order deductions are conventionally listed in. Unknown keys come last. */
export function viaOrder(key) {
  const i = Object.keys(VIA_SECTIONS).indexOf(key);
  return i === -1 ? 999 : i;
}

/* Capacity codes on the verification block. An individual signing their own
   return uses "S"; the rest appear on HUF and representative filings. */
const CAPACITY = { S: "Self", KA: "Karta", AM: "Authorised Member", R: "Representative Assessee", G: "Guardian" };

export function capacityName(code) {
  const c = String(code || "").trim().toUpperCase();
  return CAPACITY[c] || c;
}

/* Residential status. The return carries a two- or three-letter code and, for a
   resident, a further condition code that distinguishes ordinarily resident
   from not ordinarily resident. */
export function residentialStatus(code) {
  return { RES: "Resident", NRI: "Non-Resident", NOR: "Resident but not ordinarily resident" }[
    String(code || "").trim().toUpperCase()
  ] || String(code || "");
}

/** "PARIHAR" + "JAYANTSINH" + "RANJITSINH" → "Jayantsinh Ranjitsinh Parihar". */
export function personName(assesseeName) {
  const a = assesseeName || {};
  return [a.FirstName, a.MiddleName, a.SurNameOrOrgName]
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .join(" ");
}

/** Join address fields, dropping blanks, without leaving stray commas. */
export function joinAddress(addr) {
  if (!addr || typeof addr !== "object") return "";
  return [
    addr.ResidenceNo, addr.ResidenceName, addr.RoadOrStreet, addr.LocalityOrArea,
    addr.CityOrTownOrDistrict, addr.PinCode,
  ].map((x) => String(x == null ? "" : x).trim().replace(/,$/, "")).filter(Boolean).join(", ");
}

/* Section under which the return was filed. ITR-5 carries the same table in its
   own helpers; see the note at the top of this file on why that one is not
   served from here. */
const FILING_SECTION = {
  11: "Section 139(1) — on or before the due date",
  12: "Section 139(4) — belated",
  13: "Section 139(5) — revised",
  14: "Section 142(1)",
  15: "Section 148",
  16: "Section 153A",
  17: "Section 139(8A) — updated return",
  18: "Section 119(2)(b)",
  19: "Section 139(9) — in response to a defective-return notice",
  20: "Section 170A",
};

export function filingSection(code) {
  const n = Number(code);
  return FILING_SECTION[n] || (code ? `Section code ${code}` : "");
}

export function isNonOrdinaryFiling(code) {
  return [12, 13, 17, 18, 19].includes(Number(code));
}

/* TDS section codes — the portal writes "94A" for s.194A. An unrecognised code
   prints as itself; the nature line is simply omitted when we cannot name it. */
const TDS_SECTIONS = {
  "92A": "192A", "92B": "192", "93A": "193", 94: "194",
  "94A": "194A", "94B": "194B", "94C": "194C", "94D": "194D", "4DA": "194DA",
  "94H": "194H", "4H": "194H", "4I": "194I", "94I": "194I", "4IA": "194IA",
  "4IB": "194IB", "4IC": "194IC", "94J": "194J", "4JA": "194J(a)", "4JB": "194J(b)",
  "94K": "194K", "94M": "194M", "94N": "194N", "94O": "194-O", "94Q": "194Q",
  "94R": "194R", "94S": "194S", "95A": "195",
};

const TDS_NATURE = {
  192: "Salary", 193: "Interest on securities", 194: "Dividend",
  "194A": "Interest other than interest on securities",
  "194C": "Payments to contractors", "194H": "Commission or brokerage",
  "194I": "Rent", "194J": "Fees for professional or technical services",
  "194K": "Income in respect of units", "194N": "Cash withdrawals",
  "194-O": "Payments by an e-commerce operator", "194Q": "Purchase of goods",
};

export const tdsSection = (code) => TDS_SECTIONS[String(code || "").trim().toUpperCase()] || String(code || "");
export const tdsNature = (section) => TDS_NATURE[section] || "";
