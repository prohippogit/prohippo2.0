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
  return `<td class="m-c text">${esc(text)}</td>`;
}

/** One `matrix` row → a ruled schedule. */
export function renderMatrix(row) {
  const cols = row.columns || [];
  const lines = row.lines || [];

  const head = `<tr class="m-head">
  <th class="m-l">${esc(row.label || "")}</th>
  ${cols.map((c) => `<th>${esc(c.label || "")}${c.note ? `<div class="m-cn">${esc(c.note)}</div>` : ""}</th>`).join("")}
</tr>`;

  const body = lines.map((l) => `<tr class="m-${l.kind || "sub"}">
  <td class="m-l">${esc(l.label || "")}${l.note ? `<div class="m-note">${esc(l.note)}</div>` : ""}</td>
  ${cols.map((_, i) => cellHtml((l.cells || [])[i], l)).join("")}
</tr>`).join("\n");

  return `<div class="mtx">
  ${row.ref ? `<div class="m-ref">${esc(row.ref)}</div>` : ""}
  <div class="m-frame"><table class="m-t">${head}\n${body}</table></div>
  ${row.note ? `<div class="m-foot">${esc(row.note)}</div>` : ""}
</div>`;
}
