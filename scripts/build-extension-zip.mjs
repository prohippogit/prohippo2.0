/*
 * Packages `extension/` into a zip the web app can hand to a practitioner.
 *
 * WHY THIS EXISTS. Auto-login and the portal fetch both run through the
 * ProHippo Sync Chrome extension, and the only way to get it used to be "clone
 * the repo" — so a first-time user opened an assessee, pressed Sync, and was
 * told to install something they had no way of installing. The zip is built
 * from the same `extension/` folder this build deploys, so what someone
 * downloads is always the version the app expects.
 *
 * NO ZIP DEPENDENCY. A store/deflate zip is ~120 lines of well-specified header
 * writing on top of zlib, which node already has. Adding a packaging library to
 * the app's dependency tree to produce one build artefact would cost more than
 * it saves.
 *
 * Run automatically by `npm run dev` and `npm run build` (see package.json).
 * The output is git-ignored — it is a build artefact of extension/, like dist/.
 */
import { deflateRawSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The folder name someone ends up with after unzipping — it is what they pick
// in Chrome's "Load unpacked", so it says what it is rather than "extension".
export const ZIP_ROOT = "prohippo-sync-extension";
export const OUT_FILE = path.join(ROOT, "public", `${ZIP_ROOT}.zip`);

/* ---------------- minimal zip writer ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

// MS-DOS date/time, the only timestamp format the zip header has.
function dosTime(date) {
  const d = date.getFullYear() >= 1980 ? date : new Date(1980, 0, 1);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2)),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/* Build a zip from [{ name, data, mtime }]. Entries are stored deflated
   (method 8) unless that would make them bigger, which is the case for the
   already-compact manifest. */
export function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const { time, date } = dosTime(entry.mtime || new Date());
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed to extract (2.0)
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);           // extra field length
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header signature
    central.writeUInt16LE(20, 4);         // version made by
    central.writeUInt16LE(20, 6);         // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);         // extra
    central.writeUInt16LE(0, 32);         // comment
    central.writeUInt16LE(0, 34);         // disk number
    central.writeUInt16LE(0, 36);         // internal attributes
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attributes (rw-r--r--)
    central.writeUInt32LE(offset, 42);    // offset of the local header
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); // size of the central directory
  end.writeUInt32LE(offset, 16);            // where it starts
  end.writeUInt16LE(0, 20);                 // comment length

  return Buffer.concat([...locals, centralBuf, end]);
}

/* ---------------- the extension folder ---------------- */

// Everything in extension/ ships — the manifest names only some of the scripts,
// and a file left out of the zip fails at run time rather than at build time.
// Editor droppings and the README are the only exclusions.
const SKIP = new Set([".DS_Store", "Thumbs.db"]);

function collect(dir, prefix = "") {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...collect(full, `${prefix}${name}/`));
    else out.push({ name: `${prefix}${name}`, data: fs.readFileSync(full), mtime: st.mtime });
  }
  return out;
}

export function buildExtensionZip({ srcDir = path.join(ROOT, "extension"), outFile = OUT_FILE, zipRoot = ZIP_ROOT } = {}) {
  const files = collect(srcDir);
  if (!files.some((f) => f.name === "manifest.json")) {
    throw new Error(`No manifest.json in ${srcDir} — that is not a loadable extension folder.`);
  }
  const zip = makeZip(files.map((f) => ({ ...f, name: `${zipRoot}/${f.name}` })));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, zip);
  return { outFile, files: files.length, bytes: zip.length };
}

// Run directly (npm run dev / build) — but importable by the test without
// writing anything.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { outFile, files, bytes } = buildExtensionZip();
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, "extension", "manifest.json"), "utf8")).version;
  console.log(`extension v${version} → ${path.relative(ROOT, outFile)} (${files} files, ${(bytes / 1024).toFixed(0)} KB)`);
}
