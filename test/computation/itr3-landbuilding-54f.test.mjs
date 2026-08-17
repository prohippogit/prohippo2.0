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

test("every property's rows net to the gain the return states for it", () => {
  /* THE TEST THAT WOULD HAVE CAUGHT IT. Walk the long-term working the way a
     reader does — consideration, less each deduction, less the exemption — and
     require each property to land on its own CapgainonAssets. Before the fix the
     exemptions were missing, so all four overshot. */
  const { doc, body } = build();
  const stated = body.ScheduleCGFor23.LongTermCapGain23.SaleofLandBuild.SaleofLandBuildDtls;
  assert.equal(stated.length, 4);

  const lt = rows(doc, "CG");
  const start = lt.findIndex((r) => r.label === "Long-term capital gains");
  let i = start + 1;
  for (const d of stated) {
    assert.match(lt[i].label, /^Full value of consideration — property /);
    let running = lt[i].amount;
    i++;
    while (i < lt.length && /^Less:/.test(lt[i].label)) { running -= lt[i].amount; i++; }
    assert.equal(running, d.CapgainonAssets, `property closing at ${d.CapgainonAssets}`);
  }
  // …and the four together are the subtotal the return states.
  const subtotal = lt.slice(start).find((r) => r.kind === "subtotal");
  assert.equal(subtotal.amount, stated.reduce((s, d) => s + d.CapgainonAssets, 0));
  assert.equal(subtotal.amount, 87897868);
});

test("9,67,09,854 of exemptions is on the page, per property and by section", () => {
  const { doc } = build();
  const ex = rows(doc, "CG").filter((r) => /Exemption/.test(r.label));
  assert.equal(ex.length, 4, "one row per property that claimed one");
  assert.equal(ex.reduce((s, r) => s + r.amount, 0), 96709854);

  // Two claims under one section: the row names s.54F and the note carries the
  // parts, because a sale reinvested in two houses is one claim in two pieces.
  assert.equal(ex[0].label, "Less: Exemption u/s 54F");
  assert.equal(ex[0].amount, 28676630);
  assert.equal(ex[0].note, "2 claims: 1,61,39,820 + 1,25,36,810");
  // A single claim names its section and needs no note.
  assert.equal(ex[1].label, "Less: Exemption u/s 54F");
  assert.equal(ex[1].note, undefined);
  // Two DIFFERENT sections cannot both go in the caption, so the note carries
  // them — and s.54EC (bonds) against s.54F (a house) is exactly the pair a
  // reader needs to see split out.
  assert.equal(ex[2].label, "Less: Exemption claimed against the gain");
  assert.match(ex[2].note, /s\.54EC 50,00,000, s\.54F 5,19,77,324/);
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

  const row = rows(doc, "CG").find((r) => /cost of improvement/i.test(r.label));
  assert.equal(row.label, "Less: Indexed cost of improvement");
  assert.equal(row.amount, 1789799);
  assert.match(row.note, /Improvement of 16,99,462 in 2020-21, indexed/);
});

/* ---------------- the same guard, over every fixture we hold ---------------- */

test("on EVERY fixture, a property sale's rows net to the gain the return states", () => {
  /* Why this walks every fixture rather than trusting the one above.
   *
   * validate() cannot catch this class of fault: the head total it checks comes
   * from the return's own field, so a working that omits a deduction still ties.
   * (Test 2 in this file passes against the broken code — that is the proof.)
   * The only thing that catches it is adding the column up the way a reader
   * does, so that is done here for every property sale in the repository, and a
   * fixture added later is checked by the act of existing. */
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

    for (const [block, heading] of [["ShortTermCapGainFor23", "Short-term"], ["LongTermCapGain23", "Long-term"]]) {
      const stated = ((cg[block] || {}).SaleofLandBuild || {}).SaleofLandBuildDtls || [];
      const priced = stated.filter((d) => d.CapgainonAssets || d.FullConsideration);
      if (!priced.length) continue;
      const list = cgSection.rows;
      let i = list.findIndex((r) => new RegExp(`^${heading} capital gains`).test(r.label)) + 1;
      for (const d of priced) {
        /* Only the LAND rows, matched by their own caption. The equity and MF
           blocks are emitted before this one in the short-term working, so
           "the next consideration row" is not necessarily a property — a looser
           match read an equity block's cost against a property's gain and
           reported a discrepancy that was the test's, not the mapper's. */
        while (i < list.length && !/^Full value of consideration — (land or building|property \d+)/.test(list[i].label)) i++;
        assert.ok(i < list.length, `${file}: ${heading} property row missing`);
        let running = list[i].amount;
        i++;
        while (i < list.length && /^(Less|Add):/.test(list[i].label)) {
          running += /^Add:/.test(list[i].label) ? list[i].amount : -list[i].amount;
          i++;
        }
        assert.equal(running, d.CapgainonAssets || 0, `${file}: ${heading} property should net to ${d.CapgainonAssets}`);
        checked++;
      }
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
