/*
 * The renderer. ONE renderer, shared by every form — docs/computation-spec.md §2.
 *
 * If a form needs a new kind of row, add a row *type* to the model. The moment
 * you find yourself writing `if (form === 'ITR3')` in this file, stop: the model
 * is wrong, not the renderer.
 *
 * Output is a complete, self-contained HTML document — inline CSS, no external
 * URL of any kind. The render function loads it with the network cut off (§13),
 * so anything not in this string does not exist.
 *
 * The @font-face block is injected by the render function, which owns the
 * embedded Montserrat subsets (functions/fonts/montserrat.js). The placeholder
 * below is where it lands.
 */
import { amountText, inWords, longDate, esc, inr } from "../format.js";
import { renderMatrix } from "./matrix.js";
import { stylesheet } from "./styles.js";

/** The render function replaces this with the base64 @font-face rules. */
export const FONT_SLOT = "/*__COMPUTATION_FONT_FACE__*/";

const isNilAmount = (v) => v === 0;

function renderRow(row) {
  const cls = [`r-${row.kind}`];
  if (isNilAmount(row.amount)) cls.push("nil");
  const amtCls = ["amt"];
  if (row.isLoss || (typeof row.amount === "number" && row.amount < 0)) amtCls.push("loss");

  // The middle column is normally a source reference ("Sch. BP"). In the TDS and
  // carry-forward tables it carries data instead, which is what `cols` marks.
  const middle = row.cols ? esc(row.cols.ref) : esc(row.ref || "");
  const middleCls = row.cols ? "ref" : "ref";

  // A column heading may caption the amount column too. It cannot do that
  // through `amount`, which is a figure and renders as one — 0 would print an
  // em dash and null prints nothing at all (§3).
  const right = row.cols && row.cols.amt ? esc(row.cols.amt) : esc(amountText(row.amount, row.isLoss));

  return `<tr class="${cls.join(" ")}">
  <td class="label">${esc(row.label)}${row.note ? `<div class="note-line">${esc(row.note)}</div>` : ""}</td>
  <td class="${middleCls}">${middle}</td>
  <td class="${amtCls.join(" ")}">${right}</td>
</tr>`;
}

function renderSection(s) {
  // The TI section's footnote states the total income in words. It is built here
  // rather than in the mapper because it is a restatement of a row the mapper
  // already produced — deriving it twice is how the two drift apart.
  let footnote = s.footnote || "";
  if (s.id === "TI") {
    const totalRow = s.rows.filter((r) => r.kind === "total").pop();
    const words = totalRow ? inWords(totalRow.amount) : "";
    footnote = `Total income in words: ${words}`;
  }

  /* A section the mapper marked as a ledger (§3 `layout`) is ruled like one:
     the three columns get keeplines, the column header becomes a banded head,
     and the whole thing sits in a rounded frame. That frame is a wrapper div,
     not a radius on the table — a table with collapsed borders cannot round its
     own corners in Chromium, so the frame clips them instead. */
  const ledger = s.layout === "table";
  const wrap = (rows) => {
    const table = `<table class="rows${ledger ? " grid" : ""}">${rows.map(renderRow).join("\n")}</table>`;
    return ledger ? `<div class="grid-frame">${table}</div>` : table;
  };

  /* A schedule interrupts the working rather than joining it.
   *
   * A matrix has its own columns, so it cannot be a `<tr>` in the section's
   * three-column table. The rows either side of it still can — and still
   * should: a capital gains section reads "here is the head, here is the
   * property schedule, here is what it totals to". So the rows are emitted in
   * order, in as many tables as it takes, with each matrix standing between
   * them. */
  const blocks = [];
  let run = [];
  const flush = () => { if (run.length) { blocks.push(wrap(run)); run = []; } };
  for (const r of s.rows) {
    if (r.kind === "matrix") { flush(); blocks.push(renderMatrix(r)); } else run.push(r);
  }
  flush();

  return `<div class="card">
  <div class="pill ${s.tone === "gold" ? "gold" : s.tone === "slate" ? "slate" : ""}">${esc(s.letter)} · ${esc(s.title)}</div>
  ${blocks.join("\n")}
  ${footnote ? `<div class="footnote">${esc(footnote)}</div>` : ""}
</div>`;
}

function renderMasthead(doc) {
  const a = doc.assessee;
  const chips = [
    ["PAN", a.pan],
    ["A.Y.", doc.meta.assessmentYear],
    ["P.Y.", doc.meta.previousYear],
    ["Form", doc.meta.form.replace(/^ITR/, "ITR-")],
    ["Status", a.status],
  ].filter(([, v]) => v);

  return `<div class="masthead">
  <div class="blob blob-gold"></div>
  <div class="blob blob-white"></div>
  <div class="eyebrow">Computation of Total Income &amp; Tax Liability</div>
  <h1>${esc(a.name)}</h1>
  <div class="addr">${esc(a.address)}</div>
  <div class="chips">${chips.map(([k, v]) => `<span class="chip"><b>${esc(k)}</b>${esc(v)}</span>`).join("")}</div>
</div>`;
}

function renderParticulars(doc) {
  const facts = doc.assessee.facts.filter((f) => f.value || f.value2 != null);
  if (!facts.length) return "";
  return `<div class="card">
  <div class="pill">Particulars of the Assessee</div>
  <div class="facts">${facts.map((f) => `<div class="fact">
    <div class="k">${esc(f.label)}</div>
    <div class="v">${esc(f.value)}${f.value2 != null ? `\n${esc(inr(f.value2))}` : ""}</div>
  </div>`).join("")}</div>
</div>`;
}

/* The same card serves a firm listing its partners (ITR-5) and an individual
   listing the firms they are a partner in (ITR-3). A mapper that has particulars
   the default composition cannot express — a firm's capital balance, say —
   supplies them pre-composed as `detail`. */
function renderPartners(doc) {
  const partners = doc.assessee.partners || [];
  if (!partners.length) return "";
  return `<div class="card">
  <div class="pill">${esc(doc.assessee.constitutionTitle || "Constitution")}</div>
  <div class="partners">${partners.map((p) => `<div class="partner">
    <div class="pn">${esc(p.name)}</div>
    <div class="pd">${esc(p.detail || [
      p.pan && `PAN ${p.pan}`,
      p.share && `Share ${p.share}`,
      `Remuneration ${p.remuneration ? inr(p.remuneration) : "—"}`,
      p.interestRate != null ? `Interest ${p.interestRate}%` : "",
    ].filter(Boolean).join(" · "))}</div>
  </div>`).join("")}</div>
</div>`;
}

function renderBanner(doc) {
  if (doc.refund) {
    const b = doc.refund.bank;
    return `<div class="banner refund">
  <div>
    <div class="eyebrow">Net Refund Receivable</div>
    <div class="big">₹ ${esc(inr(doc.refund.amount))}</div>
    <div class="words">${esc(inWords(doc.refund.amount))}</div>
  </div>
  ${b ? `<div class="bank">
    <div class="bl">Credit to</div>
    <div class="bn">${esc(b.name)}</div>
    <div class="bl">A/c ${esc(b.accountNo)}${b.type ? ` · ${esc(b.type)}` : ""}</div>
    <div class="bl">IFSC ${esc(b.ifsc)}</div>
  </div>` : ""}
</div>`;
  }
  if (doc.payable) {
    return `<div class="banner payable">
  <div>
    <div class="eyebrow">Balance Tax Payable</div>
    <div class="big">₹ ${esc(inr(doc.payable.amount))}</div>
    <div class="words">${esc(inWords(doc.payable.amount))}</div>
  </div>
</div>`;
  }
  return "";
}

function renderTail(doc) {
  const s = doc.signatory || {};
  const notes = doc.notes || [];
  return `<div class="tail">
  ${notes.length ? `<div class="notes">
    <h4>Notes</h4>
    <ul>${notes.map((n) => `<li class="${n.severity === "attention" ? "attention" : ""}">${esc(n.text)}</li>`).join("")}</ul>
  </div>` : "<div class='notes'></div>"}
  <div class="sign">
    <div class="sn">${esc(s.name)}</div>
    <div class="sd">${esc([s.capacity, s.pan && `PAN ${s.pan}`].filter(Boolean).join(" · "))}</div>
    <div class="sd">${esc([s.place, s.date && longDate(s.date)].filter(Boolean).join(" · "))}</div>
  </div>
</div>`;
}

/* The standing declaration, on the face of every computation.
 *
 * It sits in the renderer rather than in a mapper's notes for the reason §2
 * gives for the renderer existing at all: there is ONE of it, shared by every
 * form and every year, so a declaration put here cannot be forgotten when the
 * next form or the next year is added. It is also kept apart from the Notes
 * list, which carries facts about THIS return — the reader should not have to
 * work out which bullet is a standing term and which is a finding.
 *
 * The wording is deliberately plain. This document restates a filed return; it
 * is not a certificate, not an audit report and not advice, and the person
 * reading it may be the assessee rather than the practitioner who generated it.
 */
const DECLARATION = "This Computation of Total Income and Tax Liability is a summary reference "
  + "generated from the return data (JSON) filed on the income-tax portal. It restates the "
  + "figures of that return and is not a certificate, an audit report or tax advice. Please "
  + "take the advice of a tax practitioner before relying upon it.";

function renderDeclaration() {
  return `<div class="declaration"><strong>Declaration</strong> ${esc(DECLARATION)}</div>`;
}

/* §8: unmapped figures never disappear quietly. The PDF says so on its face,
   because the practitioner may be reading a printed copy with no app in front
   of them. */
function renderReview(doc) {
  if (!doc.unmapped.length) return "";
  return `<div class="review">
  <h4>Items requiring review</h4>
  <p>These figures appear in the filed return but are not reflected above. Check them before issuing this computation.</p>
  <table>${doc.unmapped.slice(0, 40).map((u) => `<tr><td>${esc(u.path)}</td><td>${esc(inr(u.value))}</td></tr>`).join("")}</table>
  ${doc.unmapped.length > 40 ? `<p style="margin-top:6px">…and ${doc.unmapped.length - 40} more.</p>` : ""}
</div>`;
}

/** ComputationDocument → a complete, self-contained HTML document. */
export function renderHtml(doc) {
  const title = `Computation of Total Income — ${doc.assessee.name} — A.Y. ${doc.meta.assessmentYear}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>${FONT_SLOT}</style>
<style>${stylesheet()}</style>
</head>
<body>
${renderMasthead(doc)}
${renderParticulars(doc)}
${renderPartners(doc)}
${doc.sections.filter((s) => s.id !== "CFL").map(renderSection).join("\n")}
${renderBanner(doc)}
${doc.sections.filter((s) => s.id === "CFL").map(renderSection).join("\n")}
${renderReview(doc)}
${renderTail(doc)}
${renderDeclaration()}
</body>
</html>`;
}
