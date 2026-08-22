/* Computation of Income — ITR-3, A.Y. 2022-23: four property sales and the
 * exemptions claimed against them.
 *
 *   node --test test/computation/itr3-landbuilding-54f.test.mjs
 *
 * This one arrived as a bug report, and the bug is worth stating because it is
 * the kind that ties: four sales of land totalling 23.36 crore, against which
 * 9.67 crore of s.54F and s.54EC exemptions were claimed — and the working
 * printed not one of them.
 *
 * The head total was right, because it comes from the return's own field. So the
 * page showed a subtotal 9.67 crore BELOW what its own rows added up to, and
 * said nothing about the exemptions that explain the difference. A reader adding
 * the column would find it wrong; a reader checking the s.54F claim — the most
 * examined figure in any property sale — would find it absent.
 *
 * `exemptionRows()` existed and was called for every other class of asset. Land
 * and building has its own working (it carries s.50C, an indexed cost and the
 * buyers), and that working never called it. No fixture covered a property sale
 * WITH an exemption, so nothing failed.
 *
 * Anonymised (§11) — including four buyers' Aadhaar numbers, which the
 * anonymiser had to learn about first: ITD spells that field `AaadhaarOfBuyer`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildComputation, detect, validate } from "../../src/computation/index.js";
import { mapItr3 } from "../../src/computation/mappers/itr3/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "..", "fixtures", "itr3-landbuilding-54f-ay2022-23.json");
const GOLDEN = path.join(here, "..", "golden", "itr3-landbuilding-54f-ay2022-23.model.json");

const json = JSON.parse(readFileSync(FIXTURE, "utf8"));
const CTX = { generatedAt: "2026-01-01T00:00:00.000Z" };

const build = () => {
  const { form, body, ay, schemaVersion } = detect(json);
  assert.equal(form, "ITR3");
  assert.equal(ay, "2022-23");
  return { body, doc: mapItr3(body, { ...CTX, ay, schemaVersion }) };
};

const section = (doc, id) => doc.sections.find((s) => s.id === id);
const rows = (doc, id) => section(doc, id).rows;
const closing = (s) => s.rows.filter((r) => r.kind === "total").pop();

/* Reading a property schedule.
 *
 * It is a `matrix` row now, not a run of `sub` rows — see model.js. Two shapes,
 * because ten small plots cannot be ten columns across A4: up to four
 * properties get a column each and a line per figure; more than four turn, and
 * each property becomes a line. These helpers read whichever it is. */
const schedule = (doc, re) => rows(doc, "CG").find((r) => r.kind === "matrix" && re.test(r.label));
/* A property schedule alternates: a banner naming the property and its buyers,
   then the line of figures for it. `figures` drops the banners, so a property's
   nth line of figures is at index n whatever the banners did. */
const figures = (m) => (m.lines || []).filter((l) => !l.span);
/* Two columns can share a caption — "Exemption" u/s 54F and "Exemption" u/s
   54EC — so a column is addressed by caption AND note where it needs to be. */
const columnIndex = (m, label) => {
  const [, cap, note] = /^(\S+(?: \S+)*?)(?: (u\/s .+))?$/.exec(label) || [];
  return m.columns.findIndex((c) => c.label === cap && (!note || c.note === note));
};

/* ---------------- §11: the three required tests ---------------- */

test("mapper produces the golden model", () => {
  const { doc } = build();
  if (process.env.UPDATE_GOLDEN === "1" || !existsSync(GOLDEN)) {
    writeFileSync(GOLDEN, JSON.stringify(doc, null, 1) + "\n");
  }
  assert.deepEqual(doc, JSON.parse(readFileSync(GOLDEN, "utf8")));
});

test("validate() passes against the source return", () => {
  const { doc, body } = build();
  assert.deepEqual(validate(doc, body).failures, []);
});

test("unmapped is empty — 13 items surfaced before the fix", () => {
  const { doc } = build();
  assert.deepEqual(doc.unmapped, []);
});

/* ---------------- the working adds up ---------------- */

test("every property's figures net to the gain the return states for it", () => {
  /* THE TEST THAT WOULD HAVE CAUGHT IT. Read each property's line the way a
     reader does — consideration, less the s.48 deductions, less the exemption —
     and require it to land on its own CapgainonAssets. Before the exemptions
     were printed, all four overshot. */
  const { doc, body } = build();
  const stated = body.ScheduleCGFor23.LongTermCapGain23.SaleofLandBuild.SaleofLandBuildDtls;
  assert.equal(stated.length, 4);

  const m = schedule(doc, /long term$/);
  const at = (i, label) => figures(m)[i].cells[columnIndex(m, label)];

  stated.forEach((d, i) => {
    const net = at(i, "Full value") - at(i, "Deductions")
      - Number(at(i, "Exemption u/s 54F") || 0) - Number(at(i, "Exemption u/s 54EC") || 0);
    assert.equal(net, d.CapgainonAssets, `property ${i + 1} closing at ${d.CapgainonAssets}`);
    assert.equal(at(i, "Chargeable"), d.CapgainonAssets, "and the schedule says so itself");
  });

  // The total line adds the four up, and the head subtotal states the same.
  assert.equal(m.lines.at(-1).cells.at(-1), 87897868);
  const subtotal = rows(doc, "CG").find((r) => r.kind === "subtotal" && /Long-term/.test(r.label));
  assert.equal(subtotal.amount, stated.reduce((sum, d) => sum + d.CapgainonAssets, 0));
  assert.equal(subtotal.amount, 87897868);
});

test("9,67,09,854 of exemptions is on the page, per property and by section", () => {
  const { doc } = build();
  const m = schedule(doc, /long term$/);
  const cells = (label) => figures(m).slice(0, 4).map((l) => l.cells[columnIndex(m, label)]);

  // A column per section claimed, an amount per property, and the sections
  // named — s.54EC (bonds) against s.54F (a house) is exactly the pair a reader
  // has to be able to tell apart.
  const ex = m.columns.filter((c) => c.label === "Exemption");
  assert.deepEqual(ex.map((c) => c.note), ["u/s 54F", "u/s 54EC"]);
  assert.deepEqual(cells("Exemption u/s 54F"), [28676630, 5055900, 51977324, 6000000]);
  assert.deepEqual(cells("Exemption u/s 54EC"), [null, null, 5000000, null]);
  assert.deepEqual(m.lines.at(-1).cells.slice(-3), [91709854, 5000000, 87897868]);
  assert.equal(91709854 + 5000000, 96709854);
});

test("the parts of a section claimed twice are in its own schedule, with the dates", () => {
  /* Property 1 claims s.54F twice — 1,61,39,820 and 1,25,36,810 — because the
     sale was reinvested in two houses. The property's line carries the 2.86
     crore that came off the gain; WHAT it was reinvested in, and when, is the
     substance an officer asks about, and it used to be claimed as a subtree and
     never printed at all. */
  const { doc } = build();
  const f = schedule(doc, /54F$/);
  assert.deepEqual(f.columns.map((c) => c.label), [
    "Date of transfer", "Cost of new residential house", "Date of purchase / construction",
    "Deposited in the CGAS", "Deduction claimed",
  ]);
  assert.equal(f.lines.length, 6, "five claims and their total");
  assert.deepEqual(f.lines[0].cells, ["06 Oct 2021", 16139820, "06 Oct 2021", 16139820, 16139820]);
  assert.deepEqual(f.lines[1].cells, ["28 Mar 2022", 12536810, "28 Mar 2022", 12536810, 12536810]);
  assert.equal(f.lines.at(-1).cells.at(-1), 91709854);

  // s.54EC buys bonds, not a house, so its columns are its own — read from the
  // data rather than from a fixed list that would drop the section we had not
  // met yet.
  const ec = schedule(doc, /54EC$/);
  assert.deepEqual(ec.columns.map((c) => c.label), ["Date of transfer", "Amount invested", "Date of investment", "Deduction claimed"]);
  assert.deepEqual(ec.lines[0].cells, ["31 Mar 2022", 5000000, "31 Mar 2022", 5000000]);
});

test("ten small plots are ten lines, each named by the property it is", () => {
  /* The short-term side of this return is ten sales. Each is a banner naming
     the plot and its buyers, then a line of figures — which is the shape that
     made the schedule worth reading and the reason it is not a column per
     property: eleven columns of eight-digit figures does not fit across A4 at
     any font a person would sign. */
  const { doc, body } = build();
  const m = schedule(doc, /short term$/);
  const stated = body.ScheduleCGFor23.ShortTermCapGainFor23.SaleofLandBuild.SaleofLandBuildDtls;
  assert.deepEqual(m.columns.map((c) => c.label), [
    "Sold", "Acquired", "Full value", "Cost", "Deductions", "Capital gain",
  ]);
  assert.equal(figures(m).length, stated.length + 1, "one line each, and a total");
  assert.equal(m.lines.filter((l) => l.span).length, stated.length, "and a banner over each");

  stated.forEach((d, i) => {
    assert.match(m.lines[i * 2].label, new RegExp(`^Property ${i + 1} · `));
    assert.match(m.lines[i * 2].note, /^Sold to /, "the buyers identify the line");
    assert.equal(figures(m)[i].cells[2], d.FullConsideration);
    assert.equal(figures(m)[i].cells.at(-1), d.CapgainonAssets || 0);
  });
  // No exemption was claimed on any of them, so there is no "chargeable" column
  // repeating the gain to the rupee.
  assert.ok(!m.columns.some((c) => c.label === "Chargeable"));
  assert.equal(m.lines.at(-1).cells.at(-1), -258720);
});

/* ---------------- the indexed cost of improvement ---------------- */

test("an improvement is captioned as INDEXED when the return has indexed it", () => {
  const { doc, body } = build();
  const d = body.ScheduleCGFor23.LongTermCapGain23.SaleofLandBuild.SaleofLandBuildDtls[0];
  /* The trap: `ImproveCost` on the detail is 17,89,799 and there is no
     `ImproveCostIndex` field at all — but the itemised block shows the raw cost
     as 16,99,462 indexing to 17,89,799, and TotalDedn uses the indexed figure.
     So the name says cost and the value is the indexed cost. */
  assert.equal(d.ImproveCost, 1789799);
  assert.equal(d.CostOfImprovements.CostOfImprovementsDtls[0].ImproveCost, 1699462);
  assert.equal(d.CostOfImprovements.CostOfImprovementsDtls[0].CostOfImpIndex, 1789799);
  assert.equal(d.TotalDedn, d.AquisitCostIndex + d.ImproveCost + d.ExpOnTrans);

  /* So the schedule states both: the cost as incurred, and the indexed figure
     that is actually deducted. Captioning the indexed one "cost of improvement"
     understated it by the indexation on a document somebody signs. */
  const m = schedule(doc, /long term$/);
  const cells = (label) => figures(m).map((l) => l.cells[columnIndex(m, label)]);
  assert.deepEqual(cells("Improvement"), [1699462, null, null, null, 1699462]);
  assert.deepEqual(cells("Indexed"), [1789799, null, null, null, 1789799]);
  // The heading says which of the two it is, and the year it was incurred in.
  assert.equal(m.columns[columnIndex(m, "Improvement")].note, "cost incurred");
  assert.match(m.columns[columnIndex(m, "Indexed")].note, /cost of improvement, incurred 2020-21/);
});

/* ---------------- the same guard, over every fixture we hold ---------------- */

test("on EVERY fixture, a property sale's figures net to the gain the return states", () => {
  /* Why this walks every fixture rather than trusting the one above.
   *
   * validate() cannot catch this class of fault: the head total it checks comes
   * from the return's own field, so a schedule that omits a deduction still
   * ties. (Test 2 in this file passes against the broken code — that is the
   * proof.) The only thing that catches it is adding the figures up the way a
   * reader does, so that is done here for every property sale in the
   * repository, and a fixture added later is checked by the act of existing. */
  const dir = path.join(here, "..", "fixtures");
  let checked = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const source = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
    const body = source.ITR[Object.keys(source.ITR)[0]];
    const cg = body.ScheduleCGFor23;
    if (!cg) continue;
    const { doc } = buildComputation(source, CTX);
    const cgSection = doc.sections.find((s) => s.id === "CG");
    if (!cgSection) continue;

    for (const [block, term] of [["ShortTermCapGainFor23", "short"], ["LongTermCapGain23", "long"]]) {
      const stated = ((cg[block] || {}).SaleofLandBuild || {}).SaleofLandBuildDtls || [];
      const priced = stated.filter((d) => d.CapgainonAssets || d.FullConsideration
        || (d.ExemptionOrDednUs54 || {}).ExemptionGrandTotal);
      if (!priced.length) continue;
      const m = cgSection.rows.find((r) => r.kind === "matrix" && new RegExp(`${term} term$`).test(r.label));
      assert.ok(m, `${file}: no ${term}-term property schedule`);

      const idx = (label) => m.columns.findIndex((c) => c.label === label);
      const lines = m.lines.filter((l) => !l.span);
      assert.equal(lines.length, priced.length + (priced.length > 1 ? 1 : 0), `${file}: ${term}-term line count`);

      priced.forEach((d, i) => {
        const cells = lines[i].cells;
        const full = cells[idx("Full value") >= 0 ? idx("Full value") : idx("Adopted")];
        // Every column captioned as coming off the consideration, whatever it
        // is called this year: the s.48 total, and each section of exemption.
        const off = m.columns.reduce((sum, c, j) => (
          c.label === "Deductions" || c.label === "Exemption" ? sum + Number(cells[j] || 0) : sum
        ), 0);
        assert.equal(full - off, d.CapgainonAssets || 0, `${file}: ${term}-term property ${i + 1}`);
        checked++;
      });
    }
  }
  // A guard on the guard: a loop that silently matched nothing would pass.
  assert.ok(checked >= 14, `expected every property sale to be walked, walked ${checked}`);
});

/* ---------------- s.50C, and the rest of the head ---------------- */

test("no s.50C substitution is claimed where the stamp value matches", () => {
  const { doc, body } = build();
  // All four properties sold at the stamp-duty valuation, so the note that says
  // "substituted u/s 50C" must NOT appear: saying it where it did not happen is
  // as wrong as staying quiet where it did.
  for (const d of body.ScheduleCGFor23.LongTermCapGain23.SaleofLandBuild.SaleofLandBuildDtls) {
    assert.equal(d.PropertyValuation, d.FullConsideration);
  }
  assert.ok(!rows(doc, "CG").some((r) => /50C/.test(r.note || "")));
});

test("the head closes where the return says, and the short-term side is a loss", () => {
  const { doc, body } = build();
  // Ten small property sales at a loss of 2,58,720, against the four large
  // long-term gains. The captions have to name each for what it is.
  const st = rows(doc, "CG").find((r) => r.kind === "subtotal" && /Short-term/.test(r.label));
  assert.equal(st.label, "Total Short-term Capital Loss");
  assert.equal(st.isLoss, true);
  assert.equal(closing(section(doc, "CG")).amount, body.ScheduleCGFor23.TotScheduleCGFor23);
  assert.equal(closing(section(doc, "CG")).amount, 87639148);
});
