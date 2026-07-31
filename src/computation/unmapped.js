/*
 * The non-zero-leaf walker — docs/computation-spec.md §8.
 *
 * After a mapper runs we walk the source JSON and collect every numeric leaf
 * with a non-zero value whose path the mapper did not consume. Those go into
 * doc.unmapped, which the PDF surfaces in an amber "Items requiring review"
 * block and the tests treat as a failure.
 *
 * The failure this exists to prevent is a head of income silently vanishing
 * from a document a client signs. Loud and slightly ugly beats quiet and wrong.
 */
import { isIgnored } from "./ignore-paths.js";

/**
 * @param body     the form body from detect()
 * @param consumed a Set of dotted paths the mapper read
 * @returns [{ path, value }] sorted by descending value — biggest omissions first
 */
export function findUnmapped(body, consumed) {
  const out = [];

  const walk = (node, path) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
      return;
    }
    // Leaf. Only numbers matter: a stray string is a name or a code, and
    // omitting one from a computation is not the failure mode we're guarding.
    const n = typeof node === "number" ? node : NaN;
    if (!Number.isFinite(n) || n === 0) return;
    if (consumed.has(path)) return;
    if (isIgnored(path)) return;
    out.push({ path, value: n });
  };

  walk(body, "");
  return out.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
}

/**
 * A recorder a mapper threads through its reads, so consuming a path and using
 * its value are the same act.
 *
 * The alternative — maintaining a separate list of "paths I read" alongside the
 * code that reads them — drifts the moment anyone edits a mapper, and drifts
 * silently, which is the one thing §8 is trying to make impossible.
 *
 *     const src = reader(body);
 *     const netProfit = src.num("CorpScheduleBP.BusinessIncOthThanSpec.NetPLBusOthThanSpec7A7B7C");
 */
export function reader(body) {
  const consumed = new Set();

  const at = (path) => {
    let node = body;
    for (const part of String(path).split(".")) {
      const m = /^(.+?)\[(\d+)\]$/.exec(part);
      if (m) {
        node = node && node[m[1]];
        node = node && node[Number(m[2])];
      } else {
        node = node && node[part];
      }
      if (node === undefined || node === null) return undefined;
    }
    return node;
  };

  return {
    consumed,

    /** Read a numeric leaf and mark it consumed. Missing → 0. */
    num(path) {
      consumed.add(path);
      const v = at(path);
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    },

    /** Read a leaf without coercing. Marks it consumed. */
    val(path) {
      consumed.add(path);
      return at(path);
    },

    /** Read a subtree without marking anything — for arrays walked by hand. */
    peek: at,

    /**
     * Mark paths consumed that restate a figure the mapper has already taken.
     *
     * A return reports the same number at several points as it works down to a
     * total — Schedule BP arrives at its loss over five successive fields, and
     * Part B-TI restates Schedule OS's own total. Those are not omissions, and
     * letting them pile up in `unmapped` would drown the one entry that IS an
     * omission. Listing them here is deliberate and reviewable, which a blanket
     * subtree ignore would not be: a genuinely new field in the same schedule
     * still surfaces.
     */
    restate(paths) {
      for (const p of paths) consumed.add(p);
    },

    /** Mark a whole subtree consumed, e.g. an array the mapper itemised itself. */
    claim(path) {
      const node = at(path);
      const mark = (n, p) => {
        consumed.add(p);
        if (Array.isArray(n)) n.forEach((v, i) => mark(v, `${p}[${i}]`));
        else if (n && typeof n === "object") for (const [k, v] of Object.entries(n)) mark(v, `${p}.${k}`);
      };
      mark(node, path);
      return node;
    },
  };
}
