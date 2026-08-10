/*
 * ProHippo — what documents a notice actually has.
 *
 * A notice on e-Proceedings is not a document, it is a SET of them. The portal's
 * own "Notice/Letter pdf" screen for a s.148 reassessment lists four Download
 * buttons — the notice itself, the approval to the JAO, the set note, and the
 * print of the approval search — and the sync used to take exactly one of them,
 * chosen by a field that does not even point at the notice. Three files stayed
 * on the portal, and nothing on screen said so.
 *
 * Pure list-and-classify work, kept apart from the component that renders it
 * (NoticeDocuments.jsx) so it can be reused by a table cell, a badge count or a
 * test without pulling in React.
 */
import { documentKind } from "./downloadNames.js";

/* Every document on a notice, primary first.
 *
 * The primary is the notice's own storagePath — what the "PDF" button saves and
 * what the AI summary is read from. The rest ride in `attachments`, written by
 * the portal sync. A notice that predates the multi-document fetch simply has
 * no `attachments`, so it lists as one file, which is honest: one file is all
 * we hold until the sync sweeps it. */
export function noticeDocuments(notice) {
  const out = [];
  if (notice?.storagePath) {
    out.push({
      storagePath: notice.storagePath,
      filename: notice.fileName || "",
      kind: documentKind(notice.fileName, ""),
      bytes: 0,
      primary: true,
    });
  }
  for (const at of notice?.attachments || []) {
    if (!at || !at.storagePath) continue;
    out.push({
      storagePath: at.storagePath,
      filename: at.filename || "",
      kind: at.kind || documentKind(at.filename, at.contentType),
      bytes: at.bytes || 0,
      primary: false,
    });
  }
  return out;
}

/** How many files a notice has, for a row with no space for a list. */
export const noticeDocumentCount = (notice) => noticeDocuments(notice).length;

/* Whether this notice needs its documents spelled out, or whether the plain
   "PDF" button already says everything. True for a set, and true for a lone
   ZIP — "download the PDF" is a lie about a compressed folder. Exported so a
   screen can drop its own PDF button exactly when the list takes over. */
export function hasDocumentList(notice) {
  const docs = noticeDocuments(notice);
  return docs.length > 1 || docs.some((d) => d.kind !== "pdf");
}

/* "10.7 MB". Sizes are shown because one of these sets is routinely 11 MB and a
   practitioner on a phone connection deserves to know before they tap. */
export function fmtBytes(n) {
  const b = Number(n) || 0;
  if (!b) return "";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}
