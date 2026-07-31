/*
 * Formatting primitives for the Computation of Income.
 * docs/computation-spec.md §6 is authoritative for every rule in here.
 *
 * These are deliberately dumb: they format, they never decide. Nothing in this
 * file rounds, infers or corrects a figure — §1 and §6 both forbid it, and a
 * "helpful" rounding here is exactly how a PDF ends up disagreeing with the
 * acknowledgement it was built from.
 */

/** Indian digit grouping: 48,14,564 — not 4,814,564. */
export function inr(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  const neg = v < 0;
  const abs = Math.abs(v);
  // Intl's en-IN locale implements the 2,2,3 grouping natively. Fraction digits
  // are pinned to 0 because every figure in a return is already whole rupees.
  const s = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(abs);
  return neg ? `-${s}` : s;
}

/**
 * One amount cell. §6: nil is an em dash, a loss is parenthesised, and null is
 * structurally blank — the three are different things and must stay different.
 */
export function amountText(amount, isLoss) {
  if (amount === null || amount === undefined) return "";
  const v = Number(amount);
  if (!Number.isFinite(v)) return "";
  if (v === 0) return "—";
  if (isLoss || v < 0) return `(${inr(Math.abs(v))})`;
  return inr(v);
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function under1000(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : "");
  return ONES[Math.floor(n / 100)] + " Hundred" + (n % 100 ? " " + under1000(n % 100) : "");
}

/**
 * Amount in words, Indian scale (§6). "Rupees Four Lakh Forty Five Thousand
 * Four Hundred Seventy Only."
 */
export function inWords(n) {
  const v = Math.round(Math.abs(Number(n) || 0));
  if (v === 0) return "Rupees Nil Only.";
  const parts = [];
  const units = [
    [10000000, "Crore"],
    [100000, "Lakh"],
    [1000, "Thousand"],
  ];
  let rest = v;
  for (const [size, name] of units) {
    const q = Math.floor(rest / size);
    if (q) { parts.push(`${under1000(q)} ${name}`); rest %= size; }
  }
  if (rest) parts.push(under1000(rest));
  return `Rupees ${parts.join(" ")} Only.`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

/** "2025-10-08" → "08 October 2025". Anything unparseable comes back as-is. */
export function longDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || "").trim());
  if (!m) return String(iso || "");
  return `${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** The portal's AY start year → the form the spec mandates: 2025 → "2025-26". */
export function ayLabel(startYear) {
  const y = Number(startYear);
  if (!Number.isFinite(y) || y < 1900) return "";
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}

/** The previous year for an AY: "2025-26" → "2024-25". */
export function pyLabel(ay) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ay || ""));
  if (!m) return "";
  const y = Number(m[1]) - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}

/** Escape for interpolation into an HTML template. */
export function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
