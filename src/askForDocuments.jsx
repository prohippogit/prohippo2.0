/* ProHippo — "Ask for documents", the one action that turns any notice into a
 * client document request.
 *
 * Self-contained on purpose: drop <AskDocsButton notice={n}/> beside a notice
 * anywhere and it handles the whole flow, composer modal included. Callers wire
 * nothing.
 *
 * It never dead-ends. Whatever state the notice is in, pressing it gets you to
 * a composer:
 *   • a request already exists      → opens it (never a silent duplicate)
 *   • the notice lists documents    → composer, pre-filled
 *   • it has a PDF but no list      → reads the PDF first, then composer
 *   • neither                       → composer with the section's presets ready
 *
 * That last branch matters: portal-synced notices arrive with documents: []
 * because the portal's JSON has no such list — it's only in the PDF's prose.
 */
import React from 'react';
import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';
import { Icon, daysFromNow } from './shared';
import {
  useData, itemsFromNoticeDocuments, docRequestProgress, docRequestForNotice,
  noticeDeadline, noticeIsLive,
} from './store';
import DocumentRequestComposer from './DocumentRequest';

// How near a deadline has to be before the button stops being quiet about it.
const URGENT_WITHIN_DAYS = 7;

/* Short, honest label for how close the deadline is — the reason to act now. */
function deadlineLabel(notice) {
  const d = noticeDeadline(notice);
  if (!d) return "";
  const days = daysFromNow(d);
  if (days < 0) return "Overdue";
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `${days} days left`;
}

export function AskDocsButton({ notice, size = "xs" }) {
  const { data, notify } = useData();
  const [busy, setBusy] = React.useState(false);
  const [compose, setCompose] = React.useState(null); // { request } | { seed }

  const existing = docRequestForNotice(data, notice?.id);
  const live = noticeIsLive(notice);
  const days = noticeDeadline(notice) ? daysFromNow(noticeDeadline(notice)) : null;
  const urgent = live && days !== null && days <= URGENT_WITHIN_DAYS;

  // Resolve the assessee this notice belongs to — by PAN first, then name, the
  // same order the rest of the app uses. Two finds over a short list; not worth
  // memoising.
  const pan = (notice?.pan || "").toUpperCase();
  const assessee =
    data.assessees.find((a) => pan && (a.pan || "").toUpperCase() === pan)
    || data.assessees.find((a) => notice?.assessee && a.name === notice.assessee)
    || null;

  const seedFrom = (docs) => ({
    assesseeId: assessee.id,
    assessee: assessee.name,
    pan: assessee.pan || "",
    noticeId: notice.id || "",
    ay: notice.ay || "",
    authority: notice.authority || "",
    section: notice.section || "",
    din: notice.din || "",
    dueDate: noticeDeadline(notice),
    items: itemsFromNoticeDocuments(docs),
    channels: ["email", "whatsapp"],
    status: "draft",
  });

  const run = async () => {
    if (busy) return;
    if (existing) { setCompose({ request: existing }); return; }
    if (!assessee) {
      notify("This notice isn't linked to an assessee on file", "alert");
      return;
    }

    let docs = notice.documents || [];

    // Nothing listed, but there's a PDF to read — this is the portal-notice case.
    if (docs.length === 0 && notice.storagePath && notice.id) {
      setBusy(true);
      try {
        const res = await httpsCallable(functions, "extractNoticeDocuments", { timeout: 120000 })({ noticeId: notice.id });
        docs = res.data?.documents || [];
        if (docs.length === 0) {
          notify("This notice doesn't call for any documents — start from a standard set instead");
        } else {
          notify(`${docs.length} document${docs.length === 1 ? "" : "s"} read from the notice — check the list before sending`);
        }
      } catch (e) {
        // Falling through to an empty composer beats a dead end: the presets are
        // right there and the practitioner can type the list in half a minute.
        console.error("extractNoticeDocuments", e);
        notify(e?.message?.slice(0, 140) || "Couldn't read the notice PDF — add the documents by hand", "alert");
      } finally {
        setBusy(false);
      }
    }

    setCompose({ seed: seedFrom(docs) });
  };

  // An existing request reports progress instead of offering to make another.
  let label, tone, icon;
  if (busy) {
    label = "Reading notice…"; tone = "btn-secondary"; icon = "sparkle";
  } else if (existing) {
    const p = docRequestProgress(existing);
    label = existing.sentAt ? `Documents · ${p.received}/${p.total}` : "Draft request";
    tone = "btn-ghost"; icon = "doc";
  } else {
    label = "Ask for documents";
    tone = urgent ? "btn-primary" : "btn-secondary";
    icon = "mail";
  }

  return (
    <>
      <div className="center" style={{gap: 6, flexShrink: 0}}>
        {urgent && !existing && !busy && (
          <span
            className={`pill ${days < 0 ? "pill-danger" : days <= 3 ? "pill-warning" : "pill-muted"}`}
            style={{fontSize: 10}}
            title={`Deadline ${noticeDeadline(notice)}`}
          >
            {deadlineLabel(notice)}
          </span>
        )}
        <button
          className={`btn ${tone} btn-${size}`}
          disabled={busy}
          title={
            existing
              ? "Open the document request raised from this notice"
              : notice?.storagePath && !(notice.documents || []).length
                ? "Read the PDF and build the list of documents to ask the client for"
                : "Prepare a list of documents to ask the client for"
          }
          onClick={(e) => { e.stopPropagation(); run(); }}
        >
          <Icon name={icon} size={size === "sm" ? 13 : 12}/>{label}
        </button>
      </div>

      {compose && (
        <div onClick={(e) => e.stopPropagation()}>
          <DocumentRequestComposer
            request={compose.request}
            seed={compose.seed}
            onClose={() => setCompose(null)}
          />
        </div>
      )}
    </>
  );
}
