/*
 * ProHippo — download one whole proceeding as a single zip.
 *
 * The layout is decided in proceedingBundle.js; this file is the part that
 * touches the network. It resolves each Storage object, fetches the bytes,
 * settles what each file actually IS from those bytes, and hands the archive to
 * the browser as one save.
 *
 * TWO THINGS IT REFUSES TO DO QUIETLY.
 *
 * A file that will not come down does not fail the bundle — thirteen documents
 * are worth having when the fourteenth is missing, on the day a submission is
 * due. But it is not swallowed either: it is named in the index inside the zip
 * AND reported back to the caller, so the screen can say so.
 *
 * And the extension on every file is read off the first bytes rather than taken
 * from the department's filename, for the reason set out in downloadFile.js:
 * ITBA serves compressed folders called "ATTACHMENT.pdf", and a bundle full of
 * PDFs that are not PDFs is a folder a practitioner cannot open.
 */
import { ref as storageRef, getDownloadURL } from "firebase/storage";
import { storage } from "./firebase";
import { saveBlob } from "./downloadFile";
import { sniffExtension, retypeFilename } from "./downloadNames";
import { planProceedingBundle, renderIndexText } from "./proceedingBundle";
import { proceedingSummaryBytes } from "./proceedingSummaryPdf";
import { zipBlob } from "./zip";

// How many objects are fetched at once. Enough to keep a broadband connection
// busy; low enough that a proceeding with thirty documents does not open thirty
// sockets on a phone.
const PARALLEL = 4;

const retypePath = (path, ext) => {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? retypeFilename(path, ext) : path.slice(0, cut + 1) + retypeFilename(path.slice(cut + 1), ext);
};

async function fetchOne(entry) {
  const url = await getDownloadURL(storageRef(storage, entry.storagePath));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = new Uint8Array(await res.arrayBuffer());
  const sniffed = sniffExtension(data.subarray(0, 8));
  return { name: sniffed ? retypePath(entry.path, sniffed) : entry.path, data };
}

/**
 * Fetch everything in one proceeding and save it as a zip.
 *
 * @param matter        the proceeding
 * @param notices       its notices/orders, with their responses
 * @param assesseeName  who it belongs to
 * @param profile       the practice — its name, contact and accent colour, for
 *                      the summary sheet's masthead
 * @param onProgress    ({ done, total }) while the files come down
 * @returns { fileName, saved, total, failed, missing } — `failed` is what would
 *          not download, `missing` what the portal listed and we never held.
 */
export async function downloadProceedingBundle({ matter, notices, assesseeName, profile, onProgress }) {
  const plan = planProceedingBundle({ matter, notices, assesseeName });
  const enc = new TextEncoder();
  const total = plan.files.length;
  if (!total && !plan.texts.length) {
    throw new Error("There is nothing on this proceeding to download yet.");
  }

  const fetched = [];
  const failed = [];
  let done = 0;
  onProgress && onProgress({ done, total });

  // A simple worker pool over the list — the entries are independent and the
  // archive is assembled from the plan's order afterwards, not from the order
  // they happen to arrive in.
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= plan.files.length) return;
      const entry = plan.files[i];
      try {
        fetched.push({ i, ...(await fetchOne(entry)) });
      } catch (err) {
        console.error("bundle: couldn't fetch", entry.storagePath, err);
        failed.push({ path: entry.path, reason: err?.code || err?.message || "unavailable" });
      } finally {
        done++;
        onProgress && onProgress({ done, total });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, plan.files.length) }, worker));

  if (total && fetched.length === 0) {
    // Every single file failed — that is not a bundle with gaps, it is a
    // failure, and handing over a zip holding nothing but an index would be a
    // lie about it.
    throw new Error("None of the documents could be downloaded — check your connection and try again.");
  }

  /* THE SHEET THE FOLDER OPENS ON. Drawn in the practice's own theme, because
     this folder gets e-mailed to clients and carried into hearings and its
     first page is the firm's cover sheet whether anybody designed it or not.
     What failed to download is passed in here rather than read off the plan:
     it is only knowable now, and it is the half a practitioner most needs the
     sheet to say.

     If the PDF cannot be drawn — a font that did not register, a generator
     that fell over — the same listing goes in as plain text instead. A folder
     of twenty-one files with nothing to say what they are is precisely what
     this feature exists to prevent, and "the PDF didn't build" is no reason to
     hand one over. */
  const index = (() => {
    try {
      return {
        name: `${plan.folder}/00 Proceeding summary.pdf`,
        data: proceedingSummaryBytes({ plan, profile, failed }),
      };
    } catch (err) {
      console.error("bundle: couldn't draw the summary — falling back to text", err);
      const text = failed.length
        ? [
            renderIndexText(plan.header, plan.outline),
            "NOT INCLUDED",
            ...failed.map((f) => `      ${f.path.slice(plan.folder.length + 1)} — ${f.reason}`),
            "",
            "These are held by ProHippo but could not be downloaded just now. Try the bundle again, or save them one at a time from the proceeding.",
            "",
          ].join("\n")
        : plan.indexText;
      return { name: `${plan.folder}/00 Contents.txt`, data: enc.encode(text) };
    }
  })();

  const entries = [
    index,
    ...plan.texts.map((t) => ({ name: t.path, data: enc.encode(t.text) })),
    ...fetched.sort((a, b) => a.i - b.i).map(({ name, data }) => ({ name, data })),
  ];
  saveBlob(zipBlob(entries), plan.fileName);

  return {
    fileName: plan.fileName,
    saved: fetched.length,
    total,
    failed: failed.length,
    missing: plan.summary.missing,
  };
}
