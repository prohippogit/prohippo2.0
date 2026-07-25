/* ProHippo — vector PDF ledgers & payment receipts (jsPDF).
   A soft, "curvy" theme: rounded panels, pill totals and a rounded-header
   statement table, set in the same embedded Poppins family as the invoice.
   Covers a single-assessee ledger, a consolidated group ledger and a
   payment receipt. */
import { jsPDF } from "jspdf";
import { registerFonts, resolveWeight, amountInWords, fmtRupee } from "./invoicePdf.js";

const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
};
const today = () => {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
};

/* ---- colour helpers ---- */
const hexToRgb = (hex, fallback = [108, 92, 231]) => {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || "").trim());
  if (!m) return fallback.slice();
  const int = parseInt(m[1], 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
};
const tint = (rgb, t) => rgb.map((c) => Math.round(c + (255 - c) * t));
const readable = (rgb) => (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] > 150 ? [20, 19, 43] : [255, 255, 255]);

const INK = [26, 24, 46];
const BODY = [64, 60, 92];
const MUTED = [138, 135, 160];
const LINE = [230, 228, 240];
const DEBIT = [193, 51, 120];
const CREDIT = [26, 140, 92];

/* Build a jsPDF doc with Poppins registered and a small set of drawing
   helpers bound to it. */
function themedDoc() {
  const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
  registerFonts(doc);
  const text = (str, x, y, { size = 9, weight, bold, color = BODY, align = "left", spacing } = {}) => {
    doc.setFont(...resolveWeight(weight, bold));
    doc.setFontSize(size);
    doc.setTextColor(...color);
    doc.text(String(str ?? ""), x, y, { align, charSpace: spacing, baseline: "alphabetic" });
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
function clipText(ctx, str, w, size, weight) {
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
function drawBrandHeader(ctx, { profile, cfg, accent, title, subtitle = "STATEMENT OF ACCOUNT" }) {
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

/* Rounded summary chips row (Billed / Received / Outstanding). */
function drawSummary(ctx, y, accent, items) {
  const { text, rrect } = ctx;
  const L = 14, R = 196, gap = 5;
  const w = (R - L - gap * (items.length - 1)) / items.length;
  items.forEach((it, i) => {
    const x = L + i * (w + gap);
    const emph = it.emph;
    rrect(x, y, w, 17, 4, "F", emph ? tint(accent, 0.86) : [248, 247, 251]);
    text(it.label, x + 6, y + 6.5, { size: 6.8, weight: "semibold", color: emph ? accent : MUTED, spacing: 0.4 });
    text(it.value, x + 6, y + 13, { size: 12, weight: "extrabold", color: emph ? accent : INK });
  });
  return y + 17 + 8;
}

/* ============================ LEDGER ============================ */

export function buildLedgerPDF({ ledger, party, isGroup = false, profile, settings } = {}) {
  const cfg = { ...(profile?.invoiceSettings || {}), ...(settings || {}) };
  const accent = hexToRgb(cfg.accent, [108, 92, 231]);
  const accentText = readable(accent);
  const ctx = themedDoc();
  const { doc, text, wrap, rrect, line } = ctx;
  const L = 14, R = 196, W = R - L, PAGE_H = 297;

  let y = drawBrandHeader(ctx, { profile, cfg, accent, title: "Ledger" });

  /* party panel */
  rrect(L, y, W, 16, 4, "F", [248, 247, 251]);
  text(isGroup ? "GROUP LEDGER" : "LEDGER FOR", L + 6, y + 6, { size: 6.8, weight: "semibold", color: accent, spacing: 0.5 });
  text(party?.name || "—", L + 6, y + 12.4, { size: 12.5, weight: "bold", color: INK });
  const sub = isGroup
    ? `${party?.memberCount || 0} assessee${party?.memberCount === 1 ? "" : "s"}`
    : [party?.pan ? `PAN ${party.pan}` : "", party?.group ? `Group: ${party.group}` : ""].filter(Boolean).join("   ·   ");
  if (sub) text(sub, R - 6, y + 12.4, { size: 8.5, weight: "medium", color: MUTED, align: "right" });
  text(`As on ${today()}`, R - 6, y + 6, { size: 7.5, weight: "semibold", color: MUTED, align: "right" });
  y += 16 + 8;

  /* summary */
  y = drawSummary(ctx, y, accent, [
    { label: "TOTAL BILLED", value: fmtRupee(ledger.totalDebit) },
    { label: "TOTAL RECEIVED", value: fmtRupee(ledger.totalCredit) },
    { label: "OUTSTANDING", value: fmtRupee(ledger.closing), emph: true },
  ]);

  /* columns */
  let cols;
  if (isGroup) {
    cols = [
      { k: "date", h: "DATE", w: 18, a: "left" },
      { k: "party", h: "PARTY", w: 34, a: "left" },
      { k: "particulars", h: "PARTICULARS", w: 42, a: "left" },
      { k: "ref", h: "VOUCHER", w: 22, a: "left" },
      { k: "debit", h: "DEBIT", w: 22, a: "right" },
      { k: "credit", h: "CREDIT", w: 22, a: "right" },
      { k: "balance", h: "BALANCE", w: 22, a: "right" },
    ];
  } else {
    cols = [
      { k: "date", h: "DATE", w: 20, a: "left" },
      { k: "particulars", h: "PARTICULARS", w: 62, a: "left" },
      { k: "ref", h: "VOUCHER", w: 26, a: "left" },
      { k: "debit", h: "DEBIT", w: 24, a: "right" },
      { k: "credit", h: "CREDIT", w: 24, a: "right" },
      { k: "balance", h: "BALANCE", w: 26, a: "right" },
    ];
  }
  let cx = L;
  cols.forEach((c) => { c.x = cx; cx += c.w; });
  const cellX = (c) => (c.a === "right" ? c.x + c.w - 3 : c.x + 3);
  const partCol = cols.find((c) => c.k === "particulars");

  const drawHead = (top) => {
    rrect(L, top, W, 8, 2.5, "F", accent);
    cols.forEach((c) => text(c.h, cellX(c), top + 5.3, { size: 6.6, weight: "semibold", color: accentText, align: c.a, spacing: 0.2 }));
    return top + 8 + 1.5;
  };

  const cellVal = (c, e) => {
    switch (c.k) {
      case "date": return fmtDate(e.date);
      case "party": return e.party || "";
      case "ref": return e.ref || "";
      case "debit": return e.debit ? fmtRupee(e.debit) : "";
      case "credit": return e.credit ? fmtRupee(e.credit) : "";
      case "balance": return `${fmtRupee(Math.abs(e.balance))} ${e.balance >= 0 ? "Dr" : "Cr"}`;
      default: return "";
    }
  };

  y = drawHead(y);

  if (ledger.entries.length === 0) {
    rrect(L, y, W, 16, 3, "F", [250, 250, 253]);
    text("No transactions yet for this account.", L + W / 2, y + 9.5, { size: 9, weight: "medium", color: MUTED, align: "center" });
    y += 16 + 4;
  }

  ledger.entries.forEach((e, idx) => {
    const partLines = wrap(e.particulars || "", partCol.w - 5, 7.8);
    const rowH = Math.max(8.5, partLines.length * 3.4 + 4.5);
    if (y + rowH > PAGE_H - 40) {
      doc.addPage();
      y = 18;
      y = drawHead(y);
    }
    if (idx % 2 === 1) rrect(L, y, W, rowH, 1.8, "F", [249, 248, 252]);
    const baseY = y + 5;
    cols.forEach((c) => {
      if (c.k === "particulars") {
        partLines.forEach((ln, i) => text(ln, c.x + 3, baseY + i * 3.4, { size: 7.8, weight: "medium", color: INK }));
      } else {
        const isDebit = c.k === "debit", isCredit = c.k === "credit", isBal = c.k === "balance";
        // party & voucher are single-line — clip so they never run into the next column.
        const raw = cellVal(c, e);
        const val = (c.k === "party" || c.k === "ref") ? clipText(ctx, raw, c.w - 5, 7.8, c.k === "party" ? "semibold" : "regular") : raw;
        text(val, cellX(c), baseY, {
          size: 7.8,
          weight: isBal ? "semibold" : c.k === "party" ? "semibold" : (isDebit || isCredit) ? "semibold" : "regular",
          color: isDebit ? DEBIT : isCredit ? CREDIT : isBal ? INK : BODY,
          align: c.a,
        });
      }
    });
    y += rowH;
    line(L + 1, y, R - 1, y, LINE, 0.2);
  });

  /* totals row */
  y += 2;
  rrect(L, y, W, 9, 2.5, "F", tint(accent, 0.9));
  const dCol = cols.find((c) => c.k === "debit"), cCol = cols.find((c) => c.k === "credit"), bCol = cols.find((c) => c.k === "balance");
  text("TOTAL", L + 3, y + 5.8, { size: 7.6, weight: "extrabold", color: accent });
  text(fmtRupee(ledger.totalDebit), cellX(dCol), y + 5.8, { size: 7.8, weight: "extrabold", color: INK, align: "right" });
  text(fmtRupee(ledger.totalCredit), cellX(cCol), y + 5.8, { size: 7.8, weight: "extrabold", color: INK, align: "right" });
  text(`${fmtRupee(ledger.closing)} Dr`, cellX(bCol), y + 5.8, { size: 7.8, weight: "extrabold", color: accent, align: "right" });
  y += 9 + 8;

  /* closing balance pill + words */
  if (y > PAGE_H - 46) { doc.addPage(); y = 20; }
  rrect(L, y, W, 20, 5, "F", tint(accent, 0.9));
  text("CLOSING OUTSTANDING", L + 7, y + 7.5, { size: 7, weight: "semibold", color: accent, spacing: 0.4 });
  text(amountInWords(ledger.closing), L + 7, y + 14.5, { size: 8, weight: "italic", color: BODY });
  text(fmtRupee(ledger.closing), R - 7, y + 13, { size: 15, weight: "extrabold", color: accent, align: "right" });
  y += 20 + 8;

  /* group per-party summary */
  if (isGroup && party?.byParty?.length) {
    if (y > PAGE_H - 40) { doc.addPage(); y = 20; }
    text("OUTSTANDING BY ASSESSEE", L, y, { size: 7.4, weight: "semibold", color: accent, spacing: 0.4 });
    y += 5;
    party.byParty.forEach((p) => {
      if (y > PAGE_H - 24) { doc.addPage(); y = 20; }
      rrect(L, y, W, 8.5, 2.5, "F", [248, 247, 251]);
      text(p.name, L + 6, y + 5.6, { size: 8.2, weight: "semibold", color: INK });
      text(fmtRupee(p.outstanding), R - 6, y + 5.6, { size: 8.4, weight: "bold", color: p.outstanding > 0 ? DEBIT : CREDIT, align: "right" });
      y += 8.5 + 2.5;
    });
  }

  drawFooter(ctx, { cfg, profile });
  return doc;
}

/* ============================ RECEIPT ============================ */

export function buildReceiptPDF({ receipt, party, profile, settings, outstandingAfter } = {}) {
  const cfg = { ...(profile?.invoiceSettings || {}), ...(settings || {}) };
  const accent = hexToRgb(cfg.accent, [108, 92, 231]);
  const ctx = themedDoc();
  const { doc, text, wrap, rrect, line } = ctx;
  const L = 14, R = 196, W = R - L;

  let y = drawBrandHeader(ctx, { profile, cfg, accent, title: "Receipt", subtitle: "PAYMENT RECEIPT" });

  /* meta row */
  const amount = Number(receipt?.amount) || 0;
  const gap = 6, colW = (W - gap) / 2;
  rrect(L, y, colW, 15, 4, "F", [248, 247, 251]);
  rrect(L + colW + gap, y, colW, 15, 4, "F", [248, 247, 251]);
  text("RECEIPT NO.", L + 6, y + 5.8, { size: 6.6, weight: "semibold", color: MUTED, spacing: 0.4 });
  text(receipt?.number || "—", L + 6, y + 11.5, { size: 11, weight: "bold", color: INK });
  text("DATE", L + colW + gap + 6, y + 5.8, { size: 6.6, weight: "semibold", color: MUTED, spacing: 0.4 });
  text(fmtDate(receipt?.date), L + colW + gap + 6, y + 11.5, { size: 11, weight: "bold", color: INK });
  y += 15 + 8;

  /* main "received with thanks" card */
  const cardH = 62;
  rrect(L, y, W, cardH, 6, "F", tint(accent, 0.93));
  let cy = y + 11;
  text("RECEIVED WITH THANKS FROM", L + 9, cy, { size: 7, weight: "semibold", color: accent, spacing: 0.5 });
  cy += 7;
  text(party?.name || receipt?.assessee || receipt?.group || "—", L + 9, cy, { size: 14, weight: "extrabold", color: INK });
  cy += 9;
  text("THE SUM OF", L + 9, cy, { size: 7, weight: "semibold", color: accent, spacing: 0.5 });
  cy += 6;
  wrap(amountInWords(amount), W - 70, 9.5, "italic").forEach((ln, i) => { text(ln, L + 9, cy + i * 4.6, { size: 9.5, weight: "italic", color: BODY }); });
  cy += 12;
  const mode = receipt?.mode || "Payment";
  text(`by ${mode}${receipt?.note ? ` — ${receipt.note}` : ""}`, L + 9, cy, { size: 8.5, weight: "medium", color: MUTED });

  /* amount pill (top-right of card) */
  const pillW = 52, pillH = 20;
  rrect(R - 9 - pillW, y + 9, pillW, pillH, 6, "F", accent);
  text("AMOUNT", R - 9 - pillW / 2, y + 15.5, { size: 6.6, weight: "semibold", color: readable(accent), align: "center", spacing: 0.5 });
  text(fmtRupee(amount), R - 9 - pillW / 2, y + 24, { size: 14, weight: "extrabold", color: readable(accent), align: "center" });
  y += cardH + 8;

  /* allocations */
  const allocs = receipt?.allocations || [];
  if (allocs.length) {
    text("APPLIED TO", L, y, { size: 7.2, weight: "semibold", color: accent, spacing: 0.4 });
    y += 5.5;
    rrect(L, y, W, 7.5, 2.5, "F", [248, 247, 251]);
    text("INVOICE", L + 6, y + 5, { size: 6.6, weight: "semibold", color: MUTED, spacing: 0.3 });
    text("APPLIED (₹)", R - 6, y + 5, { size: 6.6, weight: "semibold", color: MUTED, align: "right", spacing: 0.3 });
    y += 7.5 + 1.5;
    allocs.forEach((a) => {
      text(a.invoiceNumber || "—", L + 6, y + 4, { size: 8.2, weight: "medium", color: INK });
      text(fmtRupee(a.amount), R - 6, y + 4, { size: 8.2, weight: "semibold", color: INK, align: "right" });
      y += 6;
      line(L + 1, y, R - 1, y, LINE, 0.2);
    });
    y += 4;
  } else if (receipt?.group) {
    rrect(L, y, W, 12, 3, "F", [248, 247, 251]);
    text(`Received against the group account “${receipt.group}”.`, L + 6, y + 7.5, { size: 8.5, weight: "medium", color: BODY });
    y += 12 + 6;
  }

  /* outstanding-after note */
  if (typeof outstandingAfter === "number") {
    rrect(L, y, W, 12, 3, "F", tint(accent, 0.9));
    text("BALANCE OUTSTANDING AFTER THIS RECEIPT", L + 6, y + 7.5, { size: 7, weight: "semibold", color: accent, spacing: 0.3 });
    text(fmtRupee(Math.max(0, outstandingAfter)), R - 6, y + 7.7, { size: 10, weight: "bold", color: accent, align: "right" });
    y += 12 + 8;
  }

  /* signatory */
  const firmName = (cfg.firmName || profile?.firmName || profile?.ownerName || "Your Firm").trim();
  const sigY = 250;
  line(R - 55, sigY, R, sigY, LINE, 0.3);
  text(cfg.signatoryLabel || "Authorised Signatory", R, sigY + 5, { size: 8, weight: "medium", color: MUTED, align: "right" });
  text(`For ${firmName}`, R, sigY + 10, { size: 9, weight: "bold", color: INK, align: "right" });

  drawFooter(ctx, { cfg, profile });
  return doc;
}

/* Shared page footer on every page. */
function drawFooter(ctx, { cfg, profile }) {
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

/* ---- download / preview wrappers ---- */
const safe = (s) => String(s || "document").replace(/[/\\\s]+/g, "-");

export function downloadLedgerPDF(args) {
  buildLedgerPDF(args).save(`Ledger-${safe(args?.party?.name)}.pdf`);
}
export function ledgerPDFDataUri(args) {
  return buildLedgerPDF(args).output("datauristring");
}
export function downloadReceiptPDF(args) {
  buildReceiptPDF(args).save(`Receipt-${safe(args?.receipt?.number)}.pdf`);
}
export function receiptPDFDataUri(args) {
  return buildReceiptPDF(args).output("datauristring");
}
