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
  // A property sale names the buyer, and a free-text "nature of income" line
  // routinely names the payer ("Interest from <company> Pvt Ltd"). Both are
  // third parties who never agreed to appear in a public repository.
  //
  // ITR-1 spells the other-sources one `OthSrcOthNatOfInc`, and the mapper
  // prints it as the row's label, so it is the same case under a third name.
  "NameOfBuyer", "OthNatOfInc", "SalOthNatOfInc", "OthersIncNature", "OthSrcOthNatOfInc",
  // The TDS schedules name the same employer again under their own key.
  "EmployerOrDeductorOrCollecterName", "DeductorName", "CollecterName",
  "InsurerName",
  // Schedule 112A names every scrip and fund sold. Not personal data, but a
  // portfolio is not something to publish on a client's behalf either.
  "ShareUnitName",
  // Schedule 80G names the institutions donated to. Not the client's own name,
  // but a named charity beside a named donor and an amount is a fact about the
  // client that is not ours to publish.
  "DoneeWithPanName", "DoneeWithoutPanName",
  // Free text inside the profit & loss account, where an assessee describes a
  // line in their own words: "Interest paid to firm - Shakti Builders" names a
  // firm the client deals with. The mapper never reads Part A-P&L (it is an
  // ignored subtree), so nothing is lost by replacing these.
  //
  // NOT here: OperatingRevenueName, which the business head DOES read and
  // print ("Less: Agriculture Income credited to the profit & loss account").
  // Renaming it would leave a fixture that no longer represents its own case.
  "ExpenseNature", "NatureOfIncome",
]);
const PLACE_KEYS = new Set([
  "AddrDetail", "ResidenceNo", "ResidenceName", "RoadOrStreet", "LocalityOrArea",
  "CityOrTownOrDistrict", "IntermediaryCity", "Place", "AddressDetail", "EmployerAddress",
  "CityOrTown", "State", "Country",
  // A sold property's address identifies it on the public land record.
  "AddressOfProperty",
]);
/* Any key naming an Aadhaar, however ITD spells it.
 *
 * A list of exact names missed `AaadhaarOfBuyer` — three a's, the department's
 * own typo — which is where a property sale records the BUYER's Aadhaar. Four
 * strangers' Aadhaar numbers would have gone into a public fixture because the
 * catalogue was spelled correctly and the schema was not. A pattern is the right
 * shape for this one: there is no field whose name mentions Aadhaar and whose
 * value should survive. */
const AADHAAR_KEY = /a+dha*r/i; // Aadhaar, Aadhar, AaadhaarOfBuyer, AudFrmAadhaar

const OPAQUE_KEYS = new Set([
  "Digest", "UDIN", "BankAccountNo", "IFSCCode", "AadhaarCardNo", "SWCreatedBy", "JSONCreatedBy",
  "LoanAccNoOfBankOrInstnRefNo", "EmailAddress", "AudFrmRegNo", "AuditorMemNo", "AudFrmAadhaar",
  // A.Y. 2026-27's ITR-1 carries a SECOND contact — `EmailAddressSec` and
  // `MobileNoSec` — and on the return that brought this to light it belonged to
  // someone other than the assessee. A field that holds a person's contact
  // details is personal data whether or not it is the filer's own.
  "EmailAddressSec",
  "AccountNumber", "DematAccountNo", "PassportNo",
  // Account, policy and security identifiers — an NPS PRAN, an insurance
  // policy number and an ISIN each point at a specific holding of a specific
  // person, and none of them is a figure the mapper reads.
  "PRANNum", "PolicyNo", "ISINCode", "IdentificationNo",
  // A DIN identifies a named director on a public register; a challan's BSR
  // code and serial number together identify one payment from one bank branch.
  "DIN", "BSRCode",
  // Schedule 80GGC carries the bank reference of each contribution to a
  // political party. It identifies one transfer between two named accounts, and
  // the computation prints it — so it has to be masked, not dropped.
  "TransactionRefNum",
]);
// NOT here on purpose: GSTINNo. A GSTIN embeds the PAN, so masking the whole
// string destroys a shape the mapper displays; replacing the PAN inside it
// leaves a structurally valid GSTIN belonging to the dummy assessee.
//
// NOT here either, for a sharper version of the same reason: TAN and
// TANOfEmployer. Masking turns every deductor's TAN into the identical
// XXXX00000X, and the computation groups credits BY TAN — so three deductors
// became one row on the first ITR-1 fixture that had more than one. The regex
// substitution below gives each a distinct, syntactically valid dummy instead,
// which preserves both the shape the document prints and the distinctness the
// mapper depends on. (Fixtures committed before this keep their masked TANs;
// they carry at most one deductor each, so nothing about them is misleading.)
const NUMERIC_ID_KEYS = new Set(["MobileNo", "MobileNoSec", "AckNum44AB", "PhoneNo", "STDcode", "SrlNoOfChaln"]);

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

  /* Some key names mean different things in different places. `Description` is
     form boilerplate under Form_ITRn ("For indls and HUFs having income from a
     proprietory business or profession"), and is a client's own words naming a
     property under Schedule AL ("Bhat Residence"). Cataloguing it unscoped would
     scrub the boilerplate too and leave a fixture nobody can read; leaving it
     out let "Bhat" through, which the self-check caught. So a key may be listed
     as `parent.key` when only that occurrence is personal. */
  const SCOPED_PLACE_KEYS = new Set(["ImmovableDetails.Description"]);

  const walk = (node, key, parentKey) => {
    if (Array.isArray(node)) return node.map((v) => walk(v, key, parentKey));
    if (node && typeof node === "object") {
      const out = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v, k, key);
      return out;
    }
    if (typeof node === "string") {
      if (PERSON_KEYS.has(key) && isProse(node)) return name(node);
      if (PLACE_KEYS.has(key) && isProse(node)) return where(node);
      if (SCOPED_PLACE_KEYS.has(`${parentKey}.${key}`) && isProse(node)) return where(node);
      if ((OPAQUE_KEYS.has(key) || AADHAAR_KEY.test(key)) && node.trim()) return /^EmailAddress/.test(key) ? "sample@example.com" : mask(node);
      /* A NUMERIC ID IS NOT ALWAYS A NUMBER. `PhoneNo` is handled below as a
         number, and on the ITR-3 that brought this to light the portal had put
         it in as the STRING "9825045098" — so the numeric branch never ran, the
         string branch had no rule for it, and a real landline went through into
         a fixture. Anonymise by field name, in every type the field arrives in
         (CLAUDE.md rule 5): the same digits, in the same shape, none of them
         the client's. */
      if (NUMERIC_ID_KEYS.has(key) && node.trim()) return "9".repeat(node.replace(/\D/g, "").length || node.length);
      let s = node;
      for (const [from, to] of Object.entries(ids)) if (s.includes(from)) s = s.split(from).join(to);
      return s;
    }
    // An Aadhaar arrives as a string on some forms and a number on others.
    if (typeof node === "number" && AADHAAR_KEY.test(String(key))) return Number("9".repeat(String(node).length));
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

  /* Case-INSENSITIVELY. A return states the same firm as "SHAKTI BUILDERS" in
     Schedule IF and as "Interest paid to firm - Shakti Builders" in a P&L
     description, and an exact-string check passed the second one through — the
     leak was found by hand afterwards, which is precisely what this is meant to
     make unnecessary. */
  const blob = values.join("\n").toLowerCase();
  const leaked = [...Object.keys(ids), ...people.keys(), ...places.keys()]
    .filter((v) => blob.includes(String(v).toLowerCase()));
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