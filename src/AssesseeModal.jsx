/* ProHippo — Add / edit assessee modal.
   Standalone so every register (notices, matters, hearings, invoices,
   communications) can open it when a record needs an assessee that
   doesn't exist yet. */
import React from 'react';
import { Icon, Modal, FormField, TextInput, SelectInput } from './shared';
import { useData, nextColor } from './store';

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

  const save = async () => {
    if (!valid) return;
    const rec = { ...form, name: form.name.trim(), pan };
    if (initial?.id) {
      updateAssessee(initial.id, rec);
      notify(`${rec.name} updated`);
      onSaved?.({ ...initial, ...rec });
    } else {
      const saved = await addAssessee({ ...rec, color: nextColor(data.assessees) });
      if (!saved) return;
      notify(`${rec.name} added`);
      onSaved?.(saved);
    }
    onClose();
  };

  return (
    <Modal
      title={initial?.id ? "Edit assessee" : "Add assessee"}
      sub="PAN is validated in the standard format (e.g. ABCPS1234F)"
      onClose={onClose}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid} style={{opacity: valid ? 1 : 0.5}} onClick={save}>
          <Icon name="check" size={14}/>{initial?.id ? "Save changes" : "Add assessee"}
        </button>
      </>}
    >
      <div className="grid" style={{gridTemplateColumns: "1fr 1fr", gap: 12}}>
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
