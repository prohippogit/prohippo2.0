/*
 * Right- and centre-aligning text that carries letter-spacing.
 *
 * WHY THIS EXISTS. jsPDF's `align` option positions a string by the width it
 * measures, and it does not measure `charSpace` the way it draws it: the
 * measurement adds the tracking to every character and divides it by the unit
 * scale, while the page shows it between them, undivided. On the ITR-B header
 * that put "BLOCK RETURN u/s 158BC" — 6.6pt with 0.6mm of tracking — eight
 * millimetres past the right margin and off the edge of the printable area,
 * with the wordmark above it landing half a millimetre short of the rule. The
 * discrepancy grows with the length of the string and the size of the tracking,
 * so the straplines that most need tracking are the ones that overflow worst.
 *
 * Rather than depend on that arithmetic, the alignment is done here and the
 * string is then drawn from the left, where there is nothing to get wrong.
 *
 * WIDTH, AS THE PAGE SHOWS IT. PDF adds the tracking after every glyph, the
 * last one included, but that final gap is empty space with no ink in it. What
 * a reader sees ending at the margin is the last glyph, so the width that
 * matters is `measured + spacing × (n − 1)` — the gaps BETWEEN characters. Use
 * the other reading and every tracked line stops one gap short of where it
 * should.
 *
 * The doc is only ever asked for `getTextWidth`, so this is testable against a
 * stub and does not need jsPDF, a font, or a page.
 */

/** The width a tracked string actually occupies, in the document's units. */
export function trackedWidth(doc, str, spacing = 0) {
  const s = String(str ?? "");
  if (!s) return 0;
  const gap = Number(spacing) || 0;
  return doc.getTextWidth(s) + gap * (s.length - 1);
}

/**
 * Where to start drawing so a tracked string lands on `x`.
 *
 * @returns the left edge to draw from, or `null` when jsPDF's own alignment is
 *          correct — no tracking to mismeasure, or nothing to shift. `null`
 *          rather than `x` so a caller cannot silently drop the `align` option
 *          on the untracked path and left-align the whole document.
 */
export function alignedX(doc, str, x, align = "left", spacing = 0) {
  const gap = Number(spacing) || 0;
  if (!gap || (align !== "right" && align !== "center")) return null;
  const w = trackedWidth(doc, str, gap);
  return align === "center" ? x - w / 2 : x - w;
}
