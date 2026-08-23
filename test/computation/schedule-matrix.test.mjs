/*
 * Schedule blocks — the `matrix` row kind (spec §3, §6).
 *
 *   node --test test/computation/schedule-matrix.test.mjs
 *
 * A working states one figure per line and reads down the page. A property sale
 * does not: the reader compares one asset against another, and a working
 * interleaved two plots into "property 1 / property 2 / property 1" with no way
 * to read across. So the model gained a kind — a grid with its own columns —
 * rather than the renderer gaining a branch (§2).
 *
 * What is asserted here is the seam. The MAPPER decides what the schedule says
 * and which way round it goes; the RENDERER decides what a schedule looks like
 * and knows nothing about capital gains or which form it is printing. A test
 * that only checked the HTML would pass just as happily if the renderer got
 * there by asking whether it was printing an ITR-3.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildComputation } from "../../src/computation/index.js";
import { matrix, matrixLine, section, finalise } from "../../src/computation/model.js";
import { renderMatrix } from "../../src/computation/render/matrix.js";
import { THEMES } from "../../src/computation/render/themes/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "..", "fixtures");
const CTX = { generatedAt: "2026-01-01T00:00:00.000Z" };
const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).sort();

/* ---------------- the model ---------------- */

test("a cell is a figure, a string or structurally blank — and the three stay apart", () => {
  /* The same distinction §3 draws for `amount`, for the same reason: in a tax
     document "nil" and "not applicable" are different statements. */
  const m = matrix("Sale of land", {
    columns: [{ label: "Property 1" }],
    lines: [
      matrixLine("Full value of consideration", [1180000]),
      matrixLine("Chargeable gain", [0]),
      matrixLine("Date of sale", ["28 Jul 2023"]),
      matrixLine("Cost of improvement", [null]),
    ],
  });
  const html = renderMatrix(m);
  assert.match(html, /<td class="m-c num">11,80,000<\/td>/);
  assert.match(html, /<td class="m-c num nil">—<\/td>/, "0 is an em dash, not a blank");
  assert.match(html, /<td class="m-c text short">28 Jul 2023<\/td>/);
  assert.match(html, /<td class="m-c blank"><\/td>/, "null prints nothing at all");
});

test("a loss is parenthesised in a cell as it is in a row", () => {
  const html = renderMatrix(matrix("Sale of land", {
    columns: [{ label: "Amount" }],
    lines: [matrixLine("Short-term capital gain", [-109575])],
  }));
  assert.match(html, /class="m-c num loss">\(1,09,575\)</);
});

test("everything in a schedule is escaped — a property description is client text", () => {
  const html = renderMatrix(matrix("Sale of <land>", {
    columns: [{ label: "P&B", note: "<b>x</b>" }],
    lines: [matrixLine("Property", ['PLOT "A" & <B>'], { note: "<i>n</i>" })],
    note: "<script>",
  }));
  assert.ok(!/<b>|<i>|<script>/.test(html), "no markup from the data reaches the page");
  assert.match(html, /PLOT &quot;A&quot; &amp; &lt;B&gt;/);
});

test("a section drops for having nothing to say only when no CELL has a figure either", () => {
  /* finalise() reads `amount` on every row to decide whether a head is empty,
     and a matrix declares `amount: null` because all its figures are in cells.
     Reading `amount` alone would have dropped a capital gains section holding a
     two-crore property schedule — which is the bug this whole change is about,
     one layer down. */
  const withFigures = section("CG", "Capital Gains", [
    matrix("Sale of land", { columns: [{ label: "Amount" }], lines: [matrixLine("Consideration", [11875000])] }),
  ]);
  const particularsOnly = section("CG", "Capital Gains", [
    matrix("Sale of land", { columns: [{ label: "Amount" }], lines: [matrixLine("Date of sale", ["28 Jul 2023"])] }),
  ]);
  assert.deepEqual(finalise([withFigures]).map((s) => s.id), ["CG"]);
  assert.deepEqual(finalise([particularsOnly]).map((s) => s.id), [], "dates alone are not a head of income");
});

/* ---------------- the seam ---------------- */

test("the renderer never asks which form or which head it is printing", () => {
  const source = readFileSync(path.join(here, "..", "..", "src", "computation", "render", "matrix.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  for (const word of ["ITR", "capital", "Capital", "54", "property", "Property"]) {
    assert.ok(!new RegExp(`\\b${word}`).test(source),
      `render/matrix.js mentions "${word}" outside a comment`);
  }
});

test("a banner spans the schedule and carries the particulars, not figures", () => {
  /* Two of a property sale's particulars are long strings — the address, and
     three joint buyers with their PANs and their shares. In a column narrow
     enough for eight amounts to fit beside them they set fourteen lines apiece,
     which is what was reported. Across the schedule they set one or two. */
  const html = renderMatrix(matrix("Sale of land", {
    columns: [{ label: "Sold" }, { label: "Full value" }],
    lines: [
      matrixLine("Property 1 · 307 SARTHIK SQ", [], { span: true, note: "Sold to A · PAN AAAPA0000A · 33.33%" }),
      matrixLine("1", ["28 Jul 2023", 11875000]),
    ],
  }));
  assert.match(html, /<td class="m-l m-span" colspan="3">Property 1 · 307 SARTHIK SQ/);
  assert.match(html, /<div class="m-note">Sold to A · PAN AAAPA0000A · 33.33%<\/div>/);
  // The line under it is still positional against the headings.
  assert.match(html, /<td class="m-c text short">28 Jul 2023<\/td><td class="m-c num">1,18,75,000<\/td>/);
});

test("a schedule interrupts the working; the rows either side keep their own table", () => {
  // The capital gains section is a working with a schedule in the middle of it:
  // "here is the head, here is the property schedule, here is what it totals
  // to". The three-column rows before and after must still be rendered.
  const { html } = buildComputation(
    JSON.parse(readFileSync(path.join(FIXTURES, "itr3-landsale-54b-ay2024-25.json"), "utf8")), CTX
  );
  const card = html.slice(html.indexOf("Capital Gains</span>"));
  const upto = card.slice(0, card.indexOf('<div class="card">'));
  assert.match(upto, /<table class="rows">[\s\S]*Long-term capital gains[\s\S]*<\/table>[\s\S]*<div class="mtx">/);
  assert.match(upto, /<\/div>\s*<table class="rows">[\s\S]*Income chargeable under the head Capital Gains/);
});

test("a schedule wide enough to run off the page is stepped down, not truncated", () => {
  /* A4 gives 188mm of usable width whatever is in it. A property schedule states
     every figure the return holds for each sale — the raw cost beside the
     indexed one, the improvement beside its indexation, a column per section of
     exemption — and a return with four properties and two sections of relief
     runs to thirteen columns. Losing one to make the rest fit would be the worst
     answer: the reader cannot tell a column that was never there from a figure
     the return does not state. So the type steps down, and past thirteen the
     block is laid out at its natural width and scaled.

     Column COUNT is the only thing the renderer can judge this by without
     measuring, and the steps are pinned here because the failure they prevent —
     a table running off the right edge of a PDF — is invisible to every other
     test in the suite. */
  const build = (n) => renderMatrix(matrix("Sale of land", {
    columns: Array.from({ length: n }, (_, i) => ({ label: `C${i}` })),
    lines: [matrixLine("1", Array.from({ length: n }, () => 1000))],
  }));
  assert.match(build(6), /class="mtx"/);
  assert.match(build(7), /class="mtx wide"/);
  assert.match(build(9), /class="mtx xwide"/);
  assert.match(build(13), /class="mtx xwide xxwide"/);

  // …and every step has to be a rule somebody wrote, in EVERY theme, or the
  // class does nothing and the schedule runs off the page in one of them.
  for (const t of Object.values(THEMES)) {
    const css = t.stylesheet({});
    for (const cls of ["mtx.wide", "mtx.xwide", "mtx.xxwide"]) {
      assert.ok(css.includes(`.${cls} `), `the ${t.id} theme has no rule for .${cls}`);
    }
  }
});

/* ---------------- every schedule any fixture produces ---------------- */

test("on every fixture, a schedule's lines match its columns and its cells are sane", () => {
  /* A cell out of step with its heading is the one failure a schedule can have
     that looks like data rather than a bug: a figure printed under the wrong
     property is still a plausible figure. So the shape is checked everywhere. */
  let checked = 0;
  for (const file of files) {
    const { doc } = buildComputation(JSON.parse(readFileSync(path.join(FIXTURES, file), "utf8")), CTX);
    for (const s of doc.sections) {
      for (const m of s.rows.filter((r) => r.kind === "matrix")) {
        assert.ok(m.columns.length, `${file}: ${m.label} has no columns`);
        assert.ok(m.lines.length, `${file}: ${m.label} has no lines`);
        assert.equal(m.amount, null, "a matrix carries no single amount");
        for (const l of m.lines) {
          // A banner is one cell across the whole schedule and carries no
          // figures; every other line is positional against the headings.
          if (l.span) { assert.deepEqual(l.cells, [], `${file}: a banner carries no cells`); continue; }
          assert.equal(l.cells.length, m.columns.length, `${file}: "${l.label}" is out of step with its headings`);
          for (const c of l.cells) {
            assert.ok(c === null || typeof c === "number" || typeof c === "string",
              `${file}: "${l.label}" has a cell that is neither a figure, text nor blank`);
            if (typeof c === "number") assert.ok(Number.isFinite(c), `${file}: "${l.label}" has a non-finite figure`);
          }
        }
        checked++;
      }
    }
  }
  assert.ok(checked >= 6, `expected the fixtures to produce schedules, found ${checked}`);
});
