/*
 * ProHippo — one place that turns a Storage object into a file on the user's
 * computer.
 *
 * THE PROBLEM THIS SOLVES. Every download used to be `window.open(url)`. A
 * browser handed a `application/pdf` URL renders it in a tab rather than saving
 * it, so a practitioner who clicked "PDF" got a viewer, not a file — and if they
 * did save it from there, it landed as `din_9c4a1f2e08b3d5a71c60.pdf`, because
 * that is what we call the object in Storage.
 *
 * Both halves matter. These documents get filed, e-mailed to clients and
 * attached to submissions; they need to arrive as files, with names a human
 * chose.
 *
 * HOW. Fetch the object, hand the blob to an <a download>. That works on
 * everything already in Storage — no metadata backfill — and lets us name the
 * file at the moment we know what it is, rather than at the moment we uploaded
 * it. Uploads also set Content-Disposition now (see portalIngest.js), which
 * covers the other case: a download URL opened outside the app.
 *
 * If the fetch is ever blocked, we fall back to opening the URL. A viewer is a
 * worse outcome than a download, but it is a much better outcome than a button
 * that does nothing.
 */
import { ref as storageRef, getDownloadURL } from "firebase/storage";
import { storage } from "./firebase";
import { safeFilename, withExtension } from "./downloadNames";

/* The actual save. Kept separate so anything holding a Blob already — a PDF we
   generated in the browser, say — can use the same path. */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  // Firefox needs the anchor in the document for a programmatic click to count.
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers; a tick is
  // enough for the save to have been handed to the browser's download manager.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * Download one Storage object to the user's computer.
 *
 * @param storagePath  the object's path, as recorded on the Firestore document
 * @param filename     what the user should see it called; extension optional
 * @returns true if it saved, false if it fell back to opening in a tab
 */
export async function downloadFromStorage(storagePath, filename) {
  if (!storagePath) return false;
  const name = safeFilename(filename || storagePath.split("/").pop());
  let url;
  try {
    url = await getDownloadURL(storageRef(storage, storagePath));
  } catch (err) {
    console.error("download: couldn't resolve", storagePath, err);
    throw err; // the file is missing or unreadable — the caller should say so
  }

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    // The path's extension is the reliable one: Storage content types are set by
    // us at upload, but the extension is what the operating system reads.
    const ext = (storagePath.match(/\.([a-z0-9]{2,5})$/i) || [])[1];
    saveBlob(blob, withExtension(name, ext));
    return true;
  } catch (err) {
    // Almost always a CORS or offline failure. Opening the URL still gets the
    // practitioner to their document, which is the point.
    console.warn("download: falling back to opening in a tab", err);
    window.open(url, "_blank", "noopener");
    return false;
  }
}
