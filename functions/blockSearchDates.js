/*
 * Shaping what a language model read out of a search case's documents.
 *
 * Its own module, and CommonJS like everything else in functions/, so it can be
 * run by `node --test` without Firebase. That is the whole point: the network
 * call in index.js cannot be tested here, and this — the half where a bad read
 * turns into a bad block period — can.
 *
 * WHAT IS AT STAKE. s.158B(b) builds the block period out of two dates: when
 * the search was initiated, and when the last of the authorisations was
 * executed. One day either side of 31 March moves the whole block by a year and
 * changes which of Part C's two mutually exclusive tables applies. So this is
 * deliberately suspicious of what it is handed, and throws away more than it
 * keeps.
 */
"use strict";

/* Chapter XIV-B applies to searches initiated on or after 01-09-2024, so a
   "search date" before 2024 is a misread of something else on the page — an
   assessment year, a date of incorporation, a demand from an earlier year. The
   window is wider than the regime to leave room for a document that states a
   date oddly, and still narrow enough to catch the common misreads. */
const EARLIEST = "2024-01-01";
const LATEST = "2100-01-01";

/* The block period's OWN start date is exempt from that floor. It is 1 April of
   the sixth year before the search, so a perfectly correct one reads 2019 —
   the window that catches misread search dates would throw away the real
   thing. Seven years before the regime began is as far back as it can go. */
const EARLIEST_BLOCK_START = "2017-01-01";

/* A notice in a block assessment is issued after the search, so it cannot
   predate the regime by much — but its own floor is separate from the search
   dates', because a wrong one here fills a Part A field rather than moving
   seven years of assessment. */
const EARLIEST_NOTICE = "2024-01-01";

/** YYYY-MM-DD, or "" for anything that is not a date in the window. */
function saneDate(v, normDate, floor) {
  const d = normDate(v);
  if (!d) return "";
  return d >= (floor || EARLIEST) && d <= LATEST ? d : "";
}

/**
 * @param raw       what the model returned
 * @param normDate  the caller's date normaliser (functions/index.js owns it)
 * @param now       ISO timestamp, injectable so a test can pin it
 */
function normaliseSearchDates(raw, normDate, now) {
  const r = raw && typeof raw === "object" ? raw : {};
  const initiationDate = saneDate(r.initiationDate, normDate);
  let lastAuthorisationDate = saneDate(r.lastAuthorisationDate, normDate);

  /* A search cannot conclude before it began. Where the read says otherwise the
     PAIR is untrustworthy, not just the later one — but the initiation date is
     the one the six preceding years hang off and is usually the better read of
     the two, so it survives and the conclusion is dropped. The block period
     then falls back to the same-day case, which is the shorter of the two
     shapes and never the one that invents a year of assessment. */
  if (lastAuthorisationDate && initiationDate && lastAuthorisationDate < initiationDate) lastAuthorisationDate = "";

  const panchnamaDates = [...new Set(
    (Array.isArray(r.panchnamaDates) ? r.panchnamaDates : []).map((v) => saneDate(v, normDate)).filter(Boolean)
  )].sort().slice(0, 20);

  const quotes = r.quotes && typeof r.quotes === "object" ? r.quotes : {};
  const quote = (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : "");

  /* THE BLOCK PERIOD, WHERE THE DEPARTMENT HAS ALREADY PRINTED IT.
   *
   * Every s.142(1) notice issued in a block assessment carries a line reading
   * "Block Period: 01/04/2019-23/08/2025" in its letterhead. That is the
   * department's own statement of the period it is assessing, and it was
   * sitting unread on a real proceeding while the app asked a practitioner to
   * find two dates by hand.
   *
   * Its END is not an inference. s.158B(b) DEFINES the block period as ending
   * on the date the last of the authorisations was executed, so a printed end
   * date IS A20 — read off the page, not computed from anything. Its START is
   * different: it fixes only the YEAR the search was initiated, never the day,
   * and A19 stays empty rather than being invented. What the start is good for
   * is checking (see statedPeriodAgrees in the client): if a same-day reading
   * of the end date reproduces the printed start, the printed period and the
   * derived one are the same period, and that can be shown rather than assumed. */
  const blockPeriodFrom = saneDate(r.blockPeriodFrom, normDate, EARLIEST_BLOCK_START);
  const blockPeriodTo = saneDate(r.blockPeriodTo, normDate);
  const statedPeriod = blockPeriodFrom && blockPeriodTo && blockPeriodFrom < blockPeriodTo
    ? { from: blockPeriodFrom, to: blockPeriodTo, quote: quote(quotes.blockPeriod) }
    : null;

  // A20 taken from a printed block period is still A20, and it is marked so the
  // screen can say where it came from rather than showing it like a direct read.
  let lastAuthFrom = lastAuthorisationDate ? "document" : "";
  if (!lastAuthorisationDate && statedPeriod && (!initiationDate || statedPeriod.to >= initiationDate)) {
    lastAuthorisationDate = statedPeriod.to;
    lastAuthFrom = "blockPeriod";
  }

  /* THE NOTICE'S OWN PARTICULARS, read only because they may have no other
   * source.
   *
   * Everywhere else in this app a notice's DIN and dates come from the portal
   * sync and a language model is not allowed near them — re-reading a recorded
   * fact can only make it worse. But a document the practitioner has UPLOADED
   * is, by definition, one the portal never sent us: there is no record to
   * prefer, and refusing to read it leaves the fields empty for no reason.
   *
   * So they are returned, and the client writes them ONLY into fields that are
   * still blank. That rule lives on the client (`fromRead` in ItrB.jsx) rather
   * than here, because only the client knows what the draft already holds.
   *
   * The PAN is read for one purpose: to notice that the wrong client's
   * panchnama has been uploaded. */
  const notice = {
    pan: /^[A-Z]{5}\d{4}[A-Z]$/i.test(String(r.pan || "").trim()) ? String(r.pan).trim().toUpperCase() : "",
    din: String(r.noticeDin || "").replace(/\D/g, "").slice(0, 30),
    date: saneDate(r.noticeDate, normDate, EARLIEST_NOTICE),
    section: ["158BC", "158BD"].includes(String(r.noticeSection || "").replace(/\s|\./g, "").toUpperCase())
      ? String(r.noticeSection).replace(/\s|\./g, "").toUpperCase() : "",
    serviceDate: saneDate(r.serviceDate, normDate, EARLIEST_NOTICE),
    dueDate: saneDate(r.responseDueDate, normDate, EARLIEST_NOTICE),
  };
  // A notice cannot be served before it is issued, and a return cannot be due
  // before the notice exists. Either way round means a misread, so it goes.
  if (notice.date && notice.serviceDate && notice.serviceDate < notice.date) notice.serviceDate = "";
  if (notice.date && notice.dueDate && notice.dueDate < notice.date) notice.dueDate = "";

  return {
    initiationDate,
    lastAuthorisationDate,
    lastAuthFrom,
    statedPeriod,
    notice,
    panchnamaDates,
    searchSection: ["132", "132A"].includes(String(r.searchSection || "").trim()) ? String(r.searchSection).trim() : "",
    /* Kept beside every date, because these two decide seven years of
       assessment and a date offered without the sentence it came from cannot be
       checked against the document. */
    quotes: {
      initiationDate: quote(quotes.initiationDate),
      lastAuthorisationDate: quote(quotes.lastAuthorisationDate),
      blockPeriod: quote(quotes.blockPeriod),
    },
    at: now || new Date().toISOString(),
  };
}

/* ---------- what was actually in the bundle ---------------------------------
 *
 * The first live run of this reader came back with nothing, on a proceeding
 * that plainly had the dates in it. Two reasons, and neither was the model's:
 *
 *  1. The department does not send ONE notice. A block proceeding accumulates
 *     the s.158BC notice, the covering letter, reminders, and the panchnama —
 *     often on separate entries. Reading only the notice that starts the return
 *     reads the one document least likely to state the date the search
 *     concluded.
 *
 *  2. What it sends is frequently a ZIP. The portal and the department's own
 *     e-mail both bundle scans that way, so what is on file is an archive whose
 *     name says nothing and whose contents were never opened. Handing that to a
 *     language model as though it were a PDF reads nothing at all.
 *
 * So: every block notice's files, archives expanded, and — because a reader
 * that silently read nothing is worse than one that fails loudly — a manifest
 * naming every file considered and what became of it. The practitioner can see
 * that the panchnama was never uploaded, which is the actual answer, instead of
 * being told the documents "could not be read".
 *
 * ZIP IS READ HERE RATHER THAN BY A DEPENDENCY. The format's central directory
 * is a few hundred bytes of fixed-offset fields and zlib — already in Node —
 * does the only hard part. Reading it here keeps it inside `node --test`, which
 * matters more than usual: a zip-bomb guard that is never exercised is not a
 * guard.
 * -------------------------------------------------------------------------- */

const zlib = require("zlib");

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/* What a language model can be handed. Anything else is named in the manifest
   and not sent — a .xlsx costs a page of tokens and cannot state a date. */
const READABLE_MIME = {
  pdf: "application/pdf",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/** What a file actually is, by its first bytes. Extensions lie; scans arrive
    named "document.pdf" and are TIFFs, and archives arrive with no extension. */
function sniffKind(buf) {
  if (!buf || buf.length < 4) return { kind: "empty", mimeType: "" };
  const b = buf;
  const at = (i, ...bytes) => bytes.every((v, k) => b[i + k] === v);
  if (at(0, 0x25, 0x50, 0x44, 0x46)) return { kind: "pdf", mimeType: READABLE_MIME.pdf };
  if (at(0, 0x50, 0x4b) && [0x03, 0x05, 0x07].includes(b[2])) return { kind: "zip", mimeType: "" };
  if (at(0, 0xff, 0xd8, 0xff)) return { kind: "jpeg", mimeType: READABLE_MIME.jpeg };
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { kind: "png", mimeType: READABLE_MIME.png };
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return { kind: "webp", mimeType: READABLE_MIME.webp };
  if (at(0, 0x52, 0x61, 0x72, 0x21)) return { kind: "rar", mimeType: "" };
  if (at(0, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return { kind: "7z", mimeType: "" };
  if (at(0, 0x49, 0x49, 0x2a, 0x00) || at(0, 0x4d, 0x4d, 0x00, 0x2a)) return { kind: "tiff", mimeType: "" };
  if (at(0, 0xd0, 0xcf, 0x11, 0xe0)) return { kind: "office", mimeType: "" };
  return { kind: "other", mimeType: "" };
}

/** The End of Central Directory record, scanned back from the tail. Its comment
    field may be up to 64 KB, so that is how far back it can be. */
function findEocd(buf) {
  const floor = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= floor; i--) if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  return -1;
}

const isCruft = (name) => /^__MACOSX\//.test(name) || /(^|\/)\.[^/]/.test(name) || name.endsWith("/");

/**
 * Everything inside a ZIP, decompressed.
 *
 * @returns { ok, reason, entries, truncated }
 *          entries[] are { name, data } or { name, error, bytes }.
 *
 * Bounded three ways — entry count, per-entry size and total size — because the
 * archive is a stranger's file and `uncompressedSize` in it is a claim, not a
 * fact. zlib's own maxOutputLength enforces the claim.
 */
function readArchive(buf, opts = {}) {
  const maxEntries = opts.maxEntries || 40;
  const maxEntryBytes = opts.maxEntryBytes || 12 * 1024 * 1024;
  const maxArchiveBytes = opts.maxArchiveBytes || 48 * 1024 * 1024;

  const eocd = findEocd(buf);
  if (eocd < 0) return { ok: false, reason: "not a readable zip", entries: [], truncated: false };

  const count = buf.readUInt16LE(eocd + 10);
  const cenOff = buf.readUInt32LE(eocd + 16);
  /* 0xFFFFFFFF is ZIP64's escape value. Those archives are 4 GB or 65,535
     files; nothing the department sends is either, so a bundle claiming to be
     one is corrupt or hostile. Refuse it by name rather than misparse it. */
  if (cenOff === 0xffffffff || count === 0xffff) return { ok: false, reason: "zip64 archives are not supported", entries: [], truncated: false };
  if (cenOff >= buf.length) return { ok: false, reason: "corrupt zip directory", entries: [], truncated: false };

  const entries = [];
  let p = cenOff;
  let total = 0;
  let truncated = false;

  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) break;
    const flag = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;

    if (isCruft(name)) continue;
    if (entries.length >= maxEntries) { truncated = true; break; }

    // General purpose bit 0. An encrypted entry is not a failure to report as a
    // bad read — somebody has to be asked for the password.
    if (flag & 0x1) { entries.push({ name, error: "password-protected", bytes: uncompSize }); continue; }
    if (compSize === 0xffffffff || uncompSize === 0xffffffff) { entries.push({ name, error: "zip64 entry", bytes: 0 }); continue; }
    if (uncompSize > maxEntryBytes) { entries.push({ name, error: "too large to open", bytes: uncompSize }); continue; }
    if (total + uncompSize > maxArchiveBytes) { entries.push({ name, error: "archive too large to open in full", bytes: uncompSize }); truncated = true; continue; }

    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== LOC_SIG) { entries.push({ name, error: "corrupt entry", bytes: uncompSize }); continue; }
    // The local header's name and extra lengths are its own and need not match
    // the central directory's — reading the central one here is the classic way
    // to land in the middle of the data.
    const start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const end = start + compSize;
    if (end > buf.length) { entries.push({ name, error: "corrupt entry", bytes: uncompSize }); continue; }

    let data = null;
    try {
      if (method === 0) data = Buffer.from(buf.subarray(start, end));
      else if (method === 8) data = zlib.inflateRawSync(buf.subarray(start, end), { maxOutputLength: maxEntryBytes });
    } catch { data = null; }
    if (!data) { entries.push({ name, error: method === 0 || method === 8 ? "corrupt entry" : `compression method ${method} not supported`, bytes: uncompSize }); continue; }

    total += data.length;
    entries.push({ name, data });
  }

  return { ok: true, reason: "", entries, truncated };
}

/** The leaf of a path, as a person would name the file. */
function fileName(s) {
  const bare = String(s || "").split(/[/\\]/).filter(Boolean).pop() || "document";
  return bare.slice(0, 120);
}

/* Which documents get the byte budget when not everything fits.
 *
 * The panchnama states both dates and the s.158BC notice usually states only
 * the first, so on a bundle too big to send whole the panchnama is the file
 * that must go. Everything else is read in the order it was found. */
function documentPriority(name) {
  const n = String(name || "").toLowerCase();
  if (/panch(n|an)ama|panchnama|conclusion of search/.test(n)) return 0;
  if (/authoris|authoriz|warrant|132/.test(n)) return 1;
  if (/158\s*b|notice|order/.test(n)) return 2;
  return 3;
}

/**
 * Turn what came out of Storage into what goes to the model, and a manifest of
 * everything considered.
 *
 * @param sources [{ notice, noticeId, name, buf, error }]
 * @param opts    { maxTotalBytes, ...archive limits }
 * @returns { files, manifest, read, skipped }
 *
 * `files` are Gemini inlineData parts. `manifest` names every file — including
 * the ones that were not sent, and why — in the order they were found, so the
 * card the practitioner sees is the bundle as it stands on file.
 */
function collectDocuments(sources, opts = {}) {
  const budget = opts.maxTotalBytes || 9 * 1024 * 1024;
  const maxDepth = opts.maxDepth || 2;
  const candidates = [];
  let seq = 0;

  const add = (row) => { candidates.push({ order: seq++, bytes: 0, from: "", detail: "", kind: "", ...row }); return candidates[candidates.length - 1]; };

  const expand = (src, depth) => {
    const base = { notice: src.notice || "", noticeId: src.noticeId || "", name: fileName(src.name), from: src.from || "" };
    if (src.error) return add({ ...base, status: "unreadable", detail: src.error });
    const buf = src.buf;
    if (!buf || !buf.length) return add({ ...base, status: "unreadable", detail: "empty file" });

    const { kind, mimeType } = sniffKind(buf);

    if (kind === "zip") {
      if (depth >= maxDepth) return add({ ...base, kind, bytes: buf.length, status: "skipped", detail: "an archive inside an archive" });
      const arch = readArchive(buf, opts);
      if (!arch.ok) return add({ ...base, kind, bytes: buf.length, status: "unreadable", detail: arch.reason });
      const inside = arch.entries.filter((e) => e.data).length;
      add({ ...base, kind, bytes: buf.length, status: "archive", detail: `opened — ${inside} file${inside === 1 ? "" : "s"} inside${arch.truncated ? ", and more it could not open" : ""}` });
      for (const e of arch.entries) {
        if (e.data) expand({ notice: base.notice, noticeId: base.noticeId, name: e.name, from: base.name, buf: e.data }, depth + 1);
        else add({ notice: base.notice, noticeId: base.noticeId, name: fileName(e.name), from: base.name, bytes: e.bytes || 0, status: e.error === "password-protected" ? "encrypted" : "unreadable", detail: e.error });
      }
      return null;
    }

    if (!mimeType) {
      return add({ ...base, kind, bytes: buf.length, status: "skipped", detail: kind === "rar" || kind === "7z" ? `${kind.toUpperCase()} archives cannot be opened here` : "not a document that can be read" });
    }
    return add({ ...base, kind, bytes: buf.length, status: "candidate", mimeType, buf });
  };

  for (const s of sources || []) expand(s, 0);

  const queue = candidates.filter((c) => c.status === "candidate")
    .sort((a, b) => documentPriority(a.name) - documentPriority(b.name) || a.bytes - b.bytes || a.order - b.order);

  const files = [];
  let total = 0;
  for (const c of queue) {
    if (total + c.bytes > budget) { c.status = "too-large"; c.detail = "left out — the bundle is bigger than one read"; continue; }
    total += c.bytes;
    files.push({ mimeType: c.mimeType, data: c.buf.toString("base64") });
    c.status = "read";
  }

  const manifest = candidates
    .sort((a, b) => a.order - b.order)
    .map(({ name, from, notice, kind, bytes, status, detail }) => ({ name, from, notice, kind, bytes, status, detail }))
    .slice(0, 60);

  return { files, manifest, read: files.length, skipped: candidates.filter((c) => !["read", "archive"].includes(c.status)).length };
}


/* Which files in a FILED REPLY are worth reading for a search date.
 *
 * The panchnama is handed to the assessee at the conclusion of the search and
 * comes back to the department as an annexure to the reply to a s.142(1)
 * notice — so on a real proceeding it sits under a response we filed, not under
 * anything the department sent. Reading a whole reply is out of the question: a
 * reply carries the client's ledgers, bank statements and confirmations, dozens
 * of files, none of which can state when a search was authorised. So the ones
 * NAMED as search documents are read and the rest are counted.
 *
 * "panch" rather than "panchnama": the spelling on a real annexure was
 * "Comprihansive Panchanama". A name typed by a person is not a fixed string,
 * and the cost of a false positive here is one extra PDF in a read that was
 * happening anyway.
 *
 * THE CLIENT HAS A COPY of this rule in src/tools/itrb/findProceeding.js, to
 * count on screen what this will read. This one is the authority — it decides
 * what is actually sent — and a test asserts the two agree.
 */
const SEARCH_DOC_NAME = /panch|warrant|authoris|authoriz|\b132\b|search\s*(&|and)?\s*seiz/i;
const isSearchDocName = (name) => SEARCH_DOC_NAME.test(String(name || ""));

module.exports = {
  normaliseSearchDates, EARLIEST, LATEST, isSearchDocName,
  sniffKind, readArchive, collectDocuments, documentPriority, fileName,
};
