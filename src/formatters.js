/* ProHippo — the formatters, as plain functions.
 *
 * These used to live in shared.jsx alongside the components that use them,
 * which was fine until a PURE module needed them too: src/messageTemplates.js
 * renders a client's letter with no React in sight, and importing shared.jsx
 * drags a whole component library — and JSX syntax — behind it. `node --test`
 * cannot parse JSX at all, so every test of a module downstream of shared.jsx
 * died on a parse error before a single assertion ran.
 *
 * So the formatters live here, in plain .js, and shared.jsx re-exports them for
 * the hundreds of existing imports. Nothing had to change at any call site.
 * Same reasoning as src/appeals.js and src/intimations.js: the pure layer must
 * be importable without a bundler.
 */

/** "rajesh m. shah" → "Rajesh M. Shah". Handles the separators Indian names
 *  actually use, apostrophes and full stops included. */
export const titleCase = (s) =>
  (s || "").toLowerCase().replace(/(^|[\s\-'./])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());

/** Indian digit grouping: ₹1,24,560, not ₹124,560. */
export const fmtINR = (n) => "₹" + new Intl.NumberFormat("en-IN").format(n);

export const fmtLakhs = (n) => {
  if (n >= 10000000) return "₹" + (n / 10000000).toFixed(2).replace(/\.?0+$/, "") + "Cr";
  if (n >= 100000) return "₹" + (n / 100000).toFixed(2).replace(/\.?0+$/, "") + "L";
  return fmtINR(n);
};

export const fmtDate = (iso) => {
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
};

export const fmtDateLong = (iso) => {
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

// Date + time, e.g. "23 Jul 2026, 2:18 PM" — for "last synced at" displays.
export const fmtDateTime = (iso) => {
  const d = new Date(iso);
  return d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });
};
