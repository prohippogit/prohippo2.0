/*
 * ProHippo — "download this whole proceeding".
 *
 * One control, three places it has to sit: on the proceeding row of a desk
 * list, on the same row where a phone draws it as a card, and inside the
 * proceeding's own pop-up. The work behind it is identical in all three, so it
 * is one component with three shapes rather than three buttons that will drift.
 *
 *   icon   the desk row and the phone card — a row that already carries a type,
 *          a year, a section, a status and a way in has no width left for a
 *          fourth word, so this is the download glyph with a tooltip that says
 *          exactly what comes down.
 *   full   the pop-up, where there is room to name it and where a practitioner
 *          who has just read the notices is most likely to want the folder.
 *
 * WHAT IT SAYS WHILE IT WORKS. A proceeding is routinely 15 MB across a dozen
 * documents, so this is seconds, not milliseconds, on a phone connection: the
 * button counts the files down rather than sitting there looking broken, and it
 * blocks a second click on the same proceeding while it runs.
 *
 * WHAT IT SAYS AFTERWARDS. The count saved, and — plainly — anything that did
 * not make it in. A bundle that is quietly short is the one a submission gets
 * built on; see proceedingBundle.js.
 */
import React from "react";
import { Icon } from "./shared";
import { useData } from "./store";
import { proceedingFileCount } from "./proceedingBundle";
import { downloadProceedingBundle } from "./proceedingDownload";

export default function ProceedingBundleButton({ matter, notices, assesseeName, notify, variant = "icon" }) {
  const [progress, setProgress] = React.useState(null); // { done, total } while running
  /* The practice's own name, contact and accent — the masthead of the summary
     sheet inside the bundle. Read here rather than threaded through three call
     sites, because none of them has any other reason to hold it. */
  const { profile } = useData();

  /* Nothing synced against this proceeding — a matter opened by hand, or one
     whose sync has not run yet. No control at all, rather than one that hands
     back an archive holding an index and nothing else. */
  const count = proceedingFileCount(notices);
  if (!count) return null;

  const busy = progress !== null;
  const run = async (e) => {
    e.stopPropagation();
    if (busy) return;
    setProgress({ done: 0, total: count });
    try {
      const res = await downloadProceedingBundle({
        matter, notices, assesseeName, profile,
        onProgress: setProgress,
      });
      /* Said in one line, in the order a practitioner needs it: what they got,
         then what is short. The gaps are two different things and are named
         separately — a file we hold but could not fetch is worth retrying now,
         a file the portal never gave us needs a sync. */
      const gaps = [
        res.failed ? `${res.failed} couldn't be downloaded` : "",
        res.missing ? `${res.missing} not yet fetched from the portal` : "",
      ].filter(Boolean);
      notify && notify(
        `Saved ${res.fileName} — ${res.saved} file${res.saved === 1 ? "" : "s"}${gaps.length ? ` · ${gaps.join(", ")}` : ""}`,
        gaps.length ? "alert" : undefined
      );
    } catch (err) {
      console.error("proceeding bundle failed", err);
      notify && notify(err?.message?.slice(0, 140) || "Couldn't build the download.", "alert");
    } finally {
      setProgress(null);
    }
  };

  const title = busy
    ? `Downloading — ${progress.done} of ${progress.total} files`
    : `Download all ${count} PDF${count === 1 ? "" : "s"} of this proceeding — one folder per notice, with the reply filed against it`;

  /* The row and the card this button sits on are themselves buttons: they open
     the proceeding on Enter and Space. Stopping the click is not enough for
     that — the key press bubbles on its own — so a practitioner tabbing to this
     button and pressing Enter would download the folder AND open the pop-up
     over it. */
  const stopKeys = (e) => e.stopPropagation();

  if (variant === "full") {
    return (
      <button type="button" className="btn btn-secondary btn-xs" onClick={run} onKeyDown={stopKeys} disabled={busy} title={title}>
        <Icon name="download" size={12}/>
        {busy ? `Downloading ${progress.done}/${progress.total}…` : "Download all PDFs"}
      </button>
    );
  }

  return (
    <button
      type="button"
      className={`pbundle-btn${busy ? " busy" : ""}`}
      onClick={run}
      onKeyDown={stopKeys}
      disabled={busy}
      title={title}
      aria-label={title}
    >
      {busy ? <span className="pbundle-count">{progress.done}/{progress.total}</span> : <Icon name="download" size={14}/>}
    </button>
  );
}
