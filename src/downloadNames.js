/*
 * ProHippo — what a downloaded document is called.
 *
 * Pure string work, deliberately kept apart from the download itself
 * (downloadFile.js) so these rules can be tested without pulling in Firebase or
 * a DOM. They are shared by every screen, because the same order downloaded
 * from the Notices page and from an assessee's Matters tab must arrive under
 * the same name — otherwise a practitioner ends up with two copies of one
 * document and no way to tell which is which.
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
