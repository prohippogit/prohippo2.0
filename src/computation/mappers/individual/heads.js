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
import { specialRateLabel, viaLabel, viaOrder, tdsSection, tdsNature } from "./labels.js";

const inr = (v) => Number(v || 0).toLocaleString("en-IN");

/* ---------------------------------------------------------------- salaries --
 *
 * Statutory shape: salary u/s 17(1), the value of perquisites u/s 17(2) and any
 * profits in lieu u/s 17(3) make up gross salary; the allowances exempt under
 * s.10 come off it; then the two deductions s.16 allows.
 *
 * §10: the per-component breakdown inside NatureOfSalary uses a numeric code
 * table we deliberately do not decode. The captions used here are the return's
 * own fields; guessing that code "4" means House Rent Allowance would put an
 * unverified label on a signed document.
 */
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

    if (many) rows.push(columnHeader(`Employer ${i + 1} — ${employerName}`, { ref: "" }));
    rows.push(sub("Salary as per section 17(1)", salary17_1, {
      ref: i === 0 && !many ? "Sch. S" : "",
      note: many ? "" : employerName,
    }));
    if (perquisites) rows.push(sub("Add: Value of perquisites u/s 17(2)", perquisites));
    if (inLieu) rows.push(sub("Add: Profits in lieu of salary u/s 17(3)", inLieu));
    if (many) rows.push(subtotal(`Gross salary — employer ${i + 1}`, gross));
    // The per-component split and the individual perquisite lines are the same
    // money already stated above, itemised for the return's own schedule.
    src.claim(`ScheduleS.Salaries[${i}].Salarys.NatureOfSalary`);
    src.claim(`ScheduleS.Salaries[${i}].Salarys.NatureOfPerquisites`);
    src.claim(`ScheduleS.Salaries[${i}].Salarys.NatureOfProfitInLieuOfSalary`);
    src.claim(`ScheduleS.Salaries[${i}].AddressDetail`);
    src.num(at("IncomeNotified89A"));
    src.num(at("IncomeNotifiedOther89A"));
    src.num(at("IncomeNotifiedPrYr89A"));
  });

  const grossSalary = src.num("ScheduleS.TotalGrossSalary");
  if (employers.length) rows.push(subtotal("Gross Salary", grossSalary));

  // Allowances exempt under s.10, itemised by the code the return gives. These
  // codes ARE readable ("10(13A)"), unlike the salary-component ones.
  const exemptRows = src.claim("ScheduleS.AllwncExemptUs10.AllwncExemptUs10Dtls") || [];
  const hra = src.claim("ScheduleS.Section10_13A") || {};
  for (const e of exemptRows) {
    const amt = Number(e.SalOthAmount || 0);
    if (!amt) continue;
    const code = String(e.SalNatureDesc || "").trim();
    const isHra = code === "10(13A)";
    rows.push(sub(
      isHra ? "Less: House rent allowance exempt u/s 10(13A)" : `Less: Allowance exempt u/s ${code === "OTH" ? "10" : code}`,
      amt,
      {
        note: isHra && hra.ActlHRARecv
          ? `HRA received ${inr(hra.ActlHRARecv)} · rent paid ${inr(hra.ActlRentPaid || 0)}`
          : (code === "OTH" ? e.SalOthNatOfInc || "" : ""),
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
    // "S" = self-occupied, "L" = let out, "D" = deemed let out.
    const use = String(prop.ifLetOut || "").toUpperCase();
    const selfOccupied = use === "S";

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
  ["SaleOnOtherAssets", "other assets"],
  ["NRISecur115AD", "securities and units u/s 115AD"],
  ["NRITransacSec48Dtl", "transactions taxable under the first proviso to s.48"],
];
const LTCG_BLOCKS = [
  ["SaleofAssetNADtls", "assets other than those listed separately"],
  ["SaleofBondsDebntr", "bonds or debentures"],
  ["NRISaleOfEquityShareUs112A", "equity shares / units u/s 112A (non-resident)"],
  ["NRISaleofForeignAsset", "assets acquired in foreign currency"],
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

/** One consideration → cost → gain working, for any block that carries a gain. */
function assetWorking(src, base, caption, rows) {
  const gain = src.num(`${base}.CapgainonAssets`);
  const consideration = src.num(`${base}.FullConsideration`);
  if (!gain && !consideration) return 0;
  rows.push(sub(`Full value of consideration — ${caption}`, consideration));
  const cost = src.num(`${base}.DeductSec48.AquisitCost`);
  const improve = src.num(`${base}.DeductSec48.ImproveCost`);
  const expense = src.num(`${base}.DeductSec48.ExpOnTrans`);
  if (cost) rows.push(sub("Less: Cost of acquisition", cost));
  if (improve) rows.push(sub("Less: Cost of improvement", improve));
  if (expense) rows.push(sub("Less: Expenditure on transfer", expense));
  src.restate([`${base}.DeductSec48.TotalDedn`, `${base}.BalanceCG`]);
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
    for (const [block, caption] of STCG_BLOCKS) {
      assetWorking(src, `ScheduleCGFor23.ShortTermCapGainFor23.${block}`, caption, rows);
    }
    const deemed = src.num("ScheduleCGFor23.ShortTermCapGainFor23.TotalAmtDeemedStcg");
    if (deemed) rows.push(sub("Deemed short-term capital gain", deemed));
    const passThrough = src.num("ScheduleCGFor23.ShortTermCapGainFor23.PassThrIncNatureSTCG");
    if (passThrough) rows.push(sub("Pass-through short-term capital gain", passThrough));
    rows.push(subtotal("Total Short-term Capital Gains", stcgTotal));
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
    for (const [block, caption] of LTCG_BLOCKS) {
      assetWorking(src, `ScheduleCGFor23.LongTermCapGain23.${block}`, caption, rows);
    }
    const deemed = src.num("ScheduleCGFor23.LongTermCapGain23.TotalAmtDeemedLtcg");
    if (deemed) rows.push(sub("Deemed long-term capital gain", deemed));
    const passThrough = src.num("ScheduleCGFor23.LongTermCapGain23.PassThrIncNatureLTCG");
    if (passThrough) rows.push(sub("Pass-through long-term capital gain", passThrough));

    rows.push(subtotal("Total Long-term Capital Gains", ltcgTotal));
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
  if (rows.length) rows.push(total("Income chargeable under the head Capital Gains", cgTotal));

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
  const keys = Object.keys(allowed)
    .filter((k) => k !== "TotalChapVIADeductions" && Number(allowed[k]) > 0)
    .sort((a, b) => viaOrder(a) - viaOrder(b));
  for (const k of keys) {
    const amt = Number(allowed[k]);
    const askedFor = Number(claimed[k] || 0);
    rows.push(sub(viaLabel(k), amt, {
      ref: k.replace(/^Section/, ""),
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
  rows.push(sub("Add: Surcharge", pick("TotalSurcharge"), {
    note: totalIncome <= 5000000 ? "Total income does not exceed ₹ 50 lakh" : undefined,
  }));
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

/** "s.234B 5,049 · s.234C 6,051" — which interest, not just how much. */
function interestNote(src, at) {
  const parts = [
    ["234A", src.num(`${at}.IntrstPay.IntrstPayUs234A`)],
    ["234B", src.num(`${at}.IntrstPay.IntrstPayUs234B`)],
    ["234C", src.num(`${at}.IntrstPay.IntrstPayUs234C`)],
  ].filter(([, v]) => v).map(([s, v]) => `s.${s} ${inr(v)}`);
  const fee = src.num(`${at}.IntrstPay.LateFilingFee234F`);
  if (fee) parts.push(`fee u/s 234F ${inr(fee)}`);
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
  if (byTanSection.size && !salaryTds.length) rows.push(columnHeader("Tax Deducted at Source — TAN of Deductor", { ref: "Gross Receipt" }));
  for (const g of [...byTanSection.values()].sort((a, b) => b.credit - a.credit)) {
    rows.push(sub(g.tan, g.credit, {
      // Some years' returns carry no section code at all. "Sec." with nothing
      // after it is worse than saying nothing.
      note: [tdsNature(g.section), g.section ? `Sec. ${g.section}` : "", g.count > 1 ? `${g.count} entries` : ""].filter(Boolean).join(" · "),
      cols: { ref: g.gross ? inr(g.gross) : "" },
    }));
  }

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
  const challans = src.claim("ScheduleIT.TaxPayment") || [];
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

  rows.push(sub("Tax Collected at Source", tcs, { ref: "Sch. TCS" }));
  rows.push(subtotal("Total Taxes Paid", totalPaid));
  rows.push(sub("Less: Total Tax and Interest Payable", aggregate));
  return rows;
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
