/*
 * ProHippo — what goes in the zip when a practitioner downloads a whole
 * proceeding, and what each thing inside it is called.
 *
 * THE PROBLEM. A proceeding is not a document. A s.147 assessment on this app
 * today is six notices, each of which can itself be a set of files (the notice,
 * the approval, the set note), and against most of them a reply was filed with
 * its own attachments. Everything was downloadable — one button at a time — and
 * what a practitioner ended up with was fourteen files in a Downloads folder,
 * named by the department's id strings, with nothing to say which reply
 * answered which notice. Reassembling that by hand, on the day a paper book is
 * due, is the work this app is supposed to remove.
 *
 * THE SHAPE. One folder per notice, in the order the proceeding actually
 * happened, and the reply filed against that notice INSIDE its folder:
 *
 *   Shraddha Rahul Mehta - AY 2024-25 - Penalty Proceeding/
 *     00 Contents.txt
 *     01 2024-08-12 Notice u-s 142(1)/
 *       Notice u-s 142(1).pdf
 *       Annexure to notice.pdf
 *       Reply - 2024-09-02/
 *         Remarks.txt
 *         Submission with annexures.pdf
 *     02 2024-11-30 Assessment order u-s 143(3)/
 *       Assessment order u-s 143(3).pdf
 *
 * NAMES ARE SHORT INSIDE THE BUNDLE. Every other download in the app is named
 * "<Assessee> - AY 2025-26 - <what it is>", because it lands loose in a
 * Downloads folder among a hundred others and the client's name is what makes
 * that folder navigable (see downloadNames.js). Here the root folder already
 * says the assessee and the year, and repeating them on all fourteen files
 * inside it only pushes the one word that distinguishes them off the end of a
 * narrow file list. So the folder carries the identity and the files say what
 * they are.
 *
 * NOTHING IS DROPPED IN SILENCE. Where the portal listed files we never
 * received, or a reply exists with nothing but remarks behind it, the index
 * says so in words. A bundle that is quietly short is worse than no bundle:
 * it is the one a submission gets built on.
 *
 * Pure string and list work — no React, no Firebase — so the layout can be
 * tested on its own. The fetching lives in proceedingDownload.js.
 */
import { safeFilename, withExtension, documentExt, documentKind, portalDocLabel } from "./downloadNames.js";
import { noticeDocuments } from "./noticeDocs.js";
import { orderDocType, DOC_TYPE_LABEL } from "./appeals.js";

const clean = (s) => String(s || "").trim();

/* A folder or file name that is safe on Windows, macOS and inside a zip.
   safeFilename already squeezes out the illegal characters; a path separator
   would silently create a folder, so it goes too (it becomes "-" there). */
const seg = (s, fallback) => safeFilename(clean(s), fallback);

/* "2024-08-12" out of whatever the record holds. Dates on notices are already
   ISO; a reply's submittedOn can be an ISO datetime or the portal's own epoch
   milliseconds, and neither should end up in a folder name as it stands. */
export function isoDay(value) {
  if (value == null || value === "") return "";
  if (typeof value === "number" || /^\d{10,}$/.test(String(value))) {
    const d = new Date(Number(value));
    return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  }
  const s = String(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return m[0];
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

/* What one notice IS, in the fewest words that still identify it — the folder's
   name, the name of the notice's own PDF inside it, and the line it gets on the
   summary. The section is what a practitioner actually calls these ("the
   142(1)"), so it leads wherever there is one.

   ORDERS ARE NAMED FOR WHAT THEY ARE. The closure-order download hands over the
   order bundled with its computation sheet and its notice of demand, all three
   carrying no section and a subject that is nothing but ITBA's concatenated
   ids — "70000000139740396_179131965_2025_AST_AIQPC6674E_Order us 143(3)_108641".
   Printing that as a folder name (which is what happened) is unreadable, and it
   is unreadable in the one place a practitioner is looking for the order. The
   classification appeals.js already does for the appeal deadline answers this
   too, so it is asked here rather than guessed at again.
*/
/* The section, read off the document's own name.
 *
 * A closure-order bundle carries no `section` field at all, and "Assessment
 * order" without a section is a weaker line than the document itself offers —
 * ITBA put "Order us 143(3)" in the filename. Read from the name rather than
 * inherited from the matter, because a s.271AAC penalty notice sitting inside a
 * scrutiny proceeding would inherit the wrong one. */
const SECTION_IN_NAME = /\bu\/?s\.?\s*(\d{2,3}[A-Z]{0,3}(?:\(\s*\d+[a-z]?\s*\))?)/i;
function sectionFromName(n) {
  const m = SECTION_IN_NAME.exec(`${n.subject || ""} ${n.fileName || n.filename || ""}`);
  return m ? m[1].replace(/\s+/g, "") : "";
}

export function noticeLabel(n) {
  if (n.isAppealForm) return "Form 35 - Appeal to CIT(A)";
  const section = clean(n.section);
  if (n.isOrder) {
    const type = orderDocType(n);
    const kind = DOC_TYPE_LABEL[type] || "Order";
    /* A demand notice and a computation sheet are named without a section: the
       one on them is the ORDER's, and nobody calls it a "computation sheet
       u/s 143(3)". */
    if (type === "demandNotice" || type === "computationSheet") return kind;
    const sec = section || sectionFromName(n);
    return sec ? `${kind} u-s ${sec}` : kind;
  }
  if (section) return `Notice u-s ${section}`;
  /* No section at all. The subject is the last thing that says anything, and
     it is routinely the ITBA filename — so it goes through the same reader the
     document tiles use, which drops the id-shaped segments and keeps the words. */
  const subject = clean(n.subject);
  if (subject) return (portalDocLabel(subject) || subject).slice(0, 70);
  return "Notice";
}

/* Every file behind one notice: its own document set, plus — for a Form 35 —
   the grounds and statement of facts, which ride on the appeal record rather
   than in `attachments`. Ordered with the notice itself first. */
function noticeFiles(n) {
  const docs = noticeDocuments(n).map((d) => ({
    storagePath: d.storagePath,
    filename: d.filename,
    contentType: d.contentType,
    label: d.primary ? noticeLabel(n) : portalDocLabel(d.filename) || "Enclosure",
  }));
  if (n.isAppealForm) {
    for (const at of (n.appeal && n.appeal.attachments) || []) {
      if (!at || !at.storagePath) continue;
      if (docs.some((d) => d.storagePath === at.storagePath)) continue;
      docs.push({
        storagePath: at.storagePath,
        filename: at.filename || "",
        contentType: at.contentType || "",
        label: clean(at.label) || portalDocLabel(at.filename) || "Enclosure",
      });
    }
  }
  return docs;
}

/* The replies filed against a notice, in the order they were filed. A reply
   with neither remarks nor an attachment is not a reply worth a folder — the
   portal returns rows like that, and ResponsesBlock drops them on screen for
   the same reason. One whose attachments were listed but never fetched IS
   kept: that is a gap to report, not a row to hide. */
function noticeReplies(n) {
  return ((n && n.responses) || [])
    .map((rsp) => {
      const listed = (rsp.attachments || []).length;
      const files = (rsp.attachments || []).filter((at) => at && at.storagePath);
      return {
        remarks: clean(rsp.remarks),
        type: clean(rsp.respType) || "Response",
        on: isoDay(rsp.submittedOn),
        files,
        missing: listed - files.length,
      };
    })
    .filter((r) => r.remarks || r.files.length || r.missing > 0)
    .sort((a, b) => (a.on || "").localeCompare(b.on || ""));
}

/* Unique names within one folder.
 *
 * Two enclosures on a s.148 notice are routinely called the same thing, and a
 * zip with two entries at one path extracts as one file — the second silently
 * replacing the first. Uniqueness is settled on the BASE name rather than the
 * whole one, because the extension is not final yet: the downloader re-reads it
 * off the file's first bytes, so "ATTACHMENT.pdf" and "ATTACHMENT.zip" can
 * still turn out to be the same name. */
function uniquifier() {
  const seen = new Map();
  return (base, ext) => {
    const key = `${base.toLowerCase()}`;
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    return withExtension(n === 1 ? base : `${base} (${n})`, ext);
  };
}

/* The extension a file goes into the bundle with.
 *
 * PDF WHEN NOTHING SAYS OTHERWISE. A record synced before the app kept content
 * types — or a reply attachment the portal named nothing at all — leaves
 * documentExt with no evidence and it returns "", which would put a file with
 * no extension in the folder and an operating system that will not open it.
 * Every document e-Proceedings serves is a PDF unless it says otherwise, and
 * the guess costs nothing anyway: the downloader reads the real type off the
 * file's first bytes and renames it if this was wrong. */
const docExt = (d) => documentExt(d.filename, d.contentType) || "pdf";

const pad2 = (n) => String(n).padStart(2, "0");

/** The bundle's root folder — the one thing that carries the full identity. */
export function bundleFolderName(matter, assesseeName) {
  const m = matter || {};
  const what = clean(m.ref) || clean(m.proceedingName) || clean(m.type) || "Proceeding";
  const parts = [clean(assesseeName) || clean(m.assessee), m.ay ? `AY ${m.ay}` : "", what];
  return seg(parts.filter(Boolean).join(" - "), "Proceeding");
}

/* How many files a proceeding would actually put in a zip. Used by the button
   to know whether there is anything to offer — a matter opened by hand, with
   nothing synced against it, must not grow a Download control that produces an
   empty archive. */
export function proceedingFileCount(notices) {
  return (notices || []).reduce(
    (sum, n) => sum + noticeFiles(n).length + noticeReplies(n).reduce((s, r) => s + r.files.length, 0),
    0
  );
}

/*
 * Lay the whole proceeding out.
 *
 * @param matter        the proceeding record
 * @param notices       its notices/orders, any order — sorted here
 * @param assesseeName  who it belongs to
 * @param now           the date the summary is stamped with (injected for tests)
 *
 * @returns {
 *   folder,    the root folder name
 *   fileName,  what the .zip itself is called
 *   files,     [{ path, storagePath, filename, contentType }] — to be fetched
 *   texts,     [{ path, text }] — written from what we already hold
 *   header,    what identifies the proceeding, for the summary's masthead
 *   outline,   the proceeding notice by notice, as data — what the summary PDF
 *              draws and what the plain-text fallback prints. One shape, so the
 *              two can never disagree about what is in the folder.
 *   indexText, that same outline as plain text, for when the PDF cannot be made
 *   summary    { notices, files, replies, missing }
 * }
 */
export function planProceedingBundle({ matter, notices, assesseeName, now = new Date() }) {
  const m = matter || {};
  const folder = bundleFolderName(m, assesseeName);
  const files = [];
  const texts = [];
  const outline = [];
  let replyCount = 0;
  let missing = 0;

  /* OLDEST FIRST — the opposite of the screen. On screen the newest notice is
     the one being acted on, so it leads. A folder is read as the story of the
     proceeding from the first notice to the order, and it is numbered so that
     every file manager, sorting by name, tells that story too. */
  const ordered = [...(notices || [])].sort((a, b) =>
    (isoDay(a.date) || "9999").localeCompare(isoDay(b.date) || "9999")
  );

  ordered.forEach((n, i) => {
    const label = noticeLabel(n);
    const day = isoDay(n.date);
    const nFiles = noticeFiles(n);
    const replies = noticeReplies(n);
    const listed = Number(n.docsTotal) || 0;
    const short = listed > nFiles.length ? listed - nFiles.length : 0;

    /* A notice with nothing behind it gets no folder — a zip cannot hold an
       empty one, and a folder holding a single line of explanation is worse
       than a line in the summary. It is still listed and still reported. */
    const hasContent = nFiles.length > 0 || replies.some((r) => r.remarks || r.files.length);
    const noticeFolder = `${folder}/${seg(`${pad2(i + 1)} ${[day, label].filter(Boolean).join(" ")}`, `${pad2(i + 1)} Notice`)}`;

    const item = {
      no: pad2(i + 1),
      label,
      date: day,
      din: clean(n.din),
      kind: n.isAppealForm ? "appeal" : n.isOrder ? "order" : "notice",
      folder: hasContent ? noticeFolder.slice(folder.length + 1) : "",
      files: [],
      replies: [],
      missing: short,
      empty: !hasContent,
    };
    outline.push(item);

    if (!hasContent) {
      missing += short;
      return;
    }

    const nameIn = uniquifier();
    for (const d of nFiles) {
      const name = nameIn(seg(d.label, "Document"), docExt(d));
      files.push({ path: `${noticeFolder}/${name}`, storagePath: d.storagePath, filename: d.filename, contentType: d.contentType });
      item.files.push({ name, kind: documentKind(name, d.contentType) });
    }
    if (short) missing += short;

    replies.forEach((r, ri) => {
      replyCount++;
      const title = replies.length > 1 ? `Reply ${ri + 1}` : "Reply";
      const replyFolder = `${noticeFolder}/${seg([title, r.on].filter(Boolean).join(" - "), title)}`;
      const replyIn = uniquifier();
      const entry = { title, type: r.type, on: r.on, remarks: "", files: [], missing: r.missing };
      /* The remarks ARE the reply on a good number of these — an adjournment
         request is typed into the portal box with nothing attached — so they
         are written out as a file rather than left on a screen. */
      if (r.remarks) {
        texts.push({
          path: `${replyFolder}/Remarks.txt`,
          text: [
            `${r.type}${r.on ? ` filed on ${r.on}` : ""}`,
            `Against: ${label}${day ? ` issued ${day}` : ""}`,
            "",
            r.remarks,
            "",
          ].join("\n"),
        });
        entry.remarks = r.remarks;
        entry.files.push({ name: "Remarks.txt", kind: "other" });
      }
      for (const at of r.files) {
        const name = replyIn(seg(clean(at.label) || portalDocLabel(at.filename) || "Attachment", "Attachment"), docExt(at));
        files.push({ path: `${replyFolder}/${name}`, storagePath: at.storagePath, filename: at.filename, contentType: at.contentType });
        entry.files.push({ name, kind: documentKind(name, at.contentType) });
      }
      if (r.missing > 0) missing += r.missing;
      item.replies.push(entry);
    });
  });

  const header = {
    title: clean(m.ref) || clean(m.proceedingName) || clean(m.type) || "Proceeding",
    assessee: clean(assesseeName) || clean(m.assessee),
    pan: clean(m.pan),
    type: clean(m.type),
    ay: clean(m.ay),
    section: clean(m.section),
    status: clean(m.status),
    bench: clean(m.bench),
    prepared: isoDay(now),
    notices: ordered.length,
    files: files.length,
    replies: replyCount,
    missing,
  };

  return {
    folder,
    fileName: withExtension(folder, "zip"),
    files,
    texts,
    header,
    outline,
    indexText: renderIndexText(header, outline),
    summary: { notices: ordered.length, files: files.length, replies: replyCount, missing },
  };
}

/* The same outline as plain text.
 *
 * The bundle's index is a PDF in the practice's own theme (proceedingSummaryPdf
 * .js). This is what goes in when that cannot be drawn — a font that failed to
 * register, a browser that fell over on the generator — because a folder of
 * fourteen files with nothing to say what they are is the thing this feature
 * exists to prevent, and "the PDF didn't build" is no reason to hand one over.
 */
export function renderIndexText(header, outline) {
  const lines = [
    `PROCEEDING — ${header.title}`,
    "",
    ...[
      ["Assessee", header.assessee],
      ["PAN", header.pan],
      ["Type", header.type],
      ["A.Y.", header.ay],
      ["Section", header.section ? `u/s ${header.section}` : ""],
      ["Status", header.status],
      ["Bench", header.bench],
    ].filter(([, v]) => v).map(([k, v]) => `${k.padEnd(10)}: ${v}`),
    `${"Prepared".padEnd(10)}: ${header.prepared} — ProHippo`,
    "",
    [
      `${header.notices} notice${header.notices === 1 ? "" : "s"}/orders`,
      `${header.files} file${header.files === 1 ? "" : "s"}`,
      header.replies ? `${header.replies} repl${header.replies === 1 ? "y" : "ies"}` : "no replies on record",
    ].join("  ·  "),
    ...(header.missing ? [`${header.missing} file${header.missing === 1 ? "" : "s"} the portal listed could not be included — see the marked lines below.`] : []),
    "",
    "CONTENTS",
  ];

  for (const it of outline) {
    lines.push("");
    lines.push(`${it.no}  ${it.label}${it.date ? ` — issued ${it.date}` : ""}${it.din ? ` — DIN ${it.din}` : ""}`);
    if (it.empty) {
      lines.push(`      (nothing held for this ${it.kind === "order" ? "order" : "notice"} yet — run a portal sync)`);
      continue;
    }
    for (const f of it.files) lines.push(`      ${f.name}`);
    if (it.missing) {
      lines.push(`      ! ${it.missing} file${it.missing === 1 ? "" : "s"} the portal lists on this notice ${it.missing === 1 ? "was" : "were"} not fetched — re-run the sync.`);
    }
    for (const r of it.replies) {
      const dir = seg([r.title, r.on].filter(Boolean).join(" - "), r.title);
      for (const f of r.files) lines.push(`      ${dir}/${f.name}`);
      if (r.missing > 0) {
        lines.push(`      ! ${r.missing} attachment${r.missing === 1 ? "" : "s"} on this reply ${r.missing === 1 ? "was" : "were"} listed by the portal but not fetched — re-run the sync.`);
      }
    }
  }
  lines.push("");
  return lines.join("\n");
}
