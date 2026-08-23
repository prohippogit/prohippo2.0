/*
 * The CURVY theme — soft violet panels, set in Poppins (spec §6, §14).
 *
 * The look every other document this practice sends out already has. The
 * ledger, the cause list and the mock ITR-B are drawn from src/pdfTheme.js:
 * rounded panels, a pill chip carrying the section letter, a tinted band under
 * each heading, Poppins throughout, and the practice's own accent colour. A
 * client who gets a computation and a ledger in the same week should get two
 * documents from one firm, and until this theme existed they got two from two.
 *
 * THE ACCENT IS THE PRACTICE'S, not this file's. `profile.invoiceSettings.accent`
 * already colours the invoices and the ITR-B; the computation reads the same
 * setting, so a firm that has chosen crimson does not get one violet document.
 * Everything derived from it — the tints behind a section band, the wash on a
 * total, the chip — is computed here rather than listed, because a listed tint
 * is a tint that stays violet when the accent does not.
 *
 * The stylesheet is emitted inline into the document. It must not reference a
 * single external URL — the render function loads the page with no network
 * access at all (§13), so an external stylesheet or webfont is a silent blank.
 */

/* Ink, body, muted, hairline: the same four the jsPDF theme uses (pdfTheme.js
   INK / BODY / MUTED / LINE), written as hex here and as RGB triples there.
   They are the constants that make two documents look like one practice, so
   they are NOT derived from the accent and NOT adjustable. */
export const TOKENS = {
  ink: "#1A182E",
  body: "#403C5C",
  muted: "#8A87A0",
  line: "#E6E4F0",
  panel: "#F8F7FB",
  page: "#FFFFFF",
  loss: "#C13378",
  credit: "#1A8C5C",
  creditInk: "#0E5C3C",
  warn: "#96580C",
  warnBg: "#FDF2E0",
  accent: "#6C5CE7",
};

const HEX = /^#?([0-9a-f]{6})$/i;

/** "#6C5CE7" → [108, 92, 231]. Anything unreadable falls back to the default. */
function rgb(hex) {
  const m = HEX.exec(String(hex || "").trim());
  const int = parseInt(m ? m[1] : TOKENS.accent.slice(1), 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

/* Mix towards white. `t` is how much white: 0.9 is the wash behind a section
   band, 0.82 the one behind a table heading. Same function, same numbers, as
   pdfTheme.js `tint` — the two themes are the same design in two media.

   A NEGATIVE `t` darkens instead, which is how the masthead's gradient gets a
   deeper end without a second colour to keep in step. Clamped, because an
   accent that is already near-black darkens past zero and `(-46).toString(16)`
   is "-2e" — a hex colour Chromium drops on the floor, silently, leaving an
   unpainted panel. */
const mix = (c, t) => `#${c
  .map((v) => Math.max(0, Math.min(255, Math.round(v + (255 - v) * t))).toString(16).padStart(2, "0"))
  .join("")}`;

/* Enough contrast to set white on, or not. A practice that picks amber gets
   ink on its chips rather than white, which is the difference between a
   legible letter and a smudge. */
const readable = (c) => (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] > 150 ? TOKENS.ink : "#FFFFFF");

export function stylesheet(opts = {}) {
  const t = TOKENS;
  const a = rgb(opts.accent || t.accent);
  const accent = mix(a, 0);
  const on = readable(a);
  const soft = mix(a, 0.9);      // section band, total wash
  const softer = mix(a, 0.94);   // zebra
  const band = mix(a, 0.82);     // table heading
  const edge = mix(a, 0.7);      // a rule that has to read as accent, not ink

  return `
:root {
  --accent: ${accent}; --on-accent: ${on};
  --soft: ${soft}; --softer: ${softer}; --band: ${band}; --edge: ${edge};
  --ink: ${t.ink}; --body: ${t.body}; --muted: ${t.muted}; --line: ${t.line};
  --panel: ${t.panel}; --loss: ${t.loss}; --credit: ${t.credit}; --credit-ink: ${t.creditInk};
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: 'Poppins', 'Segoe UI', system-ui, sans-serif;
  color: var(--body);
  background: ${t.page};
  font-size: 9.5pt;
  line-height: 1.45;
  /* Amounts must line up column-wise down a page of figures. */
  font-variant-numeric: tabular-nums;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

/* A section must never split across a page — a total row orphaned from the rows
   it totals is unreadable, and worse, misreadable. */
.card {
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 13px 15px 15px;
  margin-bottom: 10px;
  break-inside: avoid;
  page-break-inside: avoid;
}

/* ---- masthead ------------------------------------------------------------
 *
 * A CURVY BLOCK IN THE PRACTICE'S COLOUR. It was a white header with a rule
 * under it first, which is what the ITR-B working paper does — but that page
 * carries the FIRM at the top and its own colour arrives lower down. This one
 * carries the assessee, and a computation opening on white read as though the
 * theme had not been applied to the top of the page at all.
 *
 * So the identity is a filled panel and the particulars below it are a second,
 * separate one: two blocks, both in the accent, neither pretending to be part
 * of the other.
 */
.masthead {
  position: relative;
  overflow: hidden;
  border-radius: 20px;
  padding: 16px 20px 15px;
  margin-bottom: 10px;
  color: #fff;
  background: linear-gradient(118deg, ${mix(a, -0.18)} 0%, ${accent} 58%, ${mix(a, 0.14)} 100%);
  display: flex; align-items: flex-start; gap: 14px;
  break-inside: avoid;
}
/* Two soft discs, the same device the other theme uses and the reason its
   masthead does not read as a flat rectangle of colour. Kept to a whisper here
   because the accent is the practice's and may be light. */
.masthead .blob { position: absolute; border-radius: 50%; pointer-events: none; }
.masthead .blob-gold { right: -70px; top: -80px; width: 230px; height: 230px; background: #fff; opacity: .10; }
.masthead .blob-white { right: 46px; bottom: -120px; width: 190px; height: 190px; background: #fff; opacity: .07; }

.masthead .mark {
  position: relative;
  flex: 0 0 auto; width: 38px; height: 38px; border-radius: 12px;
  background: rgba(255,255,255,.18); border: 1px solid rgba(255,255,255,.34); color: #fff;
  font-size: 15pt; font-weight: 700; line-height: 36px; text-align: center;
}
.masthead .mast-main { position: relative; flex: 1 1 auto; min-width: 0; }
.masthead .eyebrow {
  font-size: 6.6pt; font-weight: 600; letter-spacing: .15em;
  text-transform: uppercase; color: rgba(255,255,255,.72); margin-bottom: 2px;
}
.masthead h1 { margin: 0 0 3px; font-size: 15pt; font-weight: 700; letter-spacing: -.01em; color: #fff; }
.masthead .addr { font-size: 7.6pt; color: rgba(255,255,255,.80); margin-bottom: 8px; line-height: 1.4; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; }
.chip {
  border: 1px solid rgba(255,255,255,.34); background: rgba(255,255,255,.12); border-radius: 999px;
  padding: 2px 10px; font-size: 7.4pt; font-weight: 500; color: #fff;
}
.chip b { color: #fff; font-weight: 700; margin-right: 4px; opacity: .78; }
/* The wordmark: what this document is, set against the panel rather than in it. */
.masthead .wordmark {
  position: relative;
  flex: 0 0 auto; text-align: right; padding-top: 1px;
  font-size: 17pt; font-weight: 700; color: rgba(255,255,255,.94);
  letter-spacing: -.02em; line-height: 1.05;
}
.masthead .wordmark span {
  display: block; font-size: 6.4pt; font-weight: 500; letter-spacing: .13em;
  text-transform: uppercase; color: rgba(255,255,255,.66); margin-top: 3px;
}

/* ---- the assessee's particulars: the second block ------------------------
 *
 * Its own panel in the accent, washed rather than filled. Filled twice over
 * would make the top of the page one block of colour with a seam in it, and
 * these are two different statements: who this is, and what is on record
 * about them.
 */
.card.card-id {
  background: var(--soft);
  border: 1px solid ${mix(a, 0.72)};
  border-radius: 18px;
}
/* No band inside a block that is already one — the heading sits on the wash. */
.card-id .pill {
  background: transparent; padding: 0 2px; margin-bottom: 10px;
  color: var(--accent); font-size: 8.6pt; letter-spacing: .06em; text-transform: uppercase;
}

/* ---- section headers ----------------------------------------------------
 *
 * A tinted band the width of the card, with the section's letter in a solid
 * chip at its left — the same shape pdfTheme.js draws for the ITR-B's parts.
 * The separator between letter and title is furniture here and is dropped; the
 * chip already separates them.
 */
.pill {
  display: flex; align-items: center; gap: 9px;
  background: var(--soft); border-radius: 9px;
  padding: 6px 11px 6px 6px; margin-bottom: 9px;
  font-size: 9pt; font-weight: 700; color: var(--ink);
  letter-spacing: 0; text-transform: none;
}
.pill .pl {
  flex: 0 0 auto; width: 20px; height: 20px; border-radius: 7px;
  background: var(--accent); color: var(--on-accent);
  font-size: 7.5pt; font-weight: 800; line-height: 20px; text-align: center;
}
.pill .pt { flex: 1 1 auto; min-width: 0; }
/* The separator is furniture here: the chip already divides the letter from
   the title. */
.pill .pd { display: none; }
/* The other theme distinguishes the tax and taxes-paid cards by the colour of
   the pill. Here the accent is the practice's and must not be overridden by a
   second one, so the distinction is carried by the chip's tone instead. */
.pill.gold { background: ${t.warnBg}; }
.pill.gold .pl { background: ${t.warn}; color: #fff; }
.pill.slate .pl { background: var(--ink); }

/* ---- figure tables ----------------------------------------------------- */
table.rows { width: 100%; border-collapse: collapse; }
table.rows td { padding: 5px 9px; vertical-align: top; border-bottom: 1px solid var(--line); }
table.rows tr:last-child td { border-bottom: 0; }
td.label { width: auto; }
td.ref { width: 108px; text-align: right; color: var(--muted); font-size: 7.6pt; padding-top: 6px; }
td.amt { width: 108px; text-align: right; font-weight: 600; white-space: nowrap; color: var(--ink); }

tr.r-sub:nth-child(even) td { background: #FBFAFE; }

/* TWO LEVELS OF SUM, IN TWO WASHES OF ONE COLOUR.
 *
 * The sample this theme is drawn from fills a total with tint(accent, 0.9) and
 * sets INK on it — nothing on its pages is a solid block of accent except a
 * chip the size of a letter. Filling the closing total solid was tried and it
 * is a handsomer row in isolation and a worse page: four of them down a
 * computation turn the accent from a signal into a stripe.
 *
 * So the hierarchy is carried by wash and by a rail. A subtotal is the lighter
 * wash; the total is the heavier one with a solid accent edge down its left,
 * which is the only mark on the page that says "this is the answer". */
tr.r-subtotal td { background: var(--softer); font-weight: 600; color: var(--ink); }
tr.r-subtotal td:first-child { border-top-left-radius: 8px; border-bottom-left-radius: 8px; }
tr.r-subtotal td:last-child { border-top-right-radius: 8px; border-bottom-right-radius: 8px; }

tr.r-total td { background: var(--soft); color: var(--ink); font-weight: 700; font-size: 9.8pt; border-bottom: 0; }
tr.r-total td.ref { color: ${mix(a, 0.35)}; }
tr.r-total td.amt { color: var(--ink); }
tr.r-total td:first-child {
  border-top-left-radius: 9px; border-bottom-left-radius: 9px;
  border-left: 4px solid var(--accent); padding-left: 10px;
}
tr.r-total td:last-child { border-top-right-radius: 9px; border-bottom-right-radius: 9px; }

tr.r-head td { background: var(--panel); font-weight: 500; }

tr.r-columnHeader td {
  font-weight: 700; font-size: 7.2pt; color: var(--accent);
  letter-spacing: .07em; text-transform: uppercase;
  padding: 8px 9px 5px; border-bottom: 1px solid var(--line);
}
tr.r-columnHeader td.ref, tr.r-columnHeader td.amt { color: var(--accent); font-size: 7.2pt; }

/* A nil row is greyed but never hidden: the head exists and its income is nil,
   which is a statement a computation has to make (§4). Greying is applied PER
   ROW KIND — a subtotal keeps its wash and a total keeps the accent behind it,
   because near-white text on a near-white row is an invisible "Total Income". */
tr.r-sub.nil td, tr.r-head.nil td { color: var(--muted); font-weight: 500; }
tr.r-sub.nil td.amt, tr.r-head.nil td.amt { color: var(--muted); }
tr.r-subtotal.nil td.label, tr.r-subtotal.nil td.amt { color: ${mix(a, 0.35)}; }
tr.r-total.nil td.label, tr.r-total.nil td.amt { color: ${mix(a, 0.3)}; }

.amt.loss { color: var(--loss); }

.note-line { font-size: 7.6pt; color: var(--muted); margin-top: 1px; }
.footnote { font-size: 7.6pt; color: var(--muted); margin-top: 7px; padding: 0 9px; }

/* ---- ledger tables (Section.layout === 'table') ------------------------- */
.grid-frame { border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
table.rows.grid { border-collapse: collapse; }
table.rows.grid td { padding: 7px 10px; border-bottom: 1px solid var(--line); }
table.rows.grid td + td { border-left: 1px solid var(--line); }
table.rows.grid tr:last-child td { border-bottom: 0; }
table.rows.grid tr td:first-child, table.rows.grid tr td:last-child { border-radius: 0; }
table.rows.grid td.ref {
  width: 150px; text-align: center; padding-top: 8px;
  white-space: nowrap; color: var(--body);
}
table.rows.grid tr.r-columnHeader td {
  background: var(--band); color: var(--accent);
  font-size: 6.8pt; padding: 8px 10px; border-top: 1px solid var(--line);
}
table.rows.grid tr.r-columnHeader td.ref, table.rows.grid tr.r-columnHeader td.amt {
  color: var(--accent); font-size: 6.8pt;
}
table.rows.grid tr.r-columnHeader td.ref { white-space: normal; }
table.rows.grid tr:first-child td { border-top: 0; }
table.rows.grid tr.r-sub:nth-child(even) td { background: transparent; }

/* ---- schedule blocks (a 'matrix' row) ----------------------------------- */
.mtx { margin: 3px 0 9px; break-inside: avoid; page-break-inside: avoid; }
.mtx .m-title {
  font-size: 7.6pt; font-weight: 700; color: var(--accent);
  letter-spacing: .06em; text-transform: uppercase;
  margin-bottom: 4px; padding: 0 2px;
  display: flex; justify-content: space-between; align-items: baseline; gap: 12px;
}
.mtx .m-title .m-ref {
  font-size: 7.2pt; font-weight: 500; color: var(--muted);
  letter-spacing: 0; text-transform: none;
}
.mtx .m-foot { font-size: 7.6pt; color: var(--muted); margin-top: 5px; padding: 0 4px; }
.m-frame { border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
table.m-t { width: 100%; border-collapse: collapse; }
table.m-t th, table.m-t td {
  padding: 6px 9px; text-align: right; vertical-align: top;
  border-bottom: 1px solid var(--line);
}
table.m-t th + th, table.m-t td + td { border-left: 1px solid var(--line); }
table.m-t tr:last-child th, table.m-t tr:last-child td { border-bottom: 0; }

table.m-t .m-l { text-align: left; width: 1%; white-space: nowrap; }
table.m-t .m-note { font-size: 7.2pt; color: var(--muted); margin-top: 1px; font-weight: 400; }

table.m-t tr.m-head th {
  background: var(--band); color: var(--accent);
  font-size: 7pt; font-weight: 700; text-align: right;
  padding: 7px 9px; line-height: 1.3;
}
table.m-t tr.m-head .m-cn { font-size: 6.6pt; font-weight: 400; color: ${mix(a, 0.35)}; margin-top: 1px; }

tr.m-sub td { background: transparent; }
table.m-t td.m-c { width: 1%; }
table.m-t td.m-c.blank { background: transparent; }
table.m-t td.m-c.num { white-space: nowrap; font-weight: 600; font-size: 8pt; color: var(--ink); }
table.m-t td.m-c.num.nil { color: var(--muted); font-weight: 400; }
table.m-t td.m-c.num.loss { color: var(--loss); }
table.m-t td.m-c.text { font-size: 7.6pt; font-weight: 400; overflow-wrap: anywhere; width: auto; }
table.m-t td.m-c.text.short { white-space: nowrap; width: 1%; }

/* The banner naming a property: the address on one line and the buyers under
   it, across the full width of the schedule. */
table.m-t tr.m-banner td, table.m-t td.m-span {
  background: var(--panel); text-align: left; font-weight: 600; color: var(--ink);
  font-size: 7.6pt; white-space: normal; padding-top: 7px; border-bottom: 0;
}
table.m-t tr.m-banner .m-note { font-weight: 400; font-size: 7.2pt; }

table.m-t tr.m-subtotal td { background: var(--softer); font-weight: 600; color: var(--ink); }
table.m-t tr.m-subtotal td.m-c.num.nil { color: ${mix(a, 0.35)}; }
/* A schedule's closing line takes the same wash as a section total, and the
   same rail — the frame clips it into the rounded corner. */
table.m-t tr.m-total td { background: var(--soft); color: var(--ink); font-weight: 700; }
table.m-t tr.m-total td.m-l { border-left: 4px solid var(--accent); }
table.m-t tr.m-total td.m-c.num { color: var(--ink); }
table.m-t tr.m-total td.m-c.num.nil { color: ${mix(a, 0.3)}; }
table.m-t tr.m-total td.m-c.num.loss { color: var(--loss); }
table.m-t tr.m-total .m-note { color: ${mix(a, 0.35)}; }

/* A schedule with a lot of columns is set smaller rather than off the page. */
.mtx.wide table.m-t th, .mtx.wide table.m-t td { padding: 5px 6px; }
.mtx.wide table.m-t td.m-c.num, .mtx.wide table.m-t td.m-c.text { font-size: 7.2pt; }
.mtx.wide table.m-t tr.m-head th { font-size: 6.8pt; }
.mtx.wide table.m-t tr.m-banner td { font-size: 7.2pt; }
.mtx.wide table.m-t tr.m-banner .m-note { font-size: 6.8pt; }

.mtx.xwide table.m-t th, .mtx.xwide table.m-t td { padding: 4px 4px; }
.mtx.xwide table.m-t td.m-c.num, .mtx.xwide table.m-t td.m-c.text { font-size: 6.6pt; }
.mtx.xwide table.m-t tr.m-head th { font-size: 6.6pt; }
.mtx.xwide table.m-t tr.m-head .m-cn { font-size: 6.2pt; }
.mtx.xwide table.m-t .m-note { font-size: 6.6pt; }
.mtx.xwide table.m-t tr.m-banner td { font-size: 6.8pt; }

.mtx.xxwide .m-frame { zoom: 0.70; }

/* ---- particulars ------------------------------------------------------- */
.facts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 11px 16px; }
.fact .k { font-size: 6.8pt; font-weight: 600; letter-spacing: .09em; text-transform: uppercase; color: ${mix(a, 0.28)}; margin-bottom: 1px; }
.fact .v { font-size: 8.6pt; font-weight: 500; color: var(--ink); white-space: pre-line; }

.partners { display: flex; flex-wrap: wrap; gap: 8px; }
.partner { border: 1px solid var(--line); background: var(--panel); border-radius: 11px; padding: 7px 11px; flex: 1 1 200px; }
.partner .pn { font-weight: 700; font-size: 8.6pt; color: var(--ink); }
.partner .pd { font-size: 7.6pt; color: var(--muted); margin-top: 1px; }

/* ---- banners -----------------------------------------------------------
 *
 * A tinted panel with a coloured rail, not a filled gradient: the accent is the
 * loudest thing on a curvy page and a refund banner shouting over it would take
 * the eye off the total it follows.
 */
.banner {
  border-radius: 14px; padding: 13px 16px; margin-bottom: 10px;
  display: flex; justify-content: space-between; align-items: flex-start; gap: 18px;
  break-inside: avoid;
  border: 1px solid var(--line); border-left: 4px solid var(--line);
}
.banner.refund { border-left-color: var(--credit); background: #F1FAF6; color: var(--credit-ink); }
.banner.payable { border-left-color: ${t.warn}; background: ${t.warnBg}; color: #7A5018; }
.banner .eyebrow { font-size: 6.6pt; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; opacity: .78; }
.banner .big { font-size: 18pt; font-weight: 800; margin: 2px 0 1px; }
.banner .words { font-size: 7.6pt; opacity: .85; }
.banner .bank { text-align: right; font-size: 7.6pt; }
.banner .bank .bn { font-weight: 700; font-size: 8.6pt; }
.banner .bank .bl { opacity: .8; }

/* ---- notes + signature ------------------------------------------------- */
.tail { display: flex; gap: 12px; align-items: stretch; break-inside: avoid; }
.notes { flex: 1 1 auto; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 10px 14px; }
.notes h4 { margin: 0 0 5px; font-size: 7.6pt; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; color: var(--accent); }
.notes ul { margin: 0; padding-left: 13px; }
.notes li { font-size: 7.6pt; margin-bottom: 4px; line-height: 1.5; color: var(--body); }
.notes li.attention { color: ${t.warn}; font-weight: 600; }

.sign {
  flex: 0 0 195px; border: 1px dashed ${mix(a, 0.6)}; border-radius: 12px;
  padding: 12px; text-align: center; display: flex; flex-direction: column; justify-content: flex-start;
}
.sign .sn { font-weight: 700; font-size: 8.6pt; color: var(--ink); margin-top: 38px; }
.sign .sd { font-size: 7.6pt; color: var(--muted); margin-top: 1px; }

/* ---- items requiring review (§8) --------------------------------------- */
.review { border: 1px solid ${mix(a, 0.55)}; background: var(--soft); border-radius: 12px; padding: 10px 14px; margin-bottom: 10px; }
.review h4 { margin: 0 0 3px; font-size: 8.6pt; font-weight: 700; color: var(--accent); }
.review p { margin: 0 0 6px; font-size: 7.6pt; color: var(--body); }
.review table { width: 100%; border-collapse: collapse; }
.review td { font-size: 7.2pt; padding: 1px 0; font-family: ui-monospace, monospace; color: var(--body); }
.review td:last-child { text-align: right; font-weight: 700; color: var(--ink); }

/* ---- the standing declaration ------------------------------------------ */
.declaration {
  break-inside: avoid; break-before: avoid;
  margin-top: 9px; padding-top: 7px; border-top: 1px solid var(--line);
  font-size: 7pt; line-height: 1.5; color: var(--muted);
}
.declaration strong { color: var(--accent); letter-spacing: .06em; text-transform: uppercase; font-size: 6.8pt; margin-right: 4px; }

@page { size: A4; margin: 12mm 11mm 16mm 11mm; }
`;
}
