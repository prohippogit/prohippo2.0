/*
 * The mock ITR-B and its summarised computation of income (jsPDF).
 *
 * WHAT THIS IS, AND WHAT IT IS NOT. It is a working paper: the block return set
 * out the way the portal asks for it, so the practitioner can settle the figures
 * with the client, get them signed off, and then key a form they have already
 * agreed rather than one they are composing in a portal session that times out.
 * It is NOT a return. Nothing here is filed, nothing is transmitted, and the
 * document says so on its face in a band that cannot be missed — a document that
 * looks like a departmental form and does not say what it is would eventually be
 * mistaken for one.
 *
 * The frame — the rounded panels, the brand header, the footer, the palette — is
 * the same one every other document this practice sends out uses (pdfTheme.js),
 * because a client who gets a computation and a ledger in the same week should
 * get two documents from one firm.
 *
 * Layout note. Part C is a matrix: seven years down, six heads across. That is
 * the one table here that is genuinely wide, and it is kept in portrait with
 * narrow columns rather than turned landscape, because a practitioner prints the
 * whole document once and a page that is the other way up in the middle of it is
 * a nuisance every time it is read.
 */
import {
  themedDoc, clipText, drawBrandHeader, drawFooter,
  hexToRgb, tint, readable, fmtDate, today,
  INK, BODY, MUTED, LINE,
} from "../../pdfTheme.js";
import { UNDISCLOSED_HEADS, RATE_PENALTY } from "./compute.js";
import { HEADS } from "./declared.js";
import { DII_ITEMS, VERIFICATION_TEXT, furnishingMode } from "./form.js";
import { columnsFor, labelFor, appliesTo, partBColumns } from "./partC.js";
import { variantFor, partYearIncome } from "./partA.js";
import { PART_B_ROWS } from "./partB.js";

const L = 14, R = 196, W = R - L, PAGE_H = 297, FOOT = 20;

/* Whole rupees, Indian grouping. A tax document does not carry paise, and a nil
   is printed as a dash rather than a zero: on a block return "nothing was
   undisclosed under this head" and "the figure has not been worked out" look
   the same as 0 and read very differently. */
const grouping = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
/* The income returned for a year, or a dash — the same rule the form applies.
 * An unread year's declared total is 0 for the arithmetic's sake; printing it
 * as "Nil" would assert that the assessee returned nil income that year. */
export const returned = (y) => (y.declaredSource || y.declaredTotal ? amt(y.declaredTotal, { zero: "Nil" }) : "—");

export const amt = (v, { dash = true, zero = "—" } = {}) => {
  if (v === null || v === undefined || v === "") return dash ? "—" : "";
  const n = Number(v);
  if (!Number.isFinite(n)) return dash ? "—" : "";
  if (n === 0) return zero;
  return (n < 0 ? "(" : "") + grouping.format(Math.abs(Math.round(n))) + (n < 0 ? ")" : "");
};

/* A cursor over pages. Every builder below asks `need()` before it draws, so a
   table that runs off the bottom continues on the next page instead of writing
   over the footer. */
function pager(ctx, onNewPage) {
  let y = 0;
  return {
    get y() { return y; },
    set y(v) { y = v; },
    need(h) {
      if (y + h <= PAGE_H - FOOT) return false;
      ctx.doc.addPage();
      y = onNewPage();
      return true;
    },
  };
}

/* Section heading — a tinted band with the part's letter and title. */
function partHead(ctx, p, accent, letter, title, sub) {
  p.need(20);
  const { text, rrect } = ctx;
  rrect(L, p.y, W, 11, 3.5, "F", tint(accent, 0.9));
  rrect(L, p.y, 9, 11, 3.5, "F", accent);
  text(letter, L + 4.5, p.y + 7.4, { size: 8.5, weight: "extrabold", color: readable(accent), align: "center" });
  // With a strapline the title rides high and the strapline sits under it;
  // without one the title is centred in the band instead of floating above a
  // gap where the strapline would have been.
  text(title, L + 13, p.y + (sub ? 5.4 : 7.4), { size: 9.5, weight: "bold", color: INK });
  if (sub) text(sub, L + 13, p.y + 9.2, { size: 6.8, color: MUTED });
  p.y += 11 + 5;
}

/* A label/value grid, two pairs to a line. Part A is nearly all of these. */
function fieldGrid(ctx, p, rows) {
  const { text, line } = ctx;
  const colW = W / 2;
  for (let i = 0; i < rows.length; i += 2) {
    p.need(10);
    const pair = rows.slice(i, i + 2);
    pair.forEach((f, c) => {
      const x = L + c * colW;
      text(f.label, x, p.y + 3.4, { size: 6.6, weight: "semibold", color: MUTED, spacing: 0.3 });
      // A field to be signed by hand gets a rule to sign on, not an em dash
      // saying the value is missing — it is supposed to be missing here.
      if (f.rule) { ctx.line(x, p.y + 8.6, x + colW - 12, p.y + 8.6, LINE, 0.4); return; }
      const value = clipText(ctx, f.value || "—", colW - 6, 8.6, f.mono ? "semibold" : "medium");
      text(value, x, p.y + 8.4, { size: 8.6, weight: f.strong ? "bold" : "medium", color: f.strong ? INK : BODY });
    });
    p.y += 11;
    line(L, p.y - 1.5, R, p.y - 1.5, LINE, 0.2);
  }
  p.y += 3;
}

/* A ruled table. `cols` is [{ label, w, align }]; `rows` is arrays of strings,
   optionally carrying `_tone: "total" | "sub"` and `_span` (see below).
 *
 * `size` and `pad` exist for the one genuinely wide table here — the
 * computation matrix, seven years across — where the default type and the
 * default cell inset together leave a bold "53,53,890" a hair too wide for its
 * column and it comes out as "53,53,8…". Everything else uses the defaults. */
function table(ctx, p, accent, cols, rows, { size = 7.4, pad = 2.5 } = {}) {
  const { text, rrect, line } = ctx;
  const inner = (w) => w - pad * 2 + 1;
  const head = () => {
    rrect(L, p.y, W, 8, 2.5, "F", tint(accent, 0.82));
    let x = L;
    cols.forEach((c) => {
      const tx = c.align === "right" ? x + c.w - pad : x + pad;
      /* Deliberately little tracking on a right-aligned header. jsPDF measures
         the string for alignment WITHOUT charSpace and then draws it with, so a
         right-aligned label overhangs its column by roughly spacing × length —
         which is how a header ends up sitting on top of its neighbour. */
      text(clipText(ctx, c.label, inner(c.w), 6.4, "semibold"), tx, p.y + 5.3,
        { size: 6.4, weight: "semibold", color: accent, align: c.align || "left", spacing: 0.12 });
      x += c.w;
    });
    p.y += 8;
  };
  head();
  rows.forEach((row) => {
    const h = row._tone === "total" ? 8.5 : 7.5;
    if (p.need(h + 2)) head();
    if (row._tone === "total") rrect(L, p.y, W, h, 2, "F", tint(accent, 0.9));
    else if (row._tone === "sub") rrect(L, p.y, W, h, 0, "F", [250, 249, 253]);
    /* A banner row — a label with no figures against it, introducing the block
       of rows under it — is given the whole width. Clipped to the first column
       it read "Undisclosed income determined on the m…", which is a caption
       that has lost the only thing it was there to say. */
    if (row._span) {
      text(clipText(ctx, String(row[0] ?? ""), W - pad * 2, size, "semibold"), L + pad, p.y + h - 2.6,
        { size, weight: "semibold", color: row._muted ? MUTED : BODY });
    } else {
      let x = L;
      cols.forEach((c, i) => {
        const tx = c.align === "right" ? x + c.w - pad : x + pad;
        const weight = row._tone === "total" ? "bold" : (i === 0 ? "medium" : "regular");
        const color = row._tone === "total" ? INK : (row._muted ? MUTED : BODY);
        text(clipText(ctx, String(row[i] ?? ""), inner(c.w), size, weight), tx, p.y + h - 2.6,
          { size, weight, color, align: c.align || "left" });
        x += c.w;
      });
    }
    p.y += h;
    line(L, p.y, R, p.y, LINE, 0.2);
  });
  p.y += 5;
}

/* The band that says what this document is. Drawn on page one only, and it is
   deliberately the loudest thing on the page. */
function mockBanner(ctx, p) {
  const { text, rrect } = ctx;
  const warn = [232, 149, 46];
  rrect(L, p.y, W, 13, 3.5, "F", tint(warn, 0.85));
  text("MOCK RETURN — NOT FILED", L + 5, p.y + 5.6, { size: 7.6, weight: "extrabold", color: [150, 88, 12], spacing: 0.4 });
  text("Prepared for review and sign-off. The return itself must be furnished on the e-filing portal under s.158BC.",
    L + 5, p.y + 10, { size: 7, weight: "medium", color: [122, 80, 24] });
  p.y += 13 + 6;
}

/** The whole document: the mock ITR-B, then the summarised computation. */
export function buildItrBPDF({ draft, result, profile, settings, sections = "both" } = {}) {
  const cfg = { ...(profile?.invoiceSettings || {}), ...(settings || {}) };
  const accent = hexToRgb(cfg.accent, [108, 92, 231]);
  const ctx = themedDoc();
  const { text, wrap, rrect } = ctx;

  const wantReturn = sections === "both" || sections === "return";
  const wantComputation = sections === "both" || sections === "computation";
  const title = wantReturn ? "ITR-B" : "COMPUTATION";
  /* Kept short on purpose: drawBrandHeader right-aligns the strapline with the
     tracking jsPDF does not measure, so a long one runs off the page edge. */
  const subtitle = wantReturn ? "BLOCK RETURN u/s 158BC" : "OF UNDISCLOSED INCOME";

  const newPage = () => drawBrandHeader(ctx, { profile, cfg, accent, title, subtitle });
  const p = pager(ctx, newPage);
  p.y = newPage();
  mockBanner(ctx, p);

  /* ---- who and what ---- */
  rrect(L, p.y, W, 18, 4, "F", [248, 247, 251]);
  text("ASSESSEE", L + 6, p.y + 6, { size: 6.6, weight: "semibold", color: accent, spacing: 0.5 });
  text(clipText(ctx, draft.assessee || "—", 118, 12.5, "bold"), L + 6, p.y + 12.6, { size: 12.5, weight: "bold", color: INK });
  text(`PAN ${draft.pan || "—"}`, R - 6, p.y + 6, { size: 8, weight: "semibold", color: BODY, align: "right" });
  text(
    draft.blockFrom ? `Block period  ${fmtDate(draft.blockFrom)} to ${fmtDate(draft.blockTo)}` : "Block period not set",
    R - 6, p.y + 12.4, { size: 8, weight: "medium", color: MUTED, align: "right" }
  );
  p.y += 18 + 7;

  if (wantReturn) {
    /* ---------------- PART A — GENERAL ---------------- */
    partHead(ctx, p, accent, "A", "General information", "Identity of the assessee, the search, and the notice under which this return is furnished");
    fieldGrid(ctx, p, [
      { label: "NAME OF ASSESSEE", value: draft.assessee, strong: true },
      { label: "PAN", value: draft.pan, mono: true, strong: true },
      { label: "STATUS", value: draft.status },
      { label: "RESIDENTIAL STATUS", value: draft.residentialStatus },
      { label: "DATE OF BIRTH / INCORPORATION", value: fmtDate(draft.dob) },
      { label: "AADHAAR", value: draft.aadhaar },
      { label: "ADDRESS", value: draft.address },
      { label: "MOBILE / E-MAIL", value: [draft.mobile, draft.email].filter(Boolean).join("  ·  ") },
      { label: "SEARCH / REQUISITION UNDER", value: draft.searchSection ? `s.${draft.searchSection}` : "" },
      { label: "A19  FIRST AUTHORISATION EXECUTED", value: fmtDate(draft.searchDate), strong: true },
      { label: "A20  LAST AUTHORISATION EXECUTED", value: fmtDate(draft.lastAuthDate || draft.searchDate), strong: true },
      { label: "DATE OF LAST PANCHNAMA", value: fmtDate(draft.lastPanchnamaDate) },
      { label: "RETURN FURNISHED UNDER", value: draft.returnSection ? `s.${draft.returnSection}` : "" },
      { label: "NOTICE u/s 158BC DATED", value: fmtDate(draft.noticeDate) },
      { label: "DIN OF NOTICE", value: draft.noticeDin, mono: true },
      { label: "DATE OF SERVICE OF NOTICE", value: fmtDate(draft.serviceDate) },
      { label: `DUE DATE (${draft.dueDateDays || 60} DAYS ALLOWED)`, value: fmtDate(draft.dueDate), strong: true },
      { label: "ACCOUNTS AUDITED u/s 44AB", value: draft.auditUs44AB ? "Yes" : "No" },
      { label: "BOOKS / DOCUMENTS FOUND IN SEARCH", value: draft.booksFound ? "Yes" : "No" },
      { label: "MUST BE FURNISHED UNDER (RULE 12AE(2))", value: furnishingMode({ status: draft.status, auditUs44AB: draft.auditUs44AB, politicalParty: draft.politicalParty }).short },
    ]);

    /* A25-A34 — the return, year by year.
     *
     * Three shapes, because the form asks three different sets of questions,
     * and a transcription sheet that flattens them into one is a sheet whose
     * rows stop matching the screen being keyed. Printed as one table with the
     * columns the widest variant needs; a row that is not asked a question
     * prints a middle dot rather than a blank, so "not asked" and "not yet
     * answered" stay distinguishable. */
    partHead(ctx, p, accent, "A25", "Returns previously filed for the years in the block period",
      "A26–A30 for Y6 to Y2, A31/A33 in full for Y1 and a complete Y0, A32/A34 for a part period");
    table(ctx, p, accent,
      [
        { label: "ROW", w: 16 },
        { label: "FIELDS", w: 20 },
        { label: "FILED ON", w: 24 },
        { label: "SECTION", w: 30 },
        { label: "FORM", w: 18 },
        { label: "ACKNOWLEDGEMENT", w: 34 },
        { label: "PENDING / DUE DATE", w: 40, align: "right" },
      ],
      result.years.map((y) => {
        const v = variantFor(y, result.spansYears);
        const a = y.partA || {};
        const label = v === "brief" ? "A26–A30" : v === "full" ? (y.slot === "Y1" ? "A31" : "A33") : (y.slot === "Y0" ? "A32" : "A34");
        if (v === "partYear") return [y.slot, label, "·", "·", "·", "·", "·"];
        if (v === "full" && y.returnFiled === false) {
          return [y.slot, label, "Not furnished", "·", a.itrFormChosen || "·", "·",
            a.dueDateExpired ? `Due date expired: ${a.dueDateExpired}` : "—"];
        }
        return [
          y.slot, label,
          fmtDate(y.filedOn) || "—",
          a.filedSection ? `s.${a.filedSection}`.replace("s.139(1) —", "s.139(1)").replace("s.139(4) —", "s.139(4)") : "—",
          v === "full" ? (y.declaredForm || "—") : "·",
          y.ackNum || "—",
          v === "brief" ? (a.pending || "—") : "·",
        ];
      }),
      { size: 6.8, pad: 2 }
    );

    /* The full-variant rows carry four money fields the brief ones do not. A
       second short table rather than four more columns above: at eight columns
       the acknowledgement number starts to clip, and an acknowledgement that
       has lost its last three digits is worse than useless. */
    const fullRows = result.years.filter((y) => variantFor(y, result.spansYears) === "full");
    const partRows2 = result.years.filter((y) => variantFor(y, result.spansYears) === "partYear");
    if (fullRows.length || partRows2.length) {
      p.need(12);
      table(ctx, p, accent,
        [
          { label: "ROW", w: 16 },
          { label: "", w: 46 },
          { label: "INCOME DECLARED", w: 40, align: "right" },
          { label: "AFTER s.143(1)", w: 30, align: "right" },
          { label: "INTL. TXNS", w: 25, align: "right" },
          { label: "SPEC. DOM. TXNS", w: 25, align: "right" },
        ],
        [
          ...fullRows.map((y) => [
            y.slot, "Return furnished for the year",
            amt(y.declaredTotal, { zero: "Nil" }), amt(y.partC.determined), amt(y.intlTxnValue), amt(y.sdtValue),
          ]),
          ...partRows2.map((y) => [
            y.slot, "Part period — break-up in Part B",
            amt(partYearIncome(y, result), { zero: "Nil" }), "·", amt(y.intlTxnValue), amt(y.sdtValue),
          ]),
        ],
        { size: 6.8, pad: 2 }
      );
    }
    p.need(8);
    text("A middle dot marks a field the form does not ask of that row. The income of a part period is stated here and broken up in Part B.",
      L, p.y, { size: 6.8, weight: "medium", color: MUTED });
    p.y += 8;

    /* ---------------- PART B — THE PART PERIOD, HEAD BY HEAD ---------------- */
    if (result.partBRow) {
      partHead(ctx, p, accent, "B", "Break-up of the part period's income",
        `${result.partBRow.slot} — A.Y. ${result.partBRow.ay}, to ${fmtDate(result.partBRow.to)} — s.158BB(1A)(c)(ii) and (iii)`);
      table(ctx, p, accent,
        [
          { label: "", w: 14 },
          { label: "PARTICULARS", w: 130 },
          { label: "AMOUNT (₹)", w: 38, align: "right" },
        ],
        PART_B_ROWS.map((row) => {
          if (row.heading) return { 0: `${row.no}.  ${row.heading}`, _span: true, _tone: "sub" };
          const pad = "     ".repeat(row.indent || 0);
          const value = result.partB.rows[row.key] || 0;
          const cells = [row.no, `${pad}${row.label}${row.nilIfLoss ? "  (nil if loss)" : ""}`, amt(value, { zero: "Nil" })];
          if (row.grand) return { 0: cells[0], 1: cells[1], 2: cells[2], _tone: "total" };
          if (row.of) return { 0: cells[0], 1: cells[1], 2: cells[2], _tone: "sub" };
          return cells;
        }),
        { size: 6.8, pad: 2 }
      );
      if (result.partB.floored.length) {
        p.need(9);
        wrap(`Carried at nil because the form says so on ${result.partB.floored.map((f) => f.no).join(", ")}: a head that lost money in the part period cannot shelter income in another head of the same period.`,
          W - 4, 6.8, "regular").forEach((ln) => { text(ln, L, p.y, { size: 6.8, weight: "medium", color: MUTED }); p.y += 3.2; });
        p.y += 4;
      }
      p.need(8);
      text(result.partBTie.ties
        ? `Row 6 agrees with the ${amt(result.partBTie.partCTotal, { zero: "Nil" })} Part C states for the same period.`
        : `Row 6 comes to ${amt(result.partBTie.partBTotal)} against the ${amt(result.partBTie.partCTotal)} Part C states for the same period. The form requires the two to agree.`,
        L, p.y, { size: 6.8, weight: "semibold", color: result.partBTie.ties ? BODY : [193, 51, 120] });
      p.y += 8;
    }

    /* ---------------- PART C — COMPUTATION OF UNDISCLOSED INCOME ---------------- */
    partHead(ctx, p, accent, "C", "Computation of undisclosed income",
      "Column [A] — undisclosed income declared for each year comprised in the block period, s.158BB(1)(a) r.w.s. 158B(b)");
    table(ctx, p, accent,
      [
        // The form's own row names, so the person keying the portal is looking
        // for the same labels on both sheets.
        { label: "ROW", w: 16 },
        { label: "PREVIOUS YEAR", w: 34 },
        { label: "A.Y.", w: 22 },
        { label: "RETURN FILED", w: 32 },
        { label: "DECLARED", w: 26, align: "right" },
        { label: "UNDISCLOSED [A]", w: 26, align: "right" },
        { label: "TOTAL", w: 26, align: "right" },
      ],
      [
        ...result.years.map((y) => [
          y.slot || "",
          y.part ? `${y.py} (part)` : y.py,
          y.ay,
          y.returnFiled === false ? "Not filed" : [y.declaredForm, y.ackNum].filter(Boolean).join(" · ") || "—",
          returned(y),
          amt(y.totalUndisclosed, { zero: "Nil" }),
          amt(y.assessedTotal, { zero: "Nil" }),
        ]),
        {
          0: "", 1: "TOTAL", 2: "", 3: "",
          4: amt(result.totalDeclared, { zero: "Nil" }),
          5: amt(result.totalUndisclosed, { zero: "Nil" }),
          6: amt(result.totalDeclared + result.totalUndisclosed, { zero: "Nil" }),
          _tone: "total",
        },
      ]
    );
    p.need(9);
    text(draft.blockSpansYears
      ? `The last authorisation was executed in a later previous year, so Y0 is a complete year and Y+1 is the part period ending ${fmtDate(result.years[result.years.length - 1].to)} — the form's second Part C table applies (s.158B(b), Note 1).`
      : `Y0 is the part period ending ${fmtDate(result.years[result.years.length - 1].to)}, the date the last authorisation was executed — the form's first Part C table applies (s.158B(b), Note 1).`,
      L, p.y, { size: 6.8, weight: "medium", color: MUTED });
    p.y += 6;
    p.y += 3;

    /* Part C's context columns, as the form's own table.
     *
     * Set landscape-tight rather than split across two tables: the whole point
     * of these columns is that a reader can run an eye across one year and see
     * the undisclosed income beside everything already on record for it, and a
     * second table on another page loses exactly that. */
    const cCols = columnsFor(result.spansYears);
    /* Headed by the bare letter. The legend printed directly beneath says what
       each one is, and an abbreviated heading in a 20mm column says neither —
       it clips to "[E] YEAR EN…", which tells a reader less than "[E]" does. */
    const cw = (W - 20) / (cCols.length + 1);
    text("PART C — COLUMNS [B] TO [H]: INCOME ALREADY DETERMINED, ASSESSED OR DECLARED",
      L, p.y + 3, { size: 6.6, weight: "semibold", color: accent, spacing: 0.3 });
    p.y += 8;
    table(ctx, p, accent,
      [
        { label: "ROW", w: 20 },
        { label: "[A]", w: cw, align: "right" },
        ...cCols.map((c) => ({ label: `[${c.letter}]`, w: cw, align: "right" })),
      ],
      [
        ...result.years.map((y) => [
          y.slot || "",
          amt(y.totalUndisclosed, { zero: "Nil" }),
          ...cCols.map((c) => (appliesTo(c, y, result.spansYears) ? amt(y.partC[c.key]) : "·")),
        ]),
        {
          0: "TOTAL",
          1: amt(result.totalUndisclosed, { zero: "Nil" }),
          ...Object.fromEntries(cCols.map((c, i) => [i + 2, amt(result.byPartCColumn[c.key])])),
          _tone: "total",
        },
      ],
      { size: 6.6, pad: 1.6 }
    );
    p.y += 1;
    // The sections travel with columns [B] and [C], and are printed beneath
    // rather than as sub-columns: at this width a section would cost a figure.
    const withSections = result.years.filter((y) => y.partC.determinedSection || y.partC.returnedSection);
    if (withSections.length) {
      p.need(6 + withSections.length * 3.6);
      withSections.forEach((y) => {
        const bits = [
          y.partC.determinedSection ? `[B] s.${y.partC.determinedSection}` : "",
          y.partC.returnedSection ? `[C] s.${y.partC.returnedSection}` : "",
        ].filter(Boolean).join("   ·   ");
        text(`${y.slot}  ${bits}`, L, p.y, { size: 6.6, color: MUTED });
        p.y += 3.6;
      });
      p.y += 3;
    }
    // The one cross-check the form spells out for these columns.
    p.need(8);
    text(`Total of ${partBColumns(result.spansYears).map((k) => `[${cCols.find((c) => c.key === k).letter}]`).join(" and ")} is ${amt(result.partBTotal, { zero: "Nil" })} — the form requires this to equal row 6 of Part B, which is completed on the portal.`,
      L, p.y, { size: 6.8, weight: "semibold", color: BODY });
    p.y += 6;
    if (result.misplacedPartC.length) {
      p.need(8);
      text(`Figures sit in columns that do not belong to their rows: ${result.misplacedPartC.map((m) => `[${m.letter}] against ${m.slot}`).join(", ")}.`,
        L, p.y, { size: 6.8, weight: "semibold", color: [193, 51, 120] });
      p.y += 6;
    }
    /* What each letter means, once, under the table. The headers above are
       abbreviated to three or four words to fit eight columns across the page,
       and an abbreviation is only readable to somebody who already knows what
       it stands for — which is precisely not the person checking this. */
    p.need(10);
    text("WHAT THE COLUMNS ARE", L, p.y + 3, { size: 6.4, weight: "semibold", color: accent, spacing: 0.3 });
    p.y += 7;
    cCols.forEach((c) => {
      const lines = wrap(`[${c.letter}]  ${labelFor(c, result.spansYears)}  {s.${c.ref}}`, W - 4, 6.4, "regular");
      p.need(lines.length * 3 + 2);
      lines.forEach((ln) => { text(ln, L, p.y, { size: 6.4, color: MUTED }); p.y += 3; });
      p.y += 1;
    });
    p.y += 3;
    if (result.years.some((y) => y.floored)) {
      p.need(8);
      text("A year whose heads net to a loss is carried at nil: no loss is set off against the undisclosed income of the block period — s.158BB(4).",
        L, p.y, { size: 6.8, weight: "medium", color: MUTED });
      p.y += 6;
    }
    p.y += 2;

    /* ---------------- PART C — HEAD-WISE UNDISCLOSED INCOME ---------------- */
    partHead(ctx, p, accent, "D-I", "Head-wise break-up of the undisclosed income",
      "The total declared in column [A] of Part C, head by head");
    const headW = (W - 22 - 24) / UNDISCLOSED_HEADS.length;
    table(ctx, p, accent,
      [
        { label: "A.Y.", w: 22 },
        ...UNDISCLOSED_HEADS.map((h) => ({ label: h.abbr, w: headW, align: "right" })),
        { label: "TOTAL", w: 24, align: "right" },
      ],
      [
        ...result.years.map((y) => [
          y.ay,
          ...UNDISCLOSED_HEADS.map((h) => amt(y.undisclosed[h.key], { zero: "—" })),
          amt(y.totalUndisclosed, { zero: "Nil" }),
        ]),
        {
          0: "TOTAL",
          ...Object.fromEntries(UNDISCLOSED_HEADS.map((h, i) => [i + 1, amt(result.byHead[h.key], { zero: "—" })])),
          [UNDISCLOSED_HEADS.length + 1]: amt(result.totalUndisclosed, { zero: "Nil" }),
          _tone: "total",
        },
      ]
    );

    /* Part D-II. The same total again, item by item, in the form's own fourteen
       rows — and the form requires this table to cast to Part D-I's row 6. When
       it does not, that is said here rather than left to be discovered on the
       portal. */
    partHead(ctx, p, accent, "D-II", "Item-wise break-up of the undisclosed income",
      "The same total as Part D-I, described item by item");
    /* Eight year columns and a total across 182mm leaves about 13mm a column,
       so this table is set a notch smaller and uses the items' short names. A
       clipped LABEL is a nuisance; a clipped FIGURE is a wrong number. */
    const dIIcols = [
      { label: "ITEM", w: 50 },
      ...result.years.map((y) => ({ label: y.slot || y.ay, w: (W - 50 - 24) / result.years.length, align: "right" })),
      { label: "TOTAL", w: 24, align: "right" },
    ];
    table(ctx, p, accent, dIIcols, [
      ...DII_ITEMS.map((item) => [
        `${item.no}. ${item.short}`,
        ...result.years.map((y) => (item.completeYearOnly && y.part ? "—" : amt(y.items[item.key]))),
        amt(result.byItem[item.key]),
      ]),
      {
        0: "TOTAL — ITEM-WISE",
        ...Object.fromEntries(result.years.map((y, i) => [i + 1, amt(y.itemTotal, { zero: "—" })])),
        [result.years.length + 1]: amt(result.totalByItem, { zero: "Nil" }),
        _tone: "total",
      },
    ], { size: 6.2, pad: 1.4 });
    if (result.itemsEntered && !result.itemsTie) {
      p.need(8);
      text(`Part D-II totals ${amt(result.totalByItem)} against Part D-I's ${amt(result.totalUndisclosed)}. The form requires the two to agree.`,
        L, p.y, { size: 6.8, weight: "semibold", color: [193, 51, 120] });
      p.y += 7;
    }
    if (result.misplaced158BB3.length) {
      p.need(10);
      wrap(`Rows 11 and 12 carry income for ${result.misplaced158BB3.join(", ")}, which is a part period. Under s.158BB(3) and Note 4 to the form, undisclosed income from an international or specified domestic transaction in a part period is assessed under the ordinary provisions and does not form part of this return.`,
        W - 4, 6.8, "regular").forEach((ln) => { text(ln, L, p.y, { size: 6.8, weight: "semibold", color: [193, 51, 120] }); p.y += 3.2; });
      p.y += 4;
    }
    const partRows = result.years.filter((y) => y.part && (y.intlTxnValue || y.sdtValue));
    if (partRows.length) {
      p.need(8 + partRows.length * 4);
      text("AGGREGATE VALUE OF TRANSACTIONS IN THE PART PERIOD (A32 / A34)", L, p.y + 3, { size: 6.6, weight: "semibold", color: accent, spacing: 0.3 });
      p.y += 8;
      partRows.forEach((y) => {
        text(`${y.ay} — international ${amt(y.intlTxnValue)} · specified domestic ${amt(y.sdtValue)}`,
          L, p.y, { size: 7.2, color: BODY });
        p.y += 4;
      });
      p.y += 3;
    }

    /* Manner of derivation and the material it comes from — s.158BC(1)(a) asks
       for both, and a block return that states a figure without them invites
       the first question of the assessment. */
    const withNotes = result.years.filter((y) => y.manner || y.evidence);
    if (withNotes.length) {
      p.need(14);
      text("MANNER IN WHICH THE UNDISCLOSED INCOME WAS DERIVED, AND THE MATERIAL IT IS BASED ON",
        L, p.y + 3, { size: 6.6, weight: "semibold", color: accent, spacing: 0.3 });
      p.y += 8;
      withNotes.forEach((y) => {
        const manner = wrap(y.manner || "—", W - 26, 7.4, "regular");
        const evidence = y.evidence ? wrap(`Material: ${y.evidence}`, W - 26, 7, "regular") : [];
        const h = 5 + manner.length * 3.6 + evidence.length * 3.4 + 3;
        p.need(h + 2);
        text(y.ay, L + 1, p.y + 4, { size: 7.4, weight: "bold", color: INK });
        let ty = p.y + 4;
        manner.forEach((ln) => { text(ln, L + 24, ty, { size: 7.4, color: BODY }); ty += 3.6; });
        evidence.forEach((ln) => { text(ln, L + 24, ty, { size: 7, color: MUTED }); ty += 3.4; });
        p.y += h;
        ctx.line(L, p.y - 2, R, p.y - 2, LINE, 0.2);
      });
      p.y += 4;
    }

    /* ---------------- PART D — TAX ---------------- */
    partHead(ctx, p, accent, "E", "Tax payable",
      "60% of the undisclosed income of the block period — s.158BA(7) r.w.s. 113 — with interest under s.158BFA(1)");
    table(ctx, p, accent,
      [
        { label: "PARTICULARS", w: 118 },
        { label: "BASIS", w: 34 },
        { label: "AMOUNT (₹)", w: 30, align: "right" },
      ],
      [
        ["Undisclosed income of the block period — Part C", "158BB(5)", amt(result.totalUndisclosed, { zero: "Nil" })],
        ["Rounded off", "288B", amt(result.roundedUndisclosed, { zero: "Nil" })],
        [`1.  Tax payable on the undisclosed income @ ${result.tax.rate}%`, "113", amt(result.tax.amount, { zero: "Nil" })],
        [`2.  Surcharge on (1) above`, `@ ${result.tax.surchargeRate}%`, amt(result.tax.surcharge, { zero: "Nil" })],
        [`3.  Health and education cess on (1+2)`, `@ ${result.tax.cessRate}%`, amt(result.tax.cess, { zero: "Nil" })],
        { 0: "4.  Total tax payable (1+2+3)", 1: "", 2: amt(result.tax.grossLiability, { zero: "Nil" }), _tone: "sub" },
        [`5.  Interest payable`, `158BFA(1) · ${result.tax.interestMonths} mth`, amt(result.tax.interest, { zero: "Nil" })],
        { 0: "6.  Gross tax payable on the undisclosed income", 1: "", 2: amt(result.tax.aggregate, { zero: "Nil" }), _tone: "total" },
        ["7.  Taxes paid — Parts F, G and H", "", amt(-(result.credits.total + result.blockTaxPaidTotal), { zero: "Nil" })],
        {
          0: result.netPayable > 0 ? "8.  Balance payable" : "8.  Balance refundable", 1: "",
          2: amt(result.netPayable > 0 ? result.netPayable : result.refundDue, { zero: "Nil" }),
          _tone: "total",
        },
      ]
    );

    /* ---------------- PART E — TAXES PAID ---------------- */
    /* Part F — self-assessment tax for the block period, by challan. This is
       the one payment rule 12AE(4) does NOT make conditional on the Assessing
       Officer's satisfaction: it is money paid against this very return. */
    partHead(ctx, p, accent, "F", "Taxes paid on the undisclosed income of the block period",
      "Self-assessment tax for the block period, challan by challan");
    table(ctx, p, accent,
      [
        { label: "BSR CODE", w: 40 },
        { label: "DATE OF DEPOSIT", w: 46 },
        { label: "SERIAL NO. OF CHALLAN", w: 56 },
        { label: "AMOUNT (₹)", w: 40, align: "right" },
      ],
      [
        ...(result.blockTaxPaid.length
          ? result.blockTaxPaid.map((c) => [c.bsrCode || "—", fmtDate(c.date) || "—", c.challanNo || "—", amt(c.amount)])
          : [{ 0: "No self-assessment tax recorded against the block period.", _span: true, _muted: true }]),
        { 0: "TOTAL", 1: "", 2: "", 3: amt(result.blockTaxPaidTotal, { zero: "Nil" }), _tone: "total" },
      ]
    );

    /* Parts G and H — credit for tax paid in earlier years. Kept apart because
       the form keeps them apart and the conditions differ: H is confined to
       TDS and TCS for which no credit has been claimed in any earlier return. */
    partHead(ctx, p, accent, "G", "Advance tax and self-assessment tax paid earlier",
      "Credit sought against the undisclosed income — allowable only on the Assessing Officer's verification (rule 12AE(4))");
    table(ctx, p, accent,
      [
        { label: "ASSESSMENT YEAR", w: 62 },
        { label: "ADVANCE TAX", w: 40, align: "right" },
        { label: "SELF-ASSESSMENT TAX", w: 40, align: "right" },
        { label: "TOTAL", w: 40, align: "right" },
      ],
      [
        ...result.years.map((y) => [y.ay, amt(y.credits.advance), amt(y.credits.selfAssessment), amt(y.credits.partG, { zero: "—" })]),
        { 0: "TOTAL — PART G", 1: amt(result.credits.advance), 2: amt(result.credits.selfAssessment), 3: amt(result.credits.partG, { zero: "Nil" }), _tone: "total" },
      ]
    );

    /* Part H in the form's own columns. Printing only the net would hide the
       working the portal asks for — and the working is the point: (6) is (4)
       less (5), and a credit the earlier return already claimed, very often
       already refunded, is what (5) takes out. */
    partHead(ctx, p, accent, "H", "TDS and TCS not claimed earlier",
      "Credit sought only where no credit has been claimed in any return filed u/s 139, or no return was filed");
    table(ctx, p, accent,
      [
        { label: "ASSESSMENT YEAR", w: 40 },
        { label: "TAN", w: 34 },
        { label: "(4) CREDIT AVAILABLE", w: 36, align: "right" },
        { label: "(5) CLAIMED U/S 139", w: 36, align: "right" },
        { label: "(6) CLAIMED HERE", w: 36, align: "right" },
      ],
      [
        ...result.years.map((y) => [
          y.ay, y.credits.tan || "—",
          amt(y.credits.available), amt(y.credits.claimedEarlier),
          amt(y.credits.partH, { zero: "—" }),
        ]),
        {
          0: "TOTAL — PART H", 1: "",
          2: amt(result.credits.available), 3: amt(result.credits.claimedEarlier),
          4: amt(result.credits.partH, { zero: "Nil" }), _tone: "total",
        },
      ]
    );
    p.need(8);
    text("Column (6) is (4) less (5) and is the only figure that reduces the tax: a credit the earlier return already claimed — and where it produced a refund, already received — cannot be taken twice. Part G is confined the same way, to challans no earlier return claimed credit for. The portal asks for Part G by challan: BSR code, date of deposit and serial number.",
      L, p.y, { size: 6.8, weight: "medium", color: MUTED });
    p.y += 10;

    /* ---- the closing position ---- */
    p.need(22);
    const payable = result.netPayable > 0;
    const tone = payable ? [193, 51, 120] : [26, 140, 92];
    rrect(L, p.y, W, 17, 4, "F", tint(tone, 0.88));
    text(payable ? "TAX PAYABLE ON THE BLOCK RETURN" : "REFUND DUE", L + 6, p.y + 6.5,
      { size: 6.8, weight: "semibold", color: tone, spacing: 0.5 });
    text(`₹ ${amt(payable ? result.netPayable : result.refundDue, { zero: "Nil" })}`, L + 6, p.y + 13.4,
      { size: 14, weight: "extrabold", color: tone });
    text("Aggregate liability less credit for taxes paid", R - 6, p.y + 13.4,
      { size: 7.4, weight: "medium", color: MUTED, align: "right" });
    p.y += 17 + 7;

    /* ---- verification ---- */
    partHead(ctx, p, accent, "§", "Verification", "");
    // Verbatim from the notified form. Not ours to reword.
    const decl = VERIFICATION_TEXT(draft.verifierName, draft.verifierFather, draft.verifierCapacity, draft.verifierPan);
    const lines = wrap(decl, W - 4, 7.6, "regular");
    p.need(lines.length * 3.8 + 26);
    lines.forEach((ln) => { text(ln, L + 2, p.y + 3, { size: 7.6, color: BODY }); p.y += 3.8; });
    p.y += 10;
    fieldGrid(ctx, p, [
      { label: "PLACE", value: draft.verificationPlace },
      { label: "DATE", value: fmtDate(draft.verificationDate) },
      { label: "PAN OF VERIFIER", value: draft.verifierPan, mono: true },
      { label: "SIGNATURE", rule: true },
    ]);
  }

  /* ---------------- SUMMARISED COMPUTATION ---------------- */
  if (wantComputation) {
    if (wantReturn) { ctx.doc.addPage(); p.y = newPage(); }
    partHead(ctx, p, accent, "§", "Summarised computation of income — block period",
      "Head by head, for each previous year in the block period");

    const yearW = (W - 64) / Math.max(1, result.years.length);
    const cols = [
      { label: "HEAD OF INCOME", w: 64 },
      ...result.years.map((y) => ({ label: y.ay, w: yearW, align: "right" })),
    ];

    /* Declared, then undisclosed, then the total for each year. Three blocks in
       one table so a reader's eye runs down a single column for a year rather
       than across three tables. */
    const rows = [];
    rows.push({ 0: "Income disclosed in the return filed", _tone: "sub", _muted: true, _span: true });
    HEADS.forEach((h) => {
      rows.push([h.label, ...result.years.map((y) => amt(y.declared && y.declared[h.key]))]);
    });
    rows.push({ 0: "Total income returned", ...Object.fromEntries(result.years.map((y, i) => [i + 1, returned(y)])), _tone: "sub" });

    rows.push({ 0: "Undisclosed income determined on the material found in the search", _tone: "sub", _muted: true, _span: true });
    UNDISCLOSED_HEADS.forEach((h) => {
      rows.push([h.label, ...result.years.map((y) => amt(y.undisclosed[h.key]))]);
    });
    rows.push({ 0: "Total undisclosed income", ...Object.fromEntries(result.years.map((y, i) => [i + 1, amt(y.totalUndisclosed, { zero: "Nil" })])), _tone: "sub" });

    rows.push({ 0: "TOTAL INCOME — BLOCK ASSESSMENT", ...Object.fromEntries(result.years.map((y, i) => [i + 1, amt(y.assessedTotal, { zero: "Nil" })])), _tone: "total" });
    table(ctx, p, accent, cols, rows, { size: 7, pad: 1.8 });

    /* The tax working, restated so the computation stands on its own — it is the
       sheet that goes to the client, and it has to be readable without the
       return stapled to it. */
    p.need(12);
    text("TAX ON THE UNDISCLOSED INCOME OF THE BLOCK PERIOD", L, p.y + 3, { size: 6.8, weight: "semibold", color: accent, spacing: 0.35 });
    p.y += 8;
    table(ctx, p, accent,
      [
        { label: "PARTICULARS", w: 130 },
        { label: "SECTION", w: 26 },
        { label: "AMOUNT (₹)", w: 26, align: "right" },
      ],
      [
        ["Total undisclosed income of the block period (rounded off)", "158BB / 288B", amt(result.roundedUndisclosed, { zero: "Nil" })],
        [`Tax @ ${result.tax.rate}%`, "113", amt(result.tax.amount, { zero: "Nil" })],
        [`Surcharge @ ${result.tax.surchargeRate}%`, "113 proviso", amt(result.tax.surcharge, { zero: "Nil" })],
        [`Health and education cess @ ${result.tax.cessRate}%`, "", amt(result.tax.cess, { zero: "Nil" })],
        [`Interest for ${result.tax.interestMonths} month${result.tax.interestMonths === 1 ? "" : "s"} @ ${result.tax.interestRate}%`, "158BFA(1)", amt(result.tax.interest, { zero: "Nil" })],
        { 0: "Aggregate liability", 1: "", 2: amt(result.tax.aggregate, { zero: "Nil" }), _tone: "sub" },
        ["Less: taxes already paid (TDS, TCS, advance and self-assessment tax)", "", amt(-result.credits.total, { zero: "Nil" })],
        {
          0: result.netPayable > 0 ? "TAX PAYABLE" : "REFUND DUE", 1: "",
          2: amt(result.netPayable > 0 ? result.netPayable : result.refundDue, { zero: "Nil" }),
          _tone: "total",
        },
      ]
    );

    p.need(16);
    text(`Penalty exposure — s.158BFA(2) at ${RATE_PENALTY}% of the tax on undisclosed income: ₹ ${amt(result.penaltyExposure, { zero: "Nil" })}.`,
      L, p.y + 3, { size: 7.2, weight: "semibold", color: BODY });
    p.y += 5;
    wrap("Not part of this return and not included in any figure above. It is stated so that the exposure is on the same sheet as the declaration it follows from — no penalty is leviable on undisclosed income that is declared in this return, the tax on it is paid, and evidence of payment is furnished with it.",
      W - 4, 6.8, "regular").forEach((ln) => { text(ln, L, p.y + 3, { size: 6.8, color: MUTED }); p.y += 3.2; });
    p.y += 4;

    if (draft.notes) {
      p.need(14);
      text("NOTES", L, p.y + 3, { size: 6.6, weight: "semibold", color: accent, spacing: 0.35 });
      p.y += 7;
      wrap(draft.notes, W - 4, 7.2, "regular").forEach((ln) => { text(ln, L, p.y + 3, { size: 7.2, color: BODY }); p.y += 3.5; });
      p.y += 4;
    }
  }

  /* The closing disclaimer. Last thing on the last page, every time. */
  p.need(16);
  ctx.line(L, p.y, R, p.y, LINE, 0.3);
  p.y += 4;
  wrap(`Prepared on ${today()} by ProHippo from the figures entered by the practitioner and from the returns already on file. It is a working paper, not a return: the block return must be furnished electronically on the e-filing portal under s.158BC, verified as required by rule 12AE. Check every figure against the seized material and the returns before filing.`,
    W - 4, 6.6, "regular").forEach((ln) => { ctx.text(ln, L, p.y + 3, { size: 6.6, color: MUTED }); p.y += 3.1; });

  drawFooter(ctx, { cfg, profile });
  return ctx.doc;
}

/** Filename a practitioner would have chosen. */
export const itrbFilename = (draft, sections = "both") => {
  const who = (draft.assessee || draft.pan || "ITR-B").replace(/[\\/:*?"<>|]+/g, "").trim();
  const what = sections === "computation"
    ? "Computation of income"
    : sections === "return" ? "ITR-B transcription sheet" : "ITR-B (mock) and computation";
  const period = draft.searchDate ? ` — search ${draft.searchDate}` : "";
  return `${what} — ${who}${period}.pdf`;
};
