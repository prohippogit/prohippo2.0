/* ProHippo — Add / edit assessee modal.
   Standalone so every register (notices, matters, hearings, invoices,
   communications) can open it when a record needs an assessee that
   doesn't exist yet. */
import React from 'react';
import { Icon, Modal, FormField, TextInput, SelectInput, ComboBox } from './shared';
import { useData, nextColor, groupsOf } from './store';
import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';
import { detectExtension, openPortalLogin, onSyncData } from './portalSync';
import { ExtensionDownloadButton } from './ExtensionDownload';

const STATUS_OPTIONS = ["Individual", "Company", "Firm", "LLP", "HUF", "Trust", "AOP/BOI"];

export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

// Income-tax state codes → names (from the portal's own master table), used to
// turn the numeric commnState in the profile into a readable address.
const STATE_CODES = {"1":"Andaman And Nicobar Islands","2":"Andhra Pradesh","3":"Arunachal Pradesh","4":"Assam","5":"Bihar","6":"Chandigarh","7":"Dadra & Nagar Haveli","8":"Daman and Diu","9":"Delhi","10":"Goa","11":"Gujarat","12":"Haryana","13":"Himachal Pradesh","14":"Jammu and Kashmir","15":"Karnataka","16":"Kerala","17":"Lakshadweep","18":"Madhya Pradesh","19":"Maharashtra","20":"Manipur","21":"Meghalaya","22":"Mizoram","23":"Nagaland","24":"Odisha","25":"Puducherry","26":"Punjab","27":"Rajasthan","28":"Sikkim","29":"Tamil Nadu","30":"Tripura","31":"Uttar Pradesh","32":"West Bengal","33":"Chhattisgarh","34":"Uttarakhand","35":"Jharkhand","36":"Telangana","37":"Ladakh","99":"Foreign"};

const MONTHS = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };

/* Correlates a "fetch master data" request with the reply the extension streams
   back, so a stale reply can't fill the form for a PAN the user has since
   changed. Module-level, so two open modals can't mint the same ref — and a
   plain counter beats the timestamp+random it replaces, which could collide
   inside a single millisecond. */
let clientRefSeq = 0;
const nextClientRef = () => `cr-${++clientRefSeq}`;

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
  // Suggest existing groups so the same group isn't re-created via a typo.
  const groupOptions = groupsOf(data).map((g) => ({ value: g.name, label: g.name, sub: `${g.members.length} assessee${g.members.length === 1 ? "" : "s"}` }));
  const pan = form.pan.trim().toUpperCase();
  // Flag a duplicate only when ANOTHER saved assessee already has this exact
  // PAN (normalised both sides). Never against the one being edited.
  const dupAssessee = PAN_RE.test(pan)
    ? data.assessees.find((a) => (a.pan || "").trim().toUpperCase() === pan && a.id !== initial?.id)
    : null;
  const duplicate = Boolean(dupAssessee);
  const valid = form.name.trim() && PAN_RE.test(pan) && !duplicate;

  // Income-tax portal login (optional). Stored encrypted via a Cloud Function;
  // the password is never kept in the app's own data.
  const [portalUserId] = React.useState(initial?.portalUserId || ""); // usually the PAN; kept for editing an existing login
  const [portalPassword, setPortalPassword] = React.useState("");
  const [portalConsent, setPortalConsent] = React.useState(false);
  const [credSet, setCredSet] = React.useState(Boolean(initial?.portalCredSet));
  const [busy, setBusy] = React.useState(false);

  // Auto-fill from the portal.
  const [statusTouched, setStatusTouched] = React.useState(false);
  const [fetching, setFetching] = React.useState(false);
  /* Set when a fetch found no extension. "Install the extension" as a toast is
     an instruction with nowhere to go — the download button appears in the box
     instead, right under the button that just failed. */
  const [extMissing, setExtMissing] = React.useState(false);
  const [fromPortal, setFromPortal] = React.useState({}); // { field: true } for the "from portal" tag
  const clientRef = React.useRef(null);   // correlates the fetch to this (unsaved) form
  const savingRef = React.useRef(false);  // hard guard against a double-tap creating two docs

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

  /* Consent gates the FETCH, not just storage. Fetching hands the client's
     e-filing password to the browser extension, which signs into the portal as
     them and pulls their master data — that is the act needing authorisation.
     Gating only the "save the password" step, as before, let the sensitive part
     happen with nothing ticked. */
  const fetchMaster = async () => {
    if (fetching) return;
    if (!PAN_RE.test(pan)) { notify("Enter a valid PAN first.", "alert"); return; }
    if (!portalPassword.trim()) { notify("Enter the portal password to fetch.", "alert"); return; }
    if (!portalConsent) { notify("Tick the authorisation box before fetching from the portal.", "alert"); return; }
    const ref = nextClientRef();
    clientRef.current = ref;
    setFetching(true);
    try {
      const ok = await detectExtension();
      if (!ok) {
        setExtMissing(true);
        notify("Install the ProHippo Sync extension to fetch — download it below.", "alert");
        setFetching(false);
        return;
      }
      setExtMissing(false);
      await openPortalLogin({ portalUserId: (portalUserId.trim() || pan), portalPassword: portalPassword.trim(), assesseeId: null, mode: "master", clientRef: ref });
      notify("Fetching master data — watch the portal tab…");
    } catch (e) {
      notify(e?.message?.slice(0, 120) || "Couldn't open the portal.", "alert");
      setFetching(false);
    }
  };

  const canFetch = PAN_RE.test(pan) && Boolean(portalPassword.trim()) && portalConsent && !fetching;

  const save = async () => {
    if (!valid || busy || savingRef.current) return;
    savingRef.current = true;
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

      /* Store the portal password if one was entered this time.
         Only ONE notify survives — the toast is a single slot, so a warning
         raised here used to be wiped out by the success message below and the
         user was told "added" while the password was silently dropped. Every
         outcome is folded into one message instead. */
      let credNote = "";
      if (portalPassword.trim() && portalConsent) {
        try {
          await httpsCallable(functions, "savePortalCredential")({
            assesseeId,
            portalUserId: (portalUserId.trim() || pan),
            portalPassword: portalPassword.trim(),
          });
        } catch (e) {
          console.error("savePortalCredential failed", e);
          credNote = " — but the portal login couldn't be stored";
        }
      } else if (portalPassword.trim() && !portalConsent) {
        credNote = " — portal login NOT saved (consent box not ticked)";
      }

      const what = initial?.id ? `${rec.name} updated` : `${rec.name} added`;
      notify(what + credNote, credNote ? "alert" : "check");
      onSaved?.(saved);
      onClose();
    } finally {
      setBusy(false);
      savingRef.current = false;
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
          </FormField>
          <FormField label="Portal password">
            {/* NOT a row of bullets. That placeholder was indistinguishable
                from a hidden password, so an empty field looked like a full
                one — press the eye on it and nothing happens, because there is
                nothing there. A saved password cannot be shown here at all: it
                is encrypted server-side and this form has never held it. */}
            <TextInput value={portalPassword} onChange={setPortalPassword} type="password"
              placeholder={credSet ? "Type a new one to replace it" : "Type the e-filing password"}/>
          </FormField>
        </div>

        {/* The authorisation gate sits ABOVE the button it governs — a consent
            box below the action it permits is a box nobody reads. */}
        {portalPassword.trim() && (
          <label className="center" style={{gap: 8, marginBottom: 10, fontSize: 11.5, cursor: "pointer", alignItems: "flex-start"}}>
            <input type="checkbox" checked={portalConsent} onChange={e => setPortalConsent(e.target.checked)} style={{marginTop: 2}}/>
            <span className="muted">I confirm the assessee has authorised ProHippo to sign in to their income-tax portal account for compliance work, and to store the login encrypted for future one-click syncs.</span>
          </label>
        )}

        <div className="row" style={{gap: 8, flexWrap: "wrap", alignItems: "center"}}>
          <button
            className="btn btn-primary btn-sm"
            disabled={!canFetch}
            style={{opacity: canFetch ? 1 : 0.5}}
            title={
              fetching ? "Fetching…"
                : !PAN_RE.test(pan) ? "Enter a valid PAN first"
                  : !portalPassword.trim() ? "Enter the portal password to fetch"
                    : !portalConsent ? "Tick the authorisation box above before fetching"
                      : "Sign in to the portal and pull this assessee's master data"
            }
            onClick={fetchMaster}
          >
            <Icon name="download" size={13}/>{fetching ? "Fetching…" : "Fetch master data"}
          </button>
          {portalPassword.trim() && !portalConsent && !fetching && (
            <span className="center" style={{gap: 5, fontSize: 11.5, color: "#B07512"}}>
              <Icon name="alert" size={12}/>Tick the box above to enable
            </span>
          )}
        </div>
        {extMissing && (
          <div style={{marginTop: 10, padding: "10px 12px", background: "var(--p-amber)", borderRadius: 11}}>
            <div className="center" style={{gap: 8, alignItems: "flex-start", justifyContent: "flex-start"}}>
              <Icon name="info" size={14}/>
              <div style={{flex: 1, fontSize: 12, lineHeight: 1.5}}>
                Fetching needs the <b>ProHippo Sync</b> Chrome extension, which isn't installed in this browser. Download it, load it once, then press Fetch again.
                {" "}(No Chrome? The <b>Sync Connector</b> desktop app can add an assessee from the portal without any extension.)
              </div>
            </div>
            <div style={{marginTop: 9}}>
              <ExtensionDownloadButton className="btn btn-primary btn-sm" label="Download extension" onRecheck={() => setExtMissing(false)}/>
            </div>
          </div>
        )}
        <div className="muted" style={{fontSize: 11, marginTop: 8}}>
          Fetches name, date of birth, address, mobile, email and jurisdiction / Assessing Officer. Anything the portal doesn't return, just fill in manually.
        </div>

        {credSet && (
          <div className="center" style={{gap: 10, padding: "10px 12px", background: "var(--p-mint)", borderRadius: 11, marginTop: 12}}>
            <Icon name="check" size={14}/>
            <div style={{flex: 1, fontSize: 12.5}}>Portal login is saved{initial?.portalUserId ? ` for ${initial.portalUserId}` : ""}. Enter a new password above to replace it.</div>
            <button className="btn btn-ghost btn-xs" onClick={removePortalLogin}><Icon name="trash" size={12}/>Remove</button>
          </div>
        )}
      </div>

      {/* A blocked save needs to say WHO it clashes with, not just that it
          clashes — otherwise someone who added this assessee minutes ago has no
          way to tell it is the same record and tries again. */}
      {duplicate && (
        <div style={{padding: "12px 14px", background: "#FFF3F3", border: "1px solid var(--p-danger)", borderRadius: 12, marginBottom: 16}}>
          <div className="center" style={{gap: 10, alignItems: "flex-start"}}>
            <div style={{width: 30, height: 30, borderRadius: 10, background: "white", color: "var(--p-danger)", display: "grid", placeItems: "center", flexShrink: 0}}>
              <Icon name="alert" size={15}/>
            </div>
            <div style={{flex: 1, minWidth: 0}}>
              <div style={{fontWeight: 800, fontSize: 13.5}}>This PAN is already on your list</div>
              <div style={{fontSize: 12.5, marginTop: 4, lineHeight: 1.5}}>
                <b>{dupAssessee.name || "—"}</b>
                <span className="muted" style={{fontFamily: "ui-monospace, monospace"}}> · {dupAssessee.pan}</span>
                {dupAssessee.status ? <span className="muted"> · {dupAssessee.status}</span> : null}
                {dupAssessee.group ? <span className="muted"> · {dupAssessee.group}</span> : null}
                {(dupAssessee.mobile || dupAssessee.email) && (
                  <div className="muted" style={{marginTop: 2}}>{[dupAssessee.mobile, dupAssessee.email].filter(Boolean).join(" · ")}</div>
                )}
              </div>
              <div className="muted" style={{fontSize: 11.5, marginTop: 7}}>
                Close this and open that assessee to edit them. A PAN can only appear once — every notice, hearing and invoice hangs off it.
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="form-grid">
        <FormField label={lbl("Name", "name")} required full><TextInput value={form.name} onChange={set("name")} placeholder="Assessee name"/></FormField>
        <FormField label="Status"><SelectInput value={form.status} onChange={onStatus} options={STATUS_OPTIONS}/></FormField>
        <FormField label={lbl(dobLabel, "dob")}><TextInput value={form.dob} onChange={set("dob")} type="date"/></FormField>
        <FormField label="Group"><ComboBox value={form.group} onChange={set("group")} options={groupOptions} placeholder="e.g. Shah Group"/></FormField>
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
