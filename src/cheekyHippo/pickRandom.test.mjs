/*
 * Unit tests for pickNoRepeat — runnable with zero dependencies:
 *   node src/cheekyHippo/pickRandom.test.mjs
 *
 * The repo has no test runner configured, so this uses node:assert directly.
 * If a runner (vitest/jest) is added later, these asserts port over unchanged.
 */
import assert from "node:assert/strict";
import { pickNoRepeat } from "./pickRandom.js";

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("  ✓", name); };

// A deterministic rng that walks through a fixed sequence of floats.
const seq = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };

test("returns undefined for empty / non-array input", () => {
  assert.equal(pickNoRepeat([], "x"), undefined);
  assert.equal(pickNoRepeat(null, "x"), undefined);
});

test("single-item list always returns that item", () => {
  assert.equal(pickNoRepeat(["only"], "only"), "only");
});

test("never repeats the previous pick", () => {
  const items = ["a", "b", "c"];
  // rng 0 would normally select index 0 ("a"); with previous "a" filtered out,
  // the pool is ["b","c"] and index 0 is "b".
  assert.equal(pickNoRepeat(items, "a", seq(0)), "b");
});

test("honours the rng index within the filtered pool", () => {
  const items = ["a", "b", "c"];
  // previous "b" → pool ["a","c"]; rng 0.99 → last element "c".
  assert.equal(pickNoRepeat(items, "b", seq(0.99)), "c");
});

test("previous == null picks from the whole list", () => {
  assert.equal(pickNoRepeat(["a", "b", "c"], null, seq(0.5)), "b");
});

test("rng() === 1 stays in range (no undefined)", () => {
  assert.equal(pickNoRepeat(["a", "b"], null, () => 1), "b");
});

test("over many draws, consecutive picks are always different", () => {
  const items = ["a", "b", "c", "d"];
  let prev = null;
  const rng = seq(0.1, 0.4, 0.7, 0.95, 0.2, 0.6, 0.85, 0.33);
  for (let i = 0; i < 50; i++) {
    const next = pickNoRepeat(items, prev, rng);
    assert.notEqual(next, prev);
    prev = next;
  }
});

console.log(`\npickNoRepeat: ${passed} tests passed`);
