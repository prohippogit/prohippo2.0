/* ProHippo — the shared "curvy" PDF theme.
 *
 * The soft look every document this practice sends out is set in: rounded
 * panels, pill chips, a rounded-header table, Poppins throughout. It was
 * written for the ledger and extracted here when the cause list needed the
 * same treatment — a second copy of a brand drifts from the first the week
 * after it is written, and these are documents clients see.
 *
 * Nothing here knows which document it is drawing. Each builder brings its own
 * content and calls these for the frame around it.
 */
import { jsPDF } from "jspdf";
import { registerFonts, resolveWeight } from "./invoicePdf.js";
import { alignedX } from "./pdfText.js";

export const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
};
export const today = () => {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
};

/* ---- colour helpers ---- */
export const hexToRgb = (hex, fallback = [108, 92, 231]) => {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || "").trim());
  if (!m) return fallback.slice();
  const int = parseInt(m[1], 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
};
export const tint = (rgb, t) => rgb.map((c) => Math.round(c + (255 - c) * t));
export const readable = (rgb) => (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] > 150 ? [20, 19, 43] : [255, 255, 255]);

export const INK = [26, 24, 46];
export const BODY = [64, 60, 92];
export const MUTED = [138, 135, 160];
export const LINE = [230, 228, 240];
export const DEBIT = [193, 51, 120];
export const CREDIT = [26, 140, 92];

/* Build a jsPDF doc with Poppins registered and a small set of drawing
   helpers bound to it. */
export function themedDoc() {
  const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
  registerFonts(doc);
  const text = (str, x, y, { size = 9, weight, bold, color = BODY, align = "left", spacing } = {}) => {
    doc.setFont(...resolveWeight(weight, bold));
    doc.setFontSize(size);
    doc.setTextColor(...color);
    const s = String(str ?? "");
    /* Tracked text is aligned here, not by jsPDF — see pdfText.js. */
    const ax = alignedX(doc, s, x, align, spacing);
    if (ax === null) doc.text(s, x, y, { align, charSpace: spacing, baseline: "alphabetic" });
    else doc.text(s, ax, y, { charSpace: spacing, baseline: "alphabetic" });
  };
  const wrap = (str, w, size, weight) => {
    doc.setFont(...resolveWeight(weight, false));
    doc.setFontSize(size);
    return doc.splitTextToSize(String(str || ""), w);
  };
  const rrect = (x, y, w, h, r, style = "F", color) => {
    if (style.includes("F")) doc.setFillColor(...(color || [255, 255, 255]));
    doc.roundedRect(x, y, w, h, r, r, style);
  };
  const stroke = (color = LINE, w = 0.3) => { doc.setDrawColor(...color); doc.setLineWidth(w); };
  const line = (x1, y1, x2, y2, color = LINE, w = 0.3) => { stroke(color, w); doc.line(x1, y1, x2, y2); };
  const measure = (str, size, weight) => { doc.setFont(...resolveWeight(weight, false)); doc.setFontSize(size); return doc.getTextWidth(String(str)); };
  return { doc, text, wrap, rrect, line, measure };
}

// Trim a single-line string to fit `w` mm, adding an ellipsis when clipped.
export function clipText(ctx, str, w, size, weight) {
  const s = String(str || "");
  if (ctx.measure(s, size, weight) <= w) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measure(s.slice(0, mid) + "…", size, weight) <= w) lo = mid; else hi = mid - 1;
  }
  return s.slice(0, lo).trimEnd() + "…";
}

/* Shared header band for both ledgers & receipts. Returns the y below it. */
export function drawBrandHeader(ctx, { profile, cfg, accent, title, subtitle = "STATEMENT OF ACCOUNT" }) {
  const { text, wrap, rrect } = ctx;
  const L = 14, R = 196;
  const accentSoft = tint(accent, 0.88);
  const firmName = (cfg.firmName || profile?.firmName || profile?.ownerName || "Your Firm").trim();
  const firmAddress = (cfg.firmAddress || profile?.firmAddress || "").trim();
  const firmGstin = (cfg.firmGstin || "").trim();
  const firmPhone = (cfg.firmPhone || profile?.firmMobile || profile?.phone || "").trim();
  const firmEmail = (cfg.firmEmail || profile?.email || "").trim();

  let y = 16;
  const mark = 13;
  rrect(L, y - 2, mark, mark, 3.5, "F", accentSoft);
  text((firmName[0] || "F").toUpperCase(), L + mark / 2, y + mark / 2 - 0.5, { size: 12, weight: "extrabold", color: accent, align: "center" });

  const hx = L + mark + 5;
  let hy = y + 1;
  text(firmName, hx, hy, { size: 13, weight: "bold", color: INK });
  hy += 4.3;
  if (firmAddress) wrap(firmAddress, 90, 7.6).forEach((ln) => { text(ln, hx, hy, { size: 7.6, color: MUTED }); hy += 3.2; });
  const line2 = [firmGstin ? `GSTIN: ${firmGstin}` : "", firmPhone, firmEmail].filter(Boolean).join("   ·   ");
  if (line2) { text(line2, hx, hy, { size: 7.6, weight: "medium", color: BODY }); hy += 3.4; }

  // right: title wordmark
  text(title, R, y + 4, { size: 22, weight: "extrabold", color: accent, align: "right", spacing: -0.2 });
  text(subtitle, R, y + 9, { size: 6.6, weight: "semibold", color: MUTED, align: "right", spacing: 0.6 });

  y = Math.max(hy, y + 12) + 3;
  ctx.line(L, y, R, y, accent, 0.9);
  return y + 7;
}

/* Shared page footer on every page. */
export function drawFooter(ctx, { cfg, profile }) {
  const { doc, text, line } = ctx;
  const L = 14, R = 196, PAGE_H = 297;
  const firmEmail = (cfg.firmEmail || profile?.email || "").trim();
  const firmPhone = (cfg.firmPhone || profile?.firmMobile || profile?.phone || "").trim();
  const n = doc.internal.getNumberOfPages();
  for (let p = 1; p <= n; p++) {
    doc.setPage(p);
    line(L, PAGE_H - 13, R, PAGE_H - 13, LINE, 0.3);
    const contact = [firmEmail, firmPhone].filter(Boolean).join("   ·   ");
    if (contact) text(contact, L, PAGE_H - 8, { size: 7, color: MUTED });
    text(`Page ${p} of ${n}  |  Generated by ProHippo`, R, PAGE_H - 8, { size: 7, color: MUTED, align: "right" });
  }
}

