/*
 * The schedule block — how a `matrix` row is drawn (model.js, spec §3).
 *
 * Kept in its own file because it is a second table shape with its own rules,
 * and folding it into template.js would make the one function that renders a
 * section into a function that renders two different documents.
 *
 * A cell is one of three things, and the three stay different for the same
 * reason §3 keeps `amount` three-valued:
 *
 *   a number  → an amount, Indian-grouped, 0 printed as an em dash
 *   a string  → printed as given (a date, a buyer's name, a PAN)
 *   null      → structurally blank; nothing at all
 *
 * The renderer never decides what a figure MEANS — it decides what it looks
 * like. Everything about which line is a subtotal, which column is a total and
 * what any of it is called was settled by the mapper.
 */
import { amountText, esc } from "../format.js";

function cellHtml(value, line) {
  if (value === null || value === undefined) return `<td class="m-c blank"></td>`;
  if (typeof value === "number") {
    const loss = line.isLoss || value < 0;
    return `<td class="m-c num${loss ? " loss" : ""}${value === 0 ? " nil" : ""}">${esc(amountText(value, line.isLoss))}</td>`;
  }
  const text = String(value);
  if (!text) return `<td class="m-c blank"></td>`;
  /* A short string is a date or a code and must not be broken across two lines
     — "28 Jul / 2023" down a column of dates is unreadable. A long one is prose
     and has to be allowed to wrap or it pushes the amounts off the page. Length
     is the only thing the renderer can tell them apart by, and it is enough. */
  return `<td class="m-c text${text.length <= 14 ? " short" : ""}">${esc(text)}</td>`;
}

/* HOW HARD THE SCHEDULE IS PRESSED FOR ROOM, from the one thing the renderer
 * can see without measuring anything: how many columns it was given.
 *
 * A property schedule states every figure the return holds for each sale — the
 * raw cost beside the indexed one, the improvement beside its indexation, a
 * column for each section of exemption claimed — and a return with four
 * properties and two sections of relief runs to fifteen columns. A4 is 188mm of
 * usable width whatever is in it, so past a certain count the figures have to be
 * set smaller or they are set off the page.
 *
 * This is the renderer's decision and belongs here, not in a mapper: it is about
 * paper, and the mapper does not know what the document is printed on (§2). The
 * mapper's job was to decide WHICH columns the schedule has.
 */
function density(n) {
  // The steps are where the widest figure a return can state stops fitting on
  // one line beside its neighbours across 188mm. `xxwide` additionally scales
  // the block: past thirteen columns no type size a person would sign gets
  // fifteen amounts across a page, so the schedule is laid out at its natural
  // width and reduced to fit, which keeps every column rather than losing one.
  if (n >= 12) return " xwide xxwide";
  if (n >= 9) return " xwide";
  if (n >= 7) return " wide";
  return "";
}

/** One `matrix` row → a ruled schedule. */
export function renderMatrix(row) {
  const cols = row.columns || [];
  const lines = row.lines || [];

  /* The caption is a heading over the frame, not the first cell of the heading
     row. Inside the table it sized the label column — "Sale of land or building
     — long term" set 303px of a 670px page, and every pixel of it came off the
     address and the buyers, which are the columns it was captioning. */
  const title = row.label
    ? `<div class="m-title">${esc(row.label)}${row.ref ? `<span class="m-ref">${esc(row.ref)}</span>` : ""}</div>`
    : "";

  const head = `<tr class="m-head">
  <th class="m-l"></th>
  ${cols.map((c) => `<th>${esc(c.label || "")}${c.note ? `<div class="m-cn">${esc(c.note)}</div>` : ""}</th>`).join("")}
</tr>`;

  const body = lines.map((l) => (l.span
    ? `<tr class="m-banner">
  <td class="m-l m-span" colspan="${cols.length + 1}">${esc(l.label || "")}${l.note ? `<div class="m-note">${esc(l.note)}</div>` : ""}</td>
</tr>`
    : `<tr class="m-${l.kind || "sub"}">
  <td class="m-l">${esc(l.label || "")}${l.note ? `<div class="m-note">${esc(l.note)}</div>` : ""}</td>
  ${cols.map((_, i) => cellHtml((l.cells || [])[i], l)).join("")}
</tr>`)).join("\n");

  return `<div class="mtx${density(cols.length)}">
  ${title}
  <div class="m-frame"><table class="m-t">${head}\n${body}</table></div>
  ${row.note ? `<div class="m-foot">${esc(row.note)}</div>` : ""}
</div>`;
}
