/*
 * Shrinks the raw captures into deck-sized JPEGs.
 *
 *   node pitch/screens/optimise.mjs
 *
 * The captures are 2880px wide PNGs — right for archiving, and about thirteen
 * megabytes of them, which no PDF should carry. A slide never shows one wider
 * than about half a 1280px page, so 1500px is already more resolution than the
 * print can use.
 *
 * Chromium does the resizing (canvas + toDataURL) because it is the one image
 * pipeline this machine is guaranteed to have — the same reason the deck is
 * printed rather than assembled in a design tool.
 */
import { chromium } from "playwright";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/* Two sets, sized to the space each actually occupies on a slide.
 *
 * The mascot panels matter more than they look: eight photographic 3D renders
 * at their native size are most of the deck's weight, and they are drawn four
 * to a row at about 270px each. 640 is already twice what the print can use. */
const SETS = [
  { src: join(here, "shots"), out: join(here, "..", "assets", "screens"), width: 1500, ext: ".png" },
  { src: join(here, "..", "..", "src", "assets", "landing", "features"), out: join(here, "..", "assets", "mascot"), width: 640, ext: ".webp" },
];

const QUALITY = 0.82;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_BIN || "/opt/pw-browsers/chromium",
  args: ["--no-sandbox"],
});
const page = await browser.newPage();

for (const { src: SRC, out: OUT, width: WIDTH, ext } of SETS) {
mkdirSync(OUT, { recursive: true });
for (const file of readdirSync(SRC).filter((f) => f.endsWith(ext)).sort()) {
  const mime = ext === ".png" ? "image/png" : "image/webp";
  const dataUri = `data:${mime};base64,${readFileSync(join(SRC, file)).toString("base64")}`;
  const out = await page.evaluate(async ([src, width, quality]) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const scale = Math.min(1, width / img.naturalWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    // White underneath: the app's own background is opaque, but a JPEG has no
    // alpha and an unpainted canvas would come out black where it showed.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", quality);
  }, [dataUri, WIDTH, QUALITY]);

  const name = `${basename(file, ext)}.jpg`;
  const bytes = Buffer.from(out.split(",")[1], "base64");
  writeFileSync(join(OUT, name), bytes);
  console.log(`  ${name.padEnd(30)} ${(bytes.length / 1024).toFixed(0)} KB`);
}
console.log("Done →", OUT);
}

await browser.close();
