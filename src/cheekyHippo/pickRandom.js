/*
 * ProHippo — tiny no-repeat random picker.
 *
 * Pure and dependency-free so it's trivial to unit-test (see pickRandom.test.mjs).
 * Given a list and the item that was shown last, it returns a random item that
 * isn't that same one — unless the list has 0 or 1 entries, where there's no
 * other choice. The `rng` is injectable so tests can make it deterministic.
 */

/**
 * Pick a random element from `items` that is not `previous`.
 *
 * @template T
 * @param {T[]} items       Candidate values.
 * @param {T|null|undefined} previous  The value shown last (avoided if possible).
 * @param {() => number} [rng]  Returns a float in [0, 1). Defaults to Math.random.
 * @returns {T|undefined}   A pick, or undefined when `items` is empty.
 */
export function pickNoRepeat(items, previous, rng = Math.random) {
  if (!Array.isArray(items) || items.length === 0) return undefined;
  if (items.length === 1) return items[0];

  // Drop the previous pick so we never repeat back-to-back. If everything in
  // the list equals `previous` (e.g. a list of duplicates), fall back to the
  // full list so we still return something.
  const pool = previous == null ? items : items.filter((x) => x !== previous);
  const source = pool.length ? pool : items;

  // Math.min guards the (rare) rng() === 1 case so the index stays in range.
  const idx = Math.min(source.length - 1, Math.floor(rng() * source.length));
  return source[idx];
}
