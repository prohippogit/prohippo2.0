/*
 * Ledger sections — Section.layout === 'table' (spec §3, §6).
 *
 *   node --test test/computation/ledger-layout.test.mjs
 *
 * Losses carried forward are the one part of a computation that is not a
 * working. Every row is a record of the same kind — an assessment year, the
 * date that year's return was filed, an amount — and the practitioner reads
 * across as much as down, comparing one year against another. So it is ruled
 * like a table rather than floated like a working.
 *
 * What matters here is that the DECISION is in the model and the LOOK is in the
 * renderer (§2). A test that only asserted on CSS would pass just as happily if
 * the renderer got there by asking which form it was printing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildComputation } from "../../src/computation/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "..", "fixtures");
const CTX = { generatedAt: "2026-01-01T00:00:00.000Z" };

const build = (name) => buildComputation(JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8")), CTX);
const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).sort();

test("every carry-forward section built from a fixture is a ledger", () => {
  const forms = new Set();
  for (const file of files) {
    const { doc } = build(file.replace(/\.json$/, ""));
    const cfl = doc.sections.find((s) => s.id === "CFL");
    if (!cfl) continue;
    forms.add(doc.meta.form);
    assert.equal(cfl.layout, "table", `${file}: the CFL section must be a ledger`);
  }
  // No ITR-2 fixture carries a brought-forward loss — a salaried assessee's
  // house property loss is set off in the year it arises. The next test covers
  // that mapper, because a fixture set cannot.
  assert.deepEqual([...forms].sort(), ["ITR3", "ITR5"]);
});

test("every mapper that builds a CFL section says it is a ledger", () => {
  // ITR-2, ITR-3 and ITR-5 build theirs in three different files. A form that
  // grows one later and forgets to mark it shows up here rather than shipping
  // a carry-forward table that silently prints as a working.
  const sites = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const src = readFileSync(p, "utf8");
      for (const m of src.matchAll(/section\("CFL"[^\n]*/g)) sites.push([path.basename(p), m[0]]);
    }
  };
  walk(path.join(here, "..", "..", "src", "computation", "mappers"));
  assert.equal(sites.length, 3, `expected one CFL section per form, found ${sites.length}`);
  for (const [file, line] of sites) assert.match(line, /layout: "table"/, `${file}: ${line}`);
});

test("a working is not a ledger — the shape is stated, never assumed", () => {
  const { doc } = build("itr3-fno-bfloss-setoff-ay2026-27");
  for (const s of doc.sections.filter((x) => x.id !== "CFL")) {
    assert.equal(s.layout, undefined, `${s.id} is a working and must not carry a layout`);
  }
});

test("the renderer rules a ledger and floats a working", () => {
  const { html } = build("itr3-fno-bfloss-setoff-ay2026-27");
  // One ledger in this document, and it is framed. The frame is what rounds the
  // corners — a table with collapsed borders cannot round its own.
  assert.equal(html.match(/class="grid-frame"/g).length, 1);
  assert.equal(html.match(/<table class="rows grid">/g).length, 1);
  assert.match(html, /\.grid-frame \{[^}]*border-radius: 16px/);
  assert.match(html, /table\.rows\.grid \{ border-collapse: collapse/);
  // The workings above it are untouched.
  assert.ok(html.match(/<table class="rows">/g).length >= 5);
});

test("the renderer decides on the layout, never on the form", () => {
  const src = readFileSync(path.join(here, "..", "..", "src", "computation", "render", "template.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")   // §2's own warning is written in a comment
    .replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(src, /form\s*===/);
  assert.match(src, /s\.layout === "table"/);
});

test("a column heading may caption the amount column", () => {
  // `amount` cannot do it: it is a figure and renders as one, so 0 would print
  // an em dash under a heading and null would print nothing at all (§3).
  const { doc, html } = build("itr3-fno-busloss-unabsdepr-ay2024-25");
  const heads = doc.sections.find((s) => s.id === "CFL").rows.filter((r) => r.kind === "columnHeader");
  assert.deepEqual(heads.map((r) => [r.label, r.cols.ref, r.cols.amt, r.amount]), [
    ["Assessment Year / Nature of loss", "Return for that year filed on", "Amount (₹)", null],
    ["Allowance carried forward", "Year it arose", "Amount (₹)", null],
  ]);
  assert.equal(html.match(/Amount \(₹\)/g).length, 2);
});

test("naming the layout changed no figure and no caption", () => {
  // This was presentation. If a single row moved, the golden models would have
  // moved with it — they did not, and the reconciliation still closes.
  const { doc } = build("itr3-fno-bfloss-setoff-ay2026-27");
  const cfl = doc.sections.find((s) => s.id === "CFL");
  const amount = (re) => cfl.rows.find((r) => re.test(r.label)).amount;
  assert.equal(amount(/^Total Brought Forward from Earlier Years/), 6645024);
  assert.equal(amount(/^Less: Set off against the income of the year/), 2787719);
  assert.equal(amount(/^Total Loss Carried Forward/), 3857305);
  assert.equal(6645024 - 2787719, 3857305);
});
