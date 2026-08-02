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
   are ITD's own, and so are the meanings: the department publishes the full code
   list in the `SecCode` enum of its own schema, where every code carries a
   description. The table below is that list, with the department's wording put
   into the house style — not a reading of what a code looked like it meant.

   Source: ITR2_2024_Main_V1.4.json,
   definitions.ScheduleSI.properties.SplCodeRateTax.items.properties.SecCode.

   That source matters. Code "21" was once captioned here as "short-term capital
   gains u/s 111A" — a guess, and a wrong one; the schema states it is s.112 long
   term gain with indexation, which is what the A.Y. 2024-25 ITR-3 that exposed
   the error also showed. Codes not in the list print as themselves (§5): a wrong
   statutory reference on a signed document is worse than a bare code a reader
   can look up. */
const SI_SECTIONS = {
  1: "Tax on the accumulated balance of a recognised provident fund u/s 111",
  "1A": "Short-term capital gains u/s 111A",
  /* Not "with indexation", though the A.Y. 2024-25 schema words it that way.
     The A.Y. 2026-27 ITR-3 carries code 21 at 12.5%, which is the amended s.112
     rate charged WITHOUT indexation — so the qualifier is a year-dependent
     claim, and the rate is printed alongside the caption anyway. */
  21: "Long-term capital gains u/s 112",
  22: "Long-term capital gains u/s 112, at the proviso rate",
  "21ciii": "Long-term capital gains u/s 112(1)(c)(iii) — unlisted securities of a non-resident",
  "2A": "Long-term capital gains u/s 112A",
  "5A1ai": "Dividend, interest and income from units purchased in foreign currency u/s 115A(1)(a)(i)",
  "5A1aA": "Dividend from a unit in an IFSC u/s 115A(1)(a)(A)",
  "5A1aii": "Interest from Government or an Indian concern received in foreign currency u/s 115A(1)(a)(ii)",
  "5A1aiia": "Interest from an infrastructure debt fund u/s 115A(1)(a)(iia)",
  "5A1aiiaa": "Interest u/s 194LC(1), taxable u/s 115A(1)(a)(iiaa)",
  "5A1aiiaaP": "Income of a non-resident under the proviso to s.194LC(1), taxable u/s 115A(1)(a)(iiaa)",
  "5A1aiiab": "Interest u/s 194LD, taxable u/s 115A(1)(a)(iiab)",
  "5A1aiiac": "Interest u/s 194LBA, taxable u/s 115A(1)(a)(iiac)",
  "5A1aiii": "Income from units of the UTI purchased in foreign currency u/s 115A(1)(a)(iii)",
  "5A1bA": "Royalty and fees for technical services u/s 115A(1)(b)",
  "5AC1ab": "Interest on bonds purchased in foreign currency u/s 115AC(1)(a)",
  "5AC1abD": "Dividend on GDRs purchased in foreign currency u/s 115AC(1)(b)",
  "5AC1c": "Long-term capital gains on bonds or GDRs purchased in foreign currency u/s 115AC(1)(c)",
  "5ACA1a": "Income from GDRs purchased in foreign currency u/s 115ACA(1)(a)",
  "5ACA1b": "Long-term capital gains on GDRs purchased in foreign currency u/s 115ACA(1)(b)",
  "5AD1i": "Income of an FII from securities u/s 115AD(1)(i)",
  "5AD1iDiv": "Dividend received by an FII on securities u/s 115AD(1)(i)",
  "5AD1iP": "Income of an FII from bonds or Government securities u/s 194LD, taxable u/s 115AD(1)(i)",
  "5AD1biip": "Short-term capital gains of an FII referred to in s.111A, taxable u/s 115AD(1)(b)(ii)",
  "5ADii": "Short-term capital gains of an FII, other than those u/s 111A, taxable u/s 115AD(1)(ii)",
  "5ADiii": "Long-term capital gains of an FII u/s 115AD(1)(iii)",
  "5ADiiiP": "Long-term capital gains of an FII under the proviso to s.115AD(1)(iii)",
  "5BB": "Winnings from lotteries, crossword puzzles, races, card games and the like u/s 115BB",
  "5BBJ": "Winnings from online games u/s 115BBJ",
  "5BBA": "Income of a non-resident sportsman or sports association u/s 115BBA",
  "5BBC": "Anonymous donations u/s 115BBC",
  "5BBE": "Income referred to in s.68, 69, 69A, 69B, 69C or 69D, taxable u/s 115BBE",
  "5BBF": "Income from patents u/s 115BBF",
  "5BBG": "Income from the transfer of carbon credits u/s 115BBG",
  "5BBH": "Income from the transfer of virtual digital assets u/s 115BBH",
  "5Ea": "Investment income of a non-resident Indian u/s 115E(a)",
  "5Eacg": "Long-term capital gains of a non-resident Indian on an asset other than a specified asset u/s 115E(a)",
  "5Eb": "Long-term capital gains of a non-resident Indian u/s 115E(b)",
  DTAASTCG: "Short-term capital gains taxable at DTAA rates",
  DTAALTCG: "Long-term capital gains taxable at DTAA rates",
  DTAAOS: "Income from other sources taxable at DTAA rates",
  DTAA: "Income taxable at DTAA rates",
};

/* Pass-through income carries the same section codes with a PTI_ prefix — the
   income of a business trust or investment fund, taxed in the unit holder's
   hands under the section that would have applied to the fund. A few PTI codes
   name the rate instead of a section, so those are captioned separately. */
const PTI_RATE_CODES = {
  PTI_STCG15P: "Short-term capital gains u/s 111A, at 15%",
  PTI_STCG30P: "Short-term capital gains at 30%",
  PTI_LTCG10P112A: "Long-term capital gains u/s 112A, at 10%",
  PTI_LTCG12_5P112A: "Long-term capital gains u/s 112A, at 12.5%",
  PTI_LTCG10P: "Long-term capital gains at 10%",
  PTI_LTCG12_5P: "Long-term capital gains at 12.5%",
  PTI_LTCG20P: "Long-term capital gains at 20%",
};

/** A readable caption for a Schedule SI row. */
export function specialRateLabel(code) {
  const c = String(code || "").trim();
  // The suffixes mark the same section stated twice, not a different section:
  // _BE / _AE split a figure across the rate before and after 23 July 2024, and
  // _BP marks the copy of the row that sits under the business head in ITR-3.
  // The rate is printed from the return's own SplRatePercent, so one caption
  // serves all of them.
  const base = c.replace(/_(BE|AE|BP)$/, "");
  if (SI_SECTIONS[base]) return SI_SECTIONS[base];
  if (PTI_RATE_CODES[base]) return `${PTI_RATE_CODES[base]} — pass-through income`;
  const pti = /^PTI_(.+)$/.exec(base);
  if (pti && SI_SECTIONS[pti[1]]) return `${SI_SECTIONS[pti[1]]} — pass-through income`;
  return `Income taxable at a special rate (code ${c})`;
}

/* --------------------------------------------------- salary components ------
 *
 * Schedule S itemises gross salary by a numeric code. Until the department's
 * schema was to hand these were deliberately left undecoded — guessing that
 * code "4" meant House Rent Allowance would have put an unverified label on a
 * signed document. The schema states the table outright, so the guess is no
 * longer a guess:
 *
 *   ITR2_2024_Main_V1.4.json
 *     definitions.NatureOfSalaryDtlsType.properties.NatureDesc
 *     definitions.NatureOfPerquisitesType.properties.NatureDesc
 *     definitions.NatureOfProfitInLieuOfSalaryType.properties.NatureDesc
 *     definitions.AllwncExemptUs10DtlsType.properties.SalNatureDesc
 */
const SALARY_COMPONENTS = {
  1: "Basic salary",
  2: "Dearness allowance",
  3: "Conveyance allowance",
  4: "House rent allowance",
  5: "Leave travel allowance",
  6: "Children education allowance",
  7: "Other allowances",
  8: "Employer's contribution to a pension scheme u/s 80CCD",
  9: "Amount deemed to be income under rule 11 of the Fourth Schedule",
  10: "Amount deemed to be income under rule 6 of the Fourth Schedule",
  11: "Annuity or pension",
  12: "Commuted pension",
  13: "Gratuity",
  14: "Fees or commission",
  15: "Advance of salary",
  16: "Leave encashment",
  17: "Contribution by the Central Government to the Agnipath Scheme u/s 80CCH",
  OTH: "Other salary",
};

const PERQUISITE_COMPONENTS = {
  1: "Accommodation",
  2: "Cars or other automotive",
  3: "Sweeper, gardener, watchman or personal attendant",
  4: "Gas, electricity and water",
  5: "Interest-free or concessional loans",
  6: "Holiday expenses",
  7: "Free or concessional travel",
  8: "Free meals",
  9: "Free education",
  10: "Gifts, vouchers etc.",
  11: "Credit card expenses",
  12: "Club expenses",
  13: "Use of movable assets by employees",
  14: "Transfer of assets to the employee",
  15: "Value of any other benefit, amenity, service or privilege",
  16: "Stock options of an eligible start-up u/s 80-IAC — tax deferred",
  17: "Stock options other than ESOPs",
  18: "Employer's contribution to a fund or scheme taxable u/s 17(2)(vii)",
  19: "Annual accretion on the balance of a fund or scheme taxable u/s 17(2)(viia)",
  21: "Stock options of an eligible start-up u/s 80-IAC — tax not deferred",
  OTH: "Other benefits or amenities",
};

const PROFIT_IN_LIEU_COMPONENTS = {
  1: "Compensation on termination of employment or modification of its terms",
  2: "Payment from a provident or other fund, or under a Keyman insurance policy",
  3: "Amount received before joining or after cessation of employment",
  OTH: "Any other profit in lieu of salary",
};

const componentTable = (kind) => (kind === "perquisite" ? PERQUISITE_COMPONENTS
  : kind === "inLieu" ? PROFIT_IN_LIEU_COMPONENTS
    : SALARY_COMPONENTS);

/** A caption for one component of gross salary. `kind` picks the table. */
export function salaryComponent(kind, code) {
  return componentTable(kind)[String(code ?? "").trim().toUpperCase()] || "";
}

/* The order the components are listed in, which is the schema's own — basic pay,
   then the allowances, then the retirement receipts. A return states them in
   whatever order the software wrote them: this return puts house rent allowance
   before basic salary, which is not how anyone reads a salary certificate. */
export function salaryComponentOrder(kind, code) {
  const i = Object.keys(componentTable(kind)).indexOf(String(code ?? "").trim().toUpperCase());
  return i === -1 ? 999 : i;
}

/* Allowances exempt u/s 10. The code IS the section for most of these, so it is
   printed as given; the two that are not are named here. */
const EXEMPT_ALLOWANCE = {
  EIC: "Exempt income of a judge under the Judges (Salaries) Act",
  OTH: "Any other allowance exempt u/s 10",
};

export const exemptAllowanceLabel = (code) => EXEMPT_ALLOWANCE[String(code || "").trim().toUpperCase()] || "";

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

  /* A.Y. 2026-27's ITR-3 asks neither. It asks instead whether Form 10-IEA was
     filed — for this year (`F10IEACurrAYOldRegime`) or an earlier one
     (`Form10IEAEarlierAYOldRegime`), because a business assessee who opts out
     stays out until the option is withdrawn. Either "Y" is the old regime.

     Verified, not inferred, on the both-"N" case: the A.Y. 2026-27 ITR-3 we hold
     states tax at normal rates of 2,09,250 on an aggregate of 20,37,001, which
     reconciles to the rupee against the s.115BAC(1A) slabs for that year
     (nil / 5 / 10 / 15 / 20 / 25%) and against nothing else — the old-regime
     slabs for an assessee of this age give 4,21,100. If a future return
     disagrees, re-derive it the same way rather than trusting the field name. */
  const current = String(fs.F10IEACurrAYOldRegime ?? "").trim().toUpperCase();
  const earlier = String(fs.Form10IEAEarlierAYOldRegime ?? "").trim().toUpperCase();
  if (current === "Y") return "Old regime — opted out of s.115BAC(1A) by Form 10-IEA filed for this year";
  if (earlier === "Y") return "Old regime — opted out of s.115BAC(1A) by Form 10-IEA filed in an earlier year";
  if (current === "N" || earlier === "N") return "New regime u/s 115BAC(1A) (default)";
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

/* The reference chip alongside each deduction. Three of the keys spell out who
   contributed rather than naming the sub-section, so stripping "Section" off
   them leaves "80CCDEmployer" printed where "80CCD(2)" belongs. */
const VIA_REF = {
  Section80CCDEmployee: "80CCD(1)",
  Section80CCD1B: "80CCD(1B)",
  Section80CCDEmployer: "80CCD(2)",
};

export const viaRef = (key) => VIA_REF[key] || String(key).replace(/^Section/, "");

/** The order deductions are conventionally listed in. Unknown keys come last. */
export function viaOrder(key) {
  const i = Object.keys(VIA_SECTIONS).indexOf(key);
  return i === -1 ? 999 : i;
}

/* Capacity codes on the verification block. An individual signing their own
   return uses "S"; the rest appear on HUF and representative filings.

   The four codes below are the whole enum — Verification.Capacity in
   ITR2_2024_Main_V1.4.json. This table previously carried "KA", "AM" and "G",
   which are not codes this return can hold: a HUF's Karta signs as "K", not
   "KA", so a real Karta's return would have printed the bare code. */
const CAPACITY = { S: "Self", R: "Representative", K: "Karta", A: "Authorised Signatory" };

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

/* Which schedules this return actually carries, for the note that says where
   the figures came from. Naming Schedule S and Schedule HP on a return that has
   neither — a proprietor with only business income and capital gains — tells a
   reader to look for workings that do not exist. */
const SOURCE_SCHEDULES = [
  ["ScheduleS", "Schedule S"],
  ["ScheduleHP", "Schedule HP"],
  ["ITR3ScheduleBP", "Schedule BP"],
  ["ScheduleCGFor23", "Schedule CG"],
  ["ScheduleOS", "Schedule OS"],
  ["ScheduleVIA", "Schedule VI-A"],
];

export function sourceSchedules(body) {
  const b = body && typeof body === "object" ? body : {};
  // Comma-separated, with no final "and" — the sentence this goes into ends
  // "… and Part B-TI / Part B-TTI of the return", and two "and"s in a row read
  // like a typo on a document somebody signs.
  return SOURCE_SCHEDULES.filter(([key]) => b[key]).map(([, label]) => label).join(", ");
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
