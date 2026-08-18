/* A pass's share of a sync, and the arithmetic that keeps it.
 *
 *   node --test test/syncBudget.test.mjs
 *
 * The reported fault this is written against: the filed-Form-35 pass could spend
 * the whole per-PAN deadline on one form, so the passes behind it never ran, and
 * nothing anywhere said so. Every call had a deadline; nothing owned the sum of
 * them.
 *
 * The clock is injected, so these run in no time at all rather than in minutes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { makeBudget } = require("../connector/src/main/syncBudget.js");

// A clock the test moves by hand.
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, tick: (ms) => { t += ms; }, at: () => t };
}

test("a budget is spent by the passing of time, and never goes negative", () => {
  const c = clock();
  const b = makeBudget(60000, { now: c.now });
  assert.equal(b.left(), 60000);
  assert.equal(b.expired(), false);
  c.tick(45000);
  assert.equal(b.left(), 15000);
  assert.equal(b.enoughFor(15000), true, "exactly enough is enough");
  assert.equal(b.enoughFor(15001), false);
  c.tick(20000);
  assert.equal(b.left(), 0, "not -5000");
  assert.equal(b.expired(), true);
});

test("`notAfter` is a wall the budget's own size cannot get past", () => {
  // The case this exists for: six minutes of appeals budget, but the PAN is
  // given up on in four, and three of those are reserved for the returns pass.
  const c = clock();
  const b = makeBudget(6 * 60000, { now: c.now, notAfter: c.at() + 60000 });
  assert.equal(b.left(), 60000, "the wall wins, not the size");
});

test("a budget with its wall already behind it is born expired", () => {
  /* Which is the right answer, not an edge case: with the PAN's deadline all but
     gone there is no point starting a Form 35 that will be cut off mid-render.
     The pass stops, says how many it did not reach, and the next sync has them
     — see appealFormsPending in syncKnowns.js. */
  const c = clock();
  const b = makeBudget(6 * 60000, { now: c.now, notAfter: c.at() - 1 });
  assert.equal(b.expired(), true);
  assert.equal(b.left(), 0);
  assert.equal(b.enoughFor(1), false);
});

test("a slice is one item's share, and never more than the pass has left", () => {
  const c = clock();
  const pass = makeBudget(300000, { now: c.now }); // five minutes
  const first = pass.slice(120000);
  assert.equal(first.left(), 120000, "two minutes for the first form");

  c.tick(240000); // four minutes gone; one left
  const last = pass.slice(120000);
  assert.equal(last.left(), 60000, "a slice cannot borrow time the pass has not got");
  assert.equal(pass.expired(), false);

  c.tick(60000);
  assert.equal(pass.expired(), true);
  assert.equal(pass.slice(120000).left(), 0, "and an exhausted pass slices nothing");
});

test("spending a slice does not stop the parent's clock, or the other way round", () => {
  // Four forms of two minutes each cannot come out of a six-minute pass. The
  // parent is the one that decides when the pass is over.
  const c = clock();
  const pass = makeBudget(360000, { now: c.now });
  let started = 0;
  for (let i = 0; i < 4; i++) {
    if (pass.expired()) break;
    started++;
    const form = pass.slice(120000);
    c.tick(form.left()); // each form takes every second it is given
  }
  assert.equal(started, 3, "three fit; the fourth is left for the next sync");
  assert.equal(pass.expired(), true);
});
