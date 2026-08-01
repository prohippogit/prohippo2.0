/*
 * Turning a real return into a committable fixture — the pure half.
 *
 * Kept apart from scripts/prepare-itr-fixture.mjs, which needs Firebase
 * credentials and a network, so these rules can be tested. They decide whether
 * a client's name reaches a public repository, which makes them exactly the
 * wrong thing to leave untested because the surrounding script is awkward to
 * run.
 */
/* ---------------- anonymisation ---------------- */

/* Anonymise by FIELD NAME, never by a list of values.
 *
 * Every free-text field that can name a person, a place or an account is listed
 * here once. A field we have not seen before is not silently passed through —
 * see the audit at the end, which reports any string value that still looks like
 * a name so the list can be extended deliberately. */
const PERSON_KEYS = new Set([
  "PartnerOrMemberName", "NameofTenant", "AssesseeVerName", "AuditorName", "AudFrmName",
  "BankOrInstnName", "BankName", "SurNameOrOrgName", "FirstName", "MiddleName", "SurName",
  "FatherName", "TradeName1", "TradeName2", "TradeName3", "NameOfEmployer", "EmployerName",
  "NameOfBusiness", "NameOfPerson", "NameOfDonee", "DoneeWithPan", "NameOfInstitution",
  "NameOfSecurity", "NameOfCompany", "TenantName", "LenderName", "NameOfDeductor",
  // ITR-3: Schedule IF names every firm the assessee is a partner in, and the
  // filing-status block names them again. A firm's name is its proprietors'.
  "FirmName", "NameOfFirm",
  // The TDS schedules name the same employer again under their own key.
  "EmployerOrDeductorOrCollecterName", "DeductorName", "CollecterName",
  "InsurerName",
  // Schedule 112A names every scrip and fund sold. Not personal data, but a
  // portfolio is not something to publish on a client's behalf either.
  "ShareUnitName",
]);
const PLACE_KEYS = new Set([
  "AddrDetail", "ResidenceNo", "ResidenceName", "RoadOrStreet", "LocalityOrArea",
  "CityOrTownOrDistrict", "IntermediaryCity", "Place", "AddressDetail", "EmployerAddress",
  "CityOrTown", "State", "Country",
]);
const OPAQUE_KEYS = new Set([
  "Digest", "UDIN", "BankAccountNo", "IFSCCode", "AadhaarCardNo", "SWCreatedBy", "JSONCreatedBy",
  "LoanAccNoOfBankOrInstnRefNo", "EmailAddress", "AudFrmRegNo", "AuditorMemNo", "AudFrmAadhaar",
  "AccountNumber", "DematAccountNo", "PassportNo", "TAN", "TANOfEmployer",
  // Account, policy and security identifiers — an NPS PRAN, an insurance
  // policy number and an ISIN each point at a specific holding of a specific
  // person, and none of them is a figure the mapper reads.
  "PRANNum", "PolicyNo", "ISINCode", "IdentificationNo",
  // A DIN identifies a named director on a public register; a challan's BSR
  // code and serial number together identify one payment from one bank branch.
  "DIN", "BSRCode",
]);
// NOT here on purpose: GSTINNo. A GSTIN embeds the PAN, so masking the whole
// string destroys a shape the mapper displays; replacing the PAN inside it
// leaves a structurally valid GSTIN belonging to the dummy assessee.
const NUMERIC_ID_KEYS = new Set(["MobileNo", "AckNum44AB", "PhoneNo", "STDcode", "SrlNoOfChaln"]);

// A PAN's fourth character carries the assessee's status, and the mapper reads
// it — so a replacement must keep it or the fixture stops representing the case.
const PAN_RE = /[A-Z]{5}\d{4}[A-Z]/g;
const TAN_RE = /\b[A-Z]{4}\d{5}[A-Z]\b/g;

export function anonymise(json) {
  const raw = JSON.stringify(json);
  const ids = {};
  [...new Set(raw.match(PAN_RE) || [])].sort().forEach((p, i) => { ids[p] = `AAA${p[3]}Z${1000 + i}A`; });
  [...new Set(raw.match(TAN_RE) || [])].sort()
    .filter((t) => !ids[t])
    .forEach((t, i) => { ids[t] = `AAA${String.fromCharCode(65 + (i % 26))}0000${i}A`; });

  const people = new Map();
  const places = new Map();
  const name = (v) => {
    if (!people.has(v)) people.set(v, `SAMPLE NAME ${people.size + 1}${/\bHUF$/i.test(v.trim()) ? " HUF" : ""}`);
    return people.get(v);
  };
  const where = (v) => {
    if (!places.has(v)) places.set(v, `SAMPLE PLACE ${places.size + 1}`);
    return places.get(v);
  };
  const mask = (v) => v.replace(/\d/g, "0").replace(/[A-Za-z]/g, "X");
  // Free text, as opposed to a code or a flag sitting in a text field.
  const isProse = (v) => v.trim().length > 3 && /[A-Za-z]{3}/.test(v);

  const walk = (node, key) => {
    if (Array.isArray(node)) return node.map((v) => walk(v, key));
    if (node && typeof node === "object") {
      const out = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v, k);
      return out;
    }
    if (typeof node === "string") {
      if (PERSON_KEYS.has(key) && isProse(node)) return name(node);
      if (PLACE_KEYS.has(key) && isProse(node)) return where(node);
      if (OPAQUE_KEYS.has(key) && node.trim()) return key === "EmailAddress" ? "sample@example.com" : mask(node);
      let s = node;
      for (const [from, to] of Object.entries(ids)) if (s.includes(from)) s = s.split(from).join(to);
      return s;
    }
    if (typeof node === "number" && NUMERIC_ID_KEYS.has(key)) {
      return key === "MobileNo" ? 9800000001 : Number("9".repeat(String(node).length));
    }
    return node;
  };

  const clean = walk(json, null);

  /* Verify against the result's string VALUES, not its serialised form: key
     names produce false positives ("Dividend" is a substring of DividendGross)
     and a check that cries wolf is a check nobody trusts. */
  const values = [];
  const collect = (n) => {
    if (Array.isArray(n)) n.forEach(collect);
    else if (n && typeof n === "object") Object.values(n).forEach(collect);
    else if (typeof n === "string") values.push(n);
  };
  collect(clean);
  const blob = values.join("\n");
  const leaked = [...Object.keys(ids), ...people.keys(), ...places.keys()].filter((v) => blob.includes(v));
  if (leaked.length) {
    throw new Error(`anonymisation missed ${leaked.length} value(s), starting with: ${leaked.slice(0, 5).join(", ")}`);
  }

  return { clean, counts: { ids: Object.keys(ids).length, people: people.size, places: places.size }, values };
}

/* Anything still looking like a person's name is reported rather than assumed
   safe — a field we have not catalogued should be added to the lists above
   deliberately, not discovered by a reader of the repository. */
export function auditResidual(values) {
  const suspicious = values.filter((v) =>
    /^[A-Z][A-Za-z]+(\s+[A-Z][A-Za-z.]+){1,4}$/.test(v.trim()) &&
    !/^SAMPLE /.test(v) &&
    !/^(ITR|For |Ver|Individual|Firm|Company|Trust|Resident|Non Resident)/i.test(v)
  );
  return [...new Set(suspicious)];
}

/* ---------------- schema description ---------------- */

// What a mapper author needs before writing a line: which schedules exist, and
// what actually carries a value in this return.
/* Numeric leaves that are identifiers rather than amounts. A mobile number is
   ten digits and would otherwise sort above every real figure in the return —
   the opposite of useful when the point of this listing is "what is big here?".
   Mirrors the reasoning in src/computation/ignore-paths.js. */
const NOT_A_FIGURE = /\.(MobileNo|PhoneNo|STDcode|PinCode|StateCode|CountryCode|CountryCodeMobile|AadhaarCardNo|AckNum44AB|SharePercentage|RateOfInterest|AssessePercentShareProp|HPSNo|TenantSNo|SplRatePercent|SrlNoOfChaln|ProfitSharePercent|NumSharesUnits|SalePricePerShareUnit)$/;

export function describe(body) {
  // Walk once. An earlier version walked again per schedule to count that
  // schedule's figures, pushing into the same array — so every figure appeared
  // twice and the listing was useless for the one thing it is for.
  const figures = [];
  const walk = (node, p) => {
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${p}[${i}]`));
    if (node && typeof node === "object") return Object.entries(node).forEach(([k, v]) => walk(v, p ? `${p}.${k}` : k));
    if (typeof node === "number" && node !== 0 && !NOT_A_FIGURE.test(`.${p}`)) figures.push([p, node]);
  };
  walk(body, "");

  const perSchedule = new Map(Object.keys(body).map((k) => [k, 0]));
  for (const [p] of figures) {
    const schedule = p.split(/[.[]/)[0];
    if (perSchedule.has(schedule)) perSchedule.set(schedule, perSchedule.get(schedule) + 1);
  }

  const lines = [`schedules (${perSchedule.size}):`];
  for (const [k, n] of perSchedule) lines.push(`  ${k.padEnd(30)} ${n ? `${n} non-zero` : "(all nil)"}`);

  lines.push("", `non-zero figures (${figures.length}), largest first:`);
  for (const [p, v] of [...figures].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))) {
    lines.push(`  ${v.toLocaleString("en-IN").padStart(16)}  ${p}`);
  }
  return lines.join("\n");
}