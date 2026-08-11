/*
 * ProHippo — what a downloaded document is called.
 *
 * Pure string work, deliberately kept apart from the download itself
 * (downloadFile.js) so these rules can be tested without pulling in Firebase or
 * a DOM. They are shared by every screen, because the same order downloaded
 * from the Appeals page, from a notice's review screen and from an assessee's
 * Matters tab must arrive under the same name — otherwise a practitioner ends
 * up with two copies of one document and no way to tell which is which.
 */

/* Characters that are illegal in a filename on Windows or macOS, plus the
   control range. A name is squeezed rather than rejected: "u/s 143(1)" is how a
   practitioner would write it, and it should survive as "u-s 143(1)". */
export function safeFilename(name, fallback = "document") {
  const cleaned = String(name || "")
    // Whitespace first. A tab and a newline are control characters, so stripping
    // the control range before collapsing whitespace would weld the words either
    // side of them together — "tab\tand" becoming "taband".
    .replace(/\s+/g, " ")
    // A slash carries meaning in the statutory text these names contain, so it
    // becomes a hyphen rather than vanishing: "u/s 143(1)" → "u-s 143(1)".
    .replace(/[/\\]/g, "-")
    // eslint-disable-next-line no-control-regex
    .replace(/[:*?"<>|\x00-\x1f]/g, "")
    // A leading dot makes a hidden file on macOS and Linux; a trailing one is
    // dropped by Windows, which then eats into the extension.
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 180)
    .trim();
  // A name that survived as nothing but punctuation ("---") is a valid filename
  // and a useless one. Only keep it if something readable is left.
  return /[a-z0-9]/i.test(cleaned) ? cleaned : fallback;
}

/** Give a name the extension its content implies, without doubling it up. */
export function withExtension(name, ext) {
  const e = String(ext || "").replace(/^\./, "").toLowerCase();
  if (!e) return name;
  return new RegExp(`\\.${e}$`, "i").test(name) ? name : `${name}.${e}`;
}

/* ---------------- what a portal document IS ----------------
 *
 * A notice on e-Proceedings is rarely one file. A s.148 notice arrives as a SET
 * — the notice itself, the approval to the JAO, the set note, the search print —
 * and the portal will also hand over a ZIP where the department chose to bundle
 * things rather than list them. So "is this a PDF?" is a real question now, and
 * it has to be answered the same way in the card, in the filename and in the
 * Storage path, or a practitioner downloads `something.pdf` and their reader
 * refuses to open it. */

const COMPRESSED_EXT = /\.(zip|rar|7z|tar|tgz)$/i;
const COMPRESSED_CT = /(zip|x-7z|rar|x-tar|compressed)/i;

/** "pdf" | "zip" | "other" — what the practitioner is about to download. */
export function documentKind(filename, contentType) {
  const name = String(filename || "").replace(/\.gz$/i, "");
  const ct = String(contentType || "");
  if (COMPRESSED_EXT.test(name) || COMPRESSED_CT.test(ct)) return "zip";
  if (/\.pdf$/i.test(name) || /pdf/i.test(ct)) return "pdf";
  return "other";
}

/** The extension a downloaded copy must carry, from the same evidence. */
export function documentExt(filename, contentType) {
  const name = String(filename || "").replace(/\.gz$/i, "");
  const m = /\.([a-z0-9]{2,5})$/i.exec(name);
  if (m) return m[1].toLowerCase();
  const kind = documentKind(name, contentType);
  return kind === "zip" ? "zip" : kind === "pdf" ? "pdf" : "";
}

/** Badge text for a document tile. Deliberately short — it sits on a chip. */
export const DOC_KIND_LABEL = { pdf: "PDF", zip: "ZIP", other: "FILE" };

/* The readable half of a portal filename.
 *
 * ITBA names its documents by concatenating every id it holds:
 *
 *   70000000145843545_186446841_2025_AST_AXIPP8954H_Notice us 148_1087936850(1)_26032026.pdf
 *
 * Exactly one of those segments says what the file IS. Printing the whole thing
 * on a card is unreadable and printing the first 26 characters of it — which is
 * what the response-attachment buttons do — prints nothing but digits. So the
 * id-shaped segments are dropped and what's left is the label: "Notice us 148".
 *
 * Anything that doesn't match the shape falls through to the base name, which
 * is worse but never wrong. */
export function portalDocLabel(filename) {
  const base = String(filename || "")
    .replace(/\.gz$/i, "")
    .replace(/\.[a-z0-9]{2,5}$/i, "");
  const junk = (p) =>
    /^\d+(\(\d+\))?$/.test(p) ||        // a bare id, "1087936850(1)" included
    /^\d{8}$/.test(p) ||                // DDMMYYYY
    /^(19|20)\d{2}$/.test(p) ||         // a year
    /^[A-Z]{5}\d{4}[A-Z]$/i.test(p) ||  // the PAN
    /^AST$/i.test(p);                   // the ITBA module code
  const keep = base.split("_").map((p) => p.trim()).filter(Boolean).filter((p) => !junk(p));
  const label = keep.join(" ").replace(/\s+/g, " ").trim();
  return label || base;
}

/* ---------------- naming ----------------
 *
 * These build the names the user actually sees in their Downloads folder. They
 * live here, next to the download itself, so every screen names the same
 * document the same way.
 *
 * Shape: "<Assessee> - AY 2025-26 - <what it is>". Assessee first because a
 * practitioner's Downloads folder is sorted by name and grouping by client is
 * what makes it navigable. */

const part = (...bits) => bits.map((b) => String(b || "").trim()).filter(Boolean).join(" - ");

/** A notice or order pulled from e-Proceedings. */
export function noticeFilename(notice, assesseeName) {
  const what = notice.isOrder
    ? part("Order", notice.section && `u-s ${notice.section}`)
    : part("Notice", notice.section && `u-s ${notice.section}`);
  return withExtension(
    safeFilename(part(assesseeName, notice.ay && `AY ${notice.ay}`, what, notice.din), "Notice"),
    "pdf"
  );
}

/* One of the OTHER documents behind the same notice — the approval, the set
   note, the search print, or a ZIP the department bundled.
   Named after what it is rather than after the notice, because a folder holding
   four files all called "…Notice u-s 148 (2)" is a folder nobody can use. */
export function noticeDocFilename(doc, notice, assesseeName) {
  const label = doc.label || portalDocLabel(doc.filename) || "Enclosure";
  return withExtension(
    safeFilename(part(assesseeName, notice.ay && `AY ${notice.ay}`, label), "Document"),
    documentExt(doc.filename, doc.contentType)
  );
}

/** A CPC intimation u/s 143(1) or rectification order u/s 154. */
export function returnOrderFilename(order, ay, assesseeName) {
  const kind = order.section === "154" ? "Rectification Order" : "Intimation";
  return withExtension(
    safeFilename(part(assesseeName, ay && `AY ${ay}`, `${kind} u-s ${order.section}`), "Order"),
    "pdf"
  );
}

/** One of the documents that belongs to a filed return. */
export function returnDocFilename(kind, ret, assesseeName) {
  const LABEL = {
    json: [`${ret.form || "ITR"} JSON`, "json"],
    ack: ["ITR-V Acknowledgement", "pdf"],
    form: [`${ret.form || "ITR"} Form`, "pdf"],
    computation: ["Computation of Income", "pdf"],
  }[kind] || ["Document", "pdf"];
  return withExtension(
    safeFilename(part(assesseeName, ret.ay && `AY ${ret.ay}`, LABEL[0]), "Return"),
    LABEL[1]
  );
}
