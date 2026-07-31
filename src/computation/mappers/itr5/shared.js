/*
 * ITR-5 helpers that are stable across assessment years.
 * docs/computation-spec.md §9 — anything year-specific belongs in ayNNNN-NN.js.
 */

/* TDS section codes are not section numbers (§10). The portal writes "94A" for
   s.194A and "4H" for s.194H, and the two styles coexist in one schedule. This
   map is the lookup; an unknown code renders as the raw code rather than a
   guessed section, because inventing "s.194X" in a signed document is worse
   than showing what the return actually said. */
const TDS_SECTIONS = {
  "92A": "192A", "92B": "192",
  "93A": "193", "94": "194",
  "94A": "194A", "94B": "194B", "94BB": "194BB", "94C": "194C", "94D": "194D",
  "4DA": "194DA", "94E": "194E", "94EE": "194EE", "94F": "194F", "94G": "194G",
  "94H": "194H", "4H": "194H", "4I": "194I", "94I": "194I", "4IA": "194IA",
  "4IB": "194IB", "4IC": "194IC", "94J": "194J", "4JA": "194J(a)", "4JB": "194J(b)",
  "94K": "194K", "94LA": "194LA", "94LB": "194LB", "94M": "194M", "94N": "194N",
  "94O": "194-O", "94P": "194P", "94Q": "194Q", "94R": "194R", "94S": "194S",
  "94T": "194T", "96A": "196A", "96B": "196B", "96C": "196C", "96D": "196D",
  "95A": "195",
};

/* What each TDS section is for. Shown as the small grey second line under the
   TAN so a reader can see at a glance which receipt a credit belongs to. */
const TDS_NATURE = {
  "192": "Salary",
  "193": "Interest on securities",
  "194": "Dividend",
  "194A": "Interest other than interest on securities",
  "194C": "Payments to contractors",
  "194D": "Insurance commission",
  "194H": "Commission or brokerage",
  "194I": "Rent",
  "194J": "Fees for professional or technical services",
  "194J(a)": "Fees for technical services",
  "194J(b)": "Fees for professional services",
  "194K": "Income in respect of units",
  "194M": "Certain payments by individuals or HUF",
  "194N": "Cash withdrawals",
  "194-O": "Payments by an e-commerce operator",
  "194Q": "Purchase of goods",
  "194R": "Benefit or perquisite of a business or profession",
  "194T": "Payments to partners of a firm",
};

export function tdsSection(code) {
  const c = String(code || "").trim().toUpperCase();
  return TDS_SECTIONS[c] || c;
}

export function tdsNature(section) {
  return TDS_NATURE[section] || "";
}

/* Capacity codes on the verification block (§10). "DP" is the code an LLP or
   firm's designated partner signs under; it is not in the original spec list and
   is recorded here from a real ITR-5. An unknown code falls through as itself
   rather than being decoded into a title nobody verified. */
const CAPACITY = {
  TR: "Trustee",
  MP: "Managing Partner",
  DP: "Designated Partner",
  P: "Partner",
  D: "Director",
  KA: "Karta",
  S: "Self",
  AM: "Authorised Member",
};

export function capacityName(code) {
  const c = String(code || "").trim().toUpperCase();
  return CAPACITY[c] || c;
}

/* The 4th character of a PAN carries the assessee's status (§10). We use it to
   describe the assessee rather than decoding StatusOrCompanyType, which is a
   longer code table that says the same thing less reliably. */
const PAN_STATUS = {
  P: "Individual",
  F: "Partnership Firm",
  C: "Company",
  H: "Hindu Undivided Family",
  A: "Association of Persons",
  B: "Body of Individuals",
  T: "Trust",
  L: "Local Authority",
  J: "Artificial Juridical Person",
  G: "Government",
};

export function statusFromPan(pan) {
  const c = String(pan || "").toUpperCase()[3];
  return PAN_STATUS[c] || "";
}

/* Heading for the constitution card.
 *
 * Derived from the PAN's status character alone. It is tempting to call an
 * entity an LLP when its verification carries capacity "DP", but a partnership
 * firm's signatory can and does file under that code — the fixture this mapper
 * was written against is a firm signed by a "DP" — and an LLP's PAN carries the
 * same 'F' as a firm's, so the two genuinely cannot be told apart from the
 * return. "Firm" is correct for both in ordinary usage; "LLP" would be a claim
 * we cannot support. */
export function constitutionTitle(pan) {
  const status = statusFromPan(pan);
  if (status === "Partnership Firm") return "Constitution of the Firm — Partners";
  if (status === "Association of Persons" || status === "Body of Individuals") return "Constitution — Members";
  if (status === "Trust") return "Constitution of the Trust — Trustees";
  return "Constitution — Partners / Members";
}

/** Join address fields, dropping the blanks, without leaving stray commas. */
export function joinAddress(addr) {
  if (!addr || typeof addr !== "object") return "";
  return [
    addr.ResidenceNo, addr.ResidenceName, addr.RoadOrStreet, addr.LocalityOrArea,
    addr.CityOrTownOrDistrict, addr.PinCode,
  ].map((x) => String(x == null ? "" : x).trim()).filter(Boolean).join(", ");
}

/* Section under which the return was filed (§10, §12). 11 = s.139(1). A revised
   or belated return must say so on the face of the computation. */
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

/** True where the return is revised, belated or updated — worth stating (§12). */
export function isNonOrdinaryFiling(code) {
  return [12, 13, 17, 18, 19].includes(Number(code));
}
