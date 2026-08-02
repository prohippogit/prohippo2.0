/*
 * The heads of income as ITR-2 and ITR-3 state them.
 *
 * These two returns carry Schedule S, HP, CG, OS, VIA, SI, TDS and Part B-TTI
 * in the same schema, field for field. The workings below are therefore written
 * once and called by both mappers; ITR-3's business head, which ITR-2 has no
 * schedule for, lives in its own directory.
 *
 * Every builder takes the reader from unmapped.js and returns rows. Reading a
 * figure through the reader is what marks it consumed, so a builder that skips
 * a schedule leaves it to surface in the "requiring review" block (§8) rather
 * than dropping it silently — which is the point of the design.
 *
 * **No head is assumed absent.** A return is not a template: one assessee has
 * salary and a house, the next has capital gains and a firm's interest. Each
 * builder therefore walks every sub-block its schedule can carry and emits rows
 * for whichever ones the assessee actually used.
 */
import { sub, subtotal, total, columnHeader } from "../../model.js";
import { longDate } from "../../format.js";
import {
  specialRateLabel, viaLabel, viaOrder, viaRef, tdsSection, tdsNature,
  salaryComponent, salaryComponentOrder, exemptAllowanceLabel, headOfIncome,
} from "./labels.js";

const inr = (v) => Number(v || 0).toLocaleString("en-IN");

/* ---------------------------------------------------------------- salaries --
 *
 * Statutory shape: salary u/s 17(1), the value of perquisites u/s 17(2) and any
 * profits in lieu u/s 17(3) make up gross salary; the allowances exempt under
 * s.10 come off it; then the two deductions s.16 allows.
 *
 * §10: the per-component breakdown inside NatureOfSalary is stated by a numeric
 * code. Those codes went undecoded for as long as the only source for them would
 * have been a guess; the department publishes the table in its own schema, so
 * each component is now named from it — see ./labels.js for the citation. The
 * components are printed beneath the line they make up, in the same shape the
 * capital-gains rate split uses, so the figure a reader ties to the return stays
 * on the line above and the detail sits under it.
 */

/**
 * "— Basic salary 21,10,460" rows for one line of the salary working.
 *
 * Returns { rows, note }. A single component equal to the whole line is not a
 * breakdown — printing the same figure twice on consecutive lines reads as an
 * error — so its name comes back as a note for the line above instead. The same
 * judgment the capital-gains rate split makes about a lone bucket.
 */
function componentRows(src, base, kind, parentAmount) {
  const list = (src.claim(base) || [])
    .filter((c) => Number(c.OthAmount || 0))
    .sort((a, b) => salaryComponentOrder(kind, a.NatureDesc) - salaryComponentOrder(kind, b.NatureDesc));
  const name = (c) => {
    const named = salaryComponent(kind, c.NatureDesc);
    // "Others" is a code the assessee describes in words; prefer their words.
    return named && c.OthNatOfInc ? `${named} — ${c.OthNatOfInc}` : (named || c.OthNatOfInc || `component ${c.NatureDesc}`);
  };
  if (list.length === 1 && Number(list[0].OthAmount) === parentAmount) {
    return { rows: [], note: name(list[0]) };
  }
  return { rows: list.map((c) => sub(`— ${name(c)}`, Number(c.OthAmount))), note: "" };
}

export function salaryRows(src) {
  const rows = [];
  const employers = src.peek("ScheduleS.Salaries") || [];
  const many = employers.length > 1;

  employers.forEach((emp, i) => {
    const at = (f) => `ScheduleS.Salaries[${i}].Salarys.${f}`;
    const employerName = emp.NameOfEmployer || "";
    const gross = src.num(at("GrossSalary"));
    const salary17_1 = src.num(at("Salary"));
    const perquisites = src.num(at("ValueOfPerquisites"));
    const inLieu = src.num(at("ProfitsinLieuOfSalary"));

    const nature = `ScheduleS.Salaries[${i}].Salarys`;
    const salaryParts = componentRows(src, `${nature}.NatureOfSalary.OthersIncDtls`, "salary", salary17_1);
    const perqParts = componentRows(src, `${nature}.NatureOfPerquisites.OthersIncDtls`, "perquisite", perquisites);
    const lieuParts = componentRows(src, `${nature}.NatureOfProfitInLieuOfSalary.OthersIncDtls`, "inLieu", inLieu);

    if (many) rows.push(columnHeader(`Employer ${i + 1} — ${employerName}`, { ref: "" }));
    rows.push(sub("Salary as per section 17(1)", salary17_1, {
      ref: i === 0 && !many ? "Sch. S" : "",
      note: [many ? "" : employerName, salaryParts.note].filter(Boolean).join(" · "),
    }));
    rows.push(...salaryParts.rows);
    if (perquisites) {
      rows.push(sub("Add: Value of perquisites u/s 17(2)", perquisites, { note: perqParts.note || undefined }));
      rows.push(...perqParts.rows);
    }
    if (inLieu) {
      rows.push(sub("Add: Profits in lieu of salary u/s 17(3)", inLieu, { note: lieuParts.note || undefined }));
      rows.push(...lieuParts.rows);
    }
    if (many) rows.push(subtotal(`Gross salary — employer ${i + 1}`, gross));
    // Whatever the itemisation above did not reach — an empty wrapper, or a
    // perquisite list on a return that states nil against s.17(2).
    src.claim(`${nature}.NatureOfSalary`);
    src.claim(`${nature}.NatureOfPerquisites`);
    src.claim(`${nature}.NatureOfProfitInLieuOfSalary`);
    src.claim(`ScheduleS.Salaries[${i}].AddressDetail`);
    src.num(at("IncomeNotified89A"));
    src.num(at("IncomeNotifiedOther89A"));
    src.num(at("IncomeNotifiedPrYr89A"));
  });

  const grossSalary = src.num("ScheduleS.TotalGrossSalary");
  if (employers.length) rows.push(subtotal("Gross Salary", grossSalary));

  // Allowances exempt under s.10, itemised by the code the return gives. Here
  // the code IS the section — "10(13A)" — so it is printed as given.
  const exemptRows = src.claim("ScheduleS.AllwncExemptUs10.AllwncExemptUs10Dtls") || [];
  const hra = src.claim("ScheduleS.Section10_13A") || {};
  for (const e of exemptRows) {
    const amt = Number(e.SalOthAmount || 0);
    if (!amt) continue;
    const code = String(e.SalNatureDesc || "").trim();
    const isHra = code === "10(13A)";
    // Most codes here ARE the section, so they print as given. The two that are
    // not — "OTH" and "EIC" — are named from the schema; see ./labels.js.
    const named = exemptAllowanceLabel(code);
    rows.push(sub(
      isHra ? "Less: House rent allowance exempt u/s 10(13A)"
        : named ? `Less: ${named}`
          : `Less: Allowance exempt u/s ${code}`,
      amt,
      {
        note: isHra && hra.ActlHRARecv
          ? `HRA received ${inr(hra.ActlHRARecv)} · rent paid ${inr(hra.ActlRentPaid || 0)}`
          : (named ? e.SalOthNatOfInc || "" : ""),
      }
    ));
  }
  const totalExempt = src.num("ScheduleS.AllwncExtentExemptUs10");
  const netSalary = src.num("ScheduleS.NetSalary");
  if (totalExempt) rows.push(subtotal("Net Salary", netSalary));
  src.num("ScheduleS.Increliefus89A");

  const stdDeduction = src.num("ScheduleS.DeductionUnderSection16ia");
  const entertainment = src.num("ScheduleS.EntertainmntalwncUs16ii");
  const profTax = src.num("ScheduleS.ProfessionalTaxUs16iii");
  if (stdDeduction) rows.push(sub("Less: Standard deduction u/s 16(ia)", stdDeduction, { ref: "Sec. 16(ia)" }));
  if (entertainment) rows.push(sub("Less: Entertainment allowance u/s 16(ii)", entertainment, { ref: "Sec. 16(ii)" }));
  if (profTax) rows.push(sub("Less: Tax on employment u/s 16(iii)", profTax, { ref: "Sec. 16(iii)" }));

  const salaryIncome = src.num("ScheduleS.TotIncUnderHeadSalaries");
  if (rows.length) rows.push(total("Income chargeable under the head Salaries", salaryIncome));
  src.num("ScheduleS.DeductionUS16");
  return rows;
}

/* --------------------------------------------------------- house property -- */
export function housePropertyRows(src) {
  const rows = [];
  const properties = src.peek("ScheduleHP.PropertyDetails") || [];
  const many = properties.length > 1;

  properties.forEach((prop, i) => {
    const at = (f) => `ScheduleHP.PropertyDetails[${i}].Rentdetails.${f}`;
    const rent = prop.Rentdetails || {};
    const address = prop.AddressDetailWithZipCode?.AddrDetail || "";
    /* "S" = self-occupied, "L" = let out, "D" = deemed let out — the enum of the
       current schema. A.Y. 2022-23 and 2023-24 answer the same question as a
       yes/no instead, so "N" there means NOT let out, which is self-occupied.
       Confirmed rather than assumed: the A.Y. 2023-24 return carries "N" against
       flat 802, Shilp Revanta, and the A.Y. 2024-25 return carries "S" against
       the same flat, with the same nil annual value and the same interest-only
       working. Reading "N" as let out printed an annual letable value of nil on
       a property that has none by law. */
    const use = String(prop.ifLetOut || "").toUpperCase();
    const selfOccupied = use === "S" || use === "N";

    if (many) rows.push(columnHeader(`Property ${i + 1}${address ? ` — ${address}` : ""}`, { ref: "" }));

    if (selfOccupied) {
      // A self-occupied property has a nil annual value by law, so the working
      // is the interest alone. Saying so is clearer than an "Annual value — nil"
      // row that invites the reader to look for rent that cannot exist.
      rows.push(sub("Annual value of the self-occupied property", src.num(at("AnnualLetableValue")), {
        ref: i === 0 && !many ? "Sch. HP" : "",
        note: [address, "self-occupied — annual value taken as nil"].filter(Boolean).join(" · "),
      }));
    } else {
      rows.push(sub("Annual letable value of the property", src.num(at("AnnualLetableValue")), {
        ref: i === 0 && !many ? "Sch. HP" : "",
        note: [address, use === "D" ? "deemed let out" : ""].filter(Boolean).join(" · "),
      }));
      const unrealised = src.num(at("RentNotRealized"));
      if (unrealised) rows.push(sub("Less: Rent not realised", unrealised));
      const localTaxes = src.num(at("LocalTaxes"));
      if (localTaxes) rows.push(sub("Less: Municipal taxes paid", localTaxes));
      const thirty = src.num(at("ThirtyPercentOfBalance"));
      if (thirty) rows.push(sub("Less: Standard deduction u/s 24(a) @ 30% of the annual value", thirty, { ref: "Sec. 24(a)" }));
    }

    const interest = src.num(at("Section24B.TotalInterestUs24B")) || src.num(at("IntOnBorwCap"));
    if (interest) {
      const lenders = (rent.Section24B?.Section24BDtls || []).map((l) => l.BankOrInstnName).filter(Boolean);
      rows.push(sub("Less: Interest on borrowed capital u/s 24(b)", interest, {
        ref: "Sec. 24(b)",
        note: lenders.length ? `Borrowed from ${lenders.join(", ")}` : undefined,
      }));
    }
    const own = src.num(at("IncomeOfHP"));
    if (many) rows.push(subtotal(own < 0 ? `Loss from property ${i + 1}` : `Income from property ${i + 1}`, Math.abs(own), { isLoss: own < 0 }));

    src.restate([
      at("BalanceALV"), at("AnnualOfPropOwned"), at("TotalDeduct"), at("IntOnBorwCap"),
      ...(rent.Section24B?.Section24BDtls || []).map((_, li) => at(`Section24B.Section24BDtls[${li}].InterestUs24B`)),
    ]);
  });

  const hpTotal = src.num("ScheduleHP.TotalIncomeChargeableUnHP");
  if (rows.length) {
    rows.push(total(hpTotal < 0 ? "Loss from House Property" : "Income from House Property", Math.abs(hpTotal), { isLoss: hpTotal < 0 }));
  }
  return rows;
}

/* ----------------------------------------------------------- capital gains --
 *
 * Schedule CG repeats one shape for every class of asset: full value of
 * consideration, the s.48 deductions, and the gain. That regularity is what
 * lets this be written once for every class rather than once for the two an
 * equity investor happens to use — an assessee who sold land, unlisted shares,
 * bonds or a virtual digital asset gets the same working, from the same fields.
 *
 * The rates on both s.111A and s.112A changed part-way through A.Y. 2025-26, so
 * the return splits one gain between the rate that applied before the change and
 * after it. Both are printed as stated, with the rate read off Schedule SI
 * rather than asserted from a date.
 */
const STCG_BLOCKS = [
  [["SaleOnOtherAssets"], "other assets"],
  [["NRISecur115AD"], "securities and units u/s 115AD"],
  [["NRITransacSec48Dtl"], "transactions taxable under the first proviso to s.48"],
];
const LTCG_BLOCKS = [
  // Two spellings, because the schema moved this block: A.Y. 2024-25 carries it
  // flat as SaleofAssetNA, later years wrap it in SaleofAssetNADtls. Both are
  // tried; see assetDetails() for why the shape inside is not assumed either.
  [["SaleofAssetNADtls", "SaleofAssetNA"], "assets other than those listed separately"],
  [["SaleofBondsDebntr"], "bonds or debentures"],
  [["NRISaleOfEquityShareUs112A"], "equity shares / units u/s 112A (non-resident)"],
  [["NRISaleofForeignAsset"], "assets acquired in foreign currency"],
];

/* Land and building is the one class that does not share the s.48 shape.
 *
 * It carries the stamp-duty valuation alongside the consideration, because s.50C
 * substitutes the higher of the two; an indexed cost of acquisition rather than a
 * plain one; and the buyer's details, which are particulars rather than figures.
 * A computation that showed only "full value of consideration" would hide a s.50C
 * substitution, which is the single most contested figure in a property sale.
 */
function landAndBuildingWorking(src, base, indexed, rows) {
  const list = src.peek(`${base}.SaleofLandBuildDtls`) || [];
  let total = 0;
  list.forEach((_, i) => {
    const at = `${base}.SaleofLandBuildDtls[${i}]`;
    const gain = src.num(`${at}.CapgainonAssets`);
    const consideration = src.num(`${at}.FullConsideration`);
    if (!gain && !consideration) return;
    total += gain;

    const stamp = src.num(`${at}.PropertyValuation`);
    const adopted = src.num(`${at}.FullConsideration50C`);
    const label = list.length > 1 ? `Full value of consideration — property ${i + 1}` : "Full value of consideration — land or building";
    rows.push(sub(label, adopted || consideration, {
      // s.50C only bites when the stamp value is the higher figure. Saying so
      // where it happens, and staying quiet where it does not, is the whole
      // point of carrying both numbers.
      note: stamp > consideration
        ? `Stamp-duty value ${inr(stamp)} adopted u/s 50C in place of the consideration of ${inr(consideration)}`
        : undefined,
    }));

    const cost = src.num(`${at}.AquisitCost`);
    const costIndexed = src.num(`${at}.AquisitCostIndex`);
    if (indexed && costIndexed) {
      rows.push(sub("Less: Indexed cost of acquisition", costIndexed, {
        note: cost && cost !== costIndexed ? `Cost ${inr(cost)}, indexed` : undefined,
      }));
    } else if (cost) {
      rows.push(sub("Less: Cost of acquisition", cost));
    }
    const improve = src.num(`${at}.ImproveCost`);
    const improveIndexed = src.num(`${at}.ImproveCostIndex`);
    if (improveIndexed) rows.push(sub("Less: Indexed cost of improvement", improveIndexed));
    else if (improve) rows.push(sub("Less: Cost of improvement", improve));
    const expense = src.num(`${at}.ExpOnTrans`);
    if (expense) rows.push(sub("Less: Expenditure on transfer", expense));

    // The buyers, their shares and the amounts against them restate the
    // consideration already shown; they are a disclosure, not a step in the
    // working.
    src.claim(`${at}.TrnsfImmblPrprty`);
    src.restate([`${at}.TotalDedn`, `${at}.Balance`, `${at}.DeductionUs54F`]);
  });
  return total;
}

/* Where a block's asset details actually sit.
 *
 * The same class of asset arrives in three shapes across the years we support:
 *
 *   A.Y. 2024-25  LongTermCapGain23.SaleofAssetNA               flat
 *   A.Y. 2025-26  ....SaleofAssetNADtls.SaleofAssetNA_BE / _AE  split at 23 July 2024
 *   A.Y. 2026-27  ....SaleofAssetNADtls.SaleofAssetNA           one again
 *
 * A table of paths per year would need editing every time the department moves a
 * block, and would fail silently when nobody noticed — the 2026-27 return's
 * 37,71,160 sale of unquoted shares surfaced in the review block for exactly
 * that reason. So the shape is discovered instead: a node carrying the gain is a
 * detail, a node whose children carry it is a wrapper.
 */
const isAssetDetail = (n) =>
  n && typeof n === "object" && !Array.isArray(n) && ("CapgainonAssets" in n || "DeductSec48" in n);

function assetDetails(src, base) {
  const node = src.peek(base);
  if (!node || typeof node !== "object") return [];
  if (isAssetDetail(node)) return [{ path: base, when: "" }];
  return Object.keys(node)
    .filter((k) => isAssetDetail(node[k]))
    .map((k) => ({
      path: `${base}.${k}`,
      // The suffix marks which side of the rate change the transfer fell on.
      when: /_BE$/.test(k) ? "transferred before 23 July 2024"
        : /_AE$/.test(k) ? "transferred on or after 23 July 2024" : "",
    }));
}

/** Resolve a block to whichever of its spellings this year's return carries. */
function blockBase(src, prefix, names) {
  for (const n of names) if (src.peek(`${prefix}.${n}`)) return `${prefix}.${n}`;
  return "";
}

/* Exemptions claimed against a gain — ss.54, 54B, 54EC, 54F. The section codes
   are the schema's own enum; the grand total is what actually comes off. */
function exemptionRows(src, base, rows) {
  const claimed = src.claim(`${base}.ExemptionOrDednUs54.ExemptionOrDednUs54Dtls`) || [];
  const total = src.num(`${base}.ExemptionOrDednUs54.ExemptionGrandTotal`);
  if (!total) return;
  const named = claimed.filter((e) => Number(e.ExemptionAmount || 0));
  if (named.length === 1) {
    rows.push(sub(`Less: Exemption u/s ${named[0].ExemptionSecCode}`, total, { ref: `Sec. ${named[0].ExemptionSecCode}` }));
    return;
  }
  rows.push(sub("Less: Exemption claimed against the gain", total, {
    note: named.length ? `Under ${named.map((e) => `s.${e.ExemptionSecCode} ${inr(e.ExemptionAmount)}`).join(", ")}` : undefined,
  }));
}

/** One consideration → cost → gain working, for any block that carries a gain. */
function assetWorking(src, base, caption, rows, when) {
  const gain = src.num(`${base}.CapgainonAssets`);
  const consideration = src.num(`${base}.FullConsideration`);
  if (!gain && !consideration) return 0;

  /* s.50CA is to unquoted shares what s.50C is to land: where the fair market
     value worked out under rule 11UA exceeds what was actually received, the
     FMV is substituted. The return carries all three figures; a computation
     showing only "full value of consideration" would hide the substitution,
     which is the figure an assessment argues about. */
  const unqReceived = src.num(`${base}.FullValueConsdRecvUnqshr`);
  const unqFmv = src.num(`${base}.FairMrktValueUnqshr`);
  const unqAdopted = src.num(`${base}.FullValueConsdSec50CA`);
  src.num(`${base}.FullValueConsdOthUnqshr`);

  rows.push(sub(`Full value of consideration — ${caption}`, consideration, {
    note: [
      when,
      unqAdopted && unqFmv > unqReceived
        ? `Fair market value of the unquoted shares ${inr(unqFmv)} substituted u/s 50CA for the consideration of ${inr(unqReceived)}`
        : "",
    ].filter(Boolean).join(" · ") || undefined,
  }));
  const cost = src.num(`${base}.DeductSec48.AquisitCost`);
  const improve = src.num(`${base}.DeductSec48.ImproveCost`);
  const expense = src.num(`${base}.DeductSec48.ExpOnTrans`);
  if (cost) rows.push(sub("Less: Cost of acquisition", cost));
  if (improve) rows.push(sub("Less: Cost of improvement", improve));
  if (expense) rows.push(sub("Less: Expenditure on transfer", expense));
  // s.94(7) / 94(8): a loss on dividend or bonus stripping is not allowed, so
  // the return adds it back on the way from the balance to the chargeable gain.
  const stripped = src.num(`${base}.LossSec94of7Or94of8`);
  if (stripped) {
    rows.push(sub("Add: Loss disallowed u/s 94(7) / 94(8)", stripped, {
      note: "Dividend or bonus stripping — the loss is not allowed",
    }));
  }
  exemptionRows(src, base, rows);
  src.restate([`${base}.DeductSec48.TotalDedn`, `${base}.BalanceCG`, `${base}.DeemedStcgOnAssets`]);
  return gain;
}

/* A slump sale is not a s.48 working at all: s.50B charges the excess of the
   consideration over the NET WORTH of the undertaking, and rule 11UAE fixes the
   consideration itself. Neither figure is a cost of acquisition, so it gets its
   own three lines rather than being forced into the shape above. */
function slumpSaleWorking(src, base, rows) {
  const gain = src.num(`${base}.CapgainonAssets`);
  const consideration = src.num(`${base}.FullConsideration`);
  if (!gain && !consideration) return 0;
  const fmvE2 = src.num(`${base}.FMV11UAEii`);
  const fmvE3 = src.num(`${base}.FMV11UAEiii`);
  rows.push(sub("Full value of consideration — slump sale u/s 50B", consideration, {
    ref: "Sec. 50B",
    note: fmvE2 || fmvE3 ? `Fair market value under rule 11UAE: ${inr(Math.max(fmvE2, fmvE3))}` : undefined,
  }));
  rows.push(sub("Less: Net worth of the undertaking transferred", src.num(`${base}.NetWorthOfDivision`)));
  exemptionRows(src, base, rows);
  src.restate([`${base}.SlumpBalance`]);
  return gain;
}

/* How a head of capital gain splits across rates, from Part B-TI's own buckets.
 *
 * This is stated as RATES, not as sections. A subtotal captioned "u/s 111A"
 * was correct for the first return we saw — where every rupee of short-term
 * gain happened to be STT-paid equity — and wrong for the next one, where a
 * land sale of 7,51,835 taxable at slab rates sat under the same caption. The
 * section attribution belongs in the tax section, where Schedule SI states it
 * against each figure and cannot be inferred wrongly.
 *
 * Which buckets exist varies by year: A.Y. 2024-25 has no 20% short-term and no
 * 12.5% long-term, A.Y. 2025-26 added both. Reading whatever is non-zero means
 * neither year needs its own branch.
 */
const ST_BUCKETS = [
  ["ShortTerm15Per", "taxable at 15%"],
  ["ShortTerm20Per", "taxable at 20%"],
  ["ShortTerm30Per", "taxable at 30%"],
  ["ShortTermAppRate", "taxable at the rates in force"],
  ["ShortTermSplRateDTAA", "taxable at DTAA rates"],
];
const LT_BUCKETS = [
  ["LongTerm10Per", "taxable at 10%"],
  ["LongTerm12_5Per", "taxable at 12.5%"],
  ["LongTerm20Per", "taxable at 20%"],
  ["LongTermSplRateDTAA", "taxable at DTAA rates"],
];

function rateSplit(src, block, buckets, rows) {
  const found = buckets
    .map(([key, label]) => [label, src.num(`PartB-TI.CapGain.${block}.${key}`)])
    .filter(([, v]) => v);
  // One bucket is not a split — the subtotal above already says the whole of it,
  // and the tax section names the rate. Two or more is worth breaking out.
  if (found.length < 2) return;
  for (const [label, v] of found) rows.push(sub(`— ${label}`, v));
}

export function capitalGainsRows(src) {
  const rows = [];

  /* -- short term -- */
  const stcgTotal = src.num("ScheduleCGFor23.ShortTermCapGainFor23.TotalSTCG");
  if (stcgTotal) {
    rows.push(columnHeader("Short-term capital gains", { ref: "Sch. CG" }));
    for (const mf of src.peek("ScheduleCGFor23.ShortTermCapGainFor23.EquityMFonSTT") || []) {
      const i = (src.peek("ScheduleCGFor23.ShortTermCapGainFor23.EquityMFonSTT") || []).indexOf(mf);
      const at = `ScheduleCGFor23.ShortTermCapGainFor23.EquityMFonSTT[${i}]`;
      assetWorking(src, `${at}.EquityMFonSTTDtls_BE`, "equity shares / units (STT paid, before 23 July 2024)", rows);
      assetWorking(src, `${at}.EquityMFonSTTDtls`, "equity shares / units (STT paid)", rows);
      src.restate([`${at}.TotalCapGainonassets`]);
    }
    landAndBuildingWorking(src, "ScheduleCGFor23.ShortTermCapGainFor23.SaleofLandBuild", false, rows);
    slumpSaleWorking(src, "ScheduleCGFor23.ShortTermCapGainFor23.SlumpSaleInStcg", rows);
    for (const [names, caption] of STCG_BLOCKS) {
      const base = blockBase(src, "ScheduleCGFor23.ShortTermCapGainFor23", names);
      for (const d of base ? assetDetails(src, base) : []) assetWorking(src, d.path, caption, rows, d.when);
    }
    const deemed = src.num("ScheduleCGFor23.ShortTermCapGainFor23.TotalAmtDeemedStcg");
    if (deemed) rows.push(sub("Deemed short-term capital gain", deemed));
    const passThrough = src.num("ScheduleCGFor23.ShortTermCapGainFor23.PassThrIncNatureSTCG");
    if (passThrough) rows.push(sub("Pass-through short-term capital gain", passThrough));
    // A negative total is a LOSS, and the caption must say so — the renderer
    // parenthesises the figure either way, but "Total Short-term Capital Gains
    // (8,83,972)" is the wrong noun on a document somebody signs.
    rows.push(subtotal(
      stcgTotal < 0 ? "Total Short-term Capital Loss" : "Total Short-term Capital Gains",
      Math.abs(stcgTotal), { isLoss: stcgTotal < 0 || undefined }
    ));
    rateSplit(src, "ShortTerm", ST_BUCKETS, rows);
  }

  /* -- long term -- */
  const ltcgTotal = src.num("ScheduleCGFor23.LongTermCapGain23.TotalLTCG");
  if (ltcgTotal) {
    const s112a = src.peek("Schedule112A") || {};
    rows.push(columnHeader("Long-term capital gains", { ref: s112a.SaleValue112A ? "Sch. 112A" : "Sch. CG" }));
    if (s112a.SaleValue112A) {
      rows.push(sub("Full value of consideration — equity shares / units u/s 112A", Number(s112a.SaleValue112A)));
      rows.push(sub("Less: Cost of acquisition", Number(s112a.Deductions112A || 0)));
    }
    landAndBuildingWorking(src, "ScheduleCGFor23.LongTermCapGain23.SaleofLandBuild", true, rows);
    const slump = blockBase(src, "ScheduleCGFor23.LongTermCapGain23", ["SlumpSaleInLtcgDtls.SlumpSaleInLtcg", "SlumpSaleInLtcg"]);
    if (slump) slumpSaleWorking(src, slump, rows);
    for (const [names, caption] of LTCG_BLOCKS) {
      const base = blockBase(src, "ScheduleCGFor23.LongTermCapGain23", names);
      for (const d of base ? assetDetails(src, base) : []) assetWorking(src, d.path, caption, rows, d.when);
    }
    const deemed = src.num("ScheduleCGFor23.LongTermCapGain23.TotalAmtDeemedLtcg");
    if (deemed) rows.push(sub("Deemed long-term capital gain", deemed));
    const passThrough = src.num("ScheduleCGFor23.LongTermCapGain23.PassThrIncNatureLTCG");
    if (passThrough) rows.push(sub("Pass-through long-term capital gain", passThrough));

    rows.push(subtotal(
      ltcgTotal < 0 ? "Total Long-term Capital Loss" : "Total Long-term Capital Gains",
      Math.abs(ltcgTotal), { isLoss: ltcgTotal < 0 || undefined }
    ));
    rateSplit(src, "LongTerm", LT_BUCKETS, rows);
    src.restate([
      "ScheduleCGFor23.LongTermCapGain23.SaleOfEquityShareUs112A.CapgainonAssetsTransferBE",
      "ScheduleCGFor23.LongTermCapGain23.SaleOfEquityShareUs112A.CapgainonAssetsTransferAE",
    ]);
  }
  // Deliberately NOT claiming the two subtrees wholesale. A class of asset this
  // builder does not recognise must surface in the review block (§8) rather than
  // vanish behind a blanket claim — that is the difference between a computation
  // that is incomplete and one that is quietly wrong.
  const at112A = "ScheduleCGFor23.LongTermCapGain23.SaleOfEquityShareUs112A";
  src.restate([
    `${at112A}.BalanceCG`, `${at112A}.CapgainonAssets`,
    `${at112A}.BalanceCGTransferBE`, `${at112A}.BalanceCGTransferAE`,
    `${at112A}.DeductionUs54F`, `${at112A}.DeductionUs54FBE`, `${at112A}.DeductionUs54FAE`,
  ]);

  /* -- virtual digital assets, taxed at their own rate u/s 115BBH -- */
  const vda = src.num("ScheduleCGFor23.IncmFromVDATrnsf");
  if (vda) rows.push(sub("Income from the transfer of virtual digital assets u/s 115BBH", vda, { ref: "Sch. VDA" }));
  src.claim("ScheduleVDA");

  const cgTotal = src.num("ScheduleCGFor23.TotScheduleCGFor23");
  if (rows.length) {
    rows.push(total(
      cgTotal < 0 ? "Loss under the head Capital Gains" : "Income chargeable under the head Capital Gains",
      Math.abs(cgTotal), { isLoss: cgTotal < 0 || undefined }
    ));
  }

  src.num("ScheduleCGFor23.SumOfCGIncm");
  src.claim("ScheduleCGFor23.CurrYrLosses");
  src.claim("ScheduleCGFor23.AccruOrRecOfCG");
  src.claim("ScheduleCGFor23.DeducClaimInfo");
  src.claim("Schedule112A");
  src.claim("Schedule115AD");
  return rows;
}

/* ----------------------------------------------------------- other sources -- */
export function otherSourcesRows(src) {
  const osPath = "ScheduleOS.IncOthThanOwnRaceHorse";
  const rows = [];
  const line = (label, path, opts) => {
    const v = src.num(`${osPath}.${path}`);
    if (v !== 0) rows.push(sub(label, v, opts));
    return v;
  };
  line("Dividend income", "DividendGross", { ref: "Sch. OS" });
  line("Interest from savings bank accounts", "IntrstFrmSavingBank");
  line("Interest on term / fixed deposits", "IntrstFrmTermDeposit");
  line("Interest on income-tax refund", "IntrstFrmIncmTaxRefund");
  line("Interest received from others", "IntrstFrmOthers");
  line("Family pension", "FamilyPension");
  line("Rent from machinery, plant or buildings", "RentFromMachPlantBldgs");
  line("Sums chargeable u/s 56(2)(x)", "Tot562x");
  line("Winnings from lotteries, crossword puzzles etc.", "LtryPzzlChrgblUs115BB");
  line("Winnings from online games u/s 115BBJ", "IncChrgblUs115BBJ");
  line("Income chargeable u/s 115BBE", "IncChrgblUs115BBE");
  const otherInc = src.claim(`${osPath}.OthersInc.OthersIncDtls`) || [];
  for (const o of otherInc) {
    const amt = Number(o.OthAmount || 0);
    if (amt) rows.push(sub(o.OthNatOfInc || "Other income", amt));
  }
  const otherGross = src.claim(`${osPath}.OthersGrossDtls`) || [];
  for (const o of otherGross) {
    const amt = Number(o.OthAmount ?? o.SalOthAmount ?? 0);
    if (amt) rows.push(sub(o.OthNatOfInc || o.SalNatureDesc || "Other income", amt));
  }
  if (!otherInc.length && !otherGross.length) {
    line("Any other income", "AnyOtherIncome");
  } else {
    // The itemised rows above add up to this. Reading it anyway is what stops a
    // 14,71,732 total appearing in the review block as an unexplained figure
    // when the itemisation has already accounted for every rupee of it.
    src.num(`${osPath}.AnyOtherIncome`);
  }
  src.num(`${osPath}.OthersGross`);

  const gross = src.num(`${osPath}.GrossIncChrgblTaxAtAppRate`);
  const deductions = src.num(`${osPath}.Deductions.TotDeductions`);
  const notDeductible = src.num(`${osPath}.AmtNotDeductibleUs58`);
  const profitChargeable = src.num(`${osPath}.ProfitChargTaxUs59`);
  const net = src.num("ScheduleOS.IncChargeable");
  if (rows.length > 1 || deductions) rows.push(subtotal("Gross income chargeable under Other Sources", gross));
  if (deductions) {
    const expenses = src.num(`${osPath}.Deductions.Expenses`);
    const interest = src.num(`${osPath}.Deductions.IntExp57`);
    const depreciation = src.num(`${osPath}.Deductions.Depreciation`);
    const familyPension = src.num(`${osPath}.Deductions.DeductionUs57iia`);
    const parts = [
      expenses && "expenses",
      interest && "interest",
      depreciation && "depreciation",
      familyPension && "the family pension deduction u/s 57(iia)",
    ].filter(Boolean);
    rows.push(sub("Less: Deductions u/s 57", deductions, {
      ref: "Sec. 57",
      note: parts.length > 1 ? `Comprising ${parts.join(", ")}` : undefined,
    }));
  }
  if (notDeductible) rows.push(sub("Add: Amounts not deductible u/s 58", notDeductible, { ref: "Sec. 58" }));
  if (profitChargeable) rows.push(sub("Add: Profit chargeable to tax u/s 59", profitChargeable, { ref: "Sec. 59" }));

  // Owning race horses is its own basket: its losses cannot be set off against
  // anything else, which is why the return keeps it apart from the rest.
  const raceHorse = src.num("ScheduleOS.IncFromOwnHorse.BalanceOwnRaceHorse");
  if (raceHorse) {
    rows.push(sub("Income from the activity of owning and maintaining race horses", raceHorse, {
      note: "Kept separate — losses of this activity are set off only against it",
    }));
  }
  src.claim("ScheduleOS.IncFromOwnHorse");

  if (rows.length) rows.push(total("Income chargeable under the head Other Sources", net));
  src.num("ScheduleOS.TotOthSrcNoRaceHorse");
  // The quarter-by-quarter splits exist so interest u/s 234C can be worked out.
  // They are the same income already stated above, cut by date of receipt.
  for (const k of Object.keys(src.peek("ScheduleOS") || {})) {
    if (/^(Dividend|IncFrm)/.test(k) && src.peek(`ScheduleOS.${k}.DateRange`)) src.claim(`ScheduleOS.${k}`);
  }
  return rows;
}

/* --------------------------------------------------------- Chapter VI-A ----
 *
 * §10: the return carries what was CLAIMED and what is ALLOWED after the
 * statutory caps, in two parallel blocks. The computation states the allowed
 * figure — that is what enters the total — and notes the claim wherever the two
 * differ. A s.80C claim of 2,28,513 restricted to 1,50,000 is exactly what a
 * reader wants to see; printing only one of the two hides it.
 */
export function chapterVIA(src) {
  const claimed = src.claim("ScheduleVIA.UsrDeductUndChapVIA") || {};
  const allowed = src.claim("ScheduleVIA.DeductUndChapVIA") || {};
  const rows = [];
  /* Anything named Tot… is a SUBTOTAL of the block, not a deduction in it. The
     A.Y. 2022-23 ITR-3 carries TotPartBchapterVIA 2,02,250 and
     TotPartCAandDchapterVIA 8,814 alongside the four real sections, and printing
     them produced a "deduction under u/s TotPartBchapterVIA" line that
     double-counted the whole of Part B. */
  const keys = Object.keys(allowed)
    .filter((k) => !/^Tot/.test(k) && Number(allowed[k]) > 0)
    .sort((a, b) => viaOrder(a) - viaOrder(b));
  for (const k of keys) {
    const amt = Number(allowed[k]);
    const askedFor = Number(claimed[k] || 0);
    rows.push(sub(viaLabel(k), amt, {
      ref: viaRef(k),
      note: askedFor > amt ? `Claimed ${inr(askedFor)}; restricted to the statutory limit` : undefined,
    }));
  }
  const allowedTotal = src.num("ScheduleVIA.DeductUndChapVIA.TotalChapVIADeductions");
  if (rows.length) rows.push(total("Total deductions under Chapter VI-A", allowedTotal));
  // Schedules 80C / 80D / 80G itemise what the summary above already totals.
  for (const s of ["Schedule80C", "Schedule80D", "Schedule80G", "Schedule80GGA", "Schedule80DD", "Schedule80U", "Schedule80IA", "Schedule80IB", "Schedule80IC", "Schedule80IE", "Schedule80P"]) {
    src.claim(s);
  }
  return { rows, allowedTotal, claimedTotal: Number(claimed.TotalChapVIADeductions || 0) };
}

/* --------------------------------------------------------- tax liability ---
 *
 * Part B-TTI, restated. Every row here is a figure the return states; the rows
 * that are nil are printed as nil rather than dropped, because a reader checking
 * a computation looks for the line before the figure.
 */
export function taxRows(src, { siRows, totalIncome }) {
  const at = "PartB_TTI.ComputationOfTaxLiability";
  const onTI = src.claim(`${at}.TaxPayableOnTI`) || {};
  const taxNormal = Number(onTI.TaxAtNormalRatesOnAggrInc ?? onTI.TaxAtNormalRates ?? 0);
  const taxSpecial = Number(onTI.TaxAtSpecialRates || 0);
  const agriRebate = Number(onTI.RebateOnAgriInc || 0);
  const taxOnTotal = Number(onTI.TaxPayableOnTotInc || 0);
  const rows = [];

  /* The rebate, surcharge and cess sit one level apart in the two returns:
     ITR-2 carries them directly under ComputationOfTaxLiability, ITR-3 inside
     TaxPayableOnTI. Reading the nested one when it exists and the outer one
     otherwise is the difference between a cess row that states 13,917 and one
     that states nil on a document somebody signs. */
  const pick = (key) => (onTI[key] === undefined ? src.num(`${at}.${key}`) : Number(onTI[key] || 0));

  rows.push(sub("Tax on income at the rates in force", taxNormal, { ref: "Para A, Sch. I" }));
  // One row per special rate the return actually used, captioned and rated from
  // Schedule SI rather than from any assumption about what the law says.
  for (const r of siRows || []) {
    const inc = Number(r.SplRateInc || 0);
    if (!inc) continue;
    rows.push(sub(`${specialRateLabel(r.SecCode)} — at ${r.SplRatePercent}%`, Number(r.SplRateIncTax || 0), {
      note: `on ${inr(inc)}`,
      ref: "Sch. SI",
    }));
  }
  if (taxSpecial && !(siRows || []).some((r) => Number(r.SplRateInc))) {
    rows.push(sub("Tax at special rates", taxSpecial, { ref: "Sch. SI" }));
  }
  // Agricultural income is exempt but is aggregated for rate purposes: tax is
  // charged on the aggregate and then reduced by the tax on the agricultural
  // income plus the basic exemption. Without this row the tax above looks
  // computed on the wrong figure.
  if (agriRebate) {
    rows.push(sub("Less: Rebate on agricultural income aggregated for rate purposes", agriRebate, {
      note: "Agricultural income is exempt; it is aggregated only to fix the rate",
    }));
  }
  rows.push(subtotal("Tax on Total Income", taxOnTotal));

  const rebate87A = pick("Rebate87A");
  const afterRebate = pick("TaxPayableOnRebate");
  rows.push(sub("Less: Rebate u/s 87A", rebate87A, { ref: "Sec. 87A" }));
  if (rebate87A) rows.push(sub("Tax after rebate", afterRebate));
  rows.push(sub("Add: Surcharge", pick("TotalSurcharge"), { note: surchargeNote(src, at, onTI, totalIncome) }));
  rows.push(sub("Add: Health & Education Cess @ 4%", pick("EducationCess")));
  rows.push(subtotal("Gross Tax Liability", src.num(`${at}.GrossTaxPayable`)));

  // AMT credit of an earlier year, set off against this year's regular tax.
  const amtCredit = src.num(`${at}.CreditUS115JD`);
  if (amtCredit) {
    rows.push(sub("Less: Credit for Alternate Minimum Tax u/s 115JD", amtCredit, { ref: "Sch. AMTC" }));
    rows.push(sub("Tax payable after AMT credit", src.num(`${at}.TaxPayAfterCreditUs115JD`)));
  }
  rows.push(sub("Less: Relief u/s 89 / 90 / 90A / 91", src.num(`${at}.TaxRelief.TotTaxRelief`)));
  rows.push(sub("Add: Interest u/s 234A / 234B / 234C and fee u/s 234F", src.num(`${at}.IntrstPay.TotalIntrstPay`), {
    note: interestNote(src, at),
  }));
  const aggregate = src.num(`${at}.AggregateTaxInterestLiability`);
  rows.push(total("Total Tax and Interest Payable", aggregate));

  src.claim(`${at}.TaxPayableOnDeemedTI`);
  return { rows, aggregate };
}

/* Why there is a surcharge, or why there is not — and what marginal relief did.
 *
 * A surcharge row carrying a lakh with no explanation is the line a client asks
 * about first. The return states the charge before marginal relief and after it
 * in parallel fields, so the relief is a subtraction of two figures the return
 * itself makes, not one this document works out. */
function surchargeNote(src, at, onTI, totalIncome) {
  const of = (key) => (onTI[key] === undefined ? src.num(`${at}.${key}`) : Number(onTI[key] || 0));
  const total = of("TotalSurcharge");
  if (!total) return totalIncome <= 5000000 ? "Total income does not exceed ₹ 50 lakh" : undefined;

  const parts = [];
  /* NOT "exceeds ₹ 1 crore", though the field is called SurchargeOnAboveCrore.
     That name is the schema's label for the limb charged on total income, at
     whatever rate the year's slab gives — the A.Y. 2022-23 ITR-3 fills it on a
     total income of 51,43,580, which is nowhere near a crore. What IS certain is
     the threshold at which any surcharge on an individual begins, and that is
     read off this return's own total income rather than off a field name. */
  if (totalIncome > 5000000) parts.push("Total income exceeds ₹ 50 lakh");
  // The surcharge on income taxable at special rates is charged apart, because
  // the rate on it is capped whatever the total income is.
  if (of("Surcharge25ofSI")) parts.push("Charged separately on the income taxable at special rates");

  /* Marginal relief, where the return itself shows it: the charge cannot take
     more than the income above the threshold. This is the return's own
     subtraction between its before- and after-relief fields, not one worked out
     here — 1,22,349 down to 1,00,506 on the A.Y. 2022-23 return. */
  const before = of("SurchargeOnAboveCroreBeforeMarginal") + of("Surcharge25ofSIBeforeMarginal");
  if (before > total) parts.push(`After marginal relief of ${inr(before - total)}`);
  return parts.length ? parts.join(" · ") : undefined;
}

/** "s.234B 5,049 · s.234C 6,051" — which interest, not just how much. */
function interestNote(src, at) {
  const parts = [
    ["234A", src.num(`${at}.IntrstPay.IntrstPayUs234A`)],
    ["234B", src.num(`${at}.IntrstPay.IntrstPayUs234B`)],
    ["234C", src.num(`${at}.IntrstPay.IntrstPayUs234C`)],
  ].filter(([, v]) => v).map(([s, v]) => `s.${s} ${inr(v)}`);
  const fee = src.num(`${at}.IntrstPay.LateFilingFee234F`);
  if (fee) parts.push(`fee u/s 234F ${inr(fee)}`);
  // New in the A.Y. 2026-27 schema, alongside the s.234 interest.
  const furnishFee = src.num(`${at}.IntrstPay.FeeFurnish234I`);
  if (furnishFee) parts.push(`fee u/s 234I ${inr(furnishFee)}`);
  return parts.length ? parts.join(" · ") : undefined;
}

/* ----------------------------------------------------------- taxes paid ---- */
export function taxesPaidRows(src, { aggregate }) {
  const rows = [];
  const salaryTds = src.claim("ScheduleTDS1.TDSonSalary") || [];
  if (salaryTds.length) {
    rows.push(columnHeader("Tax Deducted at Source — TAN of Deductor", { ref: "Gross Receipt" }));
    for (const t of salaryTds) {
      const d = t.EmployerOrDeductorOrCollectDetl || {};
      rows.push(sub(d.TAN || "", Number(t.TotalTDSSal || 0), {
        note: [d.EmployerOrDeductorOrCollecterName, "Salary · Sec. 192"].filter(Boolean).join(" · "),
        cols: { ref: inr(t.IncChrgSal || 0) },
      }));
    }
  }

  // §12: rows against the same TAN stay separate, unless they also share a
  // section — a bank that paid interest quarterly produces four near-identical
  // lines, and one row carrying the count says the same thing legibly. Merging
  // across sections would hide which receipt a credit belongs to, which is
  // exactly what a CPC mismatch query asks about.
  const otherTds = src.claim("ScheduleTDS2.TDSOthThanSalaryDtls") || [];
  const byTanSection = new Map();
  for (const t of otherTds) {
    const sec = tdsSection(t.TDSSection);
    const key = `${t.TANOfDeductor}|${sec}`;
    const prev = byTanSection.get(key) || { tan: t.TANOfDeductor, section: sec, gross: 0, credit: 0, count: 0 };
    prev.gross += Number(t.GrossAmount || 0);
    prev.credit += Number(t.TaxDeductCreditDtls?.TaxClaimedOwnHands || 0);
    prev.count += 1;
    byTanSection.set(key, prev);
  }
  // A deductor entry with neither a receipt nor a credit says nothing. Rows with
  // a gross but no credit DO stay: they are what a deductor reported against the
  // PAN without deducting, which is exactly what a s.143(1) mismatch turns on.
  const tdsRows = [...byTanSection.values()]
    .filter((g) => g.gross || g.credit)
    .sort((a, b) => b.credit - a.credit || b.gross - a.gross);
  if (tdsRows.length && !salaryTds.length) rows.push(columnHeader("Tax Deducted at Source — TAN of Deductor", { ref: "Gross Receipt" }));
  for (const g of tdsRows) {
    rows.push(sub(g.tan, g.credit, {
      // Some years' returns carry no section code at all. "Sec." with nothing
      // after it is worse than saying nothing.
      note: [tdsNature(g.section), g.section ? `Sec. ${g.section}` : "", g.count > 1 ? `${g.count} entries` : ""].filter(Boolean).join(" · "),
      cols: { ref: g.gross ? inr(g.gross) : "" },
    }));
  }

  /* Schedule TDS3 — tax deducted by someone who has no TAN.
   *
   * A buyer of immovable property (s.194-IA), an individual tenant (s.194-IB) or
   * a person paying a contractor or professional (s.194M) deducts against their
   * own PAN, so these credits appear in a schedule of their own and never in
   * TDS1 or TDS2. On the A.Y. 2023-24 return this is the ONLY tax deducted at
   * source: 45,900 on a property consideration of 45,90,000. Reading only TDS1
   * and TDS2 printed a "Total Tax Deducted at Source — 45,900" with no row above
   * it explaining where a rupee of it came from.
   */
  const tds3 = src.claim("ScheduleTDS3.TDS3onOthThanSalDtls") || [];
  const tds3Rows = tds3
    .map((t) => ({
      pan: t.PANOfBuyerTenant || t.PANofTenant || t.PANOfOtherPerson || "",
      head: headOfIncome(t.HeadOfIncome),
      gross: Number(t.GrossAmount || 0),
      credit: Number(t.TaxDeductCreditDtls?.TaxClaimedOwnHands || 0),
    }))
    .filter((g) => g.gross || g.credit)
    .sort((a, b) => b.credit - a.credit || b.gross - a.gross);
  if (tds3Rows.length) {
    rows.push(columnHeader("Tax Deducted at Source — PAN of Buyer or Tenant", { ref: "Gross Receipt" }));
    for (const g of tds3Rows) {
      rows.push(sub(g.pan, g.credit, {
        note: ["Deducted by a person not required to hold a TAN", g.head].filter(Boolean).join(" · "),
        cols: { ref: g.gross ? inr(g.gross) : "" },
      }));
    }
  }
  src.num("ScheduleTDS3.TotalTDS3OnOthThanSal");

  const tds = src.num("PartB_TTI.TaxPaid.TaxesPaid.TDS");
  const tcs = src.num("PartB_TTI.TaxPaid.TaxesPaid.TCS");
  const advance = src.num("PartB_TTI.TaxPaid.TaxesPaid.AdvanceTax");
  const selfAssessment = src.num("PartB_TTI.TaxPaid.TaxesPaid.SelfAssessmentTax");
  const totalPaid = src.num("PartB_TTI.TaxPaid.TaxesPaid.TotalTaxesPaid");
  src.claim("ScheduleTCS");
  src.num("ScheduleTDS1.TotalTDSonSalaries");
  src.num("ScheduleTDS2.TotalTDSonOthThanSals");

  rows.push(subtotal("Total Tax Deducted at Source", tds, { ref: "Sch. TDS" }));

  // Advance tax and self-assessment tax are one challan each. Listing them lets
  // a reader tie the figure to a receipt without opening the return.
  // In date order. The return lists challans in whatever order they were keyed,
  // which puts a March instalment above a June one and makes a reader check the
  // dates twice to see that the advance tax was paid when it was due.
  const challans = [...(src.claim("ScheduleIT.TaxPayment") || [])]
    .sort((a, b) => String(a.DateDep || "").localeCompare(String(b.DateDep || "")));
  if (challans.length && (advance || selfAssessment)) {
    rows.push(columnHeader("Advance Tax and Self-Assessment Tax — BSR code / challan", { ref: "Date" }));
    for (const c of challans) {
      if (!Number(c.Amt)) continue;
      rows.push(sub(`${c.BSRCode || ""}${c.SrlNoOfChaln ? ` · ${c.SrlNoOfChaln}` : ""}`, Number(c.Amt), {
        cols: { ref: longDate(c.DateDep) || "" },
      }));
    }
    rows.push(sub("Advance Tax Paid", advance, { ref: "Sch. IT" }));
    rows.push(sub("Self-Assessment Tax Paid", selfAssessment, { ref: "Sch. IT" }));
  } else {
    rows.push(sub("Advance Tax Paid", advance, { ref: "Sch. IT" }));
    rows.push(sub("Self-Assessment Tax Paid", selfAssessment, { ref: "Sch. IT" }));
  }
  src.num("ScheduleIT.TotalTaxPayments");
  src.claim("ScheduleIT");

  /* Tax collected at source, by collector. Naming them costs two lines and is
     the same information need the TDS rows serve: the A.Y. 2023-24 return
     carries 13,573 collected by two motor dealers, and a bare total leaves a
     reader with nothing to tie to a 26AS entry. */
  const tcsRows = (src.claim("ScheduleTCS.TCS") || [])
    .map((c) => ({
      tan: c.EmployerOrDeductorOrCollectTAN || c.TAN || "",
      credit: Number(c.TCSClaimedThisYearDtls?.TCSAmtCollOwnHand ?? c.TCSCurrFYDtls?.TCSAmtCollOwnHand ?? 0),
    }))
    .filter((c) => c.credit)
    .sort((a, b) => b.credit - a.credit);
  if (tcsRows.length) {
    rows.push(columnHeader("Tax Collected at Source — TAN of Collector", { ref: "" }));
    for (const c of tcsRows) rows.push(sub(c.tan, c.credit));
  }
  src.num("ScheduleTCS.TotalSchTCS");
  src.claim("ScheduleTCS");

  rows.push(sub("Tax Collected at Source", tcs, { ref: "Sch. TCS" }));
  rows.push(subtotal("Total Taxes Paid", totalPaid));
  rows.push(sub("Less: Total Tax and Interest Payable", aggregate));
  return rows;
}

/* ------------------------------------------------- losses carried forward ---
 *
 * Schedule CFL, which is the schedule a computation must NOT summarise from
 * Part B-TI. `LossesOfCurrentYearCarriedFwd` is this year's loss alone: the
 * A.Y. 2023-24 return states 8,83,972 there and 26,15,711 as the total actually
 * carried forward, the difference being a long-term capital loss of 17,31,739
 * still unabsorbed from an earlier year. Printing the first figure under the
 * caption "Total Loss Carried Forward" understated by 17.3 lakh the relief this
 * assessee can claim in future years.
 *
 * The date each earlier year's return was filed is printed beside its loss,
 * because s.80 allows the carry-forward only where that return was filed in
 * time — which is the first thing anyone checks about a brought-forward loss.
 */
/* NOT `BrtFwdBusLoss`. Each year's block states the same business loss twice —
   once against that key and once against `BusLossOthThanSpecLossCF` — and only
   the second enters the return's own totals. Listing both printed every business
   loss on the page twice, so the rows added to double the subtotal beneath them.
   It is restated below rather than captioned. */
const CFL_KINDS = [
  ["TotalHPPTILossCF", "House property loss"],
  ["BusLossOthThanSpecLossCF", "Business loss, other than speculative"],
  ["LossFrmSpecBusCF", "Speculative business loss"],
  ["LossFrmSpecifiedBusCF", "Loss of a specified business u/s 35AD"],
  ["TotalSTCGPTILossCF", "Short-term capital loss"],
  ["TotalLTCGPTILossCF", "Long-term capital loss"],
  ["OthSrcLossRaceHorseCF", "Loss from owning and maintaining race horses"],
];

const cflKinds = (src, base) =>
  CFL_KINDS.map(([key, label]) => [label, src.num(`${base}.${key}`)]).filter(([, v]) => v);

/* The assessment year a Schedule CFL slot belongs to.
 *
 * The numeric suffix on `LossCFCurrentAssmntYear2026` is the year the assessment
 * year ENDS in, so that slot holds the loss of A.Y. 2025-26. This is not read off
 * the name and hoped for — it is checked against the assessee's own consecutive
 * returns, which is the only evidence that can settle it:
 *
 *   slot …2024  15,13,184 + 1,94,592   = the A.Y. 2023-24 return's own loss
 *   slot …2025   2,91,221              = the A.Y. 2024-25 return's own loss
 *   slot …2026  12,74,083              = the A.Y. 2025-26 return's own loss
 *
 * each differing only by that year's unabsorbed depreciation, which moves into
 * Schedule UD, and each carrying that return's own filing date.
 *
 * `LossCFCurrentAssmntYear` without a suffix, and `LossCFFromPrev3rdYearFromAY`,
 * carry no year that can be derived — the window of eight years slides, so a
 * fixed name cannot mean a fixed year. Those rows are identified by the filing
 * date the return does state, and say so rather than guessing. */
function cflAssessmentYear(key) {
  const m = /^LossCFCurrentAssmntYear(\d{4})$/.exec(key);
  if (!m) return "";
  const end = Number(m[1]);
  return `A.Y. ${end - 1}-${String(end).slice(2)}`;
}

export function carriedForwardRows(src, ctx) {
  const rows = [];

  /* The earlier years, in the order the return lists them.
   *
   * Every key beginning `LossCF` is one such block. Matching only
   * `LossCFCurrentAssmntYear…` missed `LossCFFromPrev3rdYearFromAY`, which is
   * where the A.Y. 2024-25 return keeps a 5,65,132 business loss of 2016-17 —
   * silently, because the schedule is claimed wholesale afterwards.
   *
   * The suffix on those keys is year-like but is NOT reliably the assessment
   * year, so each row is identified by the filing date the return does state. */
  const earlier = Object.keys(src.peek("ScheduleCFL") || {}).filter((k) => /^LossCF/.test(k));
  for (const k of earlier) {
    const base = `ScheduleCFL.${k}.CarryFwdLossDetail`;
    const filed = longDate(src.val(`${base}.DateOfFiling`));
    const ay = cflAssessmentYear(k);
    for (const [label, v] of cflKinds(src, base)) {
      rows.push(sub(ay ? `${ay} · ${label}` : label, v, {
        cols: { ref: filed || "" },
        note: ay ? undefined : "The return does not state the assessment year for this row",
      }));
    }
    src.restate([`${base}.BrtFwdBusLoss`, `${base}.AdjustAccTax115BACAmt`]);
  }

  /* The reconciliation, every figure of it the return's own.
   *
   *   brought forward from earlier years   ScheduleCFL.TotalOfBFLossesEarlierYrs
   * + the loss of this year                ScheduleCFL.CurrentAYloss
   * − set off against this year's income   ScheduleCFL.AdjTotBFLossInBFLA
   * = carried forward                      ScheduleCFL.TotalLossCFSummary
   *
   * Where those four do not close, the difference is a loss the return lists as
   * brought forward, does not set off, and does not carry forward. It gets a
   * line of its own rather than being left for a reader to find by subtracting:
   * on the A.Y. 2024-25 return it is 5,65,132. */
  const broughtForward = cflKinds(src, "ScheduleCFL.TotalOfBFLossesEarlierYrs.LossSummaryDetail");
  const currentYear = cflKinds(src, "ScheduleCFL.CurrentAYloss.LossSummaryDetail");
  const setOff = cflKinds(src, "ScheduleCFL.AdjTotBFLossInBFLA.LossSummaryDetail");
  const totals = cflKinds(src, "ScheduleCFL.TotalLossCFSummary.LossSummaryDetail");
  const sum = (xs) => xs.reduce((s, [, v]) => s + v, 0);
  const lossTotal = sum(totals);

  const ud = unabsorbedDepreciationRows(src, ctx);
  if (!rows.length && !currentYear.length && !ud.rows.length) {
    src.claim("ScheduleCFL");
    src.claim("ITR3ScheduleUD");
    return { rows: [], note: "" };
  }

  if (rows.length || currentYear.length) {
    rows.unshift(columnHeader("Assessment Year / Nature of loss", { ref: "Return for that year filed on", amt: "Amount (₹)" }));
    if (rows.length > 1) rows.push(subtotal("Total Brought Forward from Earlier Years", sum(broughtForward)));
    for (const [label, v] of currentYear) {
      rows.push(sub(`Add: Loss of the current year — ${label.toLowerCase()}`, v, { cols: { ref: `A.Y. ${ctx.ay}` } }));
    }
    if (sum(setOff)) {
      rows.push(sub("Less: Set off against the income of the year", sum(setOff), { ref: "Sch. BFLA" }));
    }
    const lapsed = sum(broughtForward) + sum(currentYear) - sum(setOff) - lossTotal;
    if (lapsed) {
      rows.push(sub("Less: Loss of an earlier year not carried forward", lapsed, {
        note: "Listed above as brought forward, but neither set off this year nor carried to the next",
      }));
    }
    // With more than one kind of loss the per-kind figure is what a later year
    // needs, because each is set off only against its own head. With one kind the
    // rows above already name it and a subtotal would just repeat the total.
    if (totals.length > 1) {
      for (const [label, v] of totals) rows.push(subtotal(`${label} carried forward`, v));
    }
    rows.push(total("Total Loss Carried Forward", lossTotal));
  }
  rows.push(...ud.rows);

  src.claim("ScheduleCFL");
  src.claim("ITR3ScheduleUD");
  return { rows, note: "" };
}

/* Unabsorbed depreciation u/s 32(2) — ITR3ScheduleUD.
 *
 * Not a loss, and not subject to the eight-year limit that governs a business
 * loss: it is carried forward without limit of time and set off against any
 * head. That is why the return keeps it in a schedule of its own, and why it is
 * totalled separately here rather than folded into the losses above. */
function unabsorbedDepreciationRows(src, ctx) {
  const years = src.peek("ITR3ScheduleUD.ScheduleUD") || [];
  const rows = [];
  years.forEach((y, i) => {
    const at = `ITR3ScheduleUD.ScheduleUD[${i}]`;
    const balance = src.num(`${at}.BalCFNY`) + src.num(`${at}.AllowBalCFNY`);
    src.restate([`${at}.AmtBFUD`, `${at}.AmtDeprSOCY`, `${at}.AmtBFUAllow`, `${at}.AmtAllowSOCY`]);
    if (balance) rows.push(sub("Unabsorbed depreciation u/s 32(2)", balance, { cols: { ref: `A.Y. ${y.AssYr || ""}` } }));
  });
  const current = src.num("ITR3ScheduleUD.CurBalCFNY") + src.num("ITR3ScheduleUD.CurAllowBalCFNY");
  if (current) rows.push(sub("Unabsorbed depreciation u/s 32(2)", current, { cols: { ref: `A.Y. ${ctx.ay}` } }));

  const total_ = src.num("ITR3ScheduleUD.TotDepritBalCFNY") + src.num("ITR3ScheduleUD.TotalBalCFNY");
  src.restate(["ITR3ScheduleUD.TotBFUDepritAmt", "ITR3ScheduleUD.TotCurYrdepritSetoffInc",
    "ITR3ScheduleUD.TotBFUAllowAmt", "ITR3ScheduleUD.TotCurYrAllowSetoffInc"]);
  if (!rows.length || !total_) return { rows: [], total: 0 };
  rows.unshift(columnHeader("Allowance carried forward", { ref: "Year it arose", amt: "Amount (₹)" }));
  rows.push(total("Unabsorbed Depreciation Carried Forward u/s 32(2)", total_));
  return { rows, total: total_ };
}

/* -------------------------------------------------------------- the banner --
 *
 * Refund or payable, never both, and neither when the return closes level —
 * a difference of a few rupees is written off by CPC and the return states nil
 * against both fields.
 */
export function refundOrPayable(src, notes) {
  const refundDue = src.num("PartB_TTI.Refund.RefundDue");
  const balPayable = src.num("PartB_TTI.TaxPaid.BalTaxPayable");
  if (refundDue > 0) {
    const banks = src.claim("PartB_TTI.Refund.BankAccountDtls.AddtnlBankDetails") || [];
    let bank = banks.find((b) => String(b.UseForRefund).toLowerCase() === "true");
    if (!bank && banks.length) {
      bank = banks[0];
      notes.push({ severity: "attention", text: "No bank account is flagged for the refund in the return; the first account listed is shown." });
    }
    return {
      refund: {
        amount: refundDue,
        bank: bank ? { name: bank.BankName || "", accountNo: bank.BankAccountNo || "", type: bank.AccountType || "", ifsc: bank.IFSCCode || "" } : null,
      },
      payable: null,
      refundDue,
      balPayable,
    };
  }
  src.claim("PartB_TTI.Refund");
  return { refund: null, payable: balPayable > 0 ? { amount: balPayable } : null, refundDue, balPayable };
}
