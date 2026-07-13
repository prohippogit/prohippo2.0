/* ProHippo — client-side vector PDF invoice generation (jsPDF).
   Text is real vector type using an embedded DejaVu Sans subset that
   includes the rupee sign, so the PDF stays crisp at any zoom. */
import { jsPDF } from "jspdf";
import { INVOICE_FONT_REGULAR, INVOICE_FONT_BOLD } from "./fonts/invoiceFonts.js";

const fmtNum = (n) => new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
const fmtDate = (iso) => (iso ? new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—");

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

const INK = [31, 27, 58];       // heading text
const BODY = [64, 60, 92];      // body text
const MUTED = [138, 135, 160];  // labels
const ACCENT = [108, 92, 231];  // brand violet
const LINE = [228, 226, 240];
const TINT = [246, 244, 253];   // table header fill

export function buildInvoicePDF({ invoice, assessee, profile }) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  doc.addFileToVFS("InvoiceSans.ttf", INVOICE_FONT_REGULAR);
  doc.addFont("InvoiceSans.ttf", "InvoiceSans", "normal");
  doc.addFileToVFS("InvoiceSans-Bold.ttf", INVOICE_FONT_BOLD);
  doc.addFont("InvoiceSans-Bold.ttf", "InvoiceSans", "bold");

  const L = 18, R = 192, W = R - L; // margins on A4 (210mm wide)
  const text = (str, x, y, { size = 10, bold = false, color = BODY, align = "left", spacing } = {}) => {
    doc.setFont("InvoiceSans", bold ? "bold" : "normal");
    doc.setFontSize(size);
    doc.setTextColor(...color);
    doc.text(String(str), x, y, { align, charSpace: spacing });
  };
  const rule = (y, color = LINE, w = 0.35) => {
    doc.setDrawColor(...color);
    doc.setLineWidth(w);
    doc.line(L, y, R, y);
  };

  const firmName = (profile?.firmName || "").trim() || (profile?.ownerName || "").trim() || "Tax Practice";
  const ownerName = (profile?.ownerName || "").trim();
  const contact = [profile?.firmAddress, [profile?.email, profile?.firmMobile].filter(Boolean).join("  ·  ")]
    .map((s) => (s || "").trim()).filter(Boolean);

  /* ---- header ---- */
  let y = 24;
  text(firmName, L, y, { size: 19, bold: true, color: INK });
  text("INVOICE", R, y, { size: 19, bold: true, color: ACCENT, align: "right", spacing: 0.8 });
  y += 6;
  if (ownerName && ownerName !== firmName) { text(ownerName, L, y, { size: 9.5, color: BODY }); y += 4.6; }
  contact.forEach((line) => { text(line, L, y, { size: 8.5, color: MUTED }); y += 4.2; });
  y = Math.max(y + 3, 38);
  doc.setDrawColor(...ACCENT);
  doc.setLineWidth(0.9);
  doc.line(L, y, R, y);

  /* ---- meta row ---- */
  y += 9;
  const meta = [
    ["INVOICE NO.", invoice.number || "—"],
    ["INVOICE DATE", fmtDate(invoice.date)],
    ["DUE DATE", fmtDate(invoice.due)],
  ];
  meta.forEach(([label, value], i) => {
    const x = L + (i * W) / 3;
    text(label, x, y, { size: 7.5, bold: true, color: MUTED, spacing: 0.5 });
    text(value, x, y + 5.5, { size: 11, bold: true, color: INK });
  });

  /* ---- billed to ---- */
  y += 17;
  text("BILLED TO", L, y, { size: 7.5, bold: true, color: MUTED, spacing: 0.5 });
  y += 6;
  text(invoice.assessee || assessee?.name || "—", L, y, { size: 12.5, bold: true, color: INK });
  y += 5.5;
  if (assessee?.pan) { text(`PAN: ${assessee.pan}`, L, y, { size: 9.5, color: BODY }); y += 4.8; }
  if (assessee?.address) {
    doc.setFont("InvoiceSans", "normal");
    doc.setFontSize(9);
    doc.splitTextToSize(assessee.address, 110).forEach((line) => {
      text(line, L, y, { size: 9, color: MUTED });
      y += 4.4;
    });
  }

  /* ---- particulars table ---- */
  y += 8;
  const colAY = 138, colAmt = R;
  doc.setFillColor(...TINT);
  doc.rect(L, y - 5, W, 8.5, "F");
  text("PARTICULARS", L + 3, y, { size: 8, bold: true, color: MUTED, spacing: 0.4 });
  text("AY", colAY, y, { size: 8, bold: true, color: MUTED, spacing: 0.4 });
  text("AMOUNT (₹)", colAmt - 3, y, { size: 8, bold: true, color: MUTED, align: "right", spacing: 0.4 });
  y += 9;
  doc.setFont("InvoiceSans", "normal");
  doc.setFontSize(10.5);
  const service = (invoice.service || "").trim() || "Professional fees";
  const lines = doc.splitTextToSize(service, colAY - L - 10);
  lines.forEach((line, i) => {
    text(line, L + 3, y + i * 5, { size: 10.5, color: INK });
  });
  text(invoice.ay || "—", colAY, y, { size: 10, color: BODY });
  text(fmtNum(invoice.amount || 0), colAmt - 3, y, { size: 10.5, color: INK, align: "right" });
  y += lines.length * 5 + 4;
  rule(y);

  /* ---- totals ---- */
  y += 8;
  const received = invoice.received || 0;
  const balance = Math.max(0, (invoice.amount || 0) - received);
  const totalRow = (label, value, { big = false, color = INK } = {}) => {
    text(label, colAY - 32, y, { size: big ? 11.5 : 9.5, bold: big, color: big ? INK : MUTED });
    text(value, colAmt - 3, y, { size: big ? 12.5 : 10, bold: true, color, align: "right" });
    y += big ? 8 : 6.5;
  };
  totalRow("Total", `₹ ${fmtNum(invoice.amount || 0)}`, { big: true });
  if (received > 0) {
    totalRow("Received", `₹ ${fmtNum(received)}`);
    totalRow("Balance due", `₹ ${fmtNum(balance)}`, { color: balance > 0 ? [193, 51, 136] : [27, 140, 92] });
  }
  y += 2;
  text("Amount in words", L, y, { size: 7.5, bold: true, color: MUTED, spacing: 0.5 });
  y += 5;
  doc.splitTextToSize(amountInWords(invoice.amount || 0), W).forEach((line) => {
    text(line, L, y, { size: 9.5, color: BODY });
    y += 4.6;
  });

  /* ---- signature + footer ---- */
  const sigY = Math.max(y + 24, 240);
  text(`For ${firmName}`, R, sigY, { size: 10, bold: true, color: INK, align: "right" });
  doc.setDrawColor(...LINE);
  doc.setLineWidth(0.35);
  doc.line(R - 48, sigY + 18, R, sigY + 18);
  text("Authorised Signatory", R, sigY + 23, { size: 8.5, color: MUTED, align: "right" });

  rule(283);
  text("This is a computer-generated invoice and does not require a physical signature.", (L + R) / 2, 288, { size: 8, color: MUTED, align: "center" });

  return doc;
}

export function downloadInvoicePDF(args) {
  const number = args.invoice.number || "invoice";
  buildInvoicePDF(args).save(`Invoice-${number.replace(/[/\s]+/g, "-")}.pdf`);
}
