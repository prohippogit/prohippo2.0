/* The browser zip writer. A malformed archive is not a build failure — the file
   downloads fine and the practitioner's unzipper refuses it a day later, in
   front of a client — so these read the bytes back the way an extractor does:
   through the end-of-central-directory record, then the central directory, then
   each entry's own local header. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { zipBytes, zipBlob, crc32 } from "../src/zip.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function readZip(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // Find the EOCD the way an extractor does — from the end.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  assert.ok(eocd >= 0, "no end-of-central-directory record");
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  let p = view.getUint32(eocd + 16, true);
  assert.equal(p + cdSize, eocd, "central directory does not end where the EOCD starts");

  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(p, true), 0x02014b50, "bad central header signature");
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const csize = view.getUint32(p + 20, true);
    const usize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const local = view.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));

    assert.equal(method, 0, `${name}: entries are stored, not deflated`);
    assert.ok(flags & 0x0800, `${name}: the UTF-8 name flag is not set`);
    assert.equal(csize, usize, `${name}: stored entry sizes disagree`);

    assert.equal(view.getUint32(local, true), 0x04034b50, `bad local header for ${name}`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = buf.subarray(start, start + csize);
    assert.equal(data.length, usize, `${name}: declared size does not match`);
    assert.equal(crc32(data), crc, `${name}: CRC does not match`);
    out.push({ name, data });
    p += 46 + nameLen + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
  }
  return out;
}

test("crc32 matches the known zip/PNG check value", () => {
  assert.equal(crc32(enc.encode("123456789")), 0xcbf43926);
});

test("entries survive a round trip, bytes and names intact", () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x00, 0xff]);
  const zip = zipBytes([
    { name: "Matter/01 Notice/Notice u-s 142(1).pdf", data: pdf },
    { name: "Matter/00 Contents.txt", data: enc.encode("PROCEEDING — Penalty · ₹1,00,000") },
  ]);
  const entries = readZip(zip);
  assert.deepEqual(entries.map((e) => e.name), [
    "Matter/01 Notice/Notice u-s 142(1).pdf",
    "Matter/00 Contents.txt",
  ]);
  assert.deepEqual([...entries[0].data], [...pdf]);
  // Non-ASCII in a name and in the body both survive, which is the whole point
  // of the UTF-8 flag asserted above — a rupee sign in the index is routine.
  assert.equal(dec.decode(entries[1].data), "PROCEEDING — Penalty · ₹1,00,000");
});

test("a name with non-ASCII characters round-trips", () => {
  const zip = zipBytes([{ name: "Shraddha — AY 2024-25/Notice u-s 148.pdf", data: enc.encode("x") }]);
  assert.equal(readZip(zip)[0].name, "Shraddha — AY 2024-25/Notice u-s 148.pdf");
});

test("an empty archive is still a readable archive", () => {
  assert.deepEqual(readZip(zipBytes([])), []);
});

test("a leading slash is stripped — an absolute path in a zip is a trap", () => {
  assert.equal(readZip(zipBytes([{ name: "/etc/passwd", data: enc.encode("x") }]))[0].name, "etc/passwd");
});

test("zipBlob hands back the same bytes as a zip blob", async () => {
  const blob = zipBlob([{ name: "a.txt", data: enc.encode("hello") }]);
  assert.equal(blob.type, "application/zip");
  const back = new Uint8Array(await blob.arrayBuffer());
  assert.equal(dec.decode(readZip(back)[0].data), "hello");
});
