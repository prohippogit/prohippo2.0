/* ProHippo — client-side vector PDF invoice generation (jsPDF).
   Text is real vector type using an embedded subset of the Poppins family
   (Regular / Medium / SemiBold / Bold / ExtraBold / Italic) that includes
   the rupee sign, so the PDF stays crisp at any zoom and matches the
   reference invoice's typography.

   The layout is a full GST tax invoice (multiple line items, HSN/SAC,
   per-item GST, CGST/SGST or IGST split, bank details, terms & notes),
   fully driven by a configurable accent colour and invoice settings.
   GST can be switched off for a plain (non-GST) bill. */
import { jsPDF } from "jspdf";
import {
  POPPINS_REGULAR, POPPINS_MEDIUM, POPPINS_SEMIBOLD,
  POPPINS_BOLD, POPPINS_EXTRABOLD, POPPINS_ITALIC,
} from "./fonts/invoiceFonts.js";

/* jsPDF addresses fonts by (family, style); we register the extra Poppins
   weights as their own families and resolve a friendly weight name to the
   right (family, style) pair. */
const FONT_FAMILY = "Poppins";
const registerFonts = (doc) => {
  const add = (b64, file, family, style) => {
    doc.addFileToVFS(file, b64);
    doc.addFont(file, family, style);
  };
  add(POPPINS_REGULAR, "Poppins-Regular.ttf", FONT_FAMILY, "normal");
  add(POPPINS_BOLD, "Poppins-Bold.ttf", FONT_FAMILY, "bold");
  add(POPPINS_ITALIC, "Poppins-Italic.ttf", FONT_FAMILY, "italic");
  add(POPPINS_MEDIUM, "Poppins-Medium.ttf", "PoppinsMedium", "normal");
  add(POPPINS_SEMIBOLD, "Poppins-SemiBold.ttf", "PoppinsSemiBold", "normal");
  add(POPPINS_EXTRABOLD, "Poppins-ExtraBold.ttf", "PoppinsExtraBold", "normal");
};
const WEIGHTS = {
  regular: [FONT_FAMILY, "normal"],
  medium: ["PoppinsMedium", "normal"],
  semibold: ["PoppinsSemiBold", "normal"],
  bold: [FONT_FAMILY, "bold"],
  extrabold: ["PoppinsExtraBold", "normal"],
  italic: [FONT_FAMILY, "italic"],
};
// Legacy `bold` boolean → weight name; an explicit `weight` always wins.
const resolveWeight = (weight, bold) => WEIGHTS[weight] || (bold ? WEIGHTS.bold : WEIGHTS.regular);

/* ---------------- money / number helpers ---------------- */

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const fmtNum = (n) =>
  new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0);
export const fmtRupee = (n) => "₹" + fmtNum(n);
const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getFullYear()}`;
};

/* ---------------- amount in words (Indian system) ---------------- */

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "Ten", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
const two = (n) => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : ""));
const three = (n) => {
  const h = Math.floor(n / 100), r = n % 100;
  return (h ? ONES[h] + " Hundred" + (r ? " " : "") : "") + (r ? two(r) : "");
};

/* Indian-system amount in words: crores, lakhs, thousands. */
export function amountInWords(amount) {
  const n = Math.floor(Math.abs(amount));
  const paise = Math.round((Math.abs(amount) - n) * 100);
  const parts = [];
  const crore = Math.floor(n / 1e7);
  const lakh = Math.floor((n % 1e7) / 1e5);
  const thousand = Math.floor((n % 1e5) / 1e3);
  const rest = n % 1e3;
  if (crore) parts.push(three(crore) + " Crore");
  if (lakh) parts.push(two(lakh) + " Lakh");
  if (thousand) parts.push(two(thousand) + " Thousand");
  if (rest) parts.push(three(rest));
  let words = "Rupees " + (parts.join(" ") || "Zero");
  if (paise) words += " and " + two(paise) + " Paise";
  return words + " Only";
}

/* ---------------- shared totals engine ---------------- */

/* Normalise an invoice's line items. Older invoices stored a single
   `service` + `amount`; treat that as one line so everything keeps working. */
export function invoiceItems(invoice) {
  if (Array.isArray(invoice?.items) && invoice.items.length) {
    return invoice.items.map((it) => ({
      description: it.description || "",
      note: it.note || "",
      hsn: it.hsn || "",
      qty: Number(it.qty) || 0,
      rate: Number(it.rate) || 0,
      gst: Number(it.gst) || 0,
    }));
  }
  return [{
    description: invoice?.service || "Professional fees",
    note: invoice?.ay ? `AY ${invoice.ay}` : "",
    hsn: invoice?.hsn || "",
    qty: 1,
    rate: Number(invoice?.amount) || 0,
    gst: 0,
  }];
}

/* The single source of truth for every rupee shown on screen and in the PDF. */
export function computeInvoiceTotals(invoice) {
  const gstEnabled = invoice?.gstEnabled !== false && (invoice?.gstEnabled === true || Array.isArray(invoice?.items));
  const gstType = invoice?.gstType === "IGST" ? "IGST" : "CGST_SGST";
  const rows = invoiceItems(invoice).map((it) => {
    const taxable = round2(it.qty * it.rate);
    const gst = gstEnabled ? it.gst : 0;
    const taxAmt = round2((taxable * gst) / 100);
    const half = round2(taxAmt / 2);
    return {
      ...it,
      taxable,
      gstRate: gst,
      taxAmt,
      cgst: gstType === "CGST_SGST" ? half : 0,
      sgst: gstType === "CGST_SGST" ? round2(taxAmt - half) : 0,
      igst: gstType === "IGST" ? taxAmt : 0,
      total: round2(taxable + taxAmt),
    };
  });
  const subTotal = round2(rows.reduce((s, r) => s + r.taxable, 0));
  const cgst = round2(rows.reduce((s, r) => s + r.cgst, 0));
  const sgst = round2(rows.reduce((s, r) => s + r.sgst, 0));
  const igst = round2(rows.reduce((s, r) => s + r.igst, 0));
  const taxTotal = round2(cgst + sgst + igst);
  const preRound = round2(subTotal + taxTotal);
  const grandTotal = Math.round(preRound);
  const roundOff = round2(grandTotal - preRound);
  return { gstEnabled, gstType, rows, subTotal, cgst, sgst, igst, taxTotal, roundOff, grandTotal, preRound };
}

/* ---------------- colour helpers ---------------- */

const hexToRgb = (hex, fallback = [225, 29, 72]) => {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || "").trim());
  if (!m) return fallback.slice();
  const int = parseInt(m[1], 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
};
// Mix a colour toward white by `t` (0 = colour, 1 = white).
const tint = (rgb, t) => rgb.map((c) => Math.round(c + (255 - c) * t));
// Perceived luminance — pick black/white text over a fill.
const readable = (rgb) => (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] > 150 ? [20, 19, 43] : [255, 255, 255]);

const INK = [26, 24, 46];
const BODY = [64, 60, 92];
const MUTED = [138, 135, 160];
const LINE = [230, 228, 240];

/* ---------------- PDF builder ---------------- */

export function buildInvoicePDF({ invoice, assessee, profile, settings } = {}) {
  const cfg = { ...(profile?.invoiceSettings || {}), ...(settings || {}) };
  const accent = hexToRgb(cfg.accent, [225, 29, 72]);
  const accentSoft = tint(accent, 0.88);
  const accentText = readable(accent);
  const panelBg = [248, 247, 251];

  const t = computeInvoiceTotals(invoice);

  const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
  registerFonts(doc);

  const PAGE_H = 297;
  const L = 14, R = 196, W = R - L;

  const text = (str, x, y, { size = 9, bold = false, weight, color = BODY, align = "left", spacing } = {}) => {
    doc.setFont(...resolveWeight(weight, bold));
    doc.setFontSize(size);
    doc.setTextColor(...color);
    doc.text(String(str ?? ""), x, y, { align, charSpace: spacing, baseline: "alphabetic" });
  };
  const fillRect = (x, y, w, h, color, r = 0) => {
    doc.setFillColor(...color);
    if (r > 0) doc.roundedRect(x, y, w, h, r, r, "F");
    else doc.rect(x, y, w, h, "F");
  };
  const line = (x1, y1, x2, y2, color = LINE, w = 0.3) => {
    doc.setDrawColor(...color);
    doc.setLineWidth(w);
    doc.line(x1, y1, x2, y2);
  };
  // Wrap text to a width, returning the array of lines. The measuring font must
  // match the font the caller will draw with, so pass the same weight.
  const wrap = (str, w, size, weight) => {
    doc.setFont(...resolveWeight(weight, false));
    doc.setFontSize(size);
    return doc.splitTextToSize(String(str || ""), w);
  };

  /* ---- firm / customer details ---- */
  const firmName = (cfg.firmName || profile?.firmName || profile?.ownerName || "Your Firm").trim();
  const firmAddress = (cfg.firmAddress || profile?.firmAddress || "").trim();
  const firmPhone = (cfg.firmPhone || profile?.firmMobile || profile?.phone || "").trim();
  const firmEmail = (cfg.firmEmail || profile?.email || "").trim();
  const firmGstin = (cfg.firmGstin || "").trim();

  const custName = invoice?.customerName || invoice?.assessee || assessee?.name || "—";
  const custAddress = invoice?.customerAddress || assessee?.address || "";
  const custGstin = invoice?.customerGstin || assessee?.gstin || "";
  const custPan = assessee?.pan || "";

  const status = (t.grandTotal > 0 && (invoice?.received || 0) >= t.grandTotal) ? "PAID"
    : ((invoice?.received || 0) > 0 ? "PART PAID" : "UNPAID");
  const statusColor = status === "PAID" ? [22, 163, 74] : status === "PART PAID" ? [217, 119, 6] : accent;

  /* ================= HEADER ================= */
  let y = 16;
  // firm mark
  const markSize = 13;
  fillRect(L, y - 2, markSize, markSize, accentSoft, 2.5);
  text((firmName[0] || "F").toUpperCase(), L + markSize / 2, y + markSize / 2 - 0.5, { size: 12, weight: "extrabold", color: accent, align: "center" });

  const hx = L + markSize + 5;
  let hy = y + 1;
  text(firmName, hx, hy, { size: 13.5, weight: "bold", color: INK });
  hy += 4.4;
  if (firmAddress) {
    wrap(firmAddress, 78, 7.6).forEach((ln) => { text(ln, hx, hy, { size: 7.6, color: MUTED }); hy += 3.3; });
  }
  if (firmGstin) { text(`GSTIN: ${firmGstin}`, hx, hy, { size: 7.8, weight: "semibold", color: BODY }); hy += 3.4; }
  if (firmPhone) { text(`Ph: ${firmPhone}`, hx, hy, { size: 7.6, color: MUTED }); hy += 3.3; }
  if (firmEmail) { text(firmEmail, hx, hy, { size: 7.6, color: MUTED }); hy += 3.3; }

  // right: big "Invoice" wordmark + meta
  text("Invoice", R, y + 4, { size: 30, weight: "extrabold", color: accent, align: "right", spacing: -0.3 });
  let my = y + 11;
  const metaRow = (label, value) => {
    // value right-aligned at R; label sits just to its left so long numbers never collide.
    doc.setFont(...resolveWeight("bold"));
    doc.setFontSize(9);
    const vw = doc.getTextWidth(String(value));
    text(label, R - vw - 3, my, { size: 7, weight: "semibold", color: MUTED, align: "right", spacing: 0.3 });
    text(value, R, my, { size: 9, weight: "bold", color: INK, align: "right" });
    my += 5;
  };
  metaRow("INVOICE #", invoice?.number || "—");
  metaRow("DATE", fmtDate(invoice?.date));
  // status chip
  const chipW = 22, chipH = 5.6;
  fillRect(R - chipW, my - 0.5, chipW, chipH, tint(statusColor, 0.82), 2.8);
  text(status, R - chipW / 2, my + 3.4, { size: 7, weight: "semibold", color: statusColor, align: "center", spacing: 0.4 });

  y = Math.max(hy, my + 8) + 3;
  line(L, y, R, y, accent, 0.9);
  y += 8;

  /* ================= BILLED BY / BILLED TO ================= */
  const gap = 6;
  const colW = (W - gap) / 2;
  const partyBoxTop = y;
  const drawParty = (x, label, name, addr, extras) => {
    let py = partyBoxTop + 6;
    text(label, x, py, { size: 7.2, weight: "semibold", color: accent, align: "left", spacing: 0.5 });
    py += 6;
    text(name, x, py, { size: 11, weight: "bold", color: INK });
    py += 4.6;
    if (addr) wrap(addr, colW - 8, 8).forEach((ln) => { text(ln, x, py, { size: 8, color: BODY }); py += 3.5; });
    (extras || []).forEach(([lab, val]) => {
      if (!val) return;
      py += 1.5;
      text(lab, x, py, { size: 6.8, weight: "semibold", color: MUTED, spacing: 0.4 });
      py += 3.4;
      text(val, x, py, { size: 8.4, weight: "semibold", color: BODY });
      py += 0.4;
    });
    return py;
  };
  // measure both to size a common panel
  // draw panels first with an estimated height, then content
  const byExtras = [["GSTIN", firmGstin]];
  const toExtras = [["GSTIN", custGstin], custPan && !custGstin ? ["PAN", custPan] : null].filter(Boolean);
  // temporary render to compute heights by drawing to a throwaway? Simpler: estimate.
  const estLines = (addr, extras) =>
    6 + 6 + 4.6 + (addr ? wrap(addr, colW - 8, 8).length * 3.5 : 0) + extras.filter(([, v]) => v).length * 6.9 + 4;
  const panelH = Math.max(estLines(firmAddress, byExtras), estLines(custAddress, toExtras), 30);
  fillRect(L, partyBoxTop, colW, panelH, panelBg, 3);
  fillRect(L + colW + gap, partyBoxTop, colW, panelH, panelBg, 3);
  drawParty(L + 5, "BILLED BY", firmName, firmAddress, byExtras);
  drawParty(L + colW + gap + 5, "BILLED TO", custName, custAddress, toExtras);
  y = partyBoxTop + panelH + 5;

  /* place / country of supply (GST only) */
  if (t.gstEnabled && (cfg.placeOfSupply || cfg.countryOfSupply)) {
    const sH = 12;
    fillRect(L, y, colW, sH, panelBg, 3);
    fillRect(L + colW + gap, y, colW, sH, panelBg, 3);
    text("PLACE OF SUPPLY", L + 5, y + 4.6, { size: 6.8, weight: "semibold", color: MUTED, spacing: 0.4 });
    text(cfg.placeOfSupply || "—", L + 5, y + 9, { size: 9, weight: "semibold", color: INK });
    text("COUNTRY OF SUPPLY", L + colW + gap + 5, y + 4.6, { size: 6.8, weight: "semibold", color: MUTED, spacing: 0.4 });
    text(cfg.countryOfSupply || "India", L + colW + gap + 5, y + 9, { size: 9, weight: "semibold", color: INK });
    y += sH + 6;
  } else {
    y += 1;
  }

  /* ================= ITEMS TABLE ================= */
  // Column config depends on GST mode.
  let cols;
  if (!t.gstEnabled) {
    cols = [
      { k: "num", h: "#", w: 8, a: "center" },
      { k: "desc", h: "ITEM DESCRIPTION", w: 84, a: "left" },
      { k: "hsn", h: "HSN/SAC", w: 22, a: "left" },
      { k: "qty", h: "QTY", w: 16, a: "right" },
      { k: "rate", h: "RATE (₹)", w: 24, a: "right" },
      { k: "total", h: "AMOUNT", w: 28, a: "right" },
    ];
  } else if (t.gstType === "IGST") {
    cols = [
      { k: "num", h: "#", w: 7, a: "center" },
      { k: "desc", h: "ITEM DESCRIPTION", w: 48, a: "left" },
      { k: "hsn", h: "HSN/SAC", w: 16, a: "left" },
      { k: "qty", h: "QTY", w: 12, a: "right" },
      { k: "rate", h: "RATE (₹)", w: 18, a: "right" },
      { k: "gst", h: "GST%", w: 11, a: "right" },
      { k: "taxable", h: "TAXABLE", w: 24, a: "right" },
      { k: "igst", h: "IGST", w: 22, a: "right" },
      { k: "total", h: "TOTAL", w: 24, a: "right" },
    ];
  } else {
    cols = [
      { k: "num", h: "#", w: 7, a: "center" },
      { k: "desc", h: "ITEM DESCRIPTION", w: 43, a: "left" },
      { k: "hsn", h: "HSN/SAC", w: 15, a: "left" },
      { k: "qty", h: "QTY", w: 11, a: "right" },
      { k: "rate", h: "RATE (₹)", w: 17, a: "right" },
      { k: "gst", h: "GST%", w: 11, a: "right" },
      { k: "taxable", h: "TAXABLE", w: 21, a: "right" },
      { k: "sgst", h: "SGST", w: 17, a: "right" },
      { k: "cgst", h: "CGST", w: 17, a: "right" },
      { k: "total", h: "TOTAL", w: 23, a: "right" },
    ];
  }
  // x positions
  let cx = L;
  cols.forEach((c) => { c.x = cx; cx += c.w; });
  const cellX = (c) => (c.a === "right" ? c.x + c.w - 2.5 : c.a === "center" ? c.x + c.w / 2 : c.x + 2.5);

  const drawTableHeader = (top) => {
    const hH = 8;
    fillRect(L, top, W, hH, accent, 1.5);
    cols.forEach((c) => text(c.h, cellX(c), top + 5.3, { size: 6.8, weight: "semibold", color: accentText, align: c.a, spacing: 0.2 }));
    return top + hH;
  };

  const cellVal = (c, r, idx) => {
    switch (c.k) {
      case "num": return String(idx + 1);
      case "desc": return r.description || "—";
      case "hsn": return r.hsn || "—";
      case "qty": return String(r.qty);
      case "rate": return fmtRupee(r.rate);
      case "gst": return `${r.gstRate}%`;
      case "taxable": return fmtRupee(r.taxable);
      case "sgst": return fmtRupee(r.sgst);
      case "cgst": return fmtRupee(r.cgst);
      case "igst": return fmtRupee(r.igst);
      case "total": return fmtRupee(r.total);
      default: return "";
    }
  };

  const descCol = cols.find((c) => c.k === "desc");
  y = drawTableHeader(y);

  t.rows.forEach((r, idx) => {
    const descLines = wrap(r.description || "—", descCol.w - 4, 8.4, false);
    const noteLines = r.note ? wrap(r.note, descCol.w - 4, 7, false) : [];
    const rowH = Math.max(9, descLines.length * 3.7 + noteLines.length * 3 + 4);

    // page break
    if (y + rowH > PAGE_H - 62) {
      line(L, y, R, y, LINE, 0.25);
      doc.addPage();
      y = 18;
      y = drawTableHeader(y);
    }

    if (idx % 2 === 1) fillRect(L, y, W, rowH, [250, 250, 253]);
    const baseY = y + 4.6;
    cols.forEach((c) => {
      if (c.k === "desc") {
        descLines.forEach((ln, i) => text(ln, c.x + 2.5, baseY + i * 3.7, { size: 8.4, color: INK }));
        noteLines.forEach((ln, i) => text(ln, c.x + 2.5, baseY + descLines.length * 3.7 + i * 3, { size: 7, color: MUTED }));
      } else {
        const isTotal = c.k === "total";
        text(cellVal(c, r, idx), cellX(c), baseY, { size: 8.2, weight: isTotal ? "semibold" : "regular", color: isTotal ? INK : BODY, align: c.a });
      }
    });
    y += rowH;
    line(L, y, R, y, LINE, 0.25);
  });

  y += 8;

  /* ================= BOTTOM: bank/terms (left) + totals (right) ================= */
  const totalsW = 74;
  const totalsX = R - totalsW;
  const leftW = totalsX - L - 8;
  let ly = y;   // left column cursor
  let ry = y;   // right column cursor

  /* -- right: totals block -- */
  const totRow = (label, value, { big = false, color = INK, strong = false } = {}) => {
    text(label, totalsX, ry, { size: big ? 12 : 8.6, weight: big ? "extrabold" : (strong ? "semibold" : "medium"), color: big ? INK : MUTED });
    text(value, R, ry, { size: big ? 14 : 9, weight: big ? "extrabold" : "semibold", color, align: "right" });
    ry += big ? 9.5 : 6.2;
  };
  totRow("Sub Total", fmtRupee(t.subTotal));
  if (t.gstEnabled) {
    if (t.gstType === "IGST") {
      totRow("IGST", fmtRupee(t.igst));
    } else {
      totRow("CGST", fmtRupee(t.cgst));
      totRow("SGST", fmtRupee(t.sgst));
    }
  }
  if (Math.abs(t.roundOff) >= 0.005) totRow("Round Off", (t.roundOff >= 0 ? "+" : "−") + fmtRupee(Math.abs(t.roundOff)));
  ry += 1;
  line(totalsX, ry, R, ry, accent, 0.5);
  ry += 6.5;
  totRow("Total", fmtRupee(t.grandTotal), { big: true, color: accent });
  ry += 1;
  // amount in words
  text("INVOICE TOTAL (IN WORDS)", totalsX, ry, { size: 6.6, weight: "semibold", color: MUTED, spacing: 0.3 });
  ry += 4.2;
  wrap(amountInWords(t.grandTotal), totalsW, 7.6, "italic").forEach((ln) => { text(ln, totalsX, ry, { size: 7.6, weight: "italic", color: BODY }); ry += 3.4; });

  /* -- left: bank & payment details -- */
  const bank = {
    name: cfg.bankName || "",
    account: cfg.bankAccount || "",
    ifsc: cfg.bankIfsc || "",
    upi: cfg.bankUpi || "",
  };
  const hasBank = bank.name || bank.account || bank.ifsc || bank.upi;
  if (cfg.showBankDetails !== false && hasBank) {
    text("BANK & PAYMENT DETAILS", L, ly, { size: 7.2, weight: "semibold", color: accent, spacing: 0.4 });
    ly += 5.5;
    const brow = (lab, val) => { if (!val) return; text(lab, L, ly, { size: 8, color: MUTED }); text(val, L + leftW, ly, { size: 8, weight: "semibold", color: INK, align: "right" }); ly += 5; };
    brow("Bank", bank.name);
    brow("Account No.", bank.account);
    brow("IFSC", bank.ifsc);
    brow("UPI ID", bank.upi);
    ly += 3;
  }

  const terms = (cfg.terms || "").trim();
  if (terms) {
    text("TERMS & CONDITIONS", L, ly, { size: 7.2, weight: "semibold", color: accent, spacing: 0.4 });
    ly += 5;
    wrap(terms, leftW + 20, 8).forEach((ln) => { text(ln, L, ly, { size: 8, color: BODY }); ly += 3.6; });
    ly += 3;
  }
  const notes = (cfg.notes || invoice?.notes || "").trim();
  if (notes) {
    text("ADDITIONAL NOTES", L, ly, { size: 7.2, weight: "semibold", color: accent, spacing: 0.4 });
    ly += 5;
    wrap(notes, leftW + 20, 8, "italic").forEach((ln) => { text(ln, L, ly, { size: 8, weight: "italic", color: BODY }); ly += 3.6; });
  }

  /* ================= FOOTER / SIGNATURE ================= */
  y = Math.max(ly, ry) + 10;
  const sigY = Math.min(Math.max(y, 250), PAGE_H - 30);
  line(L, sigY, R, sigY, LINE, 0.3);
  const footY = sigY + 6;
  if (firmEmail) text(firmEmail, L, footY, { size: 8, color: MUTED });
  if (firmPhone) text(firmPhone, L, footY + 4, { size: 8, color: MUTED });
  text((cfg.signatoryLabel || "AUTHORISED SIGNATORY"), R, footY, { size: 7, weight: "semibold", color: MUTED, align: "right", spacing: 0.4 });
  text(firmName, R, footY + 5, { size: 9.5, weight: "bold", color: INK, align: "right" });

  /* page footer on every page */
  const pageCount = doc.internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    text(`Page ${p} of ${pageCount}  |  Generated by ProHippo`, (L + R) / 2, PAGE_H - 8, { size: 7, color: MUTED, align: "center" });
  }

  return doc;
}

export function downloadInvoicePDF(args) {
  const number = args?.invoice?.number || "invoice";
  buildInvoicePDF(args).save(`Invoice-${String(number).replace(/[/\s]+/g, "-")}.pdf`);
}

/* A data-URI string for on-screen preview in an <iframe>. */
export function invoicePDFDataUri(args) {
  return buildInvoicePDF(args).output("datauristring");
}
