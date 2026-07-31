/*
 * ProHippo — strip the password off an Income-tax intimation / rectification
 * order PDF. Browser mirror of connector/src/main/pdfUnlock.js; keep the two in
 * step, the same way ingest.js mirrors portalIngest.js.
 *
 * CPC serves every order under s.143(1) and s.154 encrypted (RC4-128, standard
 * security handler), with a password the department publishes:
 *
 *     PAN in lower case  +  date of birth / incorporation as DDMMYYYY
 *     e.g.  aalfj4935c04112015
 *
 * We hold both halves, so we unlock on the way in and Storage only ever sees a
 * clean PDF — no practitioner should have to type that string every time they
 * open an order.
 *
 * qpdf (Apache-2.0) compiled to WebAssembly does the work. It is ~1.3 MB, so it
 * is imported dynamically: Vite emits it as its own chunk and the main bundle
 * is untouched for the vast majority of sessions that never see a locked PDF.
 *
 * NOTE ON LICENCES: mupdf would also do this and is a nicer API, but it is
 * AGPL-3.0. Do not swap it in.
 */

// qpdf's exit codes: 0 = clean, 2 = error (a wrong password lands here), 3 =
// succeeded with warnings — a warning still writes a valid file, and portal
// PDFs routinely warn about their own malformed xref tables.
const EXIT_OK = 0;
const EXIT_WARN = 3;

let modulePromise = null;

function getModule() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const [{ default: createModule }, { default: wasmUrl }] = await Promise.all([
        import("@neslinesli93/qpdf-wasm"),
        import("@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url"),
      ]);
      // Note: this build writes qpdf's own diagnostics straight to the console
      // and does not honour Emscripten's print/printErr overrides, so a wrong
      // candidate logs "invalid password". That is a normal branch here — we
      // walk a candidate list — and the caller gets the real answer from the
      // return value, not the log.
      return createModule({ locateFile: () => wasmUrl });
    })().catch((err) => {
      modulePromise = null;
      throw err;
    });
  }
  return modulePromise;
}

/* "2015-11-04" | "04-11-2015" | epoch millis → "04112015". Anything we cannot
   read confidently returns "" so the caller skips rather than guesses: an
   almost-right password is as useless as none, but a guessed one hides the real
   reason the unlock failed. */
export function ddmmyyyy(value) {
  if (value == null || value === "") return "";
  const s = String(value).trim();

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); // 2015-11-04
  if (iso) return `${iso[3]}${iso[2]}${iso[1]}`;

  const dmy = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(s); // 04-11-2015, 04/11/2015
  if (dmy) return `${dmy[1]}${dmy[2]}${dmy[3]}`;

  if (/^\d{8}$/.test(s)) return s; // already DDMMYYYY

  if (/^\d{10,}$/.test(s)) {
    // Epoch millis, as the portal's myPanDetailsService returns them. Read in
    // IST — a UTC read tips dates before 05:30 back a day.
    const d = new Date(Number(s) + 5.5 * 3600 * 1000);
    if (!Number.isNaN(d.getTime())) {
      const p = (n) => String(n).padStart(2, "0");
      return `${p(d.getUTCDate())}${p(d.getUTCMonth() + 1)}${d.getUTCFullYear()}`;
    }
  }
  return "";
}

/** The department's recipe. Returns "" when either half is missing. */
export function derivePassword(pan, dob) {
  const p = String(pan || "").trim().toLowerCase();
  const d = ddmmyyyy(dob);
  if (!/^[a-z]{5}\d{4}[a-z]$/.test(p) || !d) return "";
  return p + d;
}

/** True if these bytes carry an encryption dictionary. */
export function isEncrypted(bytes) {
  const hay = new TextDecoder("latin1").decode(bytes.subarray(0, bytes.length));
  return hay.includes("/Encrypt");
}

/**
 * Try each candidate password against a PDF.
 *
 * Returns { ok: true, bytes, password } or { ok: false, reason } where reason is
 * "not-encrypted" (nothing to do — keep the original), "no-password" (nothing to
 * try), "wrong-password", or "unavailable" (the wasm would not load).
 *
 * Candidates exist because the date can come from more than one place — the
 * assessee record, the portal's PAN details, the filed ITR JSON. Trying two is
 * cheaper than deciding which is authoritative.
 */
export async function unlockPdf(bytes, candidates) {
  const passwords = [...new Set((candidates || []).filter(Boolean))];
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  if (!isEncrypted(input)) return { ok: false, reason: "not-encrypted" };
  if (!passwords.length) return { ok: false, reason: "no-password" };

  let mod;
  try {
    mod = await getModule();
  } catch (err) {
    return { ok: false, reason: "unavailable", error: String(err?.message || err) };
  }

  for (const password of passwords) {
    try {
      mod.FS.writeFile("/in.pdf", input);
      const code = mod.callMain(["--decrypt", `--password=${password}`, "/in.pdf", "/out.pdf"]);
      if (code === EXIT_OK || code === EXIT_WARN) {
        const out = mod.FS.readFile("/out.pdf");
        // Belt and braces: qpdf reported success, so the output must be a PDF
        // with the encryption gone. If it is not, treat it as a failure rather
        // than storing something we have not actually unlocked.
        const head = new TextDecoder("latin1").decode(out.subarray(0, 5));
        if (out.length > 5 && head === "%PDF-" && !isEncrypted(out)) {
          return { ok: true, bytes: out, password };
        }
      }
    } catch (err) {
      // A throw (rather than an exit code) means the runtime is suspect —
      // rebuild it before the next attempt, so one bad PDF doesn't poison the
      // rest of the sync.
      modulePromise = null;
      mod = await getModule().catch(() => null);
      if (!mod) return { ok: false, reason: "unavailable", error: String(err?.message || err) };
    }
  }
  return { ok: false, reason: "wrong-password" };
}

/** Convenience for the sync path, which moves PDFs around as base64. */
export async function unlockBase64(base64, candidates) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const res = await unlockPdf(bytes, candidates);
  if (!res.ok) return res;
  let out = "";
  const CH = 0x8000;
  for (let i = 0; i < res.bytes.length; i += CH) out += String.fromCharCode.apply(null, res.bytes.subarray(i, i + CH));
  return { ok: true, base64: btoa(out), bytes: res.bytes.length, password: res.password };
}
