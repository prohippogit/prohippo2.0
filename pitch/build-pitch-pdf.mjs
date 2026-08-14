/*
 * Renders pitch/prohippo-pitch.html to pitch/ProHippo-Pitch-Deck.pdf.
 *
 * The HTML in this folder is the source; it carries three placeholder tokens
 * (__FONT_WOFF2__, __LOGO_PNG__, __MARK_PNG__) rather than megabytes of inlined
 * base64, so the deck stays readable and reviewable in a diff. This script
 * substitutes them into a temporary copy and prints that with the Chromium
 * already on the machine — no new dependency, and the PDF is regenerated from
 * the same source every time rather than being an opaque binary nobody can
 * amend.
 *
 *   node pitch/build-pitch-pdf.mjs
 *
 * CHROMIUM is taken from $CHROMIUM_BIN, then the Playwright browsers path, then
 * the usual system locations.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const CANDIDATES = [
  process.env.CHROMIUM_BIN,
  process.env.PLAYWRIGHT_BROWSERS_PATH && join(process.env.PLAYWRIGHT_BROWSERS_PATH, "chromium"),
  "/opt/pw-browsers/chromium",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

const chromium = CANDIDATES.find((p) => existsSync(p));
if (!chromium) {
  console.error("No Chromium found. Set CHROMIUM_BIN to a Chrome/Chromium binary.");
  process.exit(1);
}

const b64 = (p) => readFileSync(p).toString("base64");

const html = readFileSync(join(here, "prohippo-pitch.html"), "utf8")
  .replace("__FONT_WOFF2__", b64(join(here, "assets", "plus-jakarta-sans-latin.woff2")))
  .replace("__LOGO_PNG__", b64(join(root, "public", "prohippo-logo.png")))
  .replace("__MARK_PNG__", b64(join(root, "public", "prohippo-mark.png")));

const work = mkdtempSync(join(tmpdir(), "prohippo-pitch-"));
const page = join(work, "deck.html");
writeFileSync(page, html);

const out = join(work, "deck.pdf");
execFileSync(chromium, [
  "--headless",
  "--disable-gpu",
  "--no-sandbox",
  "--no-pdf-header-footer",
  "--run-all-compositor-stages-before-draw",
  "--virtual-time-budget=10000",
  `--print-to-pdf=${out}`,
  `file://${page}`,
], { stdio: "inherit" });

const dest = join(here, "ProHippo-Pitch-Deck.pdf");
copyFileSync(out, dest);
console.log(`Wrote ${dest}`);
