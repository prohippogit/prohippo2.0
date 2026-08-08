/*
 * ProHippo — every file behind one notice, on the card.
 *
 * THE RULE THIS ENFORCES: A PRACTITIONER MUST NEVER HAVE TO GUESS WHETHER THERE
 * IS MORE. The portal serves a s.148 notice as four files and the app used to
 * show one of them with no hint that the other three existed — see
 * noticeDocs.js for what the set actually is.
 *
 * So the card lists the whole set, names each file for what it IS rather than
 * for the ids ITBA strings together, and says plainly when a file is a ZIP the
 * practitioner will have to unpack rather than a PDF they can read — because a
 * compressed folder downloaded as ".pdf" is a support call.
 *
 * A notice that really is one plain PDF renders nothing here: the existing
 * "PDF" button already says everything there is to say, and a list of one is
 * noise.
 */
import { Icon } from "./shared";
import { downloadFromStorage } from "./downloadFile";
import { DOC_KIND_LABEL, portalDocLabel, noticeDocFilename, noticeFilename } from "./downloadNames";
import { noticeDocuments, hasDocumentList, fmtBytes } from "./noticeDocs";

const KIND_STYLE = {
  pdf: { bg: "var(--p-pink)", fg: "#C13388" },
  zip: { bg: "var(--p-amber)", fg: "#B07512" },
  other: { bg: "var(--p-card-tint)", fg: "var(--p-text-3)" },
};

async function save(doc, notice, assesseeName) {
  try {
    await downloadFromStorage(
      doc.storagePath,
      doc.primary ? noticeFilename(notice, assesseeName) : noticeDocFilename(doc, notice, assesseeName)
    );
  } catch (e) {
    console.error("download notice document", doc.storagePath, e);
  }
}

/* One row per file. `compact` is the inline form for a table cell — same
   documents, no header, no sizes. `always` lists even a lone plain PDF, for a
   screen that has nothing else offering it. */
export default function NoticeDocuments({ notice, assesseeName, compact = false, always = false }) {
  const docs = noticeDocuments(notice);
  if (!docs.length || (!always && !hasDocumentList(notice))) return null;

  /* What the portal LISTED against what we hold. A set can be truncated by the
     per-notice ceiling in the fetch, and showing four while six exist is the
     same failure this component was written to end. */
  const listed = Number(notice?.docsTotal) || 0;
  const missing = listed > docs.length ? listed - docs.length : 0;

  if (compact) {
    return (
      <div className="row" style={{gap: 6, flexWrap: "wrap"}}>
        {docs.map((d, i) => {
          const st = KIND_STYLE[d.kind] || KIND_STYLE.other;
          return (
            <button
              key={i}
              className="btn btn-ghost btn-xs"
              title={`${d.filename || "Document"} — ${DOC_KIND_LABEL[d.kind]}`}
              onClick={(e) => { e.stopPropagation(); save(d, notice, assesseeName); }}
            >
              <span style={{fontSize: 8.5, fontWeight: 800, padding: "1px 4px", borderRadius: 4, background: st.bg, color: st.fg}}>
                {DOC_KIND_LABEL[d.kind]}
              </span>
              {(portalDocLabel(d.filename) || "Document").slice(0, 26)}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div style={{marginTop: 8}}>
      <div className="between" style={{marginBottom: 5}}>
        <div style={{fontSize: 10.5, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", opacity: 0.7}}>
          Documents
        </div>
        <div className="muted" style={{fontSize: 10.5, fontWeight: 700}}>
          {docs.length} file{docs.length === 1 ? "" : "s"}
        </div>
      </div>
      <div className="col" style={{gap: 5}}>
        {docs.map((d, i) => {
          const st = KIND_STYLE[d.kind] || KIND_STYLE.other;
          return (
            <button
              key={i}
              className="center"
              title={d.filename || "Document"}
              onClick={(e) => { e.stopPropagation(); save(d, notice, assesseeName); }}
              style={{
                gap: 9, justifyContent: "flex-start", width: "100%", textAlign: "left",
                padding: "7px 10px", background: "white", border: "1px solid var(--p-line-2)",
                borderRadius: 9, cursor: "pointer", font: "inherit", fontSize: 12,
              }}
            >
              <span style={{fontSize: 8.5, fontWeight: 800, padding: "2px 5px", borderRadius: 4, background: st.bg, color: st.fg, flexShrink: 0}}>
                {DOC_KIND_LABEL[d.kind]}
              </span>
              <span style={{flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: d.primary ? 800 : 600}}>
                {portalDocLabel(d.filename) || "Document"}
              </span>
              {d.kind === "zip" && (
                <span className="muted" style={{fontSize: 10.5, flexShrink: 0}}>compressed folder</span>
              )}
              {d.bytes ? <span className="muted" style={{fontSize: 10.5, flexShrink: 0}}>{fmtBytes(d.bytes)}</span> : null}
              <Icon name="download" size={12} className="muted"/>
            </button>
          );
        })}
      </div>
      {missing > 0 && (
        <div className="muted" style={{fontSize: 10.5, marginTop: 5, color: "var(--p-danger)"}}>
          The portal lists {listed} files on this notice; {missing} could not be fetched. Re-run the sync to try again.
        </div>
      )}
    </div>
  );
}
