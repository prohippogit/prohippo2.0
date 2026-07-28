/* ProHippo — document request composer.
 *
 * A document request is not a message: it is a tracked checklist that EMITS
 * messages. That is why it lives in its own collection rather than as free
 * text on a communication — it survives being sent, items get ticked off as
 * they arrive, and the same request can go out on more than one channel.
 *
 * Opened from a notice (items pre-filled from what the notice called for), from
 * an assessee, or from a draft in Communications.
 */
import React from 'react';
import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';
import { Icon, Modal, FormField, TextInput, EmptyState, titleCase, fmtDateLong } from './shared';
import { useData, newDocItem, docRequestProgress, derivedRequestStatus, todayISO } from './store';
import { renderDocRequest, defaultTitle, whatsappLink } from './messageTemplates';
import { presetsFor } from './docRequestPresets';

const REQUEST_STATUS_LABEL = {
  draft: "Draft", sent: "Sent", partial: "Partly received",
  complete: "All received", failed: "Send failed",
};

export const RequestStatusPill = ({ status }) => {
  const tone = { draft: "muted", sent: "info", partial: "warning", complete: "success", failed: "danger" }[status] || "muted";
  return <span className={`pill pill-${tone}`}><span className="pill-dot" style={{background: "currentColor"}}/>{REQUEST_STATUS_LABEL[status] || status}</span>;
};

/* One checklist row. Kept editable in place — a practitioner tightening the
   wording of an item shouldn't have to open a sub-form to do it. */
function ItemRow({ item, index, count, sent, onChange, onMove, onRemove }) {
  const received = item.status === "received";
  const waived = item.status === "waived";
  return (
    <div
      className="center"
      style={{
        gap: 8, padding: "8px 10px", borderRadius: 11,
        background: received ? "var(--p-mint)" : waived ? "var(--p-card-tint)" : "white",
        border: "1px solid var(--p-line-2)", opacity: waived ? 0.65 : 1,
      }}
    >
      <div style={{width: 22, height: 22, borderRadius: 7, background: "var(--p-card-tint)", display: "grid", placeItems: "center", fontSize: 11, fontWeight: 800, color: "var(--p-primary-2)", flexShrink: 0}}>
        {index + 1}
      </div>
      <input
        value={item.label}
        placeholder="Document required…"
        onChange={(e) => onChange({ ...item, label: e.target.value })}
        style={{
          flex: 1, border: "none", background: "transparent", padding: "2px 0", fontSize: 13,
          textDecoration: received || waived ? "line-through" : "none",
        }}
      />
      {sent && (
        <button
          className="btn btn-ghost btn-xs"
          title={received ? "Mark as still pending" : "Mark as received"}
          onClick={() => onChange({ ...item, status: received ? "pending" : "received", receivedAt: received ? "" : todayISO() })}
          style={{color: received ? "#1B8C5C" : "var(--p-text-3)"}}
        >
          <Icon name="check" size={13} stroke={received ? 3 : 2}/>
        </button>
      )}
      <button className="btn btn-ghost btn-xs" title="Move up" disabled={index === 0} onClick={() => onMove(index, -1)} style={{opacity: index === 0 ? 0.3 : 1}}>
        <span style={{display: "flex", transform: "rotate(180deg)"}}><Icon name="chevron-down" size={12}/></span>
      </button>
      <button className="btn btn-ghost btn-xs" title="Move down" disabled={index === count - 1} onClick={() => onMove(index, 1)} style={{opacity: index === count - 1 ? 0.3 : 1}}>
        <Icon name="chevron-down" size={12}/>
      </button>
      <button className="btn btn-ghost btn-xs" title="Remove" onClick={() => onRemove(index)}><Icon name="trash" size={12}/></button>
    </div>
  );
}

export default function DocumentRequestComposer({ request, seed, onClose }) {
  const { data, profile, addDocRequest, updateDocRequest, removeDocRequest, addCommunication, notify } = useData();
  const isNew = !request?.id;

  const [form, setForm] = React.useState(() => ({
    assesseeId: "", assessee: "", pan: "", noticeId: "", ay: "", authority: "", section: "", din: "",
    title: "", dueDate: "", note: "", items: [], channels: ["email"], status: "draft",
    ...seed, ...request,
  }));
  const [newItem, setNewItem] = React.useState("");
  const [tab, setTab] = React.useState("Email");
  const [showPresets, setShowPresets] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const assessee = data.assessees.find((a) => a.id === form.assesseeId) || null;
  const sent = Boolean(form.sentAt);
  const progress = docRequestProgress(form);

  // Everything the message needs, with the title defaulted the same way the
  // stored copy will be, so preview and sent copy can't disagree.
  const preview = React.useMemo(
    () => renderDocRequest({ request: form, assessee, profile }),
    [form, assessee, profile]
  );

  const askable = (form.items || []).filter((i) => i.status !== "received" && i.status !== "waived");
  const canSend = Boolean(assessee) && askable.length > 0;
  const hasEmail = Boolean((assessee?.email || "").trim());
  const hasMobile = Boolean((assessee?.mobile || "").trim());

  const addItem = (label) => {
    const text = (label || "").trim();
    if (!text) return;
    setForm((f) => ({ ...f, items: [...(f.items || []), newDocItem(text)] }));
  };
  const changeItem = (i, next) => setForm((f) => ({ ...f, items: f.items.map((it, j) => (j === i ? next : it)) }));
  const removeItem = (i) => setForm((f) => ({ ...f, items: f.items.filter((_, j) => j !== i) }));
  const moveItem = (i, dir) => setForm((f) => {
    const items = [...f.items];
    const j = i + dir;
    if (j < 0 || j >= items.length) return f;
    [items[i], items[j]] = [items[j], items[i]];
    return { ...f, items };
  });
  const toggleChannel = (ch) => setForm((f) => ({
    ...f,
    channels: (f.channels || []).includes(ch) ? f.channels.filter((c) => c !== ch) : [...(f.channels || []), ch],
  }));

  // Add only the preset items not already on the list, so applying two
  // overlapping presets doesn't produce duplicates.
  const applyPreset = (preset) => {
    const have = new Set((form.items || []).map((i) => i.label.trim().toLowerCase()));
    const fresh = preset.items.filter((label) => !have.has(label.trim().toLowerCase()));
    if (!fresh.length) { notify("Those items are already on the list"); return; }
    setForm((f) => ({ ...f, items: [...(f.items || []), ...fresh.map((l) => newDocItem(l))] }));
  };

  /* Persist and return the saved record (with its id). The rendered message is
     stored alongside the checklist — the sender delivers this copy verbatim. */
  const persist = async (patch = {}) => {
    const rendered = renderDocRequest({ request: { ...form, ...patch }, assessee, profile });
    // `id` must never be written into the document body: the store builds rows
    // as { id: doc.id, ...doc.data() }, so a stored `id` field would shadow the
    // real Firestore id.
    const fields = { ...form };
    delete fields.id;
    const rec = {
      ...fields, ...patch,
      title: (form.title || "").trim() || defaultTitle(form),
      assessee: assessee?.name || form.assessee || "",
      pan: assessee?.pan || form.pan || "",
      message: { subject: rendered.subject, emailHtml: rendered.emailHtml, emailText: rendered.emailText, whatsappText: rendered.whatsappText },
      updatedAt: new Date().toISOString(),
    };
    rec.status = derivedRequestStatus(rec);
    if (isNew) return await addDocRequest(rec);
    await updateDocRequest(request.id, rec);
    return { id: request.id, ...rec };
  };

  const saveDraft = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const saved = await persist();
      if (saved) { notify(sent ? "Request updated" : "Draft saved"); onClose(); }
    } finally { setBusy(false); }
  };

  const sendEmail = async () => {
    if (busy || !canSend) return;
    if (!hasEmail) { notify(`No email address on file for ${titleCase(assessee.name)} — add one on their profile`, "alert"); return; }
    setBusy(true);
    try {
      const saved = await persist();
      if (!saved) return;
      await httpsCallable(functions, "sendClientMessage")({ requestId: saved.id, channel: "email" });
      notify(`Email sent to ${assessee.email}`);
      onClose();
    } catch (e) {
      console.error("sendClientMessage", e);
      notify(e?.message || "Couldn't send the email — try again in a moment", "alert");
    } finally { setBusy(false); }
  };

  /* WhatsApp is a hand-off, not a send: we open wa.me with the message
     pre-filled and the practitioner presses send there. The log says exactly
     that — claiming "Sent" for a tab we merely opened would be a lie, and this
     log is what gets shown to a client who says they never received the list. */
  const sendWhatsApp = async () => {
    if (busy || !canSend) return;
    const link = whatsappLink(assessee, preview.whatsappText);
    if (!link) { notify(`No mobile number on file for ${titleCase(assessee.name)} — add one on their profile`, "alert"); return; }
    setBusy(true);
    try {
      const saved = await persist({ sentAt: form.sentAt || new Date().toISOString() });
      if (!saved) return;
      window.open(link, "_blank", "noopener");
      const now = new Date().toISOString();
      addCommunication({
        channel: "WhatsApp", to: assessee.mobile, assesseeId: assessee.id, assessee: assessee.name,
        requestId: saved.id, subject: preview.subject, body: preview.whatsappText,
        template: "Document request", status: "Opened in WhatsApp", time: now,
      });
      notify("Opened in WhatsApp — press send there to deliver it");
      onClose();
    } finally { setBusy(false); }
  };

  const discard = async () => {
    if (!request?.id) { onClose(); return; }
    if (!window.confirm("Delete this document request?")) return;
    await removeDocRequest(request.id);
    notify("Request deleted");
    onClose();
  };

  return (
    <Modal
      title={isNew ? "Prepare document request" : `Document request — ${titleCase(form.assessee || "")}`}
      sub={sent
        ? `${progress.received} of ${progress.total} received · tick items off as they arrive`
        : "Build the list, preview it, then send or keep it as a draft"}
      onClose={onClose}
      width={1000}
      footer={<>
        {!isNew && <button className="btn btn-ghost" onClick={discard} style={{marginRight: "auto"}}><Icon name="trash" size={14}/>Delete</button>}
        <button className="btn btn-secondary" disabled={busy} onClick={saveDraft}>{sent ? "Save changes" : "Save draft"}</button>
        {(form.channels || []).includes("whatsapp") && (
          <button className="btn btn-secondary" disabled={busy || !canSend} style={{opacity: (canSend && !busy) ? 1 : 0.5}} onClick={sendWhatsApp}>
            <Icon name="whatsapp" size={14}/>WhatsApp
          </button>
        )}
        {(form.channels || []).includes("email") && (
          <button className="btn btn-primary" disabled={busy || !canSend} style={{opacity: (canSend && !busy) ? 1 : 0.5}} onClick={sendEmail}>
            <Icon name="mail" size={14}/>{busy ? "Sending…" : "Send email"}
          </button>
        )}
      </>}
    >
      <div className="grid-split" style={{gap: 20, alignItems: "start"}}>
        {/* ---- left: the checklist ---- */}
        <div className="col" style={{gap: 14}}>
          <div className="form-grid">
            {/* Only shown when the request wasn't opened from a notice or an
                assessee — everywhere else the client is already known. */}
            {!seed?.assesseeId && !request?.assesseeId && (
              <FormField label="Assessee" required full>
                <select value={form.assesseeId} onChange={(e) => set("assesseeId", e.target.value)}>
                  <option value="">{data.assessees.length ? "Select assessee…" : "No assessees yet"}</option>
                  {data.assessees.map((a) => <option key={a.id} value={a.id}>{titleCase(a.name)}</option>)}
                </select>
              </FormField>
            )}
            <FormField label="Subject" full>
              <TextInput value={form.title} onChange={(v) => set("title", v)} placeholder={defaultTitle(form)}/>
            </FormField>
            <FormField label="Documents needed by">
              <TextInput value={form.dueDate || ""} onChange={(v) => set("dueDate", v)} type="date"/>
            </FormField>
            <FormField label="Send on">
              <div className="row" style={{gap: 6}}>
                {[["email", "Email", "mail"], ["whatsapp", "WhatsApp", "whatsapp"]].map(([key, label, icon]) => (
                  <span
                    key={key}
                    className={`fchip ${(form.channels || []).includes(key) ? "active" : ""}`}
                    onClick={() => toggleChannel(key)}
                    style={{display: "inline-flex", alignItems: "center", gap: 5}}
                  >
                    <Icon name={icon} size={12}/>{label}
                  </span>
                ))}
              </div>
            </FormField>
          </div>

          {assessee && (
            <div className="center" style={{gap: 10, padding: "10px 12px", background: "var(--p-card-tint)", borderRadius: 11, fontSize: 12.5}}>
              <Icon name="user" size={14}/>
              <div style={{flex: 1, minWidth: 0}}>
                <div style={{fontWeight: 700}}>{titleCase(assessee.name)}</div>
                <div className="muted" style={{fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis"}}>
                  {assessee.email || <span style={{color: "var(--p-danger)"}}>no email on file</span>}
                  {" · "}
                  {assessee.mobile || <span style={{color: "var(--p-danger)"}}>no mobile on file</span>}
                </div>
              </div>
              {sent && <RequestStatusPill status={derivedRequestStatus(form)}/>}
            </div>
          )}

          <div className="card" style={{padding: 14}}>
            <div className="between" style={{marginBottom: 10}}>
              <div className="card-title" style={{fontSize: 14}}>Checklist</div>
              <div className="center" style={{gap: 6}}>
                <span className="pill pill-primary">{askable.length} to ask for</span>
                <button className="btn btn-ghost btn-xs" onClick={() => setShowPresets((s) => !s)}>
                  <Icon name="sparkle" size={12}/>Standard items
                </button>
              </div>
            </div>

            {showPresets && (
              <div className="col" style={{gap: 6, marginBottom: 12, padding: 10, background: "var(--p-lavender-2)", borderRadius: 11}}>
                <div className="muted" style={{fontSize: 11.5, marginBottom: 2}}>
                  Ordered for this notice. Adds only what isn't already on the list.
                </div>
                <div className="row" style={{gap: 6, flexWrap: "wrap"}}>
                  {presetsFor({ section: form.section, authority: form.authority }).map((p) => (
                    <span key={p.key} className="fchip" onClick={() => applyPreset(p)}>+ {p.label}</span>
                  ))}
                </div>
              </div>
            )}

            <div className="col" style={{gap: 6}}>
              {(form.items || []).map((it, i) => (
                <ItemRow
                  key={it.id || i}
                  item={it} index={i} count={form.items.length} sent={sent}
                  onChange={(next) => changeItem(i, next)}
                  onMove={moveItem}
                  onRemove={removeItem}
                />
              ))}
              {(form.items || []).length === 0 && (
                <EmptyState icon="doc" title="Nothing on the list yet" sub="Add the documents the notice calls for, or start from a standard set above."/>
              )}
              <div className="center" style={{gap: 8, marginTop: 4}}>
                <div className="search" style={{flex: 1}}>
                  <Icon name="plus" size={14}/>
                  <input
                    placeholder="Add a document…"
                    value={newItem}
                    onChange={(e) => setNewItem(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { addItem(newItem); setNewItem(""); } }}
                  />
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => { addItem(newItem); setNewItem(""); }}>Add</button>
              </div>
            </div>
          </div>

          <div className="field">
            <label>Note to the client (optional)</label>
            <textarea
              rows={3}
              value={form.note || ""}
              onChange={(e) => set("note", e.target.value)}
              placeholder="Anything to add beyond the list — e.g. which items are most urgent."
            />
          </div>
        </div>

        {/* ---- right: exactly what the client will get ---- */}
        <div className="col" style={{gap: 10}}>
          <div className="between">
            <div className="card-title" style={{fontSize: 14}}>Preview</div>
            <div className="row" style={{gap: 6}}>
              {["Email", "WhatsApp"].map((t) => (
                <span key={t} className={`fchip ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{t}</span>
              ))}
            </div>
          </div>

          {tab === "Email" ? (
            <div className="col" style={{gap: 8}}>
              <div style={{padding: "10px 12px", background: "var(--p-card-tint)", borderRadius: 11, fontSize: 12.5}}>
                <div><span className="muted">To </span>{assessee?.email || "—"}</div>
                <div style={{marginTop: 3}}><span className="muted">Subject </span><b>{preview.subject}</b></div>
                <div className="muted" style={{fontSize: 11, marginTop: 5}}>
                  Replies go to {profile?.email || "your account email"}.
                </div>
              </div>
              <iframe
                title="Email preview"
                srcDoc={preview.emailHtml}
                sandbox=""
                style={{width: "100%", height: 460, border: "1px solid var(--p-line-2)", borderRadius: 12, background: "#F7F6FB"}}
              />
            </div>
          ) : (
            <div className="col" style={{gap: 8}}>
              <div style={{padding: "10px 12px", background: "var(--p-card-tint)", borderRadius: 11, fontSize: 12.5}}>
                <div><span className="muted">To </span>{assessee?.mobile || "—"}</div>
                <div className="muted" style={{fontSize: 11, marginTop: 5}}>
                  Opens WhatsApp with this text ready — you press send there.
                </div>
              </div>
              <div style={{
                height: 460, overflowY: "auto", padding: 14, borderRadius: 12,
                background: "#E5DDD5", border: "1px solid var(--p-line-2)",
              }}>
                <div style={{
                  background: "#DCF8C6", borderRadius: 10, padding: "10px 12px", fontSize: 12.5,
                  whiteSpace: "pre-wrap", lineHeight: 1.5, color: "#111", boxShadow: "0 1px 1px rgba(0,0,0,0.12)",
                }}>
                  {preview.whatsappText}
                </div>
              </div>
            </div>
          )}

          {!hasEmail && (form.channels || []).includes("email") && (
            <div className="center" style={{gap: 8, padding: "9px 11px", background: "var(--p-amber)", borderRadius: 10, fontSize: 12}}>
              <Icon name="alert" size={13}/>Add an email address on the assessee's profile to send by email.
            </div>
          )}
          {!hasMobile && (form.channels || []).includes("whatsapp") && (
            <div className="center" style={{gap: 8, padding: "9px 11px", background: "var(--p-amber)", borderRadius: 10, fontSize: 12}}>
              <Icon name="alert" size={13}/>Add a mobile number on the assessee's profile to send on WhatsApp.
            </div>
          )}
          {form.dueDate && form.dueDate < todayISO() && (
            <div className="center" style={{gap: 8, padding: "9px 11px", background: "var(--p-coral)", borderRadius: 10, fontSize: 12}}>
              <Icon name="alert" size={13}/>The due date ({fmtDateLong(form.dueDate)}) has already passed.
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
