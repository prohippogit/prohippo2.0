/*
 * House style tokens for the Computation of Income — docs/computation-spec.md §6.
 *
 * This palette is shared with BillHippo and with the appellate drafting
 * templates. It is settled: match it, don't redesign it.
 *
 * The stylesheet is emitted inline into the document. It must not reference a
 * single external URL — the render function loads the page with no network
 * access at all (§13), so an external stylesheet or webfont is a silent blank.
 */

export const TOKENS = {
  navy900: "#0B2545",
  navy700: "#13315C",
  navy500: "#1B4079",
  gold500: "#C9A227",
  gold300: "#E4C05C",
  goldBg: "#FFF6DC",
  loss: "#B23B3B",
  green1: "#0E4C3A",
  green2: "#13795C",
  ink: "#1B2537",
  muted: "#8A93A3",
  nilInk: "#9AA3B2",
  hairline: "#E2E7F0",
  rowBg: "#F4F6FA",
  nilBg: "#FAFBFC",
  cardBg: "#FFFFFF",
  pageBg: "#FFFFFF",
};

export function stylesheet() {
  const t = TOKENS;
  return `
:root {
  --navy-900: ${t.navy900}; --navy-700: ${t.navy700}; --navy-500: ${t.navy500};
  --gold-500: ${t.gold500}; --gold-300: ${t.gold300}; --gold-bg: ${t.goldBg};
  --loss: ${t.loss}; --green-1: ${t.green1}; --green-2: ${t.green2};
  --ink: ${t.ink}; --muted: ${t.muted}; --nil: ${t.nilInk}; --hairline: ${t.hairline};
  --row-bg: ${t.rowBg}; --nil-bg: ${t.nilBg}; --card-bg: ${t.cardBg};
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: 'Montserrat', 'Segoe UI', system-ui, sans-serif;
  color: var(--ink);
  background: ${t.pageBg};
  font-size: 10.5pt;
  line-height: 1.42;
  /* Amounts must line up column-wise down a page of figures. */
  font-variant-numeric: tabular-nums;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

/* A section must never split across a page — a total row orphaned from the rows
   it totals is unreadable, and worse, misreadable. */
.card {
  background: var(--card-bg);
  border: 1px solid var(--hairline);
  border-radius: 18px;
  padding: 16px 18px;
  margin-bottom: 12px;
  break-inside: avoid;
  page-break-inside: avoid;
}

/* ---- masthead ---------------------------------------------------------- */
.masthead {
  position: relative;
  overflow: hidden;
  border-radius: 26px;
  padding: 22px 26px 20px;
  margin-bottom: 14px;
  color: #fff;
  background: linear-gradient(120deg, var(--navy-900) 0%, var(--navy-700) 55%, var(--navy-500) 100%);
  break-inside: avoid;
}
.masthead .blob {
  position: absolute; border-radius: 50%; pointer-events: none;
}
.masthead .blob-gold { right: -60px; top: -70px; width: 240px; height: 240px; background: ${t.gold500}; opacity: .22; }
.masthead .blob-white { right: 40px; bottom: -110px; width: 200px; height: 200px; background: #fff; opacity: .07; }
.masthead .eyebrow {
  position: relative; font-size: 8pt; font-weight: 700; letter-spacing: .16em;
  text-transform: uppercase; color: var(--gold-300); margin-bottom: 6px;
}
.masthead h1 { position: relative; margin: 0 0 6px; font-size: 21pt; font-weight: 800; letter-spacing: -.01em; }
.masthead .addr { position: relative; font-size: 9pt; opacity: .86; margin-bottom: 12px; }
.chips { position: relative; display: flex; flex-wrap: wrap; gap: 7px; }
.chip {
  border: 1px solid rgba(255,255,255,.34); border-radius: 999px;
  padding: 3px 11px; font-size: 8.5pt; font-weight: 600;
}
.chip b { color: var(--gold-300); font-weight: 700; margin-right: 5px; }

/* ---- section headers --------------------------------------------------- */
.pill {
  display: inline-block; border-radius: 999px; padding: 5px 14px;
  font-size: 8.5pt; font-weight: 700; letter-spacing: .09em; text-transform: uppercase;
  color: #fff; background: var(--navy-900); margin-bottom: 10px;
}
.pill.gold { background: var(--gold-500); }
.pill.slate { background: var(--navy-500); }

/* ---- figure tables ----------------------------------------------------- */
table.rows { width: 100%; border-collapse: separate; border-spacing: 0 2px; }
table.rows td { padding: 6px 10px; vertical-align: top; }
td.label { width: auto; }
/* Wide enough that "Gross Receipt" and "Business Loss" — the widest things the
   middle column ever carries — sit on one line. */
td.ref { width: 118px; text-align: right; color: var(--muted); font-size: 8.5pt; padding-top: 8px; }
td.amt { width: 118px; text-align: right; font-weight: 600; white-space: nowrap; }

tr.r-sub td { background: transparent; }
tr.r-sub:nth-child(even) td { background: var(--nil-bg); }
tr.r-sub td:first-child { border-top-left-radius: 11px; border-bottom-left-radius: 11px; }
tr.r-sub td:last-child { border-top-right-radius: 11px; border-bottom-right-radius: 11px; }

tr.r-subtotal td { background: var(--gold-bg); font-weight: 700; }
tr.r-subtotal td:first-child { border-top-left-radius: 11px; border-bottom-left-radius: 11px; }
tr.r-subtotal td:last-child { border-top-right-radius: 11px; border-bottom-right-radius: 11px; }

tr.r-total td { background: var(--navy-900); color: #fff; font-weight: 700; }
tr.r-total td.ref { color: rgba(255,255,255,.6); }
tr.r-total td:first-child { border-top-left-radius: 12px; border-bottom-left-radius: 12px; }
tr.r-total td:last-child { border-top-right-radius: 12px; border-bottom-right-radius: 12px; }

tr.r-head td { background: var(--row-bg); }
tr.r-head td:first-child { border-top-left-radius: 11px; border-bottom-left-radius: 11px; }
tr.r-head td:last-child { border-top-right-radius: 11px; border-bottom-right-radius: 11px; }

tr.r-columnHeader td { font-weight: 700; font-size: 9pt; padding-bottom: 2px; }
tr.r-columnHeader td.ref, tr.r-columnHeader td.amt { color: var(--ink); font-size: 9pt; }

/* A nil row is greyed but never hidden: the head exists and its income is nil,
   which is a statement a computation has to make (§4).
 *
 * Greying is applied PER ROW KIND, not blanket. A subtotal or a total keeps its
 * band — gold and navy respectively — and only its text lightens. Dropping the
 * band on a nil total leaves near-white text on a near-white row, i.e. an
 * invisible "Total Income", which is the worst possible thing for this document
 * to do. These rules sit after the kind rules above so they win on order. */
tr.r-sub.nil td, tr.r-head.nil td { background: var(--nil-bg); }
tr.r-sub.nil td.label, tr.r-sub.nil td.amt,
tr.r-head.nil td.label, tr.r-head.nil td.amt { color: var(--nil); font-weight: 500; }
tr.r-subtotal.nil td.label, tr.r-subtotal.nil td.amt { color: #9C8642; }
tr.r-total.nil td.label, tr.r-total.nil td.amt { color: rgba(255,255,255,.78); }

.amt.loss { color: var(--loss); }
tr.r-total .amt.loss { color: #FFC9C9; }

.note-line { font-size: 8.5pt; color: var(--muted); margin-top: 2px; }
.footnote { font-size: 8.5pt; color: var(--muted); margin-top: 8px; padding: 0 10px; }

/* ---- ledger tables (Section.layout === 'table') -------------------------
 *
 * A working reads down the page — a figure, what is added to it, what is taken
 * off it, the result — so its rows float as separate rounded bands with nothing
 * ruling them into columns. A ledger reads ACROSS as well: losses carried
 * forward are an assessment year, the date that year's return was filed and an
 * amount, and the reader is comparing one row against another. Those want
 * keeplines.
 *
 * The rounding lives on a frame around the table, not on the table. Collapsed
 * borders are what make the keeplines single hairlines rather than double ones,
 * and a table with collapsed borders will not round its own corners in
 * Chromium; the frame clips them instead, which also rounds the navy total
 * closing the table without any rule of its own. */
.grid-frame {
  border: 1px solid var(--hairline);
  border-radius: 16px;
  overflow: hidden;
}
table.rows.grid { border-collapse: collapse; border-spacing: 0; }
table.rows.grid td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--hairline);
}
table.rows.grid td + td { border-left: 1px solid var(--hairline); }
table.rows.grid tr:last-child td { border-bottom: 0; }
/* The frame draws the outer edge; the cells must not draw it a second time. */
table.rows.grid tr td:first-child, table.rows.grid tr td:last-child { border-radius: 0; }
/* In a ledger the middle column is data — a filing date, the nature of the loss
   — not a source reference, so it is set in ink rather than the muted grey a
   working uses, and centred under its heading. */
table.rows.grid td.ref {
  width: 158px; text-align: center; padding-top: 9px;
  white-space: nowrap; color: var(--ink);
}

/* The column heading — banded, and repeated where a ledger carries a second
   table under the first (losses, then unabsorbed depreciation). */
table.rows.grid tr.r-columnHeader td {
  background: var(--row-bg);
  color: var(--navy-700);
  font-size: 8pt;
  font-weight: 700;
  letter-spacing: .07em;
  text-transform: uppercase;
  padding: 9px 12px;
  border-top: 1px solid var(--hairline);
  border-bottom-color: var(--hairline);
}
table.rows.grid tr.r-columnHeader td.ref, table.rows.grid tr.r-columnHeader td.amt {
  color: var(--navy-700); font-size: 8pt;
}
/* The dates below it are kept on one line; the heading over them may wrap. */
table.rows.grid tr.r-columnHeader td.ref { white-space: normal; }
table.rows.grid tr:first-child td { border-top: 0; }

/* Banding would fight the keeplines; the rules already separate the rows. */
table.rows.grid tr.r-sub:nth-child(even) td { background: transparent; }
table.rows.grid tr.r-sub.nil td { background: transparent; }

/* ---- particulars ------------------------------------------------------- */
.facts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px 18px; }
.fact .k { font-size: 8pt; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--muted); margin-bottom: 2px; }
.fact .v { font-size: 9.5pt; font-weight: 600; white-space: pre-line; }

.partners { display: flex; flex-wrap: wrap; gap: 10px; }
.partner { border: 1px solid var(--hairline); border-radius: 12px; padding: 8px 12px; flex: 1 1 210px; }
.partner .pn { font-weight: 700; font-size: 9.5pt; }
.partner .pd { font-size: 8.5pt; color: var(--muted); margin-top: 2px; }

/* ---- banners ----------------------------------------------------------- */
.banner {
  border-radius: 18px; padding: 18px 22px; margin-bottom: 12px; color: #fff;
  display: flex; justify-content: space-between; align-items: flex-start; gap: 20px;
  break-inside: avoid;
}
.banner.refund { background: linear-gradient(120deg, var(--green-1) 0%, var(--green-2) 100%); }
.banner.payable { background: linear-gradient(120deg, #7A4A10 0%, #B8801F 100%); }
.banner .eyebrow { font-size: 8pt; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; opacity: .82; }
.banner .big { font-size: 22pt; font-weight: 800; margin: 4px 0 2px; }
.banner .words { font-size: 8.5pt; opacity: .88; }
.banner .bank { text-align: right; font-size: 8.5pt; }
.banner .bank .bn { font-weight: 700; font-size: 9.5pt; }
.banner .bank .bl { opacity: .78; }

/* ---- notes + signature ------------------------------------------------- */
.tail { display: flex; gap: 14px; align-items: stretch; break-inside: avoid; }
.notes { flex: 1 1 auto; background: var(--gold-bg); border-radius: 14px; padding: 12px 16px; }
.notes h4 { margin: 0 0 6px; font-size: 9pt; color: #8A6D12; }
.notes ul { margin: 0; padding-left: 14px; }
.notes li { font-size: 8.5pt; margin-bottom: 5px; line-height: 1.45; }
.notes li.attention { color: #8A4B12; font-weight: 600; }

.sign {
  flex: 0 0 210px; border: 1px dashed var(--hairline); border-radius: 14px;
  padding: 14px; text-align: center; display: flex; flex-direction: column; justify-content: flex-start;
}
.sign .sn { font-weight: 700; font-size: 9.5pt; margin-top: 42px; }
.sign .sd { font-size: 8.5pt; color: var(--muted); margin-top: 2px; }

/* ---- items requiring review (§8) --------------------------------------- */
.review { border: 1px solid var(--gold-500); background: var(--gold-bg); border-radius: 14px; padding: 12px 16px; margin-bottom: 12px; }
.review h4 { margin: 0 0 4px; font-size: 9.5pt; color: #8A6D12; }
.review p { margin: 0 0 8px; font-size: 8.5pt; color: #6B5510; }
.review table { width: 100%; border-collapse: collapse; }
.review td { font-size: 8pt; padding: 2px 0; font-family: ui-monospace, monospace; }
.review td:last-child { text-align: right; font-weight: 700; }

/* ---- the standing declaration ------------------------------------------
   Full width under the notes and signature, set apart by a rule rather than a
   panel: it is a term of the document, not a finding about the return. Kept
   with the block above it so it can never print alone on a trailing page. */
.declaration {
  break-inside: avoid; break-before: avoid;
  margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--hairline);
  font-size: 8pt; line-height: 1.5; color: var(--muted);
}
.declaration strong { color: var(--navy-700); letter-spacing: .04em; text-transform: uppercase; font-size: 7.5pt; margin-right: 4px; }

@page { size: A4; margin: 12mm 11mm 16mm 11mm; }
`;
}
