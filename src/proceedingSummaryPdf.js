/*
 * ProHippo — the summary sheet that opens a downloaded proceeding.
 *
 * WHAT IT REPLACES. The bundle used to lead with a plain "00 Contents.txt": a
 * monospaced listing that told the truth and looked like a build log. This is
 * the same listing drawn in the practice's own theme — the soft rounded panels,
 * the pill chips and the Poppins of the ledger, the cause list and the invoice
 * (pdfTheme.js) — because the folder gets e-mailed to clients and carried into
 * hearings, and the first page of it is the firm's cover sheet whether anyone
 * designed it or not.
 *
 * WHAT IT IS FOR, WHICH IS NOT DECORATION. Opened on its own it answers the
 * three questions a folder of twenty-one PDFs cannot: what this proceeding is,
 * what happened in it and in what order, and what is NOT in the folder. The
 * third is why the gaps are drawn in amber rather than left to a line of text —
 * a bundle that is quietly short is the one a submission gets built on.
 *
 * It draws from `plan.outline` (proceedingBundle.js), the same structure the
 * plain-text fallback prints, so the two cannot disagree about what is in the
 * folder.
 */
import {
  themedDoc, clipText, drawBrandHeader, drawFooter, fmtDate,
  hexToRgb, tint, INK, BODY, MUTED, LINE, CREDIT,
} from "./pdfTheme.js";

const L = 14, R = 196, W = R - L, PAGE_H = 297, FOOT = PAGE_H - 18;

// Amber, for everything the portal listed and we do not hold. The same warning
// colour the app's own order tiles carry.
const WARN = [176, 117, 18];
const WARN_BG = [253, 243, 222];

/* One colour per kind of document, matching the tiles inside the proceeding on
   screen: an order is amber, a Form 35 is pink, a notice is the practice's own
   accent. A folder that was read on screen should be recognisable on paper. */
const kindColor = (kind, accent) =>
  kind === "order" ? WARN : kind === "appeal" ? [193, 51, 120] : accent;

const DOC_CHIP = { pdf: "PDF", zip: "ZIP", other: "FILE" };

/* The identity panel. Everything needed to know whose proceeding this is
   without opening a single file underneath it — which is the state somebody
   opening this folder in eighteen months is actually in. */
function drawIdentity(ctx, y, h, accent) {
  const { text, rrect, measure } = ctx;
  const PAD = 6;
  const box = 24;
  rrect(L, y, W, box, 4.5, "F", [248, 247, 251]);
  rrect(L, y, 2.6, box, 1.3, "F", accent);

  text("PROCEEDING", L + PAD, y + 6.4, { size: 6.4, weight: "semibold", color: accent, spacing: 0.7 });

  /* The status sits top right and the title is clipped against it, measured
     rather than guessed — an ITAT appeal number and "Closed" on one line is
     exactly where a guessed column width runs one into the other. */
  let rightW = 0;
  if (h.status) {
    const sw = measure(h.status, 7.4, "bold") + 9;
    rrect(R - PAD - sw, y + 3.2, sw, 7.4, 3.2, "F", tint(accent, 0.86));
    text(h.status, R - PAD - sw / 2, y + 8.3, { size: 7.4, weight: "bold", color: accent, align: "center" });
    rightW = sw + 5;
  }
  text(clipText(ctx, h.title, W - PAD * 2 - 34 - rightW, 12.5, "bold"), L + PAD + 34, y + 8.6,
    { size: 12.5, weight: "bold", color: INK });

  // The facts, labelled, along the foot of the panel — a run-on sentence of
  // five values is unreadable and this is the line people scan.
  const facts = [
    ["ASSESSEE", h.assessee],
    ["PAN", h.pan],
    ["A.Y.", h.ay],
    ["SECTION", h.section ? `u/s ${h.section}` : ""],
    ["TYPE", h.type],
    ["BENCH", h.bench],
  ].filter(([, v]) => v).slice(0, 5);
  /* THE COLUMNS ARE NOT EQUAL. Five equal shares of 170mm gives a name 34mm,
     and "Shraddha Rahul Mehta" clips to "Shraddha Rahul M…" — the one value on
     the panel that must never be abbreviated, on a sheet whose whole job is to
     say whose papers these are. A PAN is ten characters and an A.Y. is seven;
     they do not need what they were being given. */
  const weight = (k) => (k === "ASSESSEE" ? 2.2 : k === "BENCH" || k === "TYPE" ? 1.2 : 1);
  const share = facts.reduce((t, [k]) => t + weight(k), 0);
  const avail = W - PAD * 2;
  let fx = L + PAD;
  facts.forEach(([k, v]) => {
    const fw = (avail * weight(k)) / share;
    text(k, fx, y + 15.6, { size: 5.8, weight: "semibold", color: MUTED, spacing: 0.6 });
    text(clipText(ctx, v, fw - 4, 8.4, "semibold"), fx, y + 20.6, { size: 8.4, weight: "semibold", color: BODY });
    fx += fw;
  });
  return y + box + 6;
}

/* The counts, as chips. Deliberately the same four-across shape the cause list
   opens with, so two documents from one practice open the same way. */
function drawCounts(ctx, y, accent, h) {
  const { text, rrect } = ctx;
  const items = [
    { label: "NOTICES & ORDERS", value: String(h.notices), emph: true },
    { label: "DOCUMENTS", value: String(h.files) },
    { label: "REPLIES FILED", value: String(h.replies) },
    { label: "PREPARED", value: fmtDate(h.prepared), small: true },
  ];
  const gap = 4;
  const w = (W - gap * (items.length - 1)) / items.length;
  items.forEach((it, i) => {
    const x = L + i * (w + gap);
    rrect(x, y, w, 15, 4.5, "F", it.emph ? tint(accent, 0.86) : [248, 247, 251]);
    text(it.label, x + 5, y + 6, { size: 6.2, weight: "semibold", color: it.emph ? accent : MUTED, spacing: 0.5 });
    text(it.value, x + 5, y + 12, { size: it.small ? 9 : 11.5, weight: "extrabold", color: it.emph ? accent : INK });
  });
  return y + 15 + 7;
}

/* An amber strip. Used for the whole-bundle warning at the top and for the
   per-notice gaps below it, because they are the same fact at two scales. */
function drawWarn(ctx, y, msg, { indent = 0 } = {}) {
  const { text, rrect, wrap } = ctx;
  const x = L + indent, w = W - indent;
  const lines = wrap(msg, w - 16, 7.4, "medium");
  const h = 6 + lines.length * 3.8;
  rrect(x, y, w, h, 3.5, "F", WARN_BG);
  text("!", x + 5.5, y + h / 2 + 1.4, { size: 9, weight: "extrabold", color: WARN });
  lines.forEach((ln, i) => text(ln, x + 11, y + 5.2 + i * 3.8, { size: 7.4, weight: "medium", color: WARN }));
  return h;
}

/* One notice's band: its number, what it is, when it was issued, and its DIN.
   The number is a chip because the folders on disk are numbered and this is
   what maps the sheet onto them. */
const BAND_H = 12;

function drawBand(ctx, y, it, accent, { continued = false } = {}) {
  const { text, rrect, measure } = ctx;
  const col = kindColor(it.kind, accent);
  rrect(L, y, W, BAND_H, 3.5, "F", tint(col, 0.9));

  rrect(L + 4, y + 2.6, 9, 6.8, 2.4, "F", col);
  text(it.no, L + 8.5, y + 7.4, { size: 6.8, weight: "extrabold", color: [255, 255, 255], align: "center" });

  const right = [it.date ? `Issued ${fmtDate(it.date)}` : "", it.din ? `DIN ${it.din}` : ""].filter(Boolean).join("   ·   ");
  const rw = right ? measure(right, 7, "medium") : 0;
  const label = it.label + (continued ? " (continued)" : "");
  text(clipText(ctx, label, W - 20 - rw - 8, 9.2, "bold"), L + 17, y + 7.9, { size: 9.2, weight: "bold", color: INK });
  if (right) text(right, R - 5, y + 7.9, { size: 7, weight: "medium", color: BODY, align: "right" });
  return BAND_H;
}

/* One file. A chip saying what it is, then what it is called — the name it
   actually carries in the folder, so the sheet can be read beside the folder. */
const FILE_H = 7.6;

function drawFile(ctx, y, file, { indent = 6, color = MUTED } = {}) {
  const { text, rrect, measure } = ctx;
  const x = L + indent, w = W - indent;
  rrect(x, y, w, FILE_H, 2.6, "F", [252, 251, 254]);
  const chip = DOC_CHIP[file.kind] || "FILE";
  const cw = measure(chip, 5.6, "extrabold") + 6;
  rrect(x + 3.5, y + 1.9, cw, 4, 1.6, "F", file.kind === "zip" ? WARN_BG : tint(color, 0.86));
  text(chip, x + 3.5 + cw / 2, y + 4.9, { size: 5.6, weight: "extrabold", color: file.kind === "zip" ? WARN : color, align: "center" });
  text(clipText(ctx, file.name, w - cw - 12, 7.6, "medium"), x + cw + 8, y + 5.1, { size: 7.6, weight: "medium", color: BODY });
  return FILE_H;
}

/* A reply's own heading. Green, because that is what a filed reply is on every
   screen in this app, and because the eye needs to find "we answered this one"
   without reading. */
const REPLY_H = 8;

function drawReplyHead(ctx, y, r, { continued = false } = {}) {
  const { text, rrect, measure } = ctx;
  const x = L + 6, w = W - 6;
  rrect(x, y, w, REPLY_H, 2.8, "F", tint(CREDIT, 0.9));
  rrect(x, y, 2, REPLY_H, 1, "F", CREDIT);
  const title = `${r.title}${r.type && r.type !== "Response" ? ` — ${r.type}` : ""}${continued ? " (continued)" : ""}`.toUpperCase();
  const when = r.on ? `filed ${fmtDate(r.on)}` : "not dated";
  const ww = measure(when, 7, "semibold");
  text(clipText(ctx, title, w - ww - 18, 6.4, "extrabold"), x + 6, y + 5.4,
    { size: 6.4, weight: "extrabold", color: CREDIT, spacing: 0.5 });
  text(when, R - 5, y + 5.4, { size: 7, weight: "semibold", color: CREDIT, align: "right" });
  return REPLY_H;
}

/**
 * Build the summary. `plan` is what planProceedingBundle returned; `failed` is
 * what would not download, which is only known after the fetch and so is passed
 * in rather than read off the plan.
 */
export function buildProceedingSummaryPDF({ plan, profile, settings, failed = [] } = {}) {
  const cfg = { ...(profile?.invoiceSettings || {}), ...(settings || {}) };
  const accent = hexToRgb(cfg.accent, [108, 92, 231]);
  const ctx = themedDoc();
  const { doc, text, line } = ctx;
  const h = plan.header;

  doc.setProperties({
    title: `${h.title} — ${h.assessee}`,
    subject: "Proceeding bundle summary",
    creator: "ProHippo",
  });

  let y = drawBrandHeader(ctx, { profile, cfg, accent, title: "Proceeding", subtitle: "NOTICES, ORDERS & REPLIES ON FILE" });
  y = drawIdentity(ctx, y, h, accent);
  y = drawCounts(ctx, y, accent, h);

  if (h.missing) {
    y += drawWarn(ctx, y,
      `${h.missing} file${h.missing === 1 ? "" : "s"} the portal lists on this proceeding ${h.missing === 1 ? "is" : "are"} not in this folder — run a portal sync and download the bundle again.`) + 6;
  }

  const newPage = () => { doc.addPage(); return 18; };
  const room = (need) => { if (y + need > FOOT) y = newPage(); };

  text("WHAT IS IN THIS FOLDER", L, y + 3, { size: 6.6, weight: "extrabold", color: accent, spacing: 0.8 });
  line(L, y + 5.6, R, y + 5.6, LINE, 0.3);
  y += 10;

  for (const it of plan.outline) {
    // A band alone at the foot of a page is how a notice gets missed, so it is
    // kept with the first thing under it.
    room(BAND_H + (it.empty ? 9 : FILE_H) + 3);
    y += drawBand(ctx, y, it, accent) + 2.5;

    if (it.empty) {
      y += drawWarn(ctx, y, `Nothing is held for this ${it.kind === "order" ? "order" : "notice"} yet — run a portal sync.`, { indent: 6 }) + 4;
      continue;
    }

    /* A notice's files can outrun a page. When they do the band is redrawn at
       the top of the next one — a page that opens on four loose PDFs, with the
       notice they answer three pages back, is not a contents sheet. */
    const flow = (need) => {
      if (y + need > FOOT) {
        y = newPage();
        y += drawBand(ctx, y, it, accent, { continued: true }) + 2.5;
      }
    };

    for (const f of it.files) { flow(FILE_H); y += drawFile(ctx, y, f, { color: kindColor(it.kind, accent) }) + 1.6; }
    if (it.missing) {
      flow(10);
      y += drawWarn(ctx, y, `${it.missing} file${it.missing === 1 ? "" : "s"} the portal lists here ${it.missing === 1 ? "was" : "were"} not fetched.`, { indent: 6 }) + 2;
    }
    for (const r of it.replies) {
      flow(REPLY_H + FILE_H);
      y += drawReplyHead(ctx, y, r) + 1.6;
      /* A reply of eleven annexures outruns a page too, and when it does BOTH
         headings come back — the notice and the reply. Repeating only the
         notice put seven annexures on a fresh page under the notice they were
         filed against, reading as the notice's own enclosures. */
      const flowIn = (need) => {
        if (y + need > FOOT) {
          y = newPage();
          y += drawBand(ctx, y, it, accent, { continued: true }) + 2.5;
          y += drawReplyHead(ctx, y, r, { continued: true }) + 1.6;
        }
      };
      for (const f of r.files) { flowIn(FILE_H); y += drawFile(ctx, y, f, { indent: 12, color: CREDIT }) + 1.6; }
      if (r.missing > 0) {
        flowIn(10);
        y += drawWarn(ctx, y, `${r.missing} attachment${r.missing === 1 ? "" : "s"} on this reply ${r.missing === 1 ? "was" : "were"} listed by the portal but not fetched.`, { indent: 12 }) + 2;
      }
    }
    y += 4;
  }

  /* What we hold and could not download just now. Different from the gaps
     above — those need a sync, this needs another try — so it is said
     separately rather than folded into one number. */
  if (failed.length) {
    room(16 + failed.length * 5);
    text("NOT INCLUDED IN THIS DOWNLOAD", L, y + 3, { size: 6.6, weight: "extrabold", color: WARN, spacing: 0.8 });
    line(L, y + 5.6, R, y + 5.6, LINE, 0.3);
    y += 10;
    for (const f of failed) {
      room(FILE_H);
      y += drawFile(ctx, y, { name: `${f.path} — ${f.reason}`, kind: "other" }, { indent: 0, color: WARN }) + 1.6;
    }
    y += 2;
    y += drawWarn(ctx, y, "These are held by ProHippo but could not be downloaded just now. Try the bundle again, or save them one at a time from the proceeding.");
  }

  drawFooter(ctx, { cfg, profile });
  return doc;
}

/** The same document as bytes, for dropping into the zip. */
export function proceedingSummaryBytes(args) {
  return new Uint8Array(buildProceedingSummaryPDF(args).output("arraybuffer"));
}
