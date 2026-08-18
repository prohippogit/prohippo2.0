import React from 'react';
import { Icon, Avatar, StatusPill, EmptyState, Modal, FormField, TextInput, Toggle, Table, titleCase, fmtINR, fmtDate, fmtDateLong, fmtDateTime, fmtLakhs, daysFromNow } from './shared';
import { useAuth } from './auth';
import { mobileTen, normaliseMobile, headConsent } from './whatsappSettings';
import { useData, assesseeStats, upcomingHearings, invoiceStatus, invoiceOutstanding, fyOf, todayISO,
  groupsOf, groupLedger, assesseeOutstanding, GROUP_COLORS,
  commsOf, docRequestsOf, docRequestProgress, derivedRequestStatus, noticeDeadline } from './store';
import { viewedByOfficer, fmtPortalDate } from './noticeDates';
import { downloadLedgerPDF } from './ledgerPdf';
import { MatterModal } from './Other';
import DocumentRequestComposer, { RequestStatusPill } from './DocumentRequest';
import { AskDocsButton } from './askForDocuments';
import { AssesseeModal } from './AssesseeModal';
import { AdjournModal } from './Hearings';
import { httpsCallable } from 'firebase/functions';
import { ref as storageRef, getDownloadURL } from 'firebase/storage';
import { functions, storage } from './firebase';
import { detectExtension, openPortalLogin, onSyncData } from './portalSync';
import { ExtensionDownloadButton } from './ExtensionDownload';
import { ingestPortalSyncMessage } from './portalIngest';
import { downloadFromStorage } from './downloadFile';
import { noticeFilename, returnOrderFilename, returnDocFilename } from './downloadNames';
// The table only — the generator itself stays behind a dynamic import so it does
// not ride in the main bundle.
import { computationAvailability } from './computation/supported';
import { orderDocType, isAppealableOrder, DOC_TYPE_LABEL, sameAppeal } from './appeals';
import NoticeDocuments from './NoticeDocuments';
import { noticeDocumentCount, hasDocumentList } from './noticeDocs';
import { describeVariance, BASELINE_LABEL } from './intimations';
// What a re-sync already holds, so it fetches only what is genuinely new. The
// rules are in that module because they are decisions about what NOT to fetch,
// and a wrong one is invisible — it produces no error, just data that never
// arrives. See src/syncKnowns.js.
import { buildSyncKnowns } from './syncKnowns';

// Pause between assessees in a bulk sync. The extension emits "sync-done" only
// AFTER it logs the previous assessee out, so by the time we advance the portal
// session is already gone — this gap is just light breathing room. Tunable.
const BULK_GAP_MS = 500; // was 1500

// Sync scopes offered on the assessee's Overview card.
const SYNC_SCOPES = [
  { value: "eproc", label: "e-Proceedings only (fast)", btn: "Sync e-Proceedings" },
  { value: "all", label: "Full sync — everything", btn: "Full sync" },
  { value: "appeals", label: "First appeals (Form 35) only", btn: "Sync Form 35" },
  { value: "returns", label: "Filed returns & CPC orders only", btn: "Sync returns" },
];
import CheekyHippoProgress from './cheekyHippo/CheekyHippoProgress.jsx';

// Rough bucket for a streamed notice so the hippo can drop smarter copy
// ("2 reassessment notices…"). Best-effort string matching on the portal's
// section/description — not authoritative, just flavour for the mascot.
function classifyNoticeSection(notice) {
  const hay = `${notice?.section || ''} ${notice?.description || ''} ${notice?.proceedingName || ''}`.toLowerCase();
  if (/\b148a?\b|reassess|reopen/.test(hay)) return 'reassessment';
  if (/\b27[01]\b|penalty|penal/.test(hay)) return 'penalty';
  if (/appeal|\b250\b|form\s*35|cit\s*\(a\)/.test(hay)) return 'appeal';
  if (/\b14[34]\b|assessment|order/.test(hay) || notice?.isOrder) return 'assessment';
  return null;
}

// Save a Storage-hosted document to the user's computer, named after what it
// is rather than after its object id. See downloadFile.js — every screen shares
// these naming rules so the same document never downloads under two names.
async function downloadDoc(storagePath, filename) {
  if (!storagePath) return;
  try {
    await downloadFromStorage(storagePath, filename);
  } catch (e) {
    console.error("download", storagePath, e);
  }
}

export { AssesseeModal };

/* When the reply was due. Stated, and nothing inferred from it.
 *
 * NO COUNTDOWN, DELIBERATELY. This used to read "overdue by 695 days" beside a
 * hearing notice from 2024 — arithmetically right and completely wrong. An
 * appeal runs on a series of hearing notices, the assessee answers the current
 * one, and every superseded notice in the list then reads as a two-year-old
 * emergency. A row that shouts on a matter nobody is worried about is how a
 * screen teaches people to stop reading it. Live deadlines belong on the
 * dashboard and in the calendar; this card is the file.
 *
 * A hearing date, where there is one, outranks the response due date — the rule
 * `noticeDeadline` already applies everywhere else, and this must not be the one
 * place that disagrees. */
function ReplyDue({ notice: n }) {
  const due = noticeDeadline(n);
  if (!due) return null;
  const answered = (n.responses || []).length > 0;
  return (
    <div className="muted" style={{fontSize: 11.5, marginTop: 3}}>
      <Icon name="clock" size={11}/>{" "}
      {n.hearingDate ? "Hearing" : "Reply due"} {fmtDateLong(due)}
      {answered && " · replied"}
    </div>
  );
}

// The portal sends submittedOn as epoch millis; render it as a readable date.
function fmtSubmitted(v) {
  const n = Number(v);
  if (!v || Number.isNaN(n)) return String(v || "");
  try { return new Date(n).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }); }
  catch { return String(v); }
}

/* "Response viewed by AO on : 21-Jul-2026" — the portal's own words, and the
 * most useful thing a practitioner can know after filing. "He hasn't looked"
 * and "he's looked and said nothing" are two completely different conversations
 * to have with a client, and the app could not tell them apart.
 *
 * WHERE IT COMES FROM. The portal prints it on the NOTICE block, under the
 * response due date, so that is where it is read from — the reply is only
 * checked as a fallback. What ITBA calls the field in the JSON behind that
 * label is not something that could be read off a live row while this was
 * built, so the connector forwards every unmapped scalar and
 * src/noticeDates.js matches the likely names against them. It matches
 * `responseViewedByAoOn`, which is what the portal calls it. */
function ViewedByOfficer({ notice, response }) {
  const seen = viewedByOfficer(notice, response);
  /* THE DISCOVERY HATCH IS CLOSED, and this is where it used to be.
   *
   * Under the date sat a disclosure listing every portal field we had no name
   * for — `readFlag: Y`, `proceedingLimitationDate: 1711823400000`,
   * `nameOfAssesse`, `respStatus: S` and so on. It existed for one purpose: to
   * read the real name of the "Response viewed by AO on" field off a live reply
   * instead of guessing at it. That worked, the date above is the result, and
   * what remained in the list was JSON keys and epoch numbers on a card a
   * practitioner shows a client.
   *
   * The fields are still collected and still stored on the notice — that is
   * where the date is read from, and where the next unnamed field will be found
   * when one is needed. They are simply not a thing to print. */
  if (!seen) return null;
  return (
    <span style={{fontWeight: 700, color: "#1A8A53"}} title={`Portal field: ${seen.key}`}>
      · viewed by AO on {fmtPortalDate(seen.value)}
    </span>
  );
}

// Responses the assessee filed against a notice — remarks text + downloadable
// attachment PDFs. Shared by the Matters view and the per-assessee Notices tab
// so the two never drift apart.
function ResponsesBlock({ notice, responses, plain }) {
  /* A REPLY WITH NOTHING IN IT IS NOT A REPLY WORTH A CARD.
   *
   * The portal returns rows carrying no remarks and no attachment — and a reply
   * whose remarks are a single space counts as one of them, which is why this
   * trims rather than testing for truth. Three such rows appeared under one
   * s.142(1) notice as three empty green boxes, each saying "Response" and
   * nothing else.
   *
   * A row whose attachments exist but never came down is different, and is kept:
   * "the portal has two files here that we do not hold" is worth knowing, and
   * silently dropping it would be the quiet-omission failure again. */
  const shaped = (responses || []).map((rsp) => {
    const files = (rsp.attachments || []).filter((at) => at.storagePath);
    return {
      rsp,
      text: String(rsp.remarks || "").trim(),
      files,
      missing: (rsp.attachments || []).length - files.length,
    };
  });
  const list = shaped.filter((r) => r.text || r.files.length || r.missing > 0);
  if (list.length === 0) return null;
  return (
    <div style={{marginTop: plain ? 0 : 8, borderTop: plain ? "none" : "1px dashed var(--p-line)", paddingTop: plain ? 0 : 8}}>
      <div style={{fontSize: 10.5, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", marginBottom: 5, color: "#1A8A53"}}>
        Response{list.length > 1 ? "s" : ""} filed
      </div>
      <div className="col" style={{gap: 8}}>
        {list.map(({ rsp, text, files, missing }, ri) => (
          <div key={ri} style={{padding: "9px 11px", background: "var(--p-mint)", border: "1px solid #CDEED9", borderRadius: 10, fontSize: 12, color: "#3A5A46"}}>
            <div className="center" style={{gap: 7, justifyContent: "flex-start", marginBottom: text ? 5 : 0, flexWrap: "wrap"}}>
              <span style={{width: 18, height: 18, borderRadius: "50%", background: "#20B978", color: "#fff", display: "grid", placeItems: "center", flexShrink: 0}}><Icon name="check" size={11} stroke={3}/></span>
              <span style={{fontWeight: 800, color: "#1A8A53"}}>{rsp.respType || "Response"}</span>
              {rsp.submittedOn && <span style={{fontWeight: 700, color: "#1A8A53"}}>· filed {fmtSubmitted(rsp.submittedOn)}</span>}
              <ViewedByOfficer notice={notice} response={rsp}/>
            </div>
            {text && <div style={{whiteSpace: "pre-wrap"}}>{text}</div>}
            {files.length > 0 && (
              <div className="row" style={{gap: 6, flexWrap: "wrap", marginTop: 6}}>
                {files.map((at, ci) => (
                  <button key={ci} className="btn btn-ghost btn-xs" title={at.label ? `${at.label} — ${at.filename}` : at.filename} onClick={(e) => { e.stopPropagation(); downloadDoc(at.storagePath, at.filename); }}>
                    <Icon name="doc" size={11}/>{(at.label || at.filename || "PDF").slice(0, 26)}
                  </button>
                ))}
              </div>
            )}
            {/* Listed by the portal, never received. Said out loud rather than
                left as a card with nothing on it. */}
            {missing > 0 && (
              <div style={{marginTop: files.length ? 6 : 4, opacity: 0.75}}>
                {missing} attachment{missing > 1 ? "s" : ""} the portal listed but did not return — re-sync to try again.
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const PAGE_SIZE = 25;

// Small readout of how the last portal sync was fetched + how long it took.
// "api" = the fast portal JSON path (approach a); "scrape" = screen fallback.
function SyncTiming({ info }) {
  const fast = info.via === "api";
  const ms = typeof info.ms === "number" ? info.ms : null;
  const bg = fast ? "var(--p-mint)" : "var(--p-card-tint)";
  const fg = fast ? "#1B8C5C" : "var(--p-primary-2)";
  const label = info.calibrating
    ? `API reached${ms != null ? ` in ${ms} ms` : ""} · mapping calibration pending`
    : fast
      ? `Portal API${ms != null ? ` · ${ms} ms` : ""}${typeof info.count === "number" ? ` · ${info.count} proceedings` : ""}`
      : `Screen scrape${typeof info.count === "number" ? ` · ${info.count} proceedings` : ""}`;
  return (
    <div className="center" style={{gap: 6, justifyContent: "flex-start", padding: "6px 10px", background: bg, color: fg, borderRadius: 9, fontSize: 11.5, fontWeight: 700, alignSelf: "flex-start"}}
         title={info.endpoint || undefined}>
      <Icon name={fast ? "sparkle" : "doc"} size={12}/>
      <span>{label}</span>
    </div>
  );
}

// Column layout for the Assessees list (checkbox · name · PAN · entity ·
// contact · proceedings · assigned · status · actions).
const ASS_GRID = "30px minmax(220px, 2fr) 130px 120px 110px 150px 110px 80px";

// Colour for an entity-type pill.
function entityPill(status) {
  const map = {
    Individual: { bg: "var(--p-lavender-2)", c: "var(--p-primary-2)" },
    Company: { bg: "#E3ECFF", c: "#2B5FD0" },
    Firm: { bg: "var(--p-mint)", c: "#1B8C5C" },
    LLP: { bg: "#EDE4FF", c: "#7A4FD0" },
    HUF: { bg: "var(--p-amber)", c: "#B07512" },
    Trust: { bg: "var(--p-pink)", c: "#C13388" },
    "AOP/BOI": { bg: "#FFE7D6", c: "#B5651D" },
  };
  return map[status] || { bg: "var(--p-card-tint)", c: "var(--p-text-2)" };
}

/* ---------------- Groups (first-class) ---------------- */

// Roll-up counts for a group's members.
function groupStats(data, members) {
  const pans = new Set(members.map((m) => (m.pan || "").toUpperCase()).filter(Boolean));
  const matters = data.matters.filter((m) => !["Closed", "Decided"].includes(m.status) && pans.has((m.pan || "").toUpperCase())).length;
  const hearings = upcomingHearings(data).filter((h) => pans.has((h.pan || "").toUpperCase())).length;
  return { matters, hearings };
}

/* Create / edit a group's metadata (name, colour, group head, billing contact,
   notes).

   THE GROUP HEAD IS WHY THIS MODAL GREW. A group is a family or a business
   house, and several of its members are companies and trusts — you do not
   WhatsApp Shah Textiles Pvt. Ltd., you WhatsApp Rajesh Shah, who answers for
   all of them. Every client-facing message therefore addresses the head rather
   than the assessee the notice happens to name. */
function GroupModal({ initial, onClose }) {
  const { data, addGroup, updateGroup, renameGroup, notify } = useData();
  const { user } = useAuth();
  const isEdit = Boolean(initial?.id);
  const [form, setForm] = React.useState(() => ({
    name: "", color: GROUP_COLORS[0], notes: "", contact: "", ...initial,
    headName: initial?.head?.name || "",
    headTen: mobileTen(initial?.head?.mobile),
    headAssesseeId: initial?.head?.assesseeId || "",
    consent: headConsent(initial).optedIn,
  }));
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const [busy, setBusy] = React.useState(false);
  const name = form.name.trim();
  const dup = groupsOf(data).some((g) => g.name.toLowerCase() === name.toLowerCase() && g.name !== initial?.name);
  const valid = name && !dup;

  // Members of this group, offered as the head — the number is almost always
  // already on one of their profiles, and retyping it is how two spellings of
  // the same mobile end up on file.
  const members = React.useMemo(
    () => data.assessees.filter((a) => (a.group || "").trim() === (initial?.name || "").trim()),
    [data.assessees, initial?.name]
  );

  const headMobile = normaliseMobile(form.headTen);
  const headMobileBad = form.headTen.replace(/\D/g, "").length > 0 && !headMobile;
  // Consent is a statement about a reachable person. Without a number there is
  // nobody for it to be about, so it cannot be given.
  const canConsent = Boolean(form.headName.trim() && headMobile);
  const revokedAt = headConsent(initial).revokedAt;

  const pickMember = (id) => {
    const a = data.assessees.find((x) => x.id === id);
    if (!a) return;
    setForm((f) => ({
      ...f,
      headAssesseeId: a.id,
      headName: a.name || f.headName,
      headTen: mobileTen(a.mobile) || f.headTen,
    }));
  };

  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const head = { name: form.headName.trim(), mobile: headMobile, assesseeId: form.headAssesseeId || "" };
    /* Consent records WHO attested it and WHEN, not a bare boolean. The group
       head never sees ProHippo and cannot tick a box in it, so the practitioner
       attests on their behalf — and an attestation with no author is not one.
       Turning it off keeps `revokedAt`, so a client who said STOP is not
       silently re-enrolled by someone toggling it back on. */
    const prev = headConsent(initial);
    const consent = form.consent && canConsent
      ? { optedIn: true, at: prev.optedIn ? prev.at : new Date().toISOString(), by: user?.email || user?.uid || "", source: "practitioner", revokedAt: "" }
      : { optedIn: false, at: prev.at || "", by: prev.by || "", source: prev.source || "", revokedAt: prev.revokedAt || (prev.optedIn ? new Date().toISOString() : "") };

    const fields = { name, color: form.color, notes: form.notes.trim(), contact: form.contact.trim(), head, headWhatsappOptIn: consent };
    if (isEdit) {
      if (name !== initial.name) await renameGroup(initial.id, initial.name, name);
      await updateGroup(initial.id, fields);
    } else {
      await addGroup(fields);
    }
    setBusy(false);
    notify(isEdit ? "Group updated" : `Group “${name}” created`);
    onClose(name);
  };

  return (
    <Modal
      title={isEdit ? "Edit group" : "New group"}
      sub={isEdit ? "Renaming updates every member" : "Create a group, then add assessees to it"}
      onClose={() => onClose()}
      width={480}
      footer={<>
        <button className="btn btn-secondary" onClick={() => onClose()}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid || busy} style={{opacity: valid && !busy ? 1 : 0.5}} onClick={save}><Icon name="check" size={14}/>{busy ? "Saving…" : isEdit ? "Save group" : "Create group"}</button>
      </>}
    >
      <FormField label="Group name" required>
        <TextInput value={form.name} onChange={set("name")} placeholder="e.g. Shah Group"/>
        {dup && <div style={{fontSize: 11.5, color: "var(--p-danger)", marginTop: 4}}>A group with this name already exists.</div>}
      </FormField>
      <div className="field" style={{marginTop: 12}}>
        <label>Colour</label>
        <div className="row" style={{gap: 8, flexWrap: "wrap"}}>
          {GROUP_COLORS.map((c) => (
            <button key={c} type="button" onClick={() => set("color")(c)} title={c}
              style={{padding: 0, border: form.color === c ? "2px solid var(--p-text)" : "2px solid transparent", borderRadius: "50%", background: "none", cursor: "pointer"}}>
              <Avatar name={form.name || "G"} color={c} round soft/>
            </button>
          ))}
        </div>
      </div>
      <div style={{marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--p-line-2)"}}>
        <div style={{fontWeight: 700, fontSize: 13}}>Group head</div>
        <div className="muted" style={{fontSize: 12, marginTop: 2, lineHeight: 1.5}}>
          The person who answers for everyone in this group. Client messages — document requests, invoices — go to them
          rather than to the company or trust the notice happens to name.
        </div>

        {members.length > 0 && (
          <div className="row" style={{gap: 6, flexWrap: "wrap", marginTop: 10}}>
            <span className="muted" style={{fontSize: 11.5, alignSelf: "center"}}>Copy from</span>
            {members.map((a) => (
              <button key={a.id} type="button" className="btn btn-secondary btn-xs" onClick={() => pickMember(a.id)}>
                {a.name}{a.mobile ? "" : " · no mobile"}
              </button>
            ))}
          </div>
        )}

        <div className="form-grid" style={{marginTop: 10}}>
          <FormField label="Name" full>
            <TextInput value={form.headName} onChange={set("headName")} placeholder="e.g. Rajesh M. Shah"/>
          </FormField>
          <FormField label="WhatsApp number" full>
            <div style={{display: "flex", gap: 6}}>
              <div style={{display: "grid", placeItems: "center", padding: "0 10px", borderRadius: 8, border: "1px solid var(--p-line-2)", background: "var(--p-card-tint)", fontSize: 13, fontWeight: 600}}>+91</div>
              <input type="tel" inputMode="numeric" style={{flex: 1}} placeholder="98250 11234"
                value={form.headTen}
                onChange={(e) => set("headTen")(e.target.value.replace(/[^\d\s]/g, "").slice(0, 12))}/>
            </div>
            {headMobileBad && <div style={{fontSize: 11.5, color: "var(--p-danger)", marginTop: 4}}>That isn’t a valid 10-digit Indian mobile number.</div>}
          </FormField>
        </div>

        <div style={{marginTop: 12, background: "var(--p-card-tint)", border: "1px solid var(--p-line-2)", borderRadius: 10, padding: "10px 12px"}}>
          <div className="between" style={{gap: 12}}>
            <div>
              <div style={{fontSize: 13, fontWeight: 650}}>They’ve agreed to WhatsApp updates</div>
              <div className="muted" style={{fontSize: 11.5, lineHeight: 1.5, marginTop: 2}}>
                {canConsent
                  ? "WhatsApp requires the recipient’s consent. Tick this only if they have actually agreed — it is recorded against your account."
                  : "Add a name and a valid mobile number first."}
              </div>
            </div>
            <Toggle checked={form.consent && canConsent} disabled={!canConsent} onChange={(v) => set("consent")(v)} label="Consent to WhatsApp updates"/>
          </div>
          {revokedAt && (
            <div style={{fontSize: 11.5, color: "var(--p-danger)", marginTop: 8, lineHeight: 1.5}}>
              This number replied <b>STOP</b> on {fmtDate(revokedAt.slice(0, 10))}. WhatsApp will keep refusing messages to it
              until they message the ProHippo number again themselves — turning this back on here will not override that.
            </div>
          )}
        </div>
      </div>

      <div className="form-grid" style={{marginTop: 14}}>
        <FormField label="Billing contact (optional)" full><TextInput value={form.contact} onChange={set("contact")} placeholder="Name / phone / email for group billing"/></FormField>
        <FormField label="Notes (optional)" full><TextInput value={form.notes} onChange={set("notes")} placeholder="Anything worth remembering about this group"/></FormField>
      </div>
    </Modal>
  );
}

// Pick assessees to add to a group (moving them out of any current group).
function AddMembersModal({ group, onClose }) {
  const { data, setGroupMembers, notify } = useData();
  const [q, setQ] = React.useState("");
  const [sel, setSel] = React.useState(() => new Set());
  const [busy, setBusy] = React.useState(false);
  const candidates = data.assessees.filter((a) => (a.group || "") !== group.name);
  const ql = q.toLowerCase().trim();
  const shown = candidates.filter((a) => !ql || a.name.toLowerCase().includes(ql) || (a.pan || "").toLowerCase().includes(ql) || (a.group || "").toLowerCase().includes(ql));
  const toggle = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const save = async () => {
    if (sel.size === 0 || busy) return;
    setBusy(true);
    await setGroupMembers([...sel], group.name, group.id);
    setBusy(false);
    notify(`${sel.size} assessee${sel.size === 1 ? "" : "s"} added to ${group.name}`);
    onClose();
  };

  return (
    <Modal
      title={`Add to ${group.name}`}
      sub="Selected assessees move into this group"
      onClose={onClose}
      width={520}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={sel.size === 0 || busy} style={{opacity: sel.size && !busy ? 1 : 0.5}} onClick={save}><Icon name="check" size={14}/>{busy ? "Adding…" : `Add ${sel.size || ""}`}</button>
      </>}
    >
      <div className="search" style={{width: "100%", marginBottom: 10}}>
        <Icon name="search" size={15}/>
        <input placeholder="Search name, PAN, current group…" value={q} onChange={(e) => setQ(e.target.value)}/>
      </div>
      <div className="col" style={{gap: 6, maxHeight: 340, overflowY: "auto"}}>
        {shown.length === 0 && <div className="muted" style={{fontSize: 13, textAlign: "center", padding: 20}}>No assessees to add.</div>}
        {shown.map((a) => (
          <label key={a.id} className="center" style={{gap: 10, justifyContent: "flex-start", padding: "9px 11px", background: sel.has(a.id) ? "var(--p-lavender-2)" : "var(--p-card-tint)", borderRadius: 10, cursor: "pointer"}}>
            <input type="checkbox" checked={sel.has(a.id)} onChange={() => toggle(a.id)}/>
            <Avatar name={a.name} color={a.color} round soft size="sm"/>
            <div style={{flex: 1, minWidth: 0}}>
              <div className="strong" style={{fontSize: 13}}>{titleCase(a.name)}</div>
              <div className="muted" style={{fontSize: 11.5}}>{a.pan}{a.group ? ` · currently in ${a.group}` : ""}</div>
            </div>
          </label>
        ))}
      </div>
    </Modal>
  );
}

// Card for one group in the Groups grid.
function GroupCard({ g, data, onOpen }) {
  const st = groupStats(data, g.members);
  return (
    <div className="card" style={{cursor: "pointer"}} onClick={() => onOpen(g.name)}>
      <div className="center" style={{gap: 12, justifyContent: "flex-start", marginBottom: 12}}>
        <Avatar name={g.name} color={g.color || "violet"} round soft size="lg"/>
        <div style={{minWidth: 0}}>
          <div style={{fontWeight: 800, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{g.name}</div>
          <div className="muted" style={{fontSize: 12}}>{g.members.length} assessee{g.members.length === 1 ? "" : "s"}</div>
        </div>
      </div>
      <div className="row" style={{gap: 6, marginBottom: 12, flexWrap: "wrap"}}>
        {g.members.slice(0, 6).map((m) => <Avatar key={m.id} name={m.name} color={m.color} round soft size="sm"/>)}
        {g.members.length > 6 && <span className="muted" style={{fontSize: 12, alignSelf: "center"}}>+{g.members.length - 6}</span>}
      </div>
      <div className="between" style={{padding: "10px 12px", background: "var(--p-card-tint)", borderRadius: 11}}>
        <div className="center" style={{gap: 14}}>
          <span className="muted" style={{fontSize: 12}}><Icon name="scale" size={12}/> {st.matters}</span>
          <span className="muted" style={{fontSize: 12}}><Icon name="calendar" size={12}/> {st.hearings}</span>
        </div>
        <span style={{fontWeight: 800, fontSize: 13.5, color: g.outstanding > 0 ? "#C13388" : "var(--p-success)"}}>{g.outstanding > 0 ? fmtINR(g.outstanding) : "Settled"}</span>
      </div>
    </div>
  );
}

// Groups grid + "new group". Reconciles legacy string groups into docs on mount.
function GroupsView({ onOpenGroup }) {
  const { data, ensureGroupDocs } = useData();
  const [showNew, setShowNew] = React.useState(false);
  React.useEffect(() => { ensureGroupDocs(); }, [ensureGroupDocs]);
  const groups = groupsOf(data);
  const ungrouped = data.assessees.filter((a) => !(a.group || "").trim()).length;

  return (
    <>
      <div className="between" style={{marginBottom: 12, flexWrap: "wrap", gap: 10}}>
        <div className="muted" style={{fontSize: 12.5}}>{groups.length} group{groups.length === 1 ? "" : "s"}{ungrouped ? ` · ${ungrouped} ungrouped` : ""}</div>
        <button className="btn btn-primary btn-sm" onClick={() => setShowNew(true)}><Icon name="plus" size={13}/>New group</button>
      </div>
      {groups.length === 0 ? (
        <div className="card"><EmptyState icon="group" title="No groups yet" sub="Create a group, or tag assessees with a Group on their profile — they'll be gathered here automatically." action={<button className="btn btn-primary" onClick={() => setShowNew(true)}><Icon name="plus" size={14}/>New group</button>}/></div>
      ) : (
        <div className="grid-cards">
          {groups.map((g) => <GroupCard key={g.name} g={g} data={data} onOpen={onOpenGroup}/>)}
        </div>
      )}
      {showNew && <GroupModal onClose={(name) => { setShowNew(false); if (name) onOpenGroup(name); }}/>}
    </>
  );
}

// Drill-in: manage a single group's metadata, members and ledger.
function GroupDetail({ groupName, onBack, onOpenAssessee, onRename, profile }) {
  const { data, removeGroup, setGroupMembers, notify } = useData();
  const [showEdit, setShowEdit] = React.useState(false);
  const [showAdd, setShowAdd] = React.useState(false);
  const g = groupsOf(data).find((x) => x.name === groupName);

  React.useEffect(() => { if (!g) onBack(); }, [g, onBack]);
  if (!g) return null;

  const st = groupStats(data, g.members);
  const ledger = groupLedger(data, g.name);

  const doDelete = async () => {
    if (!window.confirm(`Delete the group “${g.name}”? Its ${g.members.length} assessee${g.members.length === 1 ? "" : "s"} will be ungrouped (not deleted).`)) return;
    onBack();
    await removeGroup(g.id, g.name);
    notify(`Group “${g.name}” removed`);
  };
  const removeMember = async (a) => {
    await setGroupMembers([a.id], "", "");
    notify(`${titleCase(a.name)} removed from ${g.name}`);
  };
  const downloadLedger = () => downloadLedgerPDF({
    ledger, isGroup: true,
    party: { name: g.name, memberCount: g.members.length, byParty: ledger.byParty },
    profile,
  });

  return (
    <div className="animate-in">
      <div className="center" style={{gap: 8, marginBottom: 16, fontSize: 13}}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}><Icon name="arrow-left" size={14}/>Groups</button>
        <span className="muted">Groups / </span>
        <span style={{fontWeight: 600}}>{g.name}</span>
      </div>

      <div className="card" style={{marginBottom: 18}}>
        <div className="between" style={{flexWrap: "wrap", gap: 12}}>
          <div className="center" style={{gap: 14}}>
            <Avatar name={g.name} color={g.color || "violet"} round soft size="lg"/>
            <div>
              <div style={{fontSize: 20, fontWeight: 800, letterSpacing: "-0.02em"}}>{g.name}</div>
              <div className="muted" style={{fontSize: 12.5, marginTop: 2}}>{g.members.length} assessee{g.members.length === 1 ? "" : "s"}{g.contact ? ` · ${g.contact}` : ""}</div>
            </div>
          </div>
          <div className="center" style={{gap: 8}}>
            <button className="btn btn-secondary btn-sm" onClick={downloadLedger}><Icon name="doc" size={13}/>Group ledger</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setShowEdit(true)}><Icon name="edit" size={13}/>Edit</button>
            <button className="icon-btn" style={{width: 34, height: 34}} title="Delete group" onClick={doDelete}><Icon name="trash" size={15}/></button>
          </div>
        </div>
        <div className="grid-stats" style={{gap: 12, marginTop: 18}}>
          <MiniStat label="Assessees" value={g.members.length} icon="users"/>
          <MiniStat label="Active matters" value={st.matters} icon="scale"/>
          <MiniStat label="Upcoming hearings" value={st.hearings} icon="calendar" accent="pink"/>
          <MiniStat label="Outstanding" value={g.outstanding ? fmtINR(g.outstanding) : "₹0"} icon="wallet" accent={g.outstanding > 100000 ? "warn" : "default"}/>
        </div>
        {g.notes && <div style={{marginTop: 16, padding: "10px 12px", background: "var(--p-card-tint)", borderRadius: 10, fontSize: 12.5, color: "var(--p-text-2)"}}>{g.notes}</div>}
      </div>

      <div className="card" style={{padding: 0, overflow: "hidden"}}>
        <div className="between" style={{padding: "14px 18px", borderBottom: "1px solid var(--p-line-2)", flexWrap: "wrap", gap: 10}}>
          <div className="card-title">Members</div>
          <button className="btn btn-primary btn-sm" onClick={() => setShowAdd(true)}><Icon name="plus" size={13}/>Add member</button>
        </div>
        {g.members.length === 0 ? (
          <EmptyState icon="users" title="No members yet" sub="Add assessees to this group." action={<button className="btn btn-primary" onClick={() => setShowAdd(true)}><Icon name="plus" size={14}/>Add member</button>}/>
        ) : (
          <Table>
            <thead><tr><th>Assessee</th><th>PAN</th><th>Entity</th><th>Outstanding</th><th></th></tr></thead>
            <tbody>
              {g.members.map((a) => {
                const ep = entityPill(a.status);
                const out = assesseeOutstanding(data, a.name);
                return (
                  <tr key={a.id} style={{cursor: "pointer"}} onClick={() => onOpenAssessee(a)}>
                    <td>
                      <div className="center" style={{gap: 10, justifyContent: "flex-start"}}>
                        <Avatar name={a.name} color={a.color} round soft size="sm"/>
                        <span className="strong">{titleCase(a.name)}</span>
                      </div>
                    </td>
                    <td className="strong" style={{fontFamily: "ui-monospace, monospace", fontSize: 12}}>{a.pan}</td>
                    <td><span className="pill" style={{background: ep.bg, color: ep.c, fontWeight: 700}}>{a.status}</span></td>
                    <td><span style={{fontWeight: 700, color: out > 0 ? "#C13388" : "var(--p-success)"}}>{out > 0 ? fmtINR(out) : "—"}</span></td>
                    <td onClick={(e) => e.stopPropagation()} style={{textAlign: "right"}}>
                      <button className="btn btn-ghost btn-xs" title="Remove from group" style={{color: "var(--p-danger)"}} onClick={() => removeMember(a)}><Icon name="x" size={13}/>Remove</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </div>

      {showEdit && <GroupModal initial={{ id: g.id, name: g.name, color: g.color || GROUP_COLORS[0], notes: g.notes, contact: g.contact }} onClose={(newName) => { setShowEdit(false); if (newName && newName !== g.name) onRename(newName); }}/>}
      {showAdd && <AddMembersModal group={g} onClose={() => setShowAdd(false)}/>}
    </div>
  );
}

export function Assessees({ onOpen, initialSearch = "" }) {
  const { data, profile, notify, backfillCommunicationLinks } = useData();
  // Stamp the hard assessee link onto any message or request written before
  // communications were linked by id. Idempotent, so running it on every visit
  // to this page costs one read once everything is already stamped.
  React.useEffect(() => { backfillCommunicationLinks(); }, [backfillCommunicationLinks]);
  const [view, setView] = React.useState("list"); // "list" | "groups"
  const [openGroup, setOpenGroup] = React.useState(null); // group name being viewed
  const [tab, setTab] = React.useState("All");
  const [search, setSearch] = React.useState(initialSearch);
  const [sortBy, setSortBy] = React.useState("recent");
  const [statusFilter, setStatusFilter] = React.useState("all");
  const [groupFilter, setGroupFilter] = React.useState("all");
  const [page, setPage] = React.useState(1);
  const [showAdd, setShowAdd] = React.useState(false);
  const [editAssessee, setEditAssessee] = React.useState(null);
  const [selected, setSelected] = React.useState(() => new Set());
  const [bulk, setBulk] = React.useState(null); // { done, total, current } while a bulk sync runs
  const doneResolver = React.useRef(null);
  const running = React.useRef(false); // true only while a bulk sync is in progress

  React.useEffect(() => { setSearch(initialSearch); }, [initialSearch]);
  React.useEffect(() => { setPage(1); }, [tab, search, sortBy, statusFilter, groupFilter]);

  // While a bulk sync runs, ingest each streamed message and advance the queue
  // when an assessee signals it's done.
  React.useEffect(() => {
    const off = onSyncData(async (payload) => {
      if (!payload || !running.current) return; // only while a bulk sync runs
      if (payload.kind === "sync-done") { const r = doneResolver.current; if (r) r(payload.assesseeId); return; }
      try { await ingestPortalSyncMessage(payload); } catch (e) { console.error("bulk ingest", e); }
    });
    return off;
  }, []);

  const toggle = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const syncableOnPage = () => pageRows.filter((a) => a.portalCredSet).map((a) => a.id);
  const allPageSelected = () => { const ids = syncableOnPage(); return ids.length > 0 && ids.every((id) => selected.has(id)); };
  const toggleAllPage = () => setSelected((s) => {
    const ids = syncableOnPage(); const n = new Set(s);
    if (ids.every((id) => n.has(id))) ids.forEach((id) => n.delete(id)); else ids.forEach((id) => n.add(id));
    return n;
  });

  const runBulkSync = async () => {
    const targets = data.assessees.filter((a) => selected.has(a.id) && a.portalCredSet);
    if (!targets.length) { notify("Select assessees that have a saved portal login.", "alert"); return; }
    if (!(await detectExtension())) { notify("Install the ProHippo Sync extension to sync from the portal.", "alert"); return; }
    running.current = true;
    for (let i = 0; i < targets.length; i++) {
      const a = targets[i];
      setBulk({ done: i, total: targets.length, current: a.name });
      try {
        const { data: cred } = await httpsCallable(functions, "getPortalCredential")({ assesseeId: a.id });
        // Bulk sync uses the fast e-Proceedings-only scope for every assessee.
        const knowns = buildSyncKnowns(data.notices, a.pan, data.matters, data.returns, a.dob);
        const done = new Promise((resolve) => { doneResolver.current = resolve; });
        await openPortalLogin({ portalUserId: cred.portalUserId, portalPassword: cred.portalPassword, assesseeId: a.id, mode: "sync", scope: "eproc", ...knowns, background: true });
        await Promise.race([done, new Promise((r) => setTimeout(r, 120000))]); // done or 2-min safety
        doneResolver.current = null;
        await new Promise((r) => setTimeout(r, BULK_GAP_MS)); // small gap between logins
      } catch (e) {
        console.error("bulk sync", a.name, e);
        notify(`Couldn't sync ${a.name}${e?.message ? " — " + e.message.slice(0, 80) : ""}`, "alert");
      }
    }
    running.current = false;
    setBulk(null);
    setSelected(new Set());
    notify(`Bulk sync complete — ${targets.length} assessee${targets.length > 1 ? "s" : ""}`);
  };

  // Active = has an open matter. Computed up-front so the KPI tiles and the
  // Status filter share one definition.
  const activeMattersAll = data.matters.filter(m => !["Closed", "Decided"].includes(m.status));
  const activePans = new Set(activeMattersAll.map(m => (m.pan || "").toUpperCase()).filter(Boolean));
  const isActive = (a) => activePans.has((a.pan || "").toUpperCase());

  const matchesTab = (a) => {
    if (tab === "All") return true;
    if (tab === "Firm/LLP") return a.status === "Firm" || a.status === "LLP";
    return a.status === tab;
  };
  const q = search.toLowerCase();
  const matchesGroup = (a) => groupFilter === "all" || (groupFilter === "__none" ? !(a.group || "").trim() : (a.group || "") === groupFilter);
  const filtered = data.assessees.filter(a =>
    matchesTab(a) &&
    matchesGroup(a) &&
    (statusFilter === "all" || (statusFilter === "active" ? isActive(a) : !isActive(a))) &&
    (!q || a.name.toLowerCase().includes(q) || a.pan.toLowerCase().includes(q) || (a.group || "").toLowerCase().includes(q) || (a.mobile || "").includes(q))
  );
  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "name") return (a.name || "").localeCompare(b.name || "");
    if (sortBy === "pan") return (a.pan || "").localeCompare(b.pan || "");
    if (sortBy === "proceedings") return assesseeStats(data, b).matters - assesseeStats(data, a).matters;
    return (b.createdAt || "").localeCompare(a.createdAt || ""); // recent (default)
  });
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageRows = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const tabCount = (t) => data.assessees.filter(a => (t === "All" ? true : t === "Firm/LLP" ? a.status === "Firm" || a.status === "LLP" : a.status === t)).length;

  return (
    <div className="animate-in">
      <div className="topbar">
        <div>
          <div className="page-title">Assessees</div>
          <div className="page-sub">Manage assessee records and related proceedings</div>
        </div>
        <div className="topbar-actions">
          <div className="search" style={{width: 300}}>
            <Icon name="search" size={15}/>
            <input placeholder="Search by name, PAN, email or mobile…" value={search} onChange={e => setSearch(e.target.value)}/>
          </div>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}><Icon name="plus" size={14}/>Add Assessee</button>
        </div>
      </div>

      {data.assessees.length > 0 && (
        <div className="row" style={{gap: 6, marginBottom: 16, flexWrap: "wrap"}}>
          {[{ k: "list", label: "All assessees", icon: "users" }, { k: "groups", label: "Groups", icon: "group", n: groupsOf(data).length }].map(v => (
            <button key={v.k} className={`fchip ${view === v.k ? "active" : ""}`} style={{display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px"}} onClick={() => { setView(v.k); setOpenGroup(null); }}>
              <Icon name={v.icon} size={13}/>{v.label}{v.n ? ` · ${v.n}` : ""}
            </button>
          ))}
        </div>
      )}

      {data.assessees.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="users"
            title="No assessees yet"
            sub="Add your first assessee to start tracking matters, hearings, notices and fees."
            action={<button className="btn btn-primary" onClick={() => setShowAdd(true)}><Icon name="plus" size={14}/>Add assessee</button>}
          />
        </div>
      ) : view === "groups" ? (
        openGroup
          ? <GroupDetail groupName={openGroup} onBack={() => setOpenGroup(null)} onOpenAssessee={onOpen} onRename={setOpenGroup} profile={profile}/>
          : <GroupsView onOpenGroup={setOpenGroup}/>
      ) : (
        <>
          <div className="tabs" style={{marginBottom: 14}}>
            {["All", "Individual", "Company", "Firm/LLP", "HUF", "Trust"].map(t => (
              <div key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
                {t}
                <span style={{marginLeft: 6, opacity: 0.65, fontSize: 11}}>{tabCount(t)}</span>
              </div>
            ))}
          </div>
          {(selected.size > 0 || bulk) && (
            <div className="card" style={{marginBottom: 12, padding: "12px 16px", background: "var(--p-card-tint)", border: "1px solid var(--p-primary-3)"}}>
              <div className="between" style={{alignItems: "center", flexWrap: "wrap", gap: 10}}>
                <div className="center" style={{gap: 10}}>
                  <Icon name="sparkle" size={15}/>
                  <span className="strong" style={{fontSize: 13.5}}>
                    {bulk
                      ? `Syncing ${bulk.done + 1} of ${bulk.total}${bulk.current ? ` — ${bulk.current}` : ""}…`
                      : `${selected.size} selected`}
                  </span>
                  {bulk && <span className="muted" style={{fontSize: 11.5}}>· running in the background, keep working</span>}
                </div>
                <div className="center" style={{gap: 8}}>
                  {!bulk && <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Clear</button>}
                  <button className="btn btn-primary btn-sm" disabled={Boolean(bulk)} onClick={runBulkSync}>
                    <Icon name="sparkle" size={13}/>{bulk ? "Syncing…" : `Sync ${selected.size} from portal`}
                  </button>
                </div>
              </div>
              {!bulk && <div className="muted" style={{fontSize: 11.5, marginTop: 6}}>Only assessees with a saved portal login can be synced. Each opens, syncs and closes in turn.</div>}
            </div>
          )}
          <div className="between" style={{marginBottom: 12, flexWrap: "wrap", gap: 10, alignItems: "center"}}>
            <div className="muted" style={{fontSize: 12.5}}>{sorted.length} assessee{sorted.length === 1 ? "" : "s"}{statusFilter !== "all" ? ` · ${statusFilter}` : ""}</div>
            <div className="center" style={{gap: 10, flexWrap: "wrap"}}>
              <label className="center" style={{gap: 6, fontSize: 12.5}}>
                <span className="muted center" style={{gap: 5}}><Icon name="group" size={13}/>Group</span>
                <select className="ph-select" value={groupFilter} onChange={e => setGroupFilter(e.target.value)}>
                  <option value="all">All</option>
                  <option value="__none">Ungrouped</option>
                  {groupsOf(data).map(g => <option key={g.name} value={g.name}>{g.name}</option>)}
                </select>
              </label>
              <label className="center" style={{gap: 6, fontSize: 12.5}}>
                <span className="muted center" style={{gap: 5}}><Icon name="filter" size={13}/>Status</span>
                <select className="ph-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                  <option value="all">All</option>
                  <option value="active">Active</option>
                  <option value="pending">Pending</option>
                </select>
              </label>
              <label className="center" style={{gap: 6, fontSize: 12.5}}>
                <span className="muted">Sort by</span>
                <select className="ph-select" value={sortBy} onChange={e => setSortBy(e.target.value)}>
                  <option value="recent">Recently added</option>
                  <option value="name">Name (A–Z)</option>
                  <option value="proceedings">Most proceedings</option>
                  <option value="pan">PAN</option>
                </select>
              </label>
            </div>
          </div>
          <div className="card" style={{padding: 0, overflow: "hidden"}}>
            <div style={{overflowX: "auto"}}>
              <div style={{minWidth: 820}}>
                <div style={{display: "grid", gridTemplateColumns: ASS_GRID, gap: 12, alignItems: "center", padding: "12px 18px", borderBottom: "1px solid var(--p-line-2)", fontSize: 10.5, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--p-text-3)"}}>
                  <span><input type="checkbox" checked={allPageSelected()} onChange={toggleAllPage} title="Select all on this page with a portal login"/></span>
                  <span>Assessee</span>
                  <span>PAN</span>
                  <span>Entity type</span>
                  <span>Proceedings</span>
                  <span>Assigned to</span>
                  <span>Status</span>
                  <span style={{textAlign: "right"}}>Actions</span>
                </div>
                {pageRows.map(a => {
                  const s = assesseeStats(data, a);
                  const ep = entityPill(a.status);
                  const active = isActive(a);
                  return (
                    <div key={a.id} className="ass-row" onClick={() => onOpen(a)}
                      style={{display: "grid", gridTemplateColumns: ASS_GRID, gap: 12, alignItems: "center", padding: "12px 18px", borderBottom: "1px solid var(--p-line-2)", cursor: "pointer"}}>
                      <span onClick={(e) => e.stopPropagation()}>
                        {a.portalCredSet
                          ? <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggle(a.id)} title="Select for portal sync"/>
                          : <span className="muted" title="No portal login saved" style={{fontSize: 11}}>—</span>}
                      </span>
                      <div className="center" style={{gap: 10, minWidth: 0, justifyContent: "flex-start"}}>
                        <Avatar name={a.name} color={a.color} round soft/>
                        <div style={{minWidth: 0}}>
                          <div className="strong" style={{fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{titleCase(a.name)}</div>
                          <div className="muted" style={{fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{a.group || a.email || "—"}</div>
                        </div>
                      </div>
                      <span className="strong" style={{fontFamily: "ui-monospace, monospace", fontSize: 12}}>{a.pan}</span>
                      <span><span className="pill" style={{background: ep.bg, color: ep.c, fontWeight: 700}}>{a.status}</span></span>
                      <span>
                        <span className="pill pill-muted" style={{fontSize: 11}} title={`${s.matters} active matter${s.matters === 1 ? "" : "s"}`}>{s.matters}</span>
                      </span>
                      <span>
                        {a.staff
                          ? <span className="center" style={{gap: 6, justifyContent: "flex-start"}}><Avatar name={a.staff} color="mint" size="sm"/><span style={{fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{a.staff.split(" ")[0]}</span></span>
                          : <span className="muted">—</span>}
                      </span>
                      <span>
                        <span className="center" style={{gap: 6, justifyContent: "flex-start"}}>
                          <span style={{width: 7, height: 7, borderRadius: "50%", background: active ? "var(--p-success)" : "#E0A43B", flexShrink: 0}}/>
                          <span style={{fontSize: 12}}>{active ? "Active" : "Pending"}</span>
                        </span>
                      </span>
                      <span onClick={(e) => e.stopPropagation()} className="center" style={{gap: 2, justifyContent: "flex-end"}}>
                        <button className="icon-btn" style={{width: 30, height: 30, borderRadius: 8}} title="Edit" onClick={() => setEditAssessee(a)}><Icon name="edit" size={15}/></button>
                      </span>
                    </div>
                  );
                })}
                {pageRows.length === 0 && (
                  <div style={{textAlign: "center", padding: 40, color: "var(--p-text-3)"}}>No assessees match this filter.</div>
                )}
              </div>
            </div>
          </div>

          <div className="between" style={{marginTop: 14}}>
            <div className="muted" style={{fontSize: 12.5}}>
              Showing {filtered.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length}
            </div>
            {pages > 1 && (
              <div className="center" style={{gap: 4}}>
                <button className="btn btn-secondary btn-sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}><Icon name="chevron-left" size={14}/></button>
                {Array.from({ length: pages }, (_, i) => i + 1).map(p => (
                  <button key={p} className={`btn ${p === page ? "btn-primary" : "btn-secondary"} btn-sm`} style={{minWidth: 32, justifyContent: "center"}} onClick={() => setPage(p)}>{p}</button>
                ))}
                <button className="btn btn-secondary btn-sm" disabled={page === pages} onClick={() => setPage(p => p + 1)}><Icon name="chevron-right" size={14}/></button>
              </div>
            )}
          </div>
        </>
      )}

      {showAdd && <AssesseeModal onClose={() => setShowAdd(false)}/>}
      {editAssessee && <AssesseeModal initial={editAssessee} onClose={() => setEditAssessee(null)}/>}
    </div>
  );
}

export function AssesseeProfile({ assessee, onBack, onNav, initialTab, initialMatterId }) {
  const { data, removeAssessee, updateAssessee, notify } = useData();
  const [tab, setTab] = React.useState(initialTab || "Overview");
  const [showEdit, setShowEdit] = React.useState(false);
  const [showMatter, setShowMatter] = React.useState(false);
  const [closedProceedings, setClosedProceedings] = React.useState([]); // popup after a sync
  const [focusReqId, setFocusReqId] = React.useState(null); // proceeding to expand in Matters
  const [compose, setCompose] = React.useState(null); // { request } | { seed } for the doc-request composer
  const [adjourning, setAdjourning] = React.useState(null); // hearing being moved to a new date
  const a = assessee;
  const s = assesseeStats(data, a);
  const hearings = upcomingHearings(data).filter(h => h.pan === a.pan);
  const allHearings = data.hearings.filter(h => h.pan === a.pan).sort((x, y) => y.date.localeCompare(x.date));
  const notices = data.notices.filter(n => n.pan === a.pan);
  const returns = (data.returns || []).filter(r => r.pan === a.pan);
  const matters = data.matters.filter(m => m.pan === a.pan);
  const invoices = data.invoices.filter(i => i.assessee === a.name);
  const comms = commsOf(data, a);
  const requests = docRequestsOf(data, a).sort((x, y) => (y.updatedAt || y.createdAt || "").localeCompare(x.updatedAt || x.createdAt || ""));

  const fy = fyOf(todayISO());
  const billedFY = invoices.filter(i => fyOf(i.date) === fy).reduce((sum, i) => sum + i.amount, 0);
  const receivedFY = invoices.filter(i => fyOf(i.date) === fy).reduce((sum, i) => sum + (i.received || 0), 0);

  const waLink = a.mobile ? `https://wa.me/${a.mobile.replace(/\D/g, "")}` : null;

  /* ---- Returns tab: portal fetches + the Computation generator -------------
     These live here rather than in PortalCard because PortalCard only exists on
     the Overview tab: a returns sync started from the Returns tab would stream
     its data into an unmounted listener and quietly vanish. AssesseeDetail stays
     mounted whichever tab is open. */
  const [returnsBusy, setReturnsBusy] = React.useState(null); // the AY being worked on, or "sync"

  React.useEffect(() => {
    const off = onSyncData(async (payload) => {
      if (!payload || payload.assesseeId !== a.id) return;
      if (payload.kind !== "return" && payload.kind !== "returnForm") return;
      try {
        const res = await ingestPortalSyncMessage(payload);
        /* Say it at the moment it is found.
         *
         * The dashboard card is the standing record, but a practitioner who
         * kicked off a sync and is watching THIS screen should not have to
         * navigate away to learn that CPC has just raised a demand on the year
         * that came in. Only the red case interrupts: an extra refund and an
         * agreed return are both good news that can wait for the card.
         *
         * The wording names no baseline on purpose. A year can carry both an
         * intimation judged against the return and a rectification judged
         * against that intimation, and the total spans both — "more payable
         * after CPC's processing" is true of either, where "more than the
         * return claimed" would not be. The per-order line on the table below
         * says which is which. */
        const v = res?.data?.variances;
        if (v && v.red > 0) {
          notify(
            `A.Y. ${payload.return?.ay || ""} — ${fmtINR(v.additionalDemand)} more payable after CPC's processing`.trim(),
            "alert"
          );
        }
      } catch (e) {
        console.error("return ingest failed", e);
        notify("Couldn't save a return from the portal.", "alert");
      } finally {
        if (payload.kind === "returnForm") setReturnsBusy(null);
      }
    });
    return off;
  }, [a.id, notify]);

  // Open the portal with a narrow scope. `formRequest` is only read by the
  // "returnForm" scope, which fetches exactly one year's ITR form PDF.
  const runReturnsFetch = async (scope, formRequest, busyKey) => {
    if (!a.portalCredSet) { notify("Add this assessee's portal login first.", "alert"); return; }
    if (!(await detectExtension())) { notify("Install the ProHippo Sync extension to fetch from the portal.", "alert"); return; }
    setReturnsBusy(busyKey);
    try {
      const { data: cred } = await httpsCallable(functions, "getPortalCredential")({ assesseeId: a.id });
      const knowns = buildSyncKnowns(data.notices, a.pan, data.matters, data.returns, a.dob);
      await openPortalLogin({
        portalUserId: cred.portalUserId, portalPassword: cred.portalPassword,
        assesseeId: a.id, mode: "sync", scope, formRequest, ...knowns,
      });
      notify(scope === "returnForm" ? "Fetching the ITR form — watch the new tab…" : "Fetching returns — watch the new tab…");
    } catch (e) {
      console.error(e);
      notify(e?.message?.slice(0, 120) || "Couldn't reach the portal.", "alert");
      setReturnsBusy(null);
    }
    // The "returns" scope has no single completion signal to wait on — each year
    // streams in on its own and the table updates live — so the button is
    // released as soon as the portal tab is on its way.
    if (scope !== "returnForm") setTimeout(() => setReturnsBusy(null), 2000);
  };

  /* Computation of Total Income for one assessment year.
     The mapping and the HTML are built here, in the browser, from the ITR JSON
     we already hold — deterministic, no AI, no guesswork (docs/computation-spec.md
     §1). Only the HTML→PDF step is a server call, because a faithful render of
     the house design needs a real browser engine. */
  const generateComputationFor = async (r) => {
    if (!r.jsonPath) { notify("The ITR JSON for this year hasn't been synced yet.", "alert"); return; }
    setReturnsBusy(r.ay);
    try {
      // Read the return we already hold. A browser refuses a cross-origin read
      // of a Storage object unless the bucket's CORS policy allows this origin,
      // and it reports that refusal as a bare "Failed to fetch" with no
      // explanation — so name the cause here rather than passing the browser's
      // word along. storage.cors.json in the repo root is the fix.
      let itrJson;
      try {
        const url = await getDownloadURL(storageRef(storage, r.jsonPath));
        const res = await fetch(url);
        if (!res.ok) throw new Error(`the portal document could not be read (HTTP ${res.status})`);
        itrJson = await res.json();
      } catch (err) {
        if (err instanceof TypeError) {
          throw new Error(
            "Couldn't read the filed return from storage. The storage bucket is not allowing this site to read files — " +
            "apply storage.cors.json (see docs/PORTAL_SYNC_SETUP.md) and try again."
          );
        }
        throw err;
      }

      const { buildComputation, UnsupportedFormError } = await import("./computation/index.js");

      let built;
      try {
        built = buildComputation(itrJson, { assessee: a, profile: data.profile });
      } catch (err) {
        if (err instanceof UnsupportedFormError) { notify(err.message, "alert"); return; }
        throw err;
      }

      const { data: res } = await httpsCallable(functions, "renderComputationPdf")({
        assesseeId: a.id, ay: r.ay, html: built.html,
      });
      if (!res?.storagePath) throw new Error("The renderer returned no document.");
      await downloadDoc(res.storagePath, returnDocFilename("computation", r, a.name));

      // §8: a computation that couldn't account for every figure in the return
      // still generates — the PDF says so itself — but the practitioner is told
      // here too, because this is the screen they are looking at.
      if (built.doc.unmapped.length) {
        notify(`Computation ready — ${built.doc.unmapped.length} figure(s) need review, listed in the PDF.`, "alert");
      } else {
        notify(`Computation of Income ready for A.Y. ${r.ay}.`);
      }
    } catch (e) {
      // The renderer's own messages say which stage failed and what to do; they
      // are worth showing whole rather than clipped to a toast-sized fragment.
      console.error("computation", e);
      notify(e?.message?.slice(0, 300) || "Couldn't generate the computation.", "alert");
    } finally {
      setReturnsBusy(null);
    }
  };

  const doDelete = async () => {
    if (!window.confirm(`Delete ${titleCase(a.name)}? Their matters, hearings, notices, invoices and messages will also be removed. This cannot be undone.`)) return;
    onBack();
    const removed = await removeAssessee(a);
    if (removed !== null) {
      notify(removed > 0
        ? `${titleCase(a.name)} deleted along with ${removed} linked record${removed > 1 ? "s" : ""}`
        : `${titleCase(a.name)} deleted`);
    }
  };

  return (
    <div className="animate-in">
      <div className="center" style={{gap: 8, marginBottom: 16, fontSize: 13}}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}><Icon name="arrow-left" size={14}/>Back</button>
        <span className="muted">Assessees / </span>
        <span style={{fontWeight: 600}}>{titleCase(a.name)}</span>
      </div>

      <div className="card" style={{position: "relative", overflow: "hidden", border: "none", background: "linear-gradient(120deg, #2B2270 0%, #5146C6 55%, #8E7CFF 100%)", color: "white", boxShadow: "0 18px 42px -20px rgba(43, 34, 112, 0.6)"}}>
        <div style={{position: "absolute", right: -50, top: -50, width: 240, height: 240, borderRadius: "50%", background: "rgba(255,180,220,0.22)", filter: "blur(24px)", pointerEvents: "none"}}/>
        <div className="between assessee-hero" style={{alignItems: "flex-start", position: "relative"}}>
          <div className="center assessee-id" style={{gap: 16}}>
            <Avatar name={a.name} color={a.color} size="lg" round soft/>
            <div>
              <div className="center" style={{gap: 8}}>
                <div style={{fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em"}}>{titleCase(a.name)}</div>
                <span className="pill" style={{background: "rgba(255,255,255,0.18)", color: "white", fontWeight: 700}}>{a.status}</span>
                {a.group && <span className="pill" style={{background: "rgba(255,255,255,0.18)", color: "white", fontWeight: 700}}>{a.group}</span>}
              </div>
              <div className="row assessee-contact" style={{gap: 18, marginTop: 8, fontSize: 13, color: "rgba(255,255,255,0.82)"}}>
                <span><b style={{fontFamily: "ui-monospace, monospace"}}>{a.pan}</b></span>
                {a.mobile && <span><Icon name="phone" size={12}/> {a.mobile}</span>}
                {a.email && <span><Icon name="mail" size={12}/> {a.email}</span>}
              </div>
            </div>
          </div>
          <div className="center assessee-actions" style={{gap: 8}}>
            {waLink && <a className="btn btn-sm" style={{background: "rgba(255,255,255,0.16)", color: "white", border: "1px solid rgba(255,255,255,0.28)"}} href={waLink} target="_blank" rel="noreferrer"><Icon name="whatsapp" size={14}/>WhatsApp</a>}
            {a.email && <a className="btn btn-sm" style={{background: "rgba(255,255,255,0.16)", color: "white", border: "1px solid rgba(255,255,255,0.28)"}} href={`mailto:${a.email}`}><Icon name="mail" size={14}/>Email</a>}
            <button className="btn btn-sm" style={{background: "white", color: "var(--p-primary-2)", fontWeight: 700}} onClick={() => setShowMatter(true)}><Icon name="plus" size={14}/>New matter</button>
            <button className="btn btn-sm" style={{background: "rgba(255,255,255,0.16)", color: "white", border: "1px solid rgba(255,255,255,0.28)"}} onClick={() => setShowEdit(true)}><Icon name="edit" size={14}/>Edit</button>
            <button className="icon-btn" style={{width: 36, height: 36, color: "white", background: "rgba(255,255,255,0.14)"}} onClick={doDelete} title="Delete assessee"><Icon name="trash" size={15}/></button>
          </div>
        </div>
        <div className="grid-stats" style={{gap: 12, marginTop: 20, position: "relative"}}>
          <MiniStat label="Active matters" value={s.matters} icon="scale"/>
          <MiniStat label="Upcoming hearings" value={hearings.length} icon="calendar" accent="pink"/>
          <MiniStat label="Outstanding" value={s.outstanding ? fmtINR(s.outstanding) : "—"} icon="wallet" accent={s.outstanding > 100000 ? "warn" : "default"}/>
          <MiniStat label="Notices on file" value={notices.length} icon="doc"/>
        </div>
      </div>

      <div className="utabs" style={{marginTop: 22}}>
        {["Overview","Returns","Matters","Hearings","Notices","Invoices","Communications","Notes"].map(t => (
          <div key={t} className={`utab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{t}</div>
        ))}
      </div>

      {tab === "Overview" && (
        <div className="grid-main">
          <div className="col" style={{gap: 18}}>
            <div className="card">
              <div className="card-head">
                <div className="card-title">Recent activity</div>
              </div>
              <Timeline data={data} assessee={a}/>
            </div>
            <div className="card">
              <div className="card-head">
                <div className="card-title">Upcoming hearings</div>
                <button className="btn btn-ghost btn-sm" onClick={() => onNav("hearings")}>View all</button>
              </div>
              <div className="col" style={{gap: 10}}>
                {hearings.length === 0 && <div className="muted" style={{fontSize: 13, padding: 8}}>No upcoming hearings.</div>}
                {hearings.map(h => {
                  const d = daysFromNow(h.date);
                  return (
                    <div key={h.id} className="hearing-card">
                      <div className={`hearing-date ${d <= 1 ? "urgent" : d <= 4 ? "warning" : ""}`}>
                        <div className="d">{new Date(h.date).getDate()}</div>
                        <div className="m">{new Date(h.date).toLocaleString("en-IN",{month:"short"})}</div>
                      </div>
                      <div style={{flex: 1}}>
                        <div className="between">
                          <div style={{fontWeight: 700}}>{h.authority} — {h.bench}</div>
                          <span className="pill pill-primary">AY {h.ay}</span>
                        </div>
                        <div className="muted" style={{fontSize: 12, marginTop: 3}}>
                          {h.ita || (h.section ? `u/s ${h.section}` : "")} · {h.mode} · <Icon name="clock" size={11}/>{h.time}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="col" style={{gap: 18}}>
            <PortalCard a={a} onAddLogin={() => setShowEdit(true)} onClosedProceedings={(list) => setClosedProceedings(list)}/>
            <div className="card">
              <div className="card-title mb-3">Particulars</div>
              <KV label="PAN" value={a.pan} mono/>
              <KV label="Status" value={a.status}/>
              <KV label="Group" value={a.group || "—"}/>
              <KV label="Mobile" value={a.mobile || "—"}/>
              <KV label="Email" value={a.email || "—"}/>
              <KV label="Address" value={a.address || "—"}/>
              <KV label="Assigned staff" value={a.staff || "—"}/>
              {a.jurisdiction && (a.jurisdiction.ward || a.jurisdiction.aoEmail || a.jurisdiction.building) && (() => {
                const j = a.jurisdiction;
                const aoAddr = [j.building, j.area].filter(Boolean).join(", ");
                return (
                  <>
                    <div className="muted" style={{fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", marginTop: 14, marginBottom: 2}}>Jurisdictional AO</div>
                    {j.ward && <KV label="AO / Ward" value={j.ward}/>}
                    {j.aoEmail && <KV label="AO email" value={<a href={`mailto:${j.aoEmail}`} style={{color: "var(--p-primary)", wordBreak: "break-all"}}>{j.aoEmail}</a>}/>}
                    {aoAddr && <KV label="AO address" value={aoAddr}/>}
                  </>
                );
              })()}
            </div>
            <div className="card">
              <div className="card-title mb-3">Ledger snapshot · FY {fy}</div>
              <div className="row" style={{gap: 16}}>
                <MiniStat label="Billed" value={billedFY ? fmtLakhs(billedFY) : "—"} icon="invoice"/>
                <MiniStat label="Received" value={receivedFY ? fmtLakhs(receivedFY) : "—"} icon="wallet" accent="success"/>
              </div>
              <div className="mt-4" style={{borderTop: "1px dashed var(--p-line)", paddingTop: 14}}>
                <div className="between">
                  <div className="muted" style={{fontSize: 12}}>Outstanding</div>
                  <div style={{fontWeight: 800, fontSize: 18, color: s.outstanding ? "#C13388" : "var(--p-success)"}}>{s.outstanding ? fmtINR(s.outstanding) : "₹0"}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === "Returns" && (
        <ReturnsView
          returns={returns}
          assessee={a}
          busyKey={returnsBusy}
          onSync={() => runReturnsFetch("returns", null, "sync")}
          onFetchForm={(r) => runReturnsFetch("returnForm", { ackNum: r.ackNum, ay: r.ay }, r.ay)}
          onGenerateComputation={(r) => generateComputationFor(r)}
        />
      )}

      {tab === "Matters" && (
        <MattersView matters={matters} notices={notices} hearings={allHearings} assesseeName={titleCase(a.name)} notify={notify} focusReqId={focusReqId} openMatterId={initialMatterId}/>
      )}

      {tab === "Hearings" && (
        <div className="card" style={{padding: 0}}>
          <Table>
            <thead><tr><th>Date / Time</th><th>Authority</th><th>Bench</th><th>AY</th><th>Mode</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {allHearings.map(h => (
                <tr key={h.id}>
                  <td><div className="strong">{fmtDateLong(h.date)}</div><div className="muted">{h.time}</div></td>
                  <td><span className="pill pill-primary">{h.authority}</span></td>
                  <td className="semi">{h.bench}</td>
                  <td>{h.ay}</td>
                  <td>{h.mode}</td>
                  <td><StatusPill status={h.date < todayISO() ? "Completed" : h.status}/></td>
                  {/* Where a practitioner already is when the news reaches them:
                      the client's own file, open on the date that just moved. */}
                  <td>
                    {h.status !== "Adjourned" && (
                      <button className="btn btn-ghost btn-xs" title="Adjourn to another date" onClick={() => setAdjourning(h)}>
                        <Icon name="clock" size={12}/>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {allHearings.length === 0 && <tr><td colSpan="7" style={{textAlign: "center", padding: 40, color: "var(--p-text-3)"}}>No hearings for {titleCase(a.name)} yet.</td></tr>}
            </tbody>
          </Table>
        </div>
      )}

      {tab === "Notices" && (
        <div className="card" style={{padding: 0}}>
          <Table>
            <thead><tr><th>DIN</th><th>AY</th><th>Section</th><th>Authority</th><th>Date</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {notices.map(n => (
                <React.Fragment key={n.id}>
                  <tr style={(n.responses || []).length > 0 ? {borderBottom: "none"} : undefined}>
                    <td className="muted" style={{fontFamily: "ui-monospace, monospace", fontSize: 11.5}}>
                      <div className="center" style={{gap: 6, justifyContent: "flex-start"}}>
                        <span>{n.din || "—"}</span>
                        {/* One button where the notice is one PDF; every file
                            listed where the portal served a set or a ZIP. */}
                        {n.storagePath && !hasDocumentList(n) && (
                          <button className="btn btn-ghost btn-xs" title="Download notice / order PDF" onClick={() => downloadDoc(n.storagePath, noticeFilename(n, a.name))}>
                            <Icon name="doc" size={11}/>PDF
                          </button>
                        )}
                        <NoticeDocuments notice={n} assesseeName={a.name} compact/>
                      </div>
                    </td>
                    <td>{n.ay}</td>
                    <td>{n.section ? <span className="pill pill-muted">u/s {n.section}</span> : "—"}</td>
                    <td>{n.authority}</td>
                    <td className="muted">{n.date ? fmtDateLong(n.date) : "—"}</td>
                    <td><StatusPill status={n.status}/></td>
                    <td>{!n.isOrder && <div className="center" style={{justifyContent: "flex-end"}}><AskDocsButton notice={n}/></div>}</td>
                  </tr>
                  {(n.responses || []).length > 0 && (
                    <tr>
                      <td></td>
                      <td colSpan="6" style={{paddingTop: 0}}><ResponsesBlock notice={n} responses={n.responses} plain/></td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
              {notices.length === 0 && <tr><td colSpan="7" style={{textAlign: "center", padding: 40, color: "var(--p-text-3)"}}>No notices for {titleCase(a.name)} yet.</td></tr>}
            </tbody>
          </Table>
        </div>
      )}

      {tab === "Invoices" && (
        <div className="card" style={{padding: 0}}>
          <Table>
            <thead><tr><th>Invoice #</th><th>Date</th><th>Service</th><th>AY</th><th>Amount</th><th>Balance</th><th>Status</th></tr></thead>
            <tbody>
              {invoices.map(inv => (
                <tr key={inv.id}>
                  <td className="strong" style={{fontFamily: "ui-monospace, monospace", fontSize: 12.5}}>{inv.number}</td>
                  <td className="muted">{fmtDateLong(inv.date)}</td>
                  <td>{inv.service}</td>
                  <td>{inv.ay}</td>
                  <td className="strong">{fmtINR(inv.amount)}</td>
                  <td>{invoiceOutstanding(inv) ? fmtINR(invoiceOutstanding(inv)) : "—"}</td>
                  <td><StatusPill status={invoiceStatus(inv)}/></td>
                </tr>
              ))}
              {invoices.length === 0 && <tr><td colSpan="7" style={{textAlign: "center", padding: 40, color: "var(--p-text-3)"}}>No invoices yet.</td></tr>}
            </tbody>
          </Table>
        </div>
      )}

      {tab === "Communications" && (
        <div className="col" style={{gap: 18}}>
          <div className="card" style={{padding: 0}}>
            <div className="between" style={{padding: "14px 18px", borderBottom: "1px solid var(--p-line-2)"}}>
              <div>
                <div className="card-title" style={{fontSize: 15}}>Document requests</div>
                <div className="card-sub">What has been asked for, and what is still outstanding</div>
              </div>
              <button className="btn btn-primary btn-sm" onClick={() => setCompose({ seed: { assesseeId: a.id, assessee: a.name, pan: a.pan, channels: ["email", "whatsapp"] } })}>
                <Icon name="plus" size={13}/>New request
              </button>
            </div>
            {requests.length === 0 ? (
              <EmptyState icon="doc" title="No document requests yet" sub={`Ask ${titleCase(a.name)} for the papers a notice calls for, and track what comes back.`}/>
            ) : (
              <div className="col">
                {requests.map(r => {
                  const p = docRequestProgress(r);
                  return (
                    <div key={r.id} className="row row-link" onClick={() => setCompose({ request: r })} style={{padding: "13px 18px", borderBottom: "1px solid var(--p-line-2)", gap: 12, cursor: "pointer", alignItems: "center"}}>
                      <Icon name="doc" size={16}/>
                      <div style={{flex: 1, minWidth: 0}}>
                        <div className="strong" style={{fontSize: 13}}>{r.title || "Document request"}</div>
                        <div className="muted" style={{fontSize: 11.5, marginTop: 2}}>
                          {p.total} item{p.total === 1 ? "" : "s"}{r.sentAt ? ` · ${p.received} received, ${p.pending} pending` : " · not sent yet"}
                          {r.dueDate ? ` · due ${fmtDateLong(r.dueDate)}` : ""}
                        </div>
                      </div>
                      <RequestStatusPill status={derivedRequestStatus(r)}/>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="card" style={{padding: 0}}>
            <div style={{padding: "14px 18px", borderBottom: "1px solid var(--p-line-2)"}}>
              <div className="card-title" style={{fontSize: 15}}>Message log</div>
              <div className="card-sub">Every email and WhatsApp hand-off, with its delivery status</div>
            </div>
            {comms.length === 0 && <EmptyState icon="chat" title="No messages logged" sub={`Messages sent to ${titleCase(a.name)} will appear here.`}/>}
            <div className="col">
              {comms.map(c => (
                <div key={c.id} className="row" style={{padding: "14px 18px", borderBottom: "1px solid var(--p-line-2)", gap: 12}}>
                  <Icon name={c.channel === "WhatsApp" ? "whatsapp" : "mail"} size={16}/>
                  <div style={{flex: 1, minWidth: 0}}>
                    <div className="strong" style={{fontSize: 13}}>{c.subject}</div>
                    <div className="muted" style={{fontSize: 11.5, marginTop: 2}}>{c.channel} · {new Date(c.time).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</div>
                  </div>
                  <StatusPill status={c.status}/>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === "Notes" && <NotesCard assessee={a} onSave={(notes) => { updateAssessee(a.id, { notes }); notify("Notes saved"); }}/>}

      {showEdit && <AssesseeModal initial={a} onClose={() => setShowEdit(false)}/>}
      {showMatter && <MatterModal initial={{ assessee: a.name, pan: a.pan, staff: a.staff }} onClose={() => setShowMatter(false)}/>}
      {adjourning && <AdjournModal hearing={adjourning} onClose={() => setAdjourning(null)}/>}
      {compose && (
        <DocumentRequestComposer
          key={compose.request?.id || "new"}
          request={compose.request}
          seed={compose.seed}
          onClose={() => setCompose(null)}
        />
      )}
      {closedProceedings.length > 0 && (
        <ClosedProceedingsModal
          items={closedProceedings}
          onClose={() => setClosedProceedings([])}
          onOpen={(reqId) => { setClosedProceedings([]); setTab("Matters"); setFocusReqId(reqId); }}
        />
      )}
    </div>
  );
}

/* Popup shown when a sync moves one or more proceedings to Closed. */
function ClosedProceedingsModal({ items, onClose, onOpen }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{maxWidth: 460, padding: "22px 26px"}} onClick={(e) => e.stopPropagation()}>
        <div className="center" style={{gap: 12, alignItems: "flex-start", marginBottom: 6}}>
          <div style={{width: 40, height: 40, borderRadius: 12, background: "var(--p-mint)", color: "#1B8C5C", display: "grid", placeItems: "center", flexShrink: 0}}>
            <Icon name="check" size={20}/>
          </div>
          <div>
            <div style={{fontSize: 17, fontWeight: 800}}>{items.length === 1 ? "A proceeding is now closed" : `${items.length} proceedings are now closed`}</div>
            <div className="card-sub" style={{marginTop: 2}}>Moved from “For your Action” to completed. An order may be available.</div>
          </div>
        </div>
        <div className="col" style={{gap: 8, marginTop: 12, maxHeight: 300, overflowY: "auto"}}>
          {items.map((it) => (
            <div key={it.proceedingReqId} className="between" style={{padding: "10px 12px", background: "var(--p-card-tint)", borderRadius: 10, alignItems: "center"}}>
              <div style={{minWidth: 0}}>
                <div className="strong" style={{fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{it.proceedingName || "Proceeding"}</div>
                <div className="muted" style={{fontSize: 11.5}}>{[it.type, it.ay ? `AY ${it.ay}` : ""].filter(Boolean).join(" · ")}</div>
              </div>
              <button className="btn btn-primary btn-sm" onClick={() => onOpen(it.proceedingReqId)}><Icon name="arrow-right" size={13}/>View order</button>
            </div>
          ))}
        </div>
        <div className="row" style={{marginTop: 16, justifyContent: "flex-end"}}>
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

/* Income-tax portal card — open e-Proceedings already logged in (Phase 1). */
function PortalCard({ a, onAddLogin, onClosedProceedings }) {
  const { data: appData, notify } = useData();
  const [hasExt, setHasExt] = React.useState(null); // null = checking
  const [busy, setBusy] = React.useState(false);
  // Default scope: first sync (never synced) pulls everything; after that a fast
  // e-Proceedings-only sync. The user can override from the dropdown.
  const [scope, setScope] = React.useState(a.portalLastSyncedAt ? "eproc" : "all");
  // Last sync's method + timing (approach "a" readout). null until a sync runs.
  const [syncInfo, setSyncInfo] = React.useState(null);
  // Counters for the streamed notice documents (used to surface failures).
  const noticeStats = React.useRef({ ok: 0, fail: 0, lastNotify: 0 });

  // ── Cheeky Hippo fetch progress ──────────────────────────────────────────
  // The extension streams the sync in the background (login → proceedings list
  // → one "notice" message per PDF → "sync-done"). We turn that stream into the
  // presentational props CheekyHippoProgress wants. `fetchPhase === null` means
  // idle (hippo hidden). Everything else mirrors the live stream.
  const [fetchState, setFetchState] = React.useState(null); // { phase, totalPdfs, downloadedCount, currentFileName, noticeCounts, errorMessage } | null
  const downloadedRef = React.useRef(0);          // live count for the sync-done branch
  const noticeCountsRef = React.useRef({});        // live section tally
  const watchdogRef = React.useRef(null);          // "no activity" timeout
  const doneTimerRef = React.useRef(null);         // processing→done beat
  const hideTimerRef = React.useRef(null);         // auto-hide after a terminal state

  // Auto-dismiss the hippo a few seconds after a terminal (done/empty) state so
  // the card quietly returns to its normal buttons. Errors stay until Retry.
  const scheduleHide = React.useCallback(() => {
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setFetchState(null), 6000);
  }, []);

  // Restart the no-activity watchdog: if the stream goes silent mid-fetch we
  // flip to the error state (with Retry) instead of spinning forever.
  const armWatchdog = React.useCallback(() => {
    clearTimeout(watchdogRef.current);
    watchdogRef.current = setTimeout(() => {
      setFetchState((f) => (f && (f.phase === 'authenticating' || f.phase === 'fetchingList' || f.phase === 'downloading' || f.phase === 'processing')
        ? { ...f, phase: 'error', errorMessage: 'The portal went quiet — the sync may have stalled. Try again.' }
        : f));
    }, 150000);
  }, []);

  React.useEffect(() => () => { clearTimeout(watchdogRef.current); clearTimeout(doneTimerRef.current); clearTimeout(hideTimerRef.current); }, []);

  const check = React.useCallback(() => {
    setHasExt(null);
    detectExtension().then(setHasExt);
  }, []);
  React.useEffect(() => {
    let alive = true;
    detectExtension().then((v) => { if (alive) setHasExt(v); });
    return () => { alive = false; };
  }, []);

  const launch = async (mode) => {
    if (busy) return;
    setBusy(true);
    // A fresh sync resets the hippo to Phase A; "open" mode doesn't fetch, so it
    // never shows the progress card.
    if (mode === "sync") {
      clearTimeout(doneTimerRef.current);
      clearTimeout(hideTimerRef.current);
      downloadedRef.current = 0;
      noticeCountsRef.current = {};
      setFetchState({ phase: 'authenticating', totalPdfs: 0, downloadedCount: 0, currentFileName: '', noticeCounts: null, errorMessage: '' });
      armWatchdog();
    }
    try {
      const { data } = await httpsCallable(functions, "getPortalCredential")({ assesseeId: a.id });
      // Incremental sync: tell the extension what's already on file so it only
      // fetches genuinely new data (see buildSyncKnowns). Empty for "open" mode.
      const knowns = mode === "sync"
        ? buildSyncKnowns(appData.notices, a.pan, appData.matters, appData.returns)
        : {};
      await openPortalLogin({ portalUserId: data.portalUserId, portalPassword: data.portalPassword, assesseeId: a.id, mode, scope, ...knowns });
      notify(mode === "sync" ? "Syncing from the portal — watch the new tab…" : "Opening the portal — logging you in…");
    } catch (e) {
      console.error(e);
      notify(e?.message?.slice(0, 120) || "Couldn't open the portal.", "alert");
      // The fetch never got off the ground — show the hippo's error + Retry.
      if (mode === "sync") {
        clearTimeout(watchdogRef.current);
        setFetchState((f) => ({ ...(f || {}), phase: 'error', errorMessage: e?.message?.slice(0, 140) || "Couldn't reach the portal." }));
      }
    } finally {
      setBusy(false);
    }
  };

  // Receive the e-Proceedings list the extension fetches and save it, and
  // record how it was fetched (portal JSON API vs screen scrape) + how long.
  React.useEffect(() => {
    const off = onSyncData(async (payload) => {
      if (!payload || payload.assesseeId !== a.id) return;

      // Sync finished (extension sends this from beginSync's .finally). Decide
      // the hippo's terminal state: nothing new → calm "empty"; otherwise a
      // brief "processing" beat then "done".
      if (payload.kind === "sync-done") {
        clearTimeout(watchdogRef.current);
        setFetchState((f) => {
          if (!f || f.phase === 'error') return f;
          if (downloadedRef.current === 0) {
            scheduleHide();
            return { ...f, phase: 'empty' };
          }
          clearTimeout(doneTimerRef.current);
          doneTimerRef.current = setTimeout(() => {
            setFetchState((g) => (g ? { ...g, phase: 'done', downloadedCount: downloadedRef.current, totalPdfs: downloadedRef.current } : g));
            scheduleHide();
          }, 1200);
          return { ...f, phase: 'processing', currentFileName: '' };
        });
        return;
      }

      // A notice/order document streamed from the portal. Upload its PDF (if
      // present) to Storage under the user's own path, then record the metadata.
      if (payload.kind === "notice") {
        const n = payload.notice || {};
        try {
          // Uploads the notice AND the rest of its set — a s.148 notice arrives
          // with its approval, set note and search print. Shared with the
          // connector's path (portalIngest.js) rather than repeated here, which
          // is how the two used to drift: this branch quietly stored one file
          // per notice long after the fetch started sending four.
          await ingestPortalSyncMessage(payload);
          noticeStats.current.ok++;
        } catch (e) {
          console.error("Notice ingest failed", e);
          noticeStats.current.fail++;
          // Surface the real error (e.g. function not deployed, permission) —
          // throttled so 39 failures don't spam 39 toasts.
          const now = Date.now();
          if (now - noticeStats.current.lastNotify > 1500) {
            noticeStats.current.lastNotify = now;
            notify("Couldn't save a portal notice — " + (e?.code || e?.message || "error") + " (check Storage/functions are deployed)", "alert");
          }
        }
        // Drive the hippo's determinate phase: one more PDF in hand. This fires
        // whether or not the ingest above succeeded — a downloaded doc counts.
        downloadedRef.current += 1;
        const bucket = classifyNoticeSection(n);
        if (bucket) noticeCountsRef.current[bucket] = (noticeCountsRef.current[bucket] || 0) + 1;
        armWatchdog();
        setFetchState((f) => f && ({
          ...f,
          phase: 'downloading',
          downloadedCount: downloadedRef.current,
          // If we have a real estimate, keep the count from ever exceeding it
          // (closure-order docs can overshoot). If we have NO estimate (0), keep
          // it 0 so the hippo shows an honest indeterminate bar + plain count
          // rather than a fake "3 of 0".
          totalPdfs: f.totalPdfs > 0 ? Math.max(f.totalPdfs, downloadedRef.current) : 0,
          currentFileName: n.filename || '',
          noticeCounts: { ...noticeCountsRef.current },
        }));
        return;
      }

      // The rest of the documents behind a notice already on file (the repair
      // pass for notices synced back when one notice meant one file).
      if (payload.kind === "notice-docs") {
        try { await ingestPortalSyncMessage(payload); }
        catch (e) { console.error("notice documents ingest failed", e); }
        downloadedRef.current += (payload.noticeDocs?.attachments || []).length;
        armWatchdog();
        setFetchState((f) => f && ({ ...f, downloadedCount: downloadedRef.current }));
        return;
      }

      // A response filed against a notice (remarks + attachment PDFs).
      if (payload.kind === "response") {
        try { await ingestPortalSyncMessage(payload); }
        catch (e) { console.error("response ingest failed", e); }
        return;
      }

      // A CIT(A) appeal filed as Form 35 (metadata + PDFs).
      if (payload.kind === "appealForm") {
        try { await ingestPortalSyncMessage(payload); }
        catch (e) { console.error("appeal ingest failed", e); }
        return;
      }

      // "return" and "returnForm" are deliberately NOT handled here. This card
      // only exists on the Overview tab, and a returns sync started from the
      // Returns tab would stream into an unmounted listener. AssesseeDetail owns
      // those two kinds instead, because it stays mounted whichever tab is open.

      // Approach (a) probe: the API was reached fast but its JSON shape still
      // needs a one-time mapping calibration. No data to save — just show the
      // timing so the speed is visible while scraping fills in the data.
      if (payload.kind === "api-probe") {
        setSyncInfo({ via: "api", ms: payload.ms, endpoint: payload.endpoint, calibrating: true, at: Date.now() });
        armWatchdog();
        setFetchState((f) => (f && f.phase === 'authenticating' ? { ...f, phase: 'fetchingList' } : f));
        return;
      }

      if (payload.kind !== "proceedings") return;
      setSyncInfo({
        via: payload.via || "scrape",
        ms: typeof payload.ms === "number" ? payload.ms : null,
        endpoint: payload.endpoint || null,
        count: (payload.proceedings || []).length,
        calibrating: false,
        at: Date.now(),
      });
      // The notice list is in: switch the hippo from indeterminate Phase A to a
      // known target. totalPdfs is an ESTIMATE (sum of the portal's per-
      // proceeding notice counts); the download branch clamps the live count to
      // it, and sync-done snaps it to the real number actually fetched.
      {
        const rows = payload.proceedings || [];
        const estTotal = rows.reduce((s, r) => s + (Number(r.viewNoticeCount ?? r.noticeCount) || 0), 0);
        armWatchdog();
        setFetchState((f) => (f ? {
          ...f,
          phase: f.phase === 'downloading' ? 'downloading' : 'fetchingList',
          totalPdfs: Math.max(f.totalPdfs || 0, estTotal, downloadedRef.current),
        } : f));
      }
      try {
        const { data } = await httpsCallable(functions, "ingestPortalProceedings")({
          assesseeId: a.id,
          proceedings: payload.proceedings || [],
        });
        notify(`Synced ${data.total} proceedings (${data.added} new)`);
        if (Array.isArray(data.closed) && data.closed.length && onClosedProceedings) onClosedProceedings(data.closed);
      } catch (e) {
        console.error(e);
        notify("Sync received but couldn't be saved.", "alert");
      }
    });
    return off;
  }, [a.id, notify, onClosedProceedings, armWatchdog, scheduleHide]);

  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">Income-tax portal</div>
        {a.portalCredSet
          ? <span className="pill pill-success"><Icon name="check" size={11}/> Login saved</span>
          : <span className="pill pill-muted">No login</span>}
      </div>

      {!a.portalCredSet ? (
        <div className="col" style={{gap: 10}}>
          <div className="muted" style={{fontSize: 12.5}}>Add this assessee's e-filing login to open the portal in one click.</div>
          {/* The extension sits beside the login, not behind it: without it the
              login saves fine and then every button on this card does nothing.
              Someone setting this assessee up for the first time needs both, so
              both are offered in the same breath. */}
          <div className="row" style={{gap: 8, flexWrap: "wrap", alignItems: "center"}}>
            <button className="btn btn-secondary btn-sm" onClick={onAddLogin}><Icon name="plus" size={13}/>Add portal login</button>
            {hasExt !== true && <ExtensionDownloadButton className="btn btn-ghost btn-sm" onRecheck={check}/>}
          </div>
        </div>
      ) : hasExt === false ? (
        <div className="col" style={{gap: 8}}>
          <div className="center" style={{gap: 8, padding: "10px 12px", background: "var(--p-amber)", borderRadius: 10, fontSize: 12.5}}>
            <Icon name="info" size={13}/>
            <span>Install the <b>ProHippo Sync</b> Chrome extension to open the portal automatically.</span>
          </div>
          <div className="row" style={{gap: 8, flexWrap: "wrap", alignItems: "center"}}>
            <ExtensionDownloadButton className="btn btn-primary btn-sm" label="Download extension" onRecheck={check}/>
            <button className="btn btn-ghost btn-sm" onClick={check}><Icon name="arrow-right" size={12}/>I've installed it — recheck</button>
          </div>
        </div>
      ) : (
        <div className="col" style={{gap: 10}}>
          <div className="row" style={{gap: 8, flexWrap: "wrap", alignItems: "center"}}>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              disabled={busy}
              title="Choose what to sync"
              style={{fontFamily: "inherit", fontSize: 12.5, fontWeight: 600, color: "var(--p-text-2)", background: "white", border: "1px solid var(--p-line-2)", borderRadius: 10, padding: "8px 10px"}}
            >
              {SYNC_SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <button className="btn btn-primary btn-sm" disabled={busy || hasExt === null} onClick={() => launch("sync")}>
              <Icon name="sparkle" size={13}/>{busy ? "Working…" : (SYNC_SCOPES.find((s) => s.value === scope)?.btn || "Sync")}
            </button>
            <button className="btn btn-secondary btn-sm" disabled={busy || hasExt === null} onClick={() => launch("open")}>
              <Icon name="link" size={13}/>Open portal
            </button>
          </div>
          <div className="muted" style={{fontSize: 11}}>
            {scope === "eproc" && "Fast: checks FYA for new notices/orders only — skips Form 35."}
            {scope === "all" && "Thorough: FYA + FYI + replies + Form 35. Use for the first sync."}
            {scope === "appeals" && "Re-pulls filed Form 35 appeals only."}
          </div>
          {/* The hippo narrates a live sync (Phase A → B → done/empty/error). */}
          {fetchState && (
            <CheekyHippoProgress
              phase={fetchState.phase}
              totalPdfs={fetchState.totalPdfs}
              downloadedCount={fetchState.downloadedCount}
              noticeCounts={fetchState.noticeCounts}
              currentFileName={fetchState.currentFileName}
              errorMessage={fetchState.errorMessage}
              onRetry={() => launch("sync")}
            />
          )}
          <div className="muted" style={{fontSize: 11.5}}>
            Last synced: {a.portalLastSyncedAt ? fmtDateTime(a.portalLastSyncedAt) : "never"}
            {typeof a.portalProceedingCount === "number" ? ` · ${a.portalProceedingCount} proceedings` : ""}
            {typeof a.portalNoticeCount === "number" ? ` · ${a.portalNoticeCount} notices` : ""}
          </div>
          {syncInfo && <SyncTiming info={syncInfo}/>}
        </div>
      )}
    </div>
  );
}

// Accent colour per proceeding type — used for the row's left stripe and the
// modal header so scrutiny / appeal / penalty proceedings read apart at a glance.
/* ---------------- Returns: filed ITRs, intimations and s.154 orders ------- */

// Why an order has no PDF behind it. These read as short, plain sentences
// because they appear inline in the table where a download chip would be, and
// the practitioner needs to know whether it's their problem to fix.
const LOCK_REASON_TEXT = {
  "no-password": "Add the date of birth / incorporation to unlock",
  "wrong-password": "The date on file doesn't unlock this PDF",
  "request-only": "The portal only sends this one by e-mail for A.Y. 2016-17 and earlier",
  unavailable: "The portal didn't return this document",
  "": "Locked",
};

// The portal reports the filing type as a single letter.
const FILING_TYPE = { O: "Original", R: "Revised", D: "Defective", U: "Updated", C: "Condoned" };

// A rupee figure the portal sends as a string, which may be "", "null" or "0".
// Anything that isn't a real number renders as an em dash — a blank cell and a
// genuine nil are different things in a tax record.
function portalAmount(v) {
  const n = Number(v);
  if (v == null || v === "" || v === "null" || Number.isNaN(n)) return null;
  return n;
}

/* What the order did to this year's position, under the order it did it to.
 *
 * The amount alone would be worse than nothing here: a s.154 order is measured
 * against the intimation it rectified and a s.143(1) against the return as
 * filed, so the SAME rupee figure describes two different events. The baseline
 * is therefore part of the sentence, never a tooltip.
 *
 * Computed at ingest by functions/returnVariance.js — this only renders it.
 * Orders synced before the feature existed carry no variance and get no line,
 * rather than a line saying nothing. */
function VarianceLine({ variance }) {
  if (!variance) return null;
  const tone = variance.flag === "red" ? { fg: "#B23B3B", bg: "#FDECEC" }
    : variance.flag === "green" ? { fg: "#13795C", bg: "#E7F7F0" }
      : { fg: "var(--p-text-3)", bg: "var(--p-line-2)" };
  const signed = variance.amount != null && variance.flag !== "neutral" && variance.flag !== "unknown"
    ? `${variance.amount < 0 ? "−" : "+"}${fmtINR(Math.abs(variance.amount))}`
    : null;

  return (
    <div className="center" style={{gap: 6, justifyContent: "flex-start", flexWrap: "wrap", marginTop: 6}}>
      {signed && (
        <span style={{background: tone.bg, color: tone.fg, borderRadius: 7, padding: "2px 7px", fontWeight: 800, fontSize: 11.5}}>
          {signed}
        </span>
      )}
      <span style={{fontSize: 11.5, color: tone.fg}} title={BASELINE_LABEL[variance.baseline?.kind] || ""}>
        {describeVariance(variance)}
      </span>
      {variance.adjusted && (
        <span className="pill pill-muted" title="CPC set this refund off against an earlier demand u/s 245 — it is not being paid out">
          adjusted u/s 245
        </span>
      )}
    </div>
  );
}

function ReturnsView({ returns, assessee, onSync, onFetchForm, onGenerateComputation, busyKey }) {
  const [openAy, setOpenAy] = React.useState(null);
  const rows = [...(returns || [])].sort((x, y) => String(y.ay || "").localeCompare(String(x.ay || "")));

  if (!rows.length) {
    return (
      <div className="card">
        <EmptyState
          icon="doc"
          title={`No filed returns for ${titleCase(assessee.name)} yet`}
          sub="Run a full sync — or Sync returns — to pull every assessment year's ITR, its JSON, and any intimation u/s 143(1) or rectification order u/s 154."
        />
        <div className="center" style={{justifyContent: "center", marginTop: 4}}>
          <button className="btn btn-primary btn-sm" disabled={!assessee.portalCredSet || Boolean(busyKey)} onClick={onSync}>
            <Icon name="refresh" size={14}/>Sync returns
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="col" style={{gap: 14}}>
      <div className="between">
        <div className="muted" style={{fontSize: 12.5}}>
          {rows.length} assessment year{rows.length > 1 ? "s" : ""} on file
        </div>
        <button className="btn btn-secondary btn-sm" disabled={!assessee.portalCredSet || Boolean(busyKey)} onClick={onSync}>
          <Icon name="refresh" size={14}/>Sync returns
        </button>
      </div>

      <div className="card" style={{padding: 0}}>
        <Table>
          <thead><tr><th>A.Y.</th><th>Form</th><th>Filed</th><th>Status</th><th>Demand / Refund</th><th>Documents</th><th></th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const demand = portalAmount(r.computedDemndAmt) ?? portalAmount(r.demandAmt);
              const refund = portalAmount(r.computedRefndAmt) ?? portalAmount(r.refundAmt);
              const open = openAy === r.ay;
              const busy = busyKey === r.ay;
              const computation = computationAvailability(r.form, r.ay);
              return (
                <React.Fragment key={r.id || r.ay}>
                  <tr style={open ? {borderBottom: "none"} : undefined}>
                    <td className="strong">{r.ay}</td>
                    <td>
                      <span className="pill pill-muted">{r.form || `Form ${r.formTypeCd || "?"}`}</span>
                      {r.filingTypeCd && r.filingTypeCd !== "O" && (
                        <span className="pill" style={{marginLeft: 5}}>{FILING_TYPE[r.filingTypeCd] || r.filingTypeCd}</span>
                      )}
                    </td>
                    <td className="muted">
                      <div>{r.filedOn ? fmtDateLong(r.filedOn) : "—"}</div>
                      <div style={{fontSize: 11}}>{r.verified ? `e-verified · ${r.verifiedMode || ""}` : "Not verified"}</div>
                    </td>
                    <td style={{maxWidth: 260}}>
                      <div style={{fontSize: 12.5}}>{r.statusDesc || "—"}</div>
                    </td>
                    <td>
                      {demand ? <div style={{color: "#B23B3B", fontWeight: 700}}>{fmtINR(demand)} demand</div> : null}
                      {refund ? <div style={{color: "#13795C", fontWeight: 700}}>{fmtINR(refund)} refund</div> : null}
                      {!demand && !refund ? <span className="muted">—</span> : null}
                    </td>
                    <td>
                      <div className="center" style={{gap: 5, justifyContent: "flex-start", flexWrap: "wrap"}}>
                        {r.jsonPath && (
                          <button className="btn btn-ghost btn-xs" title="Download the ITR JSON exactly as filed" onClick={() => downloadDoc(r.jsonPath, returnDocFilename("json", r, assessee.name))}>
                            <Icon name="doc" size={11}/>JSON
                          </button>
                        )}
                        {r.ackPdfPath && (
                          <button className="btn btn-ghost btn-xs" title="Download the ITR-V / Acknowledgement" onClick={() => downloadDoc(r.ackPdfPath, returnDocFilename("ack", r, assessee.name))}>
                            <Icon name="doc" size={11}/>ITR-V
                          </button>
                        )}
                        {r.formPdfPath ? (
                          <button className="btn btn-ghost btn-xs" title="Download the full ITR form" onClick={() => downloadDoc(r.formPdfPath, returnDocFilename("form", r, assessee.name))}>
                            <Icon name="doc" size={11}/>Form
                          </button>
                        ) : (
                          <button
                            className="btn btn-ghost btn-xs"
                            /* Two reasons this button is here, and they are not
                               the same: the sync leaves older years alone by
                               design, or it tried this one and the portal gave
                               it something unusable. The second is worth saying
                               out loud — it is the difference between "not yet"
                               and "something is wrong". */
                            title={r.formPdfError
                              ? `The sync couldn't fetch this year's return PDF: ${r.formPdfError}. Click to try again from the portal.`
                              : "The sync keeps only the two most recent years' return PDFs — they're 10-12 MB each. Click to fetch this one from the portal."}
                            disabled={!assessee.portalCredSet || Boolean(busyKey)}
                            onClick={() => onFetchForm(r)}
                          >
                            <Icon name="download" size={11}/>{r.formPdfError ? "Retry form" : "Fetch form"}
                          </button>
                        )}
                      </div>
                    </td>
                    <td>
                      <div className="center" style={{gap: 6, justifyContent: "flex-end"}}>
                        {/* A button that cannot produce anything is worse than no
                            button: it invites a click, fails, and leaves the
                            practitioner wondering whether the return is at fault.
                            Where no mapper exists for this form and year, say so
                            on the row and give the reason on hover. */}
                        {computation.ok ? (
                          <button
                            className="btn btn-primary btn-xs"
                            disabled={!r.jsonPath || busy}
                            title={r.jsonPath ? "Generate a Computation of Total Income from the filed return" : "The ITR JSON for this year hasn't been synced yet"}
                            onClick={() => onGenerateComputation(r)}
                          >
                            <Icon name="doc" size={11}/>{busy ? "Generating…" : "Computation"}
                          </button>
                        ) : (
                          <span className="pill pill-muted" title={computation.reason}>
                            Computation · coming soon
                          </span>
                        )}
                        <button className="icon-btn" style={{width: 26, height: 26}} onClick={() => setOpenAy(open ? null : r.ay)} title={open ? "Hide detail" : "Show the CPC timeline and orders"}>
                          <Icon name={open ? "chevron-up" : "chevron-down"} size={13}/>
                        </button>
                      </div>
                    </td>
                  </tr>

                  {open && (
                    <tr>
                      <td colSpan="7" style={{paddingTop: 0}}>
                        <div className="row" style={{gap: 18, alignItems: "flex-start", flexWrap: "wrap", paddingBottom: 8}}>
                          <div style={{flex: "1 1 320px", minWidth: 280}}>
                            <div className="pm-eyebrow" style={{fontSize: 11, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", marginBottom: 8}}>
                              Intimations &amp; orders
                            </div>
                            {(r.orders || []).length === 0 && <div className="muted" style={{fontSize: 12.5}}>Nothing issued by CPC for this year.</div>}
                            <div className="col" style={{gap: 8}}>
                              {(r.orders || []).map((o) => (
                                <div key={o.commRefNo} style={{border: "1px solid var(--p-line)", borderRadius: 10, padding: "8px 10px"}}>
                                  <div className="between" style={{gap: 8}}>
                                    <div>
                                      <span className="pill pill-primary">u/s {o.section}</span>
                                      <span className="muted" style={{marginLeft: 8, fontFamily: "ui-monospace, monospace", fontSize: 11}}>{o.commRefNo}</span>
                                    </div>
                                    {o.storagePath && !o.locked ? (
                                      <button className="btn btn-ghost btn-xs" onClick={() => downloadDoc(o.storagePath, returnOrderFilename(o, r.ay, assessee.name))}>
                                        <Icon name="doc" size={11}/>PDF
                                      </button>
                                    ) : (
                                      <span className="muted" style={{fontSize: 11}}>
                                        {LOCK_REASON_TEXT[o.lockReason] || LOCK_REASON_TEXT[""]}
                                      </span>
                                    )}
                                  </div>
                                  <div className="muted" style={{fontSize: 12, marginTop: 4}}>{o.statusDesc}</div>
                                  {o.orderDate && <div className="muted" style={{fontSize: 11, marginTop: 2}}>Order dated {fmtDateLong(o.orderDate)}</div>}
                                  <VarianceLine variance={o.variance}/>
                                </div>
                              ))}
                            </div>
                          </div>

                          <div style={{flex: "1 1 260px", minWidth: 240}}>
                            <div className="pm-eyebrow" style={{fontSize: 11, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", marginBottom: 8}}>
                              CPC timeline
                            </div>
                            <div className="col" style={{gap: 4}}>
                              {(r.timeline || []).map((e, i) => (
                                <div key={i} className="between" style={{gap: 10, fontSize: 12}}>
                                  <span>{e.statusDesc}</span>
                                  <span className="muted" style={{whiteSpace: "nowrap"}}>{e.activityDt ? fmtDate(e.activityDt) : ""}</span>
                                </div>
                              ))}
                              {(r.timeline || []).length === 0 && <div className="muted" style={{fontSize: 12.5}}>No activity recorded.</div>}
                            </div>
                            <div className="muted" style={{fontSize: 11, marginTop: 10, fontFamily: "ui-monospace, monospace"}}>
                              Ack. {r.ackNum}
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </Table>
      </div>

      {rows.some((r) => (r.orders || []).some((o) => o.locked && o.lockReason === "no-password")) && !assessee.dob && (
        <div className="card" style={{background: "var(--p-amber)", border: "none"}}>
          <div style={{fontSize: 12.5}}>
            <b>Some order PDFs are still locked.</b> CPC protects every intimation and s.154 order with the PAN in lower case
            followed by the date of birth / incorporation as DDMMYYYY. Add that date on the Edit screen and re-run the sync —
            they'll be unlocked automatically from then on.
          </div>
        </div>
      )}
    </div>
  );
}

const TYPE_ACCENT = {
  Scrutiny: { bar: "#F39C12", tint: "var(--p-amber)", fg: "#B07512" },
  "CIT(A)": { bar: "#C13388", tint: "var(--p-pink)", fg: "#C13388" },
  ITAT: { bar: "var(--p-primary)", tint: "var(--p-lavender-2)", fg: "var(--p-primary-2)" },
  Penalty: { bar: "#EE5A5A", tint: "var(--p-coral)", fg: "#B8463A" },
};
const accentFor = (t) => TYPE_ACCENT[t] || { bar: "var(--p-primary-3)", tint: "var(--p-lavender-2)", fg: "var(--p-primary-2)" };

/* Consolidated, proceeding-wise view: each matter (proceeding) is a distinct,
   clearly-separated card. Clicking one opens a full, scrollable pop-up card
   (ProceedingModal) with its hearings and notices/orders. Manual matters (no
   proceeding) open the same card — it simply has nothing synced to show yet. */
function MattersView({ matters, notices, hearings, assesseeName, notify, focusReqId, openMatterId }) {
  const [openId, setOpenId] = React.useState(null);
  const [parsingId, setParsingId] = React.useState("");

  const byDateDesc = (arr) => [...arr].sort((x, y) => (y.date || "").localeCompare(x.date || ""));
  const noticesFor = (m) => byDateDesc(notices.filter((n) => m.proceedingReqId && n.proceedingReqId === m.proceedingReqId));
  /* Linked by the portal's proceeding id where there is one, and otherwise by
     the appeal number. A matter opened from the Tribunal's own email has no
     proceeding id — it never came through the portal sync — so on that test
     alone its own hearings were invisible, and an ITAT card read "0 hearings"
     with two of them sitting on the assessee's Hearings tab. */
  const hearingsFor = (m) => byDateDesc(hearings.filter((h) => (
    (m.proceedingReqId && h.proceedingReqId === m.proceedingReqId) || sameAppeal(m.ref, h.ita)
  )));

  // When asked to focus a proceeding — from the "closed" popup (by reqId) or a
  // click on the global Matters / Hearings page (by matter id) — open its card.
  React.useEffect(() => {
    let id = null;
    if (openMatterId && matters.some((m) => m.id === openMatterId)) id = openMatterId;
    else if (focusReqId) id = matters.find((mm) => mm.proceedingReqId === focusReqId)?.id || null;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (id) setOpenId(id);
  }, [focusReqId, openMatterId, matters]);

  // Newest-first: order by the latest notice/order or hearing date in the
  // proceeding (NOT the sync timestamp — that's the same for every matter and
  // would flatten the order). Fall back to createdAt only when it has no dates.
  const lastActivity = (m) => {
    const ns = noticesFor(m); const hs = hearingsFor(m);
    const dated = [ns[0]?.date, hs[0]?.date].filter(Boolean).sort();
    return dated.length ? dated[dated.length - 1] : ("0000-" + (m.createdAt || m.portalSyncedAt || ""));
  };
  const ordered = [...matters].sort((x, y) => lastActivity(y).localeCompare(lastActivity(x)));

  const parse = async (n) => {
    setParsingId(n.id);
    try {
      await httpsCallable(functions, "summarizePortalNotice")({ noticeId: n.id });
      // The summary lands on the notice doc → appears via the store's live data.
    } catch (e) {
      console.error("summarize failed", e);
      notify && notify("Couldn't summarise that PDF — " + (e?.message?.slice(0, 100) || "try again in a moment"), "alert");
    } finally {
      setParsingId("");
    }
  };

  if (matters.length === 0) {
    return (
      <div className="card" style={{padding: 0}}>
        <EmptyState icon="scale" title={`No proceedings for ${assesseeName} yet`} sub="Run a portal sync from the Overview tab to pull the assessee's e-Proceedings, or add a matter manually."/>
      </div>
    );
  }

  const selected = ordered.find((m) => m.id === openId) || null;

  // type | proceeding (flex) | AY | section (no-wrap) | status | view chip
  const GRID = "96px minmax(170px, 1fr) 70px 128px 96px 104px";
  return (
    <>
      <div className="matters-surface" style={{overflowX: "auto"}}>
        <div className="col" style={{gap: 10, minWidth: 640}}>
          <div style={{display: "grid", gridTemplateColumns: GRID, gap: 14, alignItems: "center", padding: "0 18px", fontSize: 10.5, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", color: "#46389C"}}>
            <span>Type</span><span>Proceeding</span><span>AY</span><span>Section</span><span>Status</span><span/>
          </div>
          {ordered.map((m) => {
            const ns = noticesFor(m);
            const hs = hearingsFor(m);
            const isPortal = Boolean(m.proceedingReqId);
            const docCount = ns.length;
            const section = m.section || ns.map((n) => n.section).find(Boolean) || "";
            const accent = accentFor(m.type);
            return (
              <div
                key={m.id}
                className="card matter-row"
                onClick={() => setOpenId(m.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenId(m.id); } }}
                style={{display: "grid", gridTemplateColumns: GRID, gap: 14, alignItems: "center", padding: "14px 18px", cursor: "pointer", borderLeft: `4px solid ${accent.bar}`}}
              >
                <span><span className="pill" style={{background: accent.tint, color: accent.fg, fontWeight: 700}}>{m.type || "Matter"}</span></span>
                <span style={{minWidth: 0}}>
                  <span className="strong" style={{fontSize: 13, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{m.ref || m.proceedingName || "Matter"}</span>
                  <span className="muted" style={{fontSize: 11}}>
                    {isPortal
                      ? `${docCount} notice${docCount === 1 ? "" : "s"}/orders${hs.length ? ` · ${hs.length} hearing${hs.length === 1 ? "" : "s"}` : ""}`
                      : "Manual matter"}
                  </span>
                </span>
                <span>{m.ay || "—"}</span>
                <span style={{whiteSpace: "nowrap"}}>{section ? <span className="pill pill-muted">u/s {section}</span> : <span className="muted">—</span>}</span>
                <span><StatusPill status={m.status}/></span>
                <span className="matter-view center" style={{gap: 5, justifySelf: "end", padding: "6px 11px", borderRadius: 999, background: "var(--p-lavender-2)", color: "var(--p-primary-2)", fontSize: 11.5, fontWeight: 700, whiteSpace: "nowrap"}}>
                  View <Icon name="arrow-right" size={13}/>
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {selected && (
        <ProceedingModal
          matter={selected}
          notices={noticesFor(selected)}
          hearings={hearingsFor(selected)}
          parsingId={parsingId}
          onParse={parse}
          onClose={() => setOpenId(null)}
        />
      )}
    </>
  );
}

/* Full, scrollable pop-up card for a single proceeding — its hearings and every
   notice / order / appeal filed against it, with the assessee's responses. */
function ProceedingModal({ matter: m, notices: ns, hearings: hs, parsingId, onParse, onClose }) {
  const [adjourning, setAdjourning] = React.useState(null);
  const accent = accentFor(m.type);
  const section = m.section || ns.map((n) => n.section).find(Boolean) || "";
  const docCount = ns.length;
  /* Notices and FILES are different numbers, and the difference is the whole
     point of this change: four notices on this proceeding can be a dozen
     documents. Only printed when they actually differ. */
  const fileCount = ns.reduce((s, n) => s + noticeDocumentCount(n), 0);
  return (
    <Modal
      title={m.ref || m.proceedingName || "Proceeding"}
      titleStyle={{fontSize: 22}}
      sub={[m.type || "Matter", m.ay ? `AY ${m.ay}` : "", section ? `u/s ${section}` : ""].filter(Boolean).join("  ·  ")}
      onClose={onClose}
      width={780}
      footer={<button className="btn btn-secondary" onClick={onClose}>Close</button>}
    >
      <div className="col" style={{gap: 16}}>
        {/* Summary strip — tinted by the proceeding type so it reads apart. */}
        <div className="between" style={{alignItems: "center", flexWrap: "wrap", gap: 10, padding: "12px 14px", background: accent.tint, borderRadius: 12, borderLeft: `4px solid ${accent.bar}`}}>
          <div className="center" style={{gap: 8, flexWrap: "wrap", justifyContent: "flex-start"}}>
            <span className="pill" style={{background: "white", color: accent.fg, fontWeight: 800}}>{m.type || "Matter"}</span>
            <StatusPill status={m.status}/>
            {m.bench && <span className="muted" style={{fontSize: 12}}>{m.bench}</span>}
          </div>
          <div style={{fontSize: 12.5, fontWeight: 700, color: accent.fg}}>
            {docCount} notice{docCount === 1 ? "" : "s"}/orders
            {fileCount > docCount ? ` · ${fileCount} files` : ""}
            {hs.length ? ` · ${hs.length} hearing${hs.length === 1 ? "" : "s"}` : ""}
          </div>
        </div>

        {hs.length > 0 && (
          <div>
            <div className="pm-eyebrow" style={{fontSize: 11, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", marginBottom: 8}}>Hearings</div>
            <div className="col" style={{gap: 8}}>
              {hs.map((h) => (
                <div key={h.id} className="between" style={{gap: 10, fontSize: 12.5, padding: "9px 11px", background: "#E7EEFD", borderRadius: 12, border: "1px solid #D3E0FB", flexWrap: "wrap"}}>
                  <div className="center" style={{gap: 10, justifyContent: "flex-start", flexWrap: "wrap"}}>
                    <Icon name="calendar" size={13} className="muted"/>
                    <span className="strong">{fmtDateLong(h.date)}</span>
                    <span className="muted">{h.time} · {h.mode}</span>
                    <StatusPill status={h.date < todayISO() ? "Completed" : h.status}/>
                  </div>
                  {/* The proceeding is what a practitioner has open when they are
                      reading up on a matter, so the date can be moved from here
                      without hunting for the same hearing on another screen. */}
                  {h.status !== "Adjourned" && (
                    <button className="btn btn-ghost btn-xs" title="Adjourn to another date" onClick={() => setAdjourning(h)}>
                      <Icon name="clock" size={12}/>
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <div className="pm-eyebrow" style={{fontSize: 11, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", marginBottom: 8}}>Notices &amp; orders</div>
          {ns.length === 0
            ? <div className="muted" style={{fontSize: 12.5, padding: "10px 12px", background: "var(--p-card-tint)", borderRadius: 10, border: "1px dashed var(--p-line)"}}>No notices/orders synced for this proceeding yet.</div>
            : (
              <div className="col" style={{gap: 10}}>
                {ns.map((n) => {
                  const appeal = Boolean(n.isAppealForm);
                  const dt = n.isOrder ? orderDocType(n) : null;
                  const appealable = isAppealableOrder(n);
                  const enclosure = dt === "demandNotice" || dt === "computationSheet";
                  const ap = n.appeal || {};
                  const apAtts = appeal ? (ap.attachments || []).filter((x) => x.storagePath) : [];
                  // Functional tile colour: order → amber, appeal form → lavender,
                  // demand/computation enclosure → neutral, plain notice → violet.
                  const tileBg = appealable ? "#FCF3DE" : appeal ? "#F0EBFB" : enclosure ? "var(--p-card-tint)" : "#F0EBFB";
                  const tileBd = appealable ? "#F3E6C4" : enclosure ? "var(--p-line-2)" : "#E6DDF7";
                  return (
                    <div key={n.id} style={{padding: "11px 13px", background: tileBg, borderRadius: 12, border: `1px solid ${tileBd}`}}>
                      <div className="center" style={{gap: 10, alignItems: "flex-start"}}>
                        <div style={{width: 30, height: 38, borderRadius: 5, background: appeal ? "var(--p-lavender-2)" : appealable ? "var(--p-amber)" : enclosure ? "var(--p-card-tint)" : "var(--p-pink)", display: "grid", placeItems: "center", color: appeal ? "var(--p-primary-2)" : appealable ? "#B07512" : enclosure ? "var(--p-text-3)" : "#C13388", fontSize: 8, fontWeight: 800, flexShrink: 0}}>PDF</div>
                        <div style={{flex: 1, minWidth: 0}}>
                          <div className="center" style={{gap: 6, justifyContent: "flex-start"}}>
                            <span className={`pill ${appeal ? "pill-primary" : appealable ? "pill-warning" : enclosure ? "pill-info" : "pill-muted"}`} style={{fontSize: 10}}>{appeal ? "Appeal · Form 35" : dt ? DOC_TYPE_LABEL[dt] : "Notice"}</span>
                            <span className="strong" style={{fontSize: 13, fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{n.subject || n.din || "Notice"}</span>
                          </div>
                          <div className="muted" style={{fontSize: 11, marginTop: 2}}>
                            {appeal
                              ? [ap.dateFiling ? `Filed ${fmtDateLong(ap.dateFiling)}` : "", ap.ackNum ? `Ack ${ap.ackNum}` : "", ap.dateOrder ? `vs order ${fmtDateLong(ap.dateOrder)}` : "", ap.orderSection ? `u/s ${ap.orderSection}` : "", ap.appealSection ? `appeal u/s ${ap.appealSection}` : ""].filter(Boolean).join(" · ")
                              : [
                                n.date ? `Issued ${fmtDateLong(n.date)}` : "",
                                // Only when it differs — on most notices the two
                                // are the same day and printing both is noise.
                                n.servedOn && n.servedOn !== n.date ? `served ${fmtDateLong(n.servedOn)}` : "",
                                n.section ? `u/s ${n.section}` : "",
                                n.din ? `DIN ${n.din}` : "",
                              ].filter(Boolean).join(" · ")}
                          </div>
                          {/* THE DATE THE PRACTICE WORKS TO. The portal has always
                              sent it and the dashboard has always used it; this
                              card simply never printed it. An order has no reply
                              date, so it only shows on notices. */}
                          {!appeal && !n.isOrder && <ReplyDue notice={n}/>}
                          {!appeal && (n.assessedIncome != null || (n.parsed && n.parsed.disputedDemand)) ? (
                            <div style={{fontSize: 12, marginTop: 3, fontWeight: 700, color: "#8A6A12"}}>
                              {[n.assessedIncome != null ? `Assessed ${fmtINR(n.assessedIncome)}` : "", n.parsed && n.parsed.disputedDemand ? `Demand ${fmtINR(n.parsed.disputedDemand)}` : ""].filter(Boolean).join(" · ")}
                            </div>
                          ) : null}
                          {appeal && (ap.amountAssessed || ap.disputedDemand) ? (
                            <div style={{fontSize: 12, marginTop: 3, fontWeight: 700, color: "#8A6A12"}}>
                              {[ap.amountAssessed ? `Assessed ${fmtINR(ap.amountAssessed)}` : "", ap.disputedDemand ? `Disputed ${fmtINR(ap.disputedDemand)}` : ""].filter(Boolean).join(" · ")}
                            </div>
                          ) : null}
                        </div>
                        {/* "Get summary", not "Parse with AI": a button is named
                            for what it gives you, not for what runs inside it.
                            The sparkle and the note under the result already say
                            a model read the PDF, which is where that belongs —
                            on the output a practitioner has to check, not on the
                            control. */}
                        {!appeal && n.storagePath && (
                          <button className="btn btn-ghost btn-xs" title="Read this PDF and summarise what it says" disabled={parsingId === n.id} onClick={(e) => { e.stopPropagation(); onParse(n); }}>
                            <Icon name="sparkle" size={12}/>{parsingId === n.id ? "Summarising…" : (n.aiSummary ? "Refresh summary" : "Get summary")}
                          </button>
                        )}
                        {/* The notice's own document. Where the portal served a
                            SET — a s.148 notice comes with its approval, set
                            note and search print — the whole set is listed
                            below rather than hidden behind this one button. */}
                        {!appeal && n.storagePath && (
                          <button className="btn btn-ghost btn-xs" title="Download the portal PDF" onClick={(e) => { e.stopPropagation(); downloadDoc(n.storagePath, noticeFilename(n, n.assessee)); }}>
                            <Icon name="doc" size={12}/>PDF
                          </button>
                        )}
                      </div>
                      {!appeal && <NoticeDocuments notice={n} assesseeName={n.assessee}/>}
                      {/* Orders are decided — there is nothing left to ask the
                          client for. Notices are what call for documents. */}
                      {!appeal && !n.isOrder && (
                        <div className="row" style={{justifyContent: "flex-end", marginTop: 8}}>
                          <AskDocsButton notice={n}/>
                        </div>
                      )}
                      {appeal && apAtts.length > 0 && (
                        <div className="row" style={{gap: 6, flexWrap: "wrap", marginTop: 8}}>
                          {apAtts.map((at, ai) => (
                            <button key={ai} className="btn btn-ghost btn-xs" title={at.label ? `${at.label} — ${at.filename}` : at.filename} onClick={(e) => { e.stopPropagation(); downloadDoc(at.storagePath, at.filename); }}>
                              <Icon name="doc" size={11}/>{(at.label || at.filename || "PDF").slice(0, 28)}
                            </button>
                          ))}
                        </div>
                      )}
                      {appeal && ap.formPdfError && !apAtts.some((at) => /form 35/i.test(at.label || at.filename || "")) && (
                        <div className="muted" style={{marginTop: 6, fontSize: 10.5, color: "var(--p-danger)"}}>Form 35 PDF couldn't be fetched — {ap.formPdfError}</div>
                      )}
                      {/* GROUNDS THAT NEVER ARRIVED. The portal lists what was
                          uploaded with the appeal; a download that failed used
                          to be dropped in silence, so a Form 35 with no grounds
                          attached looked exactly like one filed without any.
                          The count is the portal's own, and the sync comes back
                          for these on its next run. */}
                      {appeal && (ap.attachmentsMissing || []).length > 0 && (
                        <div className="muted" style={{marginTop: 6, fontSize: 10.5, color: "var(--p-danger)"}}>
                          {ap.attachmentsMissing.length} of {ap.attachmentsExpected || ap.attachmentsMissing.length} attachment(s) not fetched yet — {ap.attachmentsMissing.slice(0, 3).join(", ")}
                        </div>
                      )}
                      {!appeal && n.aiSummary && (n.aiSummary.summary || (n.aiSummary.items || []).length > 0) && (
                        <div style={{marginTop: 8, padding: "8px 10px", background: "white", borderRadius: 8, border: "1px solid var(--p-line-2)", fontSize: 12}}>
                          <div className="center" style={{gap: 6, justifyContent: "flex-start", marginBottom: (n.aiSummary.items || []).length ? 5 : 0}}>
                            <Icon name="sparkle" size={11}/><span className="strong">{n.aiSummary.summary}</span>
                          </div>
                          {(n.aiSummary.items || []).length > 0 && (
                            <ul style={{margin: 0, paddingLeft: 18}}>
                              {n.aiSummary.items.map((it, i) => <li key={i} style={{marginTop: 2}}>{it}</li>)}
                            </ul>
                          )}
                        </div>
                      )}
                      <ResponsesBlock notice={n} responses={n.responses}/>
                    </div>
                  );
                })}
              </div>
            )}
        </div>
      </div>
      {adjourning && <AdjournModal hearing={adjourning} onClose={() => setAdjourning(null)}/>}
    </Modal>
  );
}

function NotesCard({ assessee, onSave }) {
  const [text, setText] = React.useState(assessee.notes || "");
  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">Notes</div>
        <button className="btn btn-primary btn-sm" onClick={() => onSave(text)}><Icon name="check" size={13}/>Save notes</button>
      </div>
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder={`Internal notes about ${assessee.name}…`}
        style={{width: "100%", minHeight: 180, border: "1px solid var(--p-line)", borderRadius: 12, padding: "12px 14px", fontSize: 13.5, fontFamily: "inherit", resize: "vertical", outline: "none"}}
      />
    </div>
  );
}

function MiniStat({ label, value, icon, accent = "default" }) {
  const colors = {
    default: { bg: "var(--p-lavender-2)", fg: "var(--p-primary-2)" },
    pink:    { bg: "var(--p-pink)", fg: "#C13388" },
    warn:    { bg: "var(--p-amber)", fg: "#B07512" },
    success: { bg: "var(--p-mint)", fg: "#1B8C5C" },
  }[accent];
  return (
    <div style={{display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", background: "white", borderRadius: 14, border: "1px solid var(--p-line-2)", flex: 1}}>
      <div style={{width: 34, height: 34, borderRadius: 10, background: colors.bg, color: colors.fg, display: "grid", placeItems: "center"}}>
        <Icon name={icon} size={16}/>
      </div>
      <div style={{minWidth: 0}}>
        <div style={{fontSize: 11, color: "var(--p-text-3)", fontWeight: 600}}>{label}</div>
        <div style={{fontWeight: 800, fontSize: 16, letterSpacing: "-0.02em", color: "var(--p-text)"}}>{value}</div>
      </div>
    </div>
  );
}

function KV({ label, value, mono }) {
  return (
    <div className="between" style={{padding: "8px 0", borderBottom: "1px dashed var(--p-line-2)", fontSize: 13, alignItems: "flex-start"}}>
      <div className="muted" style={{fontSize: 12, minWidth: 130}}>{label}</div>
      <div style={{fontWeight: 600, textAlign: "right", maxWidth: "60%", fontFamily: mono ? "ui-monospace, monospace" : "inherit"}}>{value}</div>
    </div>
  );
}

function Timeline({ data, assessee }) {
  const items = [];
  data.notices.filter(n => n.pan === assessee.pan).forEach(n => items.push({
    when: n.date || n.createdAt?.slice(0, 10) || "", icon: "doc", color: "primary",
    title: `Notice ${n.section ? `u/s ${n.section}` : ""} received — ${n.authority}`,
    desc: n.din ? `DIN ${n.din}` : (n.subject || ""),
  }));
  data.hearings.filter(h => h.pan === assessee.pan).forEach(h => items.push({
    when: h.date, icon: "calendar", color: "pink",
    title: `${h.authority} hearing ${h.date < todayISO() ? "held" : "scheduled"}`,
    desc: `${h.bench} · AY ${h.ay} · ${h.time}`,
  }));
  data.invoices.filter(i => i.assessee === assessee.name).forEach(i => items.push({
    when: i.date, icon: "invoice", color: "info",
    title: `Invoice ${i.number} raised`,
    desc: `${fmtINR(i.amount)} · ${i.service}${i.due ? ` · Due ${fmtDate(i.due)}` : ""}`,
  }));
  data.communications.filter(c => c.to === assessee.name).forEach(c => items.push({
    when: (c.time || "").slice(0, 10), icon: c.channel === "WhatsApp" ? "whatsapp" : "mail", color: "success",
    title: `${c.channel} sent — ${c.template || "message"}`,
    desc: c.subject,
  }));
  items.sort((x, y) => (y.when || "").localeCompare(x.when || ""));
  const shown = items.slice(0, 6);
  const colorMap = { primary: "var(--p-primary)", success: "var(--p-success)", info: "var(--p-info)", pink: "#C13388" };

  if (shown.length === 0) return <div className="muted" style={{fontSize: 13, padding: 8}}>No activity recorded yet.</div>;

  return (
    <div style={{position: "relative", paddingLeft: 8}}>
      <div style={{position: "absolute", left: 17, top: 8, bottom: 8, width: 2, background: "var(--p-lavender-2)"}}/>
      <div className="col" style={{gap: 14}}>
        {shown.map((it, i) => (
          <div key={i} className="center" style={{gap: 14, alignItems: "flex-start", position: "relative"}}>
            <div style={{width: 28, height: 28, borderRadius: 9, background: "white", border: `2px solid ${colorMap[it.color]}`, color: colorMap[it.color], display: "grid", placeItems: "center", flexShrink: 0, zIndex: 1}}>
              <Icon name={it.icon} size={13}/>
            </div>
            <div style={{flex: 1}}>
              <div className="between">
                <div style={{fontWeight: 700, fontSize: 13.5}}>{it.title}</div>
                <div className="muted" style={{fontSize: 11.5}}>{it.when ? fmtDate(it.when) : ""}</div>
              </div>
              <div className="muted" style={{fontSize: 12.5, marginTop: 2}}>{it.desc}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
