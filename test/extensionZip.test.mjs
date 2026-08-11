/* The extension zip is what a first-time user downloads to make auto-login
   work, so a zip that is subtly malformed is a support call, not a build error:
   the file downloads fine and Chrome refuses it days later. These tests read
   the archive back the way an unzipper does — central directory, then each
   entry's own header — rather than trusting the bytes we just wrote. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeZip, crc32, buildExtensionZip, ZIP_ROOT } from "../scripts/build-extension-zip.mjs";

// Read an archive through its central directory, as any unzipper does.
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, "no end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  let p = buf.readUInt32LE(eocd + 16);
  assert.equal(p + cdSize, eocd, "central directory does not end where the EOCD starts");

  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, "bad central header signature");
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");

    // Now follow the offset to the entry itself, exactly as an extractor would.
    assert.equal(buf.readUInt32LE(local), 0x04034b50, `bad local header for ${name}`);
    const localNameLen = buf.readUInt16LE(local + 26);
    const localExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + localNameLen + localExtraLen;
    const body = buf.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);

    assert.equal(data.length, usize, `${name}: declared size does not match`);
    assert.equal(crc32(data), crc, `${name}: CRC does not match`);
    out.push({ name, data });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

test("crc32 matches the known zip/PNG check value", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("entries survive a round trip, compressed or stored", () => {
  const compressible = Buffer.from("prohippo ".repeat(400));
  const incompressible = Buffer.from([1, 2, 3]); // deflate would make this bigger
  const zip = makeZip([
    { name: "a/big.txt", data: compressible, mtime: new Date("2026-02-01T10:00:00Z") },
    { name: "a/tiny.bin", data: incompressible, mtime: new Date("2026-02-01T10:00:00Z") },
  ]);
  const entries = readZip(zip);
  assert.deepEqual(entries.map((e) => e.name), ["a/big.txt", "a/tiny.bin"]);
  assert.deepEqual(entries[0].data, compressible);
  assert.deepEqual(entries[1].data, incompressible);
  assert.ok(zip.length < compressible.length, "the compressible entry was not deflated");
});

test("a pre-1980 timestamp is clamped rather than written as a negative date", () => {
  // The zip date field starts at 1980; a file older than that would otherwise
  // write a negative year and produce an archive no extractor accepts.
  const zip = makeZip([{ name: "old.txt", data: Buffer.from("x"), mtime: new Date("1970-01-01T00:00:00Z") }]);
  assert.deepEqual(readZip(zip)[0].data, Buffer.from("x"));
});

test("the built archive is the extension folder, under one loadable root", () => {
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ph-ext-")), "ext.zip");
  const { files } = buildExtensionZip({ outFile });
  const entries = readZip(fs.readFileSync(outFile));

  assert.equal(entries.length, files);
  assert.ok(entries.every((e) => e.name.startsWith(`${ZIP_ROOT}/`)), "entries are not under one folder");

  // Chrome loads the folder by its manifest, and the manifest names the scripts
  // that have to be beside it — so those are the ones worth asserting.
  const manifestEntry = entries.find((e) => e.name === `${ZIP_ROOT}/manifest.json`);
  assert.ok(manifestEntry, "no manifest.json in the archive");
  const manifest = JSON.parse(manifestEntry.data.toString("utf8"));
  const named = [
    manifest.background.service_worker,
    ...manifest.content_scripts.flatMap((c) => c.js),
  ];
  for (const js of named) {
    assert.ok(entries.some((e) => e.name === `${ZIP_ROOT}/${js}`), `manifest names ${js}, which is missing from the archive`);
  }
});
