// Strip the password off an Income-tax intimation / rectification order PDF.
//
// CPC serves every order under s.143(1) and s.154 encrypted (RC4-128, standard
// security handler). The password is documented by the department and is always
// the same recipe:
//
//     PAN in lower case  +  date of birth / incorporation as DDMMYYYY
//     e.g.  aalfj4935c04112015
//
// We hold both halves already, so there is no reason to store a file the
// practitioner then has to unlock by hand every time they open it. We decrypt
// on the way in and Storage only ever sees a clean PDF.
//
// qpdf (Apache-2.0) compiled to WebAssembly does the work — no native module to
// build per platform, and the same package runs in the browser, so the
// extension fetch path (src/pdfUnlock.js) is a straight mirror of this file.
//
// NOTE ON LICENCES: mupdf would also do this and is a nicer API, but it is
// AGPL-3.0. Do not swap it in.
"use strict";

const path = require("node:path");

// qpdf's exit codes: 0 = clean, 2 = error (wrong password lands here), 3 =
// succeeded with warnings — a warning still writes a valid output file, and
// portal PDFs routinely warn about their own malformed xref tables.
const EXIT_OK = 0;
const EXIT_WARN = 3;

let modulePromise = null;

// One Emscripten instance, built on first use and reused. If a call ever throws
// (as opposed to returning a non-zero exit code) the runtime may be left in an
// unusable state, so we drop the cache and the next call rebuilds.
function getModule() {
  if (!modulePromise) {
    const createModule = require("@neslinesli93/qpdf-wasm");
    const wasm = path.join(path.dirname(require.resolve("@neslinesli93/qpdf-wasm")), "qpdf.wasm");
    // Note: this build writes qpdf's own diagnostics straight to stderr and
    // does not honour Emscripten's print/printErr overrides, so a wrong
    // candidate logs "invalid password". That is a normal branch here — we walk
    // a candidate list — and the caller gets the real answer from the return
    // value, not the log.
    modulePromise = createModule({ locateFile: () => wasm }).catch((err) => {
      modulePromise = null;
      throw err;
    });
  }
  return modulePromise;
}

// "2015-11-04" | "04-11-2015" | epoch millis → "04112015". Anything we can't
// read confidently returns "" so the caller can skip rather than guess: an
// almost-right password is the same as no password, but a guessed one hides the
// real reason the unlock failed.
function ddmmyyyy(value) {
  if (value == null || value === "") return "";
  const s = String(value).trim();

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); // 2015-11-04
  if (iso) return `${iso[3]}${iso[2]}${iso[1]}`;

  const dmy = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(s); // 04-11-2015, 04/11/2015
  if (dmy) return `${dmy[1]}${dmy[2]}${dmy[3]}`;

  if (/^\d{8}$/.test(s)) return s; // already DDMMYYYY

  if (/^\d{10,}$/.test(s)) {
    // Epoch millis, as the portal's own myPanDetailsService returns them. Read
    // in IST, because a UTC read tips dates before 05:30 back a day.
    const d = new Date(Number(s) + 5.5 * 3600 * 1000);
    if (!Number.isNaN(d.getTime())) {
      const p = (n) => String(n).padStart(2, "0");
      return `${p(d.getUTCDate())}${p(d.getUTCMonth() + 1)}${d.getUTCFullYear()}`;
    }
  }
  return "";
}

// The department's recipe. Returns "" when either half is missing.
function derivePassword(pan, dob) {
  const p = String(pan || "").trim().toLowerCase();
  const d = ddmmyyyy(dob);
  if (!/^[a-z]{5}\d{4}[a-z]$/.test(p) || !d) return "";
  return p + d;
}

// Try each candidate password in turn against a base64 PDF.
//
// Returns { ok: true, base64, password } on success, or { ok: false, reason }
// where reason is one of "not-encrypted" (nothing to do — caller keeps the
// original), "no-password" (we had nothing to try) or "wrong-password".
//
// Candidates exist because the date can come from more than one place: the
// assessee record, the portal's PAN details, and the filed ITR JSON. Trying two
// is cheaper than deciding which is authoritative.
async function unlockPdf(base64, candidates) {
  const passwords = [...new Set((candidates || []).filter(Boolean))];
  const input = Buffer.from(base64, "base64");

  // An unencrypted PDF has no /Encrypt in its trailer. Checking first means the
  // ITR-V and form-preview PDFs (which are not encrypted) never touch qpdf.
  if (!input.includes("/Encrypt")) return { ok: false, reason: "not-encrypted" };
  if (!passwords.length) return { ok: false, reason: "no-password" };

  let mod;
  try {
    mod = await getModule();
  } catch (err) {
    return { ok: false, reason: "unavailable", error: String((err && err.message) || err) };
  }

  for (const password of passwords) {
    try {
      mod.FS.writeFile("/in.pdf", input);
      const code = mod.callMain(["--decrypt", `--password=${password}`, "/in.pdf", "/out.pdf"]);
      if (code === EXIT_OK || code === EXIT_WARN) {
        const out = Buffer.from(mod.FS.readFile("/out.pdf"));
        // Belt and braces: qpdf reported success, so the output must be a PDF
        // with the encryption gone. If it isn't, treat it as a failure rather
        // than storing something we haven't actually unlocked.
        if (out.length > 5 && out.subarray(0, 5).toString() === "%PDF-" && !out.includes("/Encrypt")) {
          return { ok: true, base64: out.toString("base64"), bytes: out.length, password };
        }
      }
    } catch (err) {
      // A throw (not an exit code) means the wasm runtime is suspect — rebuild
      // it before the next attempt rather than failing every later PDF too.
      modulePromise = null;
      mod = await getModule().catch(() => null);
      if (!mod) return { ok: false, reason: "unavailable", error: String((err && err.message) || err) };
    }
  }
  return { ok: false, reason: "wrong-password" };
}

module.exports = { derivePassword, ddmmyyyy, unlockPdf };
