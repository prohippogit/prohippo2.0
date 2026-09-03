/*
 * ProHippo — a zip file, built in the browser.
 *
 * WHY THIS EXISTS. A practitioner filing a paper book, or e-mailing a client
 * everything the department has served in one proceeding, needs the whole
 * proceeding as ONE download with the notices and their replies kept apart in
 * folders. Downloading eleven files one button at a time and then sorting them
 * by hand is the job this app exists to remove.
 *
 * WHY NOT A LIBRARY. Everything in a proceeding bundle is already compressed —
 * PDFs, and the odd ZIP the department itself bundled — so deflating them again
 * buys nothing and costs a dependency plus a WASM download on a page that is
 * mostly used on a phone connection. Stored entries (method 0) are the whole of
 * what is needed here, and that is ~70 lines of well-specified header writing.
 *
 * The build-time twin of this file is scripts/build-extension-zip.mjs, which
 * packages the Chrome extension. That one runs in node, deflates, and leans on
 * Buffer and zlib; this one runs in a browser and cannot. They are deliberately
 * separate rather than shared — the alternative is a module that pretends both
 * environments are one, and neither of them is where the bug would show up.
 *
 * LIMIT. No ZIP64, so an archive is capped at 4 GiB, entries included. A tab
 * holding four gigabytes of PDFs in memory has already died, so this is a
 * stated limit rather than a hidden one — see the throw below.
 */

const ZIP_MAX = 0xffffffff; // what a 32-bit size/offset field can hold

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

/** CRC-32 of a byte array — the checksum every zip entry carries. */
export function crc32(bytes) {
  let c = ~0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

/* MS-DOS date/time, the only timestamp format a zip header has.
 *
 * Entries carry the moment the archive was BUILT unless the caller says
 * otherwise. Not the epoch of the format: a folder of documents all stamped
 * 1 January 1980 reads as a corrupt download, and a practitioner sorting their
 * case folder by date would find this one at the bottom for ever. */
function dosTime(date) {
  const given = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const d = given.getFullYear() >= 1980 ? given : new Date(1980, 0, 1);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const concat = (chunks, total) => {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
};

/**
 * Build a zip archive.
 *
 * Folders are the "/" in an entry's name — no directory entries are written,
 * which every extractor in use handles and which keeps an empty folder from
 * being expressible. (The bundle planner never asks for one: a notice with
 * nothing behind it is reported in the index instead of becoming an empty
 * folder somebody has to open to find out it is empty.)
 *
 * @param entries [{ name, data: Uint8Array|ArrayBuffer, mtime?: Date }]
 * @returns Uint8Array
 */
export function zipBytes(entries) {
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let localBytes = 0;
  let centralBytes = 0;
  let offset = 0;

  for (const entry of entries) {
    const name = enc.encode(String(entry.name).replace(/^\/+/, ""));
    const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data || 0);
    if (data.length > ZIP_MAX || offset > ZIP_MAX - data.length) {
      throw new Error("This bundle is over 4 GB — download the notices in smaller batches.");
    }
    const crc = crc32(data);
    const { time, date } = dosTime(entry.mtime);

    const local = new Uint8Array(30);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);  // local file header signature
    lv.setUint16(4, 20, true);          // version needed to extract (2.0)
    lv.setUint16(6, 0x0800, true);      // flags — bit 11: the name is UTF-8
    lv.setUint16(8, 0, true);           // method 0 — stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // compressed size == size, stored
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);           // extra field length
    locals.push(local, name, data);
    localBytes += local.length + name.length + data.length;

    const central = new Uint8Array(46);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);  // central directory header signature
    cv.setUint16(4, 20, true);          // version made by
    cv.setUint16(6, 20, true);          // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);          // stored
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true);          // extra
    cv.setUint16(32, 0, true);          // comment
    cv.setUint16(34, 0, true);          // disk number
    cv.setUint16(36, 0, true);          // internal attributes
    cv.setUint32(38, (0o100644 << 16) >>> 0, true); // external attributes
    cv.setUint32(42, offset, true);     // where this entry's local header is
    centrals.push(central, name);
    centralBytes += central.length + name.length;

    offset += local.length + name.length + data.length;
  }

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);    // end of central directory
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralBytes, true); // size of the central directory
  ev.setUint32(16, localBytes, true);   // where it starts
  ev.setUint16(20, 0, true);            // comment length

  return concat([...locals, ...centrals, end], localBytes + centralBytes + end.length);
}

/** The same archive as something the browser can save. */
export function zipBlob(entries) {
  return new Blob([zipBytes(entries)], { type: "application/zip" });
}
