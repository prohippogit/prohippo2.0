/*
 * The table the Returns tab reads, against the mappers that actually exist.
 *
 * The tab cannot import the mappers to find out what is supported — the whole
 * generator is code-split behind a dynamic import — so it reads a small table
 * instead. Two copies of one fact drift, and the direction they drift in matters:
 * a table that claims too little hides a year that works behind "coming soon",
 * and one that claims too much puts a button in front of a practitioner that
 * cannot produce anything. This test is what stops both.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { SUPPORTED as FROM_MAPPERS } from "../../src/computation/index.js";
import { SUPPORTED, computationAvailability, formKey } from "../../src/computation/supported.js";

test("the table matches the mappers, form for form and year for year", () => {
  assert.deepEqual(SUPPORTED, FROM_MAPPERS);
});

test("a form and year with a mapper offers the button", () => {
  for (const [form, years] of Object.entries(SUPPORTED)) {
    for (const ay of years) {
      assert.equal(computationAvailability(form.replace("ITR", "ITR-"), ay).ok, true, `${form} ${ay}`);
    }
  }
});

test("a form with no mapper says so, and says what there is instead", () => {
  const { ok, reason } = computationAvailability("ITR-4", "2025-26");
  assert.equal(ok, false);
  assert.match(reason, /ITR-4 isn't built yet/);
  assert.match(reason, /ITR-2, ITR-3 and ITR-5/, "tell the practitioner what does work");
});

test("a supported form in an unsupported year names the years that are supported", () => {
  const { ok, reason } = computationAvailability("ITR-2", "2019-20");
  assert.equal(ok, false);
  assert.match(reason, /A\.Y\. 2025-26 only/);
  // §9: never fall back to the nearest year. The reason says why, because a
  // practitioner who does not know that will read "coming soon" as laziness.
  assert.match(reason, /looks right and is wrong/);
});

test("a form supported for several years lists them all, not just the newest", () => {
  // ITR-3 covers two years. Naming only one would send a practitioner to the
  // portal for a computation the app can already produce.
  const { ok, reason } = computationAvailability("ITR-3", "2019-20");
  assert.equal(ok, false);
  assert.match(reason, /2025-26/);
  assert.match(reason, /2024-25/);
});

test("an unknown form is offered rather than refused", () => {
  // The form code is missing on some synced years. Which form it is becomes
  // certain only when the JSON is read, and detect() raises a plain sentence of
  // its own if there is no mapper — so refusing here would hide a year that works.
  assert.equal(computationAvailability("", "2025-26").ok, true);
  assert.equal(computationAvailability(undefined, "2025-26").ok, true);
});

test("the form code is read the way the return stores it, and the way it doesn't", () => {
  assert.equal(formKey("ITR-3"), "ITR3");
  assert.equal(formKey("ITR3"), "ITR3");
  assert.equal(formKey("itr 3"), "ITR3");
  assert.equal(formKey("Form 3"), "ITR3");
  assert.equal(formKey(""), "");
});
