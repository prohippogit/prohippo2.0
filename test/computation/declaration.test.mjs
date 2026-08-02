/*
 * The standing declaration — on every computation, of every form, of every year.
 *
 *   node --test test/computation/declaration.test.mjs
 *
 * A computation restates a filed return. It is not a certificate, not an audit
 * report and not advice, and the person holding the printed copy is often the
 * assessee rather than the practitioner who generated it. So the document says
 * so on its own face.
 *
 * This test walks every fixture in the repository rather than naming a list,
 * which is the point: a form or a year added later cannot quietly ship without
 * the declaration, because the fixture that proves it works also proves this.
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

const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).sort();

test("there are fixtures to walk", () => {
  // A guard on the guard: if the glob ever stops matching, the loop below would
  // pass by doing nothing at all.
  assert.ok(files.length >= 12, `expected the fixture set, found ${files.length}`);
});

for (const file of files) {
  test(`${file.replace(/\.json$/, "")} carries the declaration`, () => {
    const { html } = buildComputation(JSON.parse(readFileSync(path.join(FIXTURES, file), "utf8")), CTX);

    assert.match(html, /class="declaration"/);
    assert.match(html, /summary reference generated from the return data \(JSON\)/);
    assert.match(html, /not a certificate, an audit report or tax advice/);
    assert.match(html, /take the advice of a tax practitioner before relying upon it/);

    // It belongs to the document, not to a section: it must survive whatever
    // heads this particular return happens to have, and sit after the notes and
    // the signature rather than inside them.
    assert.ok(html.indexOf('class="declaration"') > html.indexOf('class="sign"'));
  });
}

test("the declaration is not a per-form note that a new mapper could forget", () => {
  const { doc, html } = buildComputation(JSON.parse(readFileSync(path.join(FIXTURES, files[0]), "utf8")), CTX);
  // It comes from the renderer, which §2 keeps as one shared thing, so it is
  // impossible to add a form or a year without it. Nothing in doc.notes carries
  // it — those are facts about THIS return, and a reader should not have to work
  // out which bullet is a standing term and which is a finding.
  assert.ok(!doc.notes.some((n) => /tax practitioner/i.test(n.text)));
  assert.match(html, /take the advice of a tax practitioner/);
});
