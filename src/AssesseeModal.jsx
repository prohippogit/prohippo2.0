/* ProHippo — Add / edit assessee modal.
   Standalone so every register (notices, matters, hearings, invoices,
   communications) can open it when a record needs an assessee that
   doesn't exist yet. */
import React from 'react';
import { Icon, Modal, FormField, TextInput, SelectInput } from './shared';
import { useData, nextColor } from './store';
import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';
import { detectExtension, openPortalLogin, onSyncData } from './portalSync';

const STATUS_OPTIONS = ["Individual", "Company", "Firm", "LLP", "HUF", "Trust", "AOP/BOI"];

export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

// Income-tax state codes → names (from the portal's own master table), used to
// turn the numeric commnState in the profile into a readable address.
const STATE_CODES = {"1":"Andaman And Nicobar Islands","2":"Andhra Pradesh","3":"Arunachal Pradesh","4":"Assam","5":"Bihar","6":"Chandigarh","7":"Dadra & Nagar Haveli","8":"Daman and Diu","9":"Delhi","10":"Goa","11":"Gujarat","12":"Haryana","13":"Himachal Pradesh","14":"Jammu and Kashmir","15":"Karnataka","16":"Kerala","17":"Lakshadweep","18":"Madhya Pradesh","19":"Maharashtra","20":"Manipur","21":"Meghalaya","22":"Mizoram","23":"Nagaland","24":"Odisha","25":"Puducherry","26":"Punjab","27":"Rajasthan","28":"Sikkim","29":"Tamil Nadu","30":"Tripura","31":"Uttar Pradesh","32":"West Bengal","33":"Chhattisgarh","34":"Uttarakhand","35":"Jharkhand","36":"Telangana","37":"Ladakh","99":"Foreign"};

const MONTHS = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };

// The portal's 4th PAN character encodes the holder type.
function entityFromPan(pan) {
  const p = (pan || "").toUpperCase();
  if (!/^[A-Z]{4}/.test(p)) return "";
  return { P: "Individual", C: "Company", H: "HUF", F: "Firm", A: "AOP/BOI", B: "AOP/BOI", T: "Trust" }[p[3]] || "";
}

// DOB / date-of-incorporation → YYYY-MM-DD. Prefer the portal's "10-Mar-1978"
// string; fall back to the epoch (which is midnight IST).
function itdDate(m) {
  const s = (m.incorporateDate || "").trim();
  const mm = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  if (mm && MONTHS[mm[2]]) return `${mm[3]}-${MONTHS[mm[2]]}-${mm[1].padStart(2, "0")}`;
  if (m.dobEpoch) {
    const d = new Date(Number(m.dobEpoch) + 5.5 * 3600 * 1000);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return "";
}

export function AssesseeModal({ initial, onClose, onSaved }) {
  const { data, addAssessee, updateAssessee, notify } = useData();
  const [form, setForm] = React.useState({
    name: "", pan: "", status: "Individual", group: "", mobile: "", email: "", staff: "", address: "", dob: "", jurisdiction: null,
    ...initial,
  });
  const set = (k) => (v) => setForm(f => ({ ...f, [k]: v }));
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

  // Auto-fill from the portal.
  const [statusTouched, setStatusTouched] = React.useState(false);
  const [fetching, setFetching] = React.useState(false);
  const [fromPortal, setFromPortal] = React.useState({}); // { field: true } for the "from portal" tag
  const clientRef = React.useRef(null);   // correlates the fetch to this (unsaved) form
  const fullSyncArmed = React.useRef(false); // "Fetch all data" → also sync e-Proceedings after save

  // PAN edit → uppercase + auto-pick the entity type (until the user overrides it).
  const onPan = (v) => setForm(f => {
    const up = (v || "").toUpperCase();
    const next = { ...f, pan: up };
    if (!statusTouched) { const s = entityFromPan(up); if (s) next.status = s; }
    return next;
  });
  const onStatus = (v) => { setStatusTouched(true); set("status")(v); };

  // Fill the form from a fetched profile. Everything remains editable.
  const applyMaster = React.useCallback((m) => {
    const name = [m.firstNm, m.midNm, m.surname].map(s => (s || "").trim()).filter(Boolean).join(" ");
    const stateName = STATE_CODES[String(m.stateCode)] || "";
    const address = [...(m.addrLines || []).map(x => (x || "").trim()).filter(Boolean), stateName, m.pin].filter(Boolean).join(", ");
    const dob = itdDate(m);
    const filled = {};
    setForm(f => {
      const next = { ...f };
      if (name) { next.name = name; filled.name = true; }
      if (dob) { next.dob = dob; filled.dob = true; }
      if (address) { next.address = address; filled.address = true; }
      if (m.email) { next.email = m.email; filled.email = true; }
      if (m.mobile) { next.mobile = m.mobile; filled.mobile = true; }
      if (m.jurisdiction && (m.jurisdiction.ward || m.jurisdiction.aoEmail)) { next.jurisdiction = m.jurisdiction; filled.jurisdiction = true; }
      const ent = entityFromPan(next.pan); if (ent) next.status = ent;
      return next;
    });
    setFromPortal(fp => ({ ...fp, ...filled }));
    setFetching(false);
    notify("Master data filled in — review and save.");
  }, [notify]);

  // Listen for the profile the extension streams back after a "master" fetch.
  React.useEffect(() => {
    const off = onSyncData((payload) => {
      if (!payload) return;
      if (payload.kind === "master" && payload.master && payload.master.clientRef === clientRef.current) applyMaster(payload.master);
      else if (payload.kind === "master-done" && payload.clientRef === clientRef.current) setFetching(false);
    });
    return off;
  }, [applyMaster]);

  const fetchMaster = async (fullSync) => {
    if (fetching) return;
    if (!PAN_RE.test(pan)) { notify("Enter a valid PAN first.", "alert"); return; }
    if (!portalPassword.trim()) { notify("Enter the portal password to fetch.", "alert"); return; }
    const ref = "cr-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    clientRef.current = ref;
    fullSyncArmed.current = Boolean(fullSync);
    setFetching(true);
    try {
      const ok = await detectExtension();
      if (!ok) { notify("Install / enable the ProHippo Sync extension to fetch.", "alert"); setFetching(false); return; }
      await openPortalLogin({ portalUserId: (portalUserId.trim() || pan), portalPassword: portalPassword.trim(), assesseeId: null, mode: "master", clientRef: ref });
      notify("Fetching master data — watch the portal tab…");
    } catch (e) {
      notify(e?.message?.slice(0, 120) || "Couldn't open the portal.", "alert");
      setFetching(false);
    }
  };

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
      if (portalPassword.trim() && portalConsent) {
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
      } else if (portalPassword.trim() && !portalConsent && !fullSyncArmed.current) {
        notify("Tick the consent box to store the portal password.", "alert");
      }

      // "Fetch all data" → kick the e-Proceedings sync now with the entered
      // password; opening the assessee's profile (below) lets its portal card
      // ingest the streamed notices/orders.
      const doFullSync = fullSyncArmed.current && portalPassword.trim();
      if (doFullSync) {
        try {
          await openPortalLogin({ portalUserId: (portalUserId.trim() || pan), portalPassword: portalPassword.trim(), assesseeId, mode: "sync", knownDins: [] });
          notify("Fetching e-Proceedings — watch the portal tab…");
        } catch (e) { console.error("full sync start failed", e); }
      } else {
        notify(initial?.id ? `${rec.name} updated` : `${rec.name} added`);
      }
      onSaved?.(saved, { fullSync: doFullSync });
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

  const lbl = (base, key) => fromPortal[key] ? `${base}  ·  from portal ✓` : base;
  const dobLabel = form.status === "Individual" ? "Date of birth" : "Date of incorporation";
  const j = form.jurisdiction;

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
      {/* Auto-fill from the Income-tax portal — PAN + password + two fetch buttons. */}
      <div style={{padding: "14px 16px", background: "var(--p-lavender-2)", borderRadius: 12, marginBottom: 16}}>
        <div className="center" style={{gap: 8, marginBottom: 4, justifyContent: "flex-start"}}>
          <Icon name="sparkle" size={14}/>
          <div style={{fontWeight: 800, fontSize: 13.5}}>Auto-fill from the Income-tax portal</div>
        </div>
        <div className="muted" style={{fontSize: 11.5, marginBottom: 10}}>
          Enter the PAN and e-filing password, then fetch. Every field below stays editable.
        </div>
        <div className="form-grid" style={{marginBottom: 10}}>
          <FormField label="PAN" required>
            <TextInput value={form.pan} onChange={onPan} placeholder="ABCPS1234F" mono/>
            {duplicate && <div style={{fontSize: 11.5, color: "var(--p-danger)", marginTop: 4}}>An assessee with this PAN already exists.</div>}
          </FormField>
          <FormField label="Portal password">
            <TextInput value={portalPassword} onChange={setPortalPassword} type="password" placeholder="••••••••"/>
          </FormField>
        </div>
        <div className="row" style={{gap: 8, flexWrap: "wrap"}}>
          <button className="btn btn-primary btn-sm" disabled={fetching} onClick={() => fetchMaster(false)}>
            <Icon name="download" size={13}/>{fetching ? "Fetching…" : "Fetch master data only"}
          </button>
          <button className="btn btn-secondary btn-sm" disabled={fetching} onClick={() => fetchMaster(true)}>
            <Icon name="sparkle" size={13}/>Fetch all data (incl. e-Proceedings)
          </button>
        </div>
        <div className="muted" style={{fontSize: 11, marginTop: 8}}>
          Fetches name, date of birth, address, mobile, email and jurisdiction / Assessing Officer. Anything the portal doesn't return, just fill in manually.
        </div>
      </div>

      <div className="form-grid">
        <FormField label={lbl("Name", "name")} required full><TextInput value={form.name} onChange={set("name")} placeholder="Assessee name"/></FormField>
        <FormField label="Status"><SelectInput value={form.status} onChange={onStatus} options={STATUS_OPTIONS}/></FormField>
        <FormField label={lbl(dobLabel, "dob")}><TextInput value={form.dob} onChange={set("dob")} type="date"/></FormField>
        <FormField label="Group"><TextInput value={form.group} onChange={set("group")} placeholder="e.g. Shah Group"/></FormField>
        <FormField label="Assigned staff"><TextInput value={form.staff} onChange={set("staff")} placeholder="Staff name"/></FormField>
        <FormField label={lbl("Mobile", "mobile")}><TextInput value={form.mobile} onChange={set("mobile")} placeholder="+91 …"/></FormField>
        <FormField label={lbl("Email", "email")}><TextInput value={form.email} onChange={set("email")} type="email" placeholder="name@example.com"/></FormField>
        <FormField label={lbl("Address", "address")} full><TextInput value={form.address} onChange={set("address")} placeholder="Address"/></FormField>
      </div>

      {j && (j.ward || j.aoEmail) && (
        <div style={{marginTop: 12, padding: "10px 12px", background: "var(--p-card-tint)", borderRadius: 10, fontSize: 12}}>
          <div className="center" style={{gap: 6, justifyContent: "flex-start", marginBottom: 3}}>
            <Icon name="scale" size={12}/>
            <span style={{fontWeight: 800}}>Jurisdiction / Assessing Officer</span>
            {fromPortal.jurisdiction && <span className="muted">· from portal ✓</span>}
          </div>
          {(j.ward || j.building || j.area) && <div className="muted">{[j.ward, j.building, j.area].filter(Boolean).join(" · ")}</div>}
          {j.aoEmail && <div className="muted">AO email: {j.aoEmail}</div>}
        </div>
      )}

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
            <div style={{flex: 1, fontSize: 12.5}}>Portal login is saved{initial?.portalUserId ? ` for ${initial.portalUserId}` : ""}. Enter a new password above/below to replace it.</div>
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
