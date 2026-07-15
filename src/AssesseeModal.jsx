/* ProHippo — Add / edit assessee modal.
   Standalone so every register (notices, matters, hearings, invoices,
   communications) can open it when a record needs an assessee that
   doesn't exist yet. */
import React from 'react';
import { Icon, Modal, FormField, TextInput, SelectInput } from './shared';
import { useData, nextColor } from './store';
import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';

const STATUS_OPTIONS = ["Individual", "Company", "Firm", "LLP", "HUF", "Trust", "AOP/BOI"];

export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export function AssesseeModal({ initial, onClose, onSaved }) {
  const { data, addAssessee, updateAssessee, notify } = useData();
  const [form, setForm] = React.useState({
    name: "", pan: "", status: "Individual", group: "", mobile: "", email: "", staff: "", address: "",
    ...initial,
  });
  const set = (k) => (v) => setForm(f => ({ ...f, [k]: k === "pan" ? v.toUpperCase() : v }));
  const pan = form.pan.trim();
  const duplicate = PAN_RE.test(pan) && data.assessees.some(a => a.pan === pan && a.id !== initial?.id);
  const valid = form.name.trim() && PAN_RE.test(pan) && !duplicate;

  // Income-tax portal login (optional). Stored encrypted via a Cloud Function;
  // the password is never kept in the app's own data.
  const [portalUserId, setPortalUserId] = React.useState(initial?.portalUserId || "");
  const [portalPassword, setPortalPassword] = React.useState("");
  const [portalConsent, setPortalConsent] = React.useState(false);
  const [credSet, setCredSet] = React.useState(Boolean(initial?.portalCredSet));
  const [busy, setBusy] = React.useState(false);

  const save = async () => {
    if (!valid || busy) return;
    const rec = { ...form, name: form.name.trim(), pan };
    let assesseeId = initial?.id;
    let saved;
    setBusy(true);
    try {
      if (assesseeId) {
        updateAssessee(assesseeId, rec);
        saved = { ...initial, ...rec };
      } else {
        saved = await addAssessee({ ...rec, color: nextColor(data.assessees) });
        if (!saved) { setBusy(false); return; }
        assesseeId = saved.id;
      }

      // Store the portal password if one was entered this time.
      if (portalPassword.trim()) {
        if (!portalConsent) {
          notify("Tick the consent box to store the portal password.", "alert");
          setBusy(false);
          return;
        }
        try {
          await httpsCallable(functions, "savePortalCredential")({
            assesseeId,
            portalUserId: (portalUserId.trim() || pan),
            portalPassword: portalPassword.trim(),
          });
        } catch (e) {
          console.error("savePortalCredential failed", e);
          notify("Assessee saved, but the portal login couldn't be stored.", "alert");
        }
      }
      notify(initial?.id ? `${rec.name} updated` : `${rec.name} added`);
      onSaved?.(saved);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const removePortalLogin = async () => {
    if (!initial?.id) return;
    if (!window.confirm("Remove the stored income-tax portal login for this assessee?")) return;
    try {
      await httpsCallable(functions, "deletePortalCredential")({ assesseeId: initial.id });
      setCredSet(false);
      setPortalPassword("");
      notify("Portal login removed");
    } catch (e) {
      console.error(e);
      notify("Couldn't remove the portal login.", "alert");
    }
  };

  return (
    <Modal
      title={initial?.id ? "Edit assessee" : "Add assessee"}
      sub="PAN is validated in the standard format (e.g. ABCPS1234F)"
      onClose={onClose}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid || busy} style={{opacity: (valid && !busy) ? 1 : 0.5}} onClick={save}>
          <Icon name="check" size={14}/>{busy ? "Saving…" : initial?.id ? "Save changes" : "Add assessee"}
        </button>
      </>}
    >
      <div className="form-grid">
        <FormField label="Name" required full><TextInput value={form.name} onChange={set("name")} placeholder="Assessee name"/></FormField>
        <FormField label="PAN" required>
          <TextInput value={form.pan} onChange={set("pan")} placeholder="ABCPS1234F" mono/>
          {duplicate && <div style={{fontSize: 11.5, color: "var(--p-danger)", marginTop: 4}}>An assessee with this PAN already exists.</div>}
        </FormField>
        <FormField label="Status"><SelectInput value={form.status} onChange={set("status")} options={STATUS_OPTIONS}/></FormField>
        <FormField label="Group"><TextInput value={form.group} onChange={set("group")} placeholder="e.g. Shah Group"/></FormField>
        <FormField label="Assigned staff"><TextInput value={form.staff} onChange={set("staff")} placeholder="Staff name"/></FormField>
        <FormField label="Mobile"><TextInput value={form.mobile} onChange={set("mobile")} placeholder="+91 …"/></FormField>
        <FormField label="Email"><TextInput value={form.email} onChange={set("email")} type="email" placeholder="name@example.com"/></FormField>
        <FormField label="Address" full><TextInput value={form.address} onChange={set("address")} placeholder="Address"/></FormField>
      </div>

      <div style={{marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--p-line)"}}>
        <div className="center" style={{gap: 8, marginBottom: 4}}>
          <Icon name="link" size={14}/>
          <div style={{fontWeight: 700, fontSize: 13.5}}>Income-tax portal login <span className="muted" style={{fontWeight: 500}}>· optional</span></div>
        </div>
        <div className="muted" style={{fontSize: 11.5, marginBottom: 12}}>
          Lets ProHippo open the e-filing portal already logged in for this assessee. The password is stored encrypted and is never shown again.
        </div>
        {credSet ? (
          <div className="center" style={{gap: 10, padding: "10px 12px", background: "var(--p-mint)", borderRadius: 11, marginBottom: 12}}>
            <Icon name="check" size={14}/>
            <div style={{flex: 1, fontSize: 12.5}}>Portal login is saved{initial?.portalUserId ? ` for ${initial.portalUserId}` : ""}. Enter a new password below to replace it.</div>
            <button className="btn btn-ghost btn-xs" onClick={removePortalLogin}><Icon name="trash" size={12}/>Remove</button>
          </div>
        ) : null}
        <div className="form-grid">
          <FormField label="Portal user ID (usually PAN)">
            <TextInput value={portalUserId} onChange={setPortalUserId} placeholder={pan || "PAN / user ID"} mono/>
          </FormField>
          <FormField label={credSet ? "New portal password" : "Portal password"}>
            <TextInput value={portalPassword} onChange={setPortalPassword} type="password" placeholder="••••••••"/>
          </FormField>
        </div>
        {portalPassword.trim() && (
          <label className="center" style={{gap: 8, marginTop: 10, fontSize: 12, cursor: "pointer", alignItems: "flex-start"}}>
            <input type="checkbox" checked={portalConsent} onChange={e => setPortalConsent(e.target.checked)} style={{marginTop: 2}}/>
            <span className="muted">I confirm the assessee has authorised storing their income-tax portal login for compliance work, and I understand it will be stored encrypted by ProHippo.</span>
          </label>
        )}
      </div>
    </Modal>
  );
}

/* Inline banner shown in entry forms when the record can't be saved
   because no matching assessee profile exists yet. */
export function AssesseeRequiredNote({ message, actionLabel = "Add assessee", onCreate }) {
  return (
    <div className="center" style={{gap: 10, padding: "10px 12px", background: "var(--p-amber)", borderRadius: 11, border: "1px solid var(--p-line-2)", alignItems: "center"}}>
      <div style={{width: 28, height: 28, borderRadius: 9, background: "white", color: "#B07512", display: "grid", placeItems: "center", flexShrink: 0}}>
        <Icon name="alert" size={14}/>
      </div>
      <div style={{flex: 1, fontSize: 12.5, lineHeight: 1.45}}>{message}</div>
      <button className="btn btn-primary btn-sm" style={{flexShrink: 0}} onClick={onCreate}><Icon name="plus" size={12}/>{actionLabel}</button>
    </div>
  );
}
