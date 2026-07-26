// Per-phase stopwatch for one PAN sync.
//
// The point is measurement, not decoration: several of the remaining tuning
// decisions (whether the PDF bucket needs moving to asia-south1, whether the
// per-document pacing is worth its cost) should be settled with real numbers
// from real practices rather than guesses. Every phase of the sync accumulates
// into a named bucket here, and the pool logs the breakdown when the PAN
// finishes.
//
// Buckets are additive, so a phase entered many times (one `notice-pdf` per
// document, say) reports its TOTAL share of the run.
"use strict";

function makeTimer() {
  const buckets = {};
  const t0 = Date.now();

  const add = (name, ms) => {
    buckets[name] = (buckets[name] || 0) + ms;
  };

  // Await `fn`, charging its wall time to `name`. Charges on throw too — a slow
  // failure is exactly the thing we want to see in the breakdown.
  const time = async (name, fn) => {
    const started = Date.now();
    try {
      return await fn();
    } finally {
      add(name, Date.now() - started);
    }
  };

  const report = () => {
    const total = Date.now() - t0;
    const line = Object.entries(buckets)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`)
      .join(", ");
    return { totalMs: total, buckets: { ...buckets }, line };
  };

  return { add, time, report };
}

module.exports = { makeTimer };
