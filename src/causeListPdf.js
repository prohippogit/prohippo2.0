/* ProHippo — the printed cause list (jsPDF).
 *
 * The sheet a practitioner carries into the week: every hearing in date and
 * time order, with enough on each line to walk into the room without opening
 * anything — who, before whom, which year, under which section, by video or in
 * person, and who from the firm is going.
 *
 * Set in the same soft, curvy theme as the ledger and the invoice (pdfTheme.js):
 * rounded day bands, rounded rows, pill chips. A document that goes out under
 * the firm's name should look like the others that do.
 *
 * WHY ROWS RATHER THAN A GRID. A ruled table is what the department's own cause
 * lists look like, and they are miserable to read at a glance in a corridor.
 * Each hearing is a rounded row with the time in a chip on the left, so the day
 * scans down its left edge and the eye finds "11:00" without reading anything
 * else.
 */
import {
  themedDoc, clipText, drawBrandHeader, drawFooter,
  hexToRgb, tint, INK, BODY, MUTED, LINE,
} from "./pdfTheme.js";
import { causeListRows, groupByDay, causeListSummary, shouldShowEmptyDays } from "./causeList.js";

const L = 14, R = 196, W = R - L, PAGE_H = 297, FOOT = PAGE_H - 18;

// One colour per forum, matching the week grid on screen so the paper and the
// app agree about what an ITAT day looks like.
const AUTHORITY_COLOR = {
  ITAT: [108, 92, 231],
  "CIT(A)": [193, 51, 120],
  Scrutiny: [243, 156, 18],
  Penalty: [224, 70, 74],
};
const OTHER = [32, 185, 120];
const authorityColor = (a) => AUTHORITY_COLOR[a] || OTHER;

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayParts(iso) {
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return { dow: "", label: iso };
  return { dow: DOW[d.getDay()], label: `${String(d.getDate()).padStart(2, "0")} ${MON[d.getMonth()]} ${d.getFullYear()}` };
}

const dateLabel = (iso) => dayParts(iso).label;

/* The range, said the way a person would say it: one date when it is one day,
   and a month named once when both ends share it. */
export function rangeLabel(from, to) {
  if (!from || !to) return "";
  if (from === to) return dateLabel(from);
  const a = new Date(from + "T00:00:00"), b = new Date(to + "T00:00:00");
  if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) {
    return `${String(a.getDate()).padStart(2, "0")} – ${String(b.getDate()).padStart(2, "0")} ${MON[b.getMonth()]} ${b.getFullYear()}`;
  }
  return `${dateLabel(from)}  –  ${dateLabel(to)}`;
}

/* Rounded count chips under the header: hearings, days, assessees, VC. */
function drawSummary(ctx, y, accent, items) {
  const { text, rrect } = ctx;
  const gap = 4;
  const w = (W - gap * (items.length - 1)) / items.length;
  items.forEach((it, i) => {
    const x = L + i * (w + gap);
    rrect(x, y, w, 15, 4.5, "F", it.emph ? tint(accent, 0.86) : [248, 247, 251]);
    text(it.label, x + 5, y + 6, { size: 6.2, weight: "semibold", color: it.emph ? accent : MUTED, spacing: 0.5 });
    text(it.value, x + 5, y + 12, { size: 11.5, weight: "extrabold", color: it.emph ? accent : INK });
  });
  return y + 15 + 7;
}

/* One hearing. Returns its height so the caller can page-break before drawing.
   Two lines: the assessee and the forum on top, the working detail below. */
const ROW_H = 15;

function drawRow(ctx, y, h) {
  const { text, rrect, measure } = ctx;
  const col = authorityColor(h.authority);
  rrect(L, y, W, ROW_H, 4, "F", [252, 251, 254]);
  // The left edge carries the forum's colour, so a day scans by shape.
  rrect(L, y, 2.4, ROW_H, 1.2, "F", col);

  // Time chip.
  const t = (h.time || "—").trim();
  const tw = Math.max(measure(t, 8, "bold") + 8, 18);
  rrect(L + 5, y + 3.4, tw, 8.2, 3, "F", tint(col, 0.86));
  text(t, L + 5 + tw / 2, y + 9.1, { size: 8, weight: "bold", color: col, align: "center" });

  const x = L + 5 + tw + 5;

  /* Both lines share the row with something right-aligned, so each is clipped
     against what is actually beside it and not against a guessed column width.
     Measured, not assumed: "Video conference · Priya Mehta" and "ITAT" need
     very different room, and the first version let the long one run into the
     bench on the line above. */
  const GAP = 6;
  const authority = h.authority || "—";
  const authW = measure(authority, 8, "semibold");
  const mode = h.mode === "Video Conference" ? "Video conference" : (h.mode || "");
  const tail = clipText(ctx, [mode, h.staff || ""].filter(Boolean).join("  ·  "), 46, 7, "medium");
  const tailW = tail ? measure(tail, 7, "medium") : 0;

  const nameW = Math.max(30, R - 5 - authW - GAP - x);
  const detailW = Math.max(30, R - 5 - tailW - GAP - x);

  text(clipText(ctx, h.assessee || "—", nameW, 9.6, "bold"), x, y + 6.6, { size: 9.6, weight: "bold", color: INK });

  // Second line: everything needed to open the file, in one sentence.
  const detail = [
    h.ay ? `AY ${h.ay}` : "",
    h.section ? `u/s ${h.section}` : "",
    h.ita || "",
    h.bench || "",
    h.pan || "",
  ].filter(Boolean).join("   ·   ");
  text(clipText(ctx, detail, detailW, 7.2, "medium"), x, y + 11.6, { size: 7.2, weight: "medium", color: MUTED });

  // Right: the forum, and how it is being attended.
  text(authority, R - 5, y + 6.6, { size: 8, weight: "semibold", color: col, align: "right" });
  if (tail) text(tail, R - 5, y + 11.6, { size: 7, weight: "medium", color: BODY, align: "right" });
  return ROW_H;
}

/* A day's band: the weekday, the date, and how many are listed. Empty days get
   the same band and a quiet line, because "nothing on Thursday" is information
   a practitioner is reading this sheet to find. */
const DAY_H = 9;

function drawDayBand(ctx, y, iso, count, accent) {
  const { text, rrect } = ctx;
  const { dow, label } = dayParts(iso);
  rrect(L, y, W, DAY_H, 3, "F", tint(accent, 0.9));
  text(dow.toUpperCase(), L + 6, y + 6, { size: 6.6, weight: "extrabold", color: accent, spacing: 0.8 });
  text(label, L + 34, y + 6, { size: 8.4, weight: "bold", color: INK });
  text(count ? `${count} hearing${count === 1 ? "" : "s"}` : "No hearings listed",
    R - 6, y + 6, { size: 7.2, weight: "semibold", color: count ? BODY : MUTED, align: "right" });
  return y + DAY_H + 3;
}

/* Build the document. `hearings` is the practice's whole list; the range and
   filters decide what appears. Returns the jsPDF doc. */
export function buildCauseListPDF({ hearings, from, to, authority = "All", includeAdjourned = false, profile, settings } = {}) {
  const cfg = { ...(profile?.invoiceSettings || {}), ...(settings || {}) };
  const accent = hexToRgb(cfg.accent, [108, 92, 231]);
  const ctx = themedDoc();
  const { doc, text, rrect, line } = ctx;

  const rows = causeListRows(hearings, { from, to, authority, includeAdjourned });
  const days = groupByDay(rows, { from, to, withEmptyDays: shouldShowEmptyDays(from, to) });
  const s = causeListSummary(rows);

  let y = drawBrandHeader(ctx, { profile, cfg, accent, title: "Cause List", subtitle: "HEARINGS FOR THE PERIOD" });

  /* The period panel — the first thing anybody checks on a sheet that was
     printed at some point and read at another. */
  rrect(L, y, W, 16, 4, "F", [248, 247, 251]);
  text("PERIOD", L + 6, y + 6, { size: 6.8, weight: "semibold", color: accent, spacing: 0.5 });
  text(rangeLabel(from, to), L + 6, y + 12.4, { size: 12.5, weight: "bold", color: INK });
  const scope = [
    authority && authority !== "All" ? `${authority} only` : "All authorities",
    includeAdjourned ? "including adjourned" : "excluding adjourned",
  ].join("   ·   ");
  text(scope, R - 6, y + 12.4, { size: 8, weight: "medium", color: MUTED, align: "right" });
  y += 16 + 8;

  y = drawSummary(ctx, y, accent, [
    { label: "HEARINGS", value: String(s.hearings), emph: true },
    { label: "DAYS LISTED", value: String(s.days) },
    { label: "ASSESSEES", value: String(s.assessees) },
    { label: "VIDEO CONFERENCE", value: String(s.videoConference) },
  ]);

  if (rows.length === 0) {
    rrect(L, y, W, 26, 4, "F", [252, 251, 254]);
    text("Nothing is listed in this period.", L + W / 2, y + 11, { size: 10, weight: "bold", color: BODY, align: "center" });
    text("Hearings synced or added later will appear on a fresh cause list.", L + W / 2, y + 18, { size: 7.6, color: MUTED, align: "center" });
    drawFooter(ctx, { cfg, profile });
    return doc;
  }

  const newPage = () => { doc.addPage(); return 18; };

  for (const day of days) {
    // Keep a day's band with at least its first row; a heading alone at the
    // foot of a page is how a hearing gets missed.
    const need = DAY_H + 3 + (day.hearings.length ? ROW_H : 8);
    if (y + need > FOOT) y = newPage();
    y = drawDayBand(ctx, y, day.iso, day.hearings.length, accent);

    if (day.hearings.length === 0) {
      line(L + 6, y + 3, R - 6, y + 3, LINE, 0.3);
      y += 8;
      continue;
    }
    for (const h of day.hearings) {
      if (y + ROW_H > FOOT) {
        y = newPage();
        // Repeat the day, so a page that opens mid-Tuesday says so.
        y = drawDayBand(ctx, y, day.iso, day.hearings.length, accent);
      }
      y += drawRow(ctx, y, h) + 2.5;
    }
    y += 3.5;
  }

  drawFooter(ctx, { cfg, profile });
  return doc;
}

/* A plain-ASCII name. The range label carries an en dash, which survives no
   round trip through a mail client worth relying on. */
const safe = (s) => String(s || "cause-list")
  .replace(/\s*[–—-]\s*/g, "-to-")
  .replace(/\s+/g, "-")
  .replace(/[^A-Za-z0-9._-]/g, "")
  .replace(/-{2,}/g, "-");

export function causeListFilename({ from, to } = {}) {
  const label = rangeLabel(from, to);
  return `Cause-list-${safe(label) || "hearings"}.pdf`;
}

export function downloadCauseListPDF(args) {
  buildCauseListPDF(args).save(causeListFilename(args || {}));
}

export function causeListPDFDataUri(args) {
  return buildCauseListPDF(args).output("datauristring");
}
