/*
 * Photographs the app for the deck.
 *
 *   npx vite --config pitch/screens/vite.config.js     # terminal 1
 *   node pitch/screens/capture.mjs                     # terminal 2
 *
 * Drives the real app — real components, real navigation, real rendering —
 * against the seed practice in ./seed.js, and writes one PNG per screen into
 * pitch/screens/shots/. Re-running it re-photographs everything, so a screen
 * that changes in the app changes in the deck rather than quietly disagreeing
 * with it.
 *
 * Playwright is not a dependency of this project. Install it for the run and
 * leave package.json alone:
 *
 *   PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-save playwright
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "shots");
const BASE = process.env.HARNESS_URL || "http://localhost:5178";

/* A desktop the screens were designed for, at 2x so the shots survive being
   placed on a slide. Anything wider and the sidebar starts to look like a
   rounding error next to the content. */
const VIEWPORT = { width: 1440, height: 900 };

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_BIN || "/opt/pw-browsers/chromium",
  args: ["--no-sandbox", "--font-render-hinting=none"],
});
const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
const page = await ctx.newPage();

// The app animates cards in on mount (.animate-in) and the dashboard counts up.
// Half a second past network idle is enough for both to settle.
const settle = async (ms = 700) => {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(ms);
};

const shot = async (name) => {
  await settle();
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log("  ✓", name);
};

const nav = async (label) => {
  await page.locator(".nav-item", { hasText: label }).first().click();
  await settle(500);
};

console.log("Capturing from", BASE);

/* ---- the public landing page, signed out ----
   The hero headline plays a per-character cascade on mount, and a shot taken
   during it catches two half-drawn copies of the same line. The reveal runs
   for roughly a character-count times its stagger; three seconds clears it
   with room to spare. */
await page.goto(`${BASE}/?screen=landing`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".lp-hero", { timeout: 20000 });
await page.waitForTimeout(3000);
await shot("00-landing");

/* ---- signed in ---- */
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sidebar .nav-item", { timeout: 20000 });
await shot("01-dashboard");

/* The dashboard's notice queues are modals over the same page — the number on
   a stat tile and the notices behind it are one story, so both are captured. */
await page.locator(".stat", { hasText: "Awaiting reply" }).first().click();
await page.waitForSelector(".modal", { timeout: 10000 });
await shot("02-dashboard-notice-queue");
await page.keyboard.press("Escape").catch(() => {});
await page.locator(".modal-backdrop").click({ position: { x: 8, y: 8 } }).catch(() => {});
await settle(400);

await nav("Assessees");
await shot("03-assessees");

/* Into one client's file, then across the two tabs that carry the most.
   Named rather than "the first row": the register sorts by name, and the top
   of it is a trust with no filed returns behind it — which photographs the
   Returns tab's empty state instead of the Returns tab. */
await page.locator(".ass-row", { hasText: "Rajesh M. Shah" }).first().click();
await settle(600);
await shot("04-assessee-overview");

for (const [tab, name] of [["Returns", "05-assessee-returns"], ["Matters", "06-assessee-matters"]]) {
  const el = page.locator(".utab", { hasText: tab }).first();
  if (await el.count()) { await el.click(); await shot(name); }
}

await nav("Matters");
await shot("07-matters");

await nav("Hearings");
await shot("08-hearings-calendar");
const week = page.locator(".tab", { hasText: "Week" }).first();
if (await week.count()) { await week.click(); await shot("09-hearings-week"); }

await nav("Appeals");
await shot("10-appeals");
// The countdown row opened: the preparation is the feature, not the number.
const row = page.locator(".ap-rowhead").first();
if (await row.count()) { await row.click(); await shot("11-appeals-open"); }

await nav("Intimations");
await shot("12-intimations");

await nav("Invoices");
await shot("13-invoices");

await nav("Communications");
await shot("14-communications");

await nav("Reports");
await shot("15-reports");

await nav("Settings");
await shot("16-settings");

await nav("Sync Connector App");
await shot("17-connector");

/* ---- the phone ---- */
const mobile = await browser.newContext({
  viewport: { width: 414, height: 896 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});
const mp = await mobile.newPage();
await mp.goto(BASE, { waitUntil: "domcontentloaded" });
await mp.waitForSelector(".sidebar", { timeout: 20000 });
await mp.waitForTimeout(1200);
await mp.screenshot({ path: join(OUT, "18-mobile-dashboard.png") });
console.log("  ✓ 18-mobile-dashboard");

await browser.close();
console.log("Done →", OUT);
