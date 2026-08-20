/*
 * Documents the practitioner has, that the portal does not.
 *
 * WHY THIS EXISTS. The two dates that fix a block period are on the panchnama,
 * and the panchnama is very often nowhere in this app: it is handed over on the
 * day the search concludes, on paper, and it reaches the portal only if somebody
 * later files it as an annexure to a reply. On a case where that has not
 * happened there is nothing to read, and the practitioner is left keying two
 * dates off a document sitting on their desk — the one situation this whole
 * feature exists to avoid.
 *
 * So the reader takes uploads as well. Same reader, same manifest, same quotes:
 * a document that came off the practitioner's scanner is treated exactly like
 * one that came off the portal, because for the purpose of reading a date out of
 * it there is no difference.
 *
 * PDF ONLY, AND CHECKED BY ITS BYTES. Not because anything downstream would
 * break — the server sniffs every file it is handed — but because the failure a
 * name-only check produces is the worst kind: the file uploads, the read runs,
 * it costs money, and it comes back with nothing, and the practitioner has no
 * way to know it was because their scanner wrote a TIFF called "panchnama.pdf".
 * Refusing it at the moment of choosing says so while they can still fix it.
 *
 * Pure, so `node --test` can reach it without a browser: everything here works
 * from a name, a size and the first few bytes.
 */

/* Each file is capped below the whole-request budget in functions/index.js
   (MAX_TOTAL_BYTES, 9 MB): one file that fills the request leaves no room for
   the notice it needs to be read alongside. A scanned panchnama of a dozen
   pages is comfortably under this. */
export const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;

/** At most this many at once — the reader gets one call and it has to fit. */
export const MAX_UPLOADS = 10;

/** The first bytes of a PDF: "%PDF". Everything else is not one, whatever the
    name says — a scanner that writes TIFFs called .pdf is a real thing. */
export function looksLikePdf(head) {
  const b = head || [];
  return b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;
}

/**
 * May this file be uploaded?
 *
 * @param file  { name, size } — a File, or anything shaped like one
 * @param head  its first few bytes, already read
 * @param held  how many are already attached to this draft
 * @returns { ok, reason } — `reason` is shown to the practitioner verbatim, so
 *          it names the file and says what to do rather than what went wrong
 */
export function checkUpload(file, head, held = 0) {
  const name = String(file?.name || "").trim();
  const size = Number(file?.size) || 0;
  if (!name) return { ok: false, reason: "That file has no name." };
  if (held >= MAX_UPLOADS) return { ok: false, reason: `${MAX_UPLOADS} documents is as many as one read can take. Remove one first.` };
  if (!/\.pdf$/i.test(name)) return { ok: false, reason: `${name} is not a PDF. Only PDFs can be read.` };
  if (!size) return { ok: false, reason: `${name} is empty.` };
  if (size > MAX_UPLOAD_BYTES) {
    return { ok: false, reason: `${name} is ${(size / (1024 * 1024)).toFixed(1)} MB — the limit is ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB. Scan it at a lower resolution, or split it.` };
  }
  if (!looksLikePdf(head)) {
    return { ok: false, reason: `${name} is named .pdf but is not one — its contents are something else. Open it and re-save it as a PDF.` };
  }
  return { ok: true, reason: "" };
}

/* Where an upload lives in Storage.
 *
 * Under the user's own tree, so the rules already in storage.rules cover it
 * (users/{uid}/** is theirs and nobody else's), and under an `itrb/` segment so
 * the callable can insist on that prefix rather than accepting any path a
 * caller cares to name. The id is random rather than derived from the filename:
 * two panchnamas called "scan.pdf" are two documents.
 *
 * @param uid  the signed-in user
 * @param id   a random id — passed in so this stays pure and testable
 */
export function uploadPath(uid, id) {
  return `users/${uid}/itrb/${String(id).replace(/[^A-Za-z0-9_-]/g, "")}.pdf`;
}

/** A short, honest name for a file on a card. Long scanner names are the norm. */
export function shortName(name, max = 64) {
  const s = String(name || "Document");
  return s.length <= max ? s : `${s.slice(0, max - 12)}…${s.slice(-8)}`;
}
