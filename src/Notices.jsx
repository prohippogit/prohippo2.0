/* ProHippo — Notices list + review/entry form */
import React from 'react';
import { Icon, StatusPill, EmptyState, fmtDateLong, daysFromNow } from './shared';
import { useData, awaitingNotices, todayISO } from './store';

function NoticeStat({ label, value, color, icon }) {
  const map = {
    pink: { bg: "var(--p-pink)", fg: "#C13388" },
    info: { bg: "#E1EEFF", fg: "#2766C7" },
    success: { bg: "var(--p-mint)", fg: "#1B8C5C" },
    warning: { bg: "var(--p-amber)", fg: "#B07512" },
  }[color];
  return (
    <div className="card" style={{padding: "16px 18px"}}>
      <div className="between">
        <div>
          <div className="stat-label">{label}</div>
          <div className="stat-value" style={{fontSize: 26}}>{value}</div>
        </div>
        <div style={{width: 38, height: 38, borderRadius: 12, background: map.bg, color: map.fg, display: "grid", placeItems: "center"}}>
          <Icon name={icon} size={18}/>
        </div>
      </div>
    </div>
  );
}

const FILTERS = ["All notices", "Awaiting review", "Scrutiny", "CIT(A)", "ITAT", "Penalty"];

export default function Notices({ onOpenNotice }) {
  const { data, removeNotice, notify } = useData();
  const [filter, setFilter] = React.useState("All notices");

  const awaiting = awaitingNotices(data);
  const monthPrefix = todayISO().slice(0, 7);
  const drafted = data.notices.filter(n => n.status === "Reply drafted");
  const submittedThisMonth = data.notices.filter(n => n.status === "Submitted" && (n.date || "").startsWith(monthPrefix));
  const dueSoon = data.notices.filter(n => n.hearingDate && n.hearingDate >= todayISO() && daysFromNow(n.hearingDate) <= 3);

  const filtered = data.notices.filter(n => {
    if (filter === "All notices") return true;
    if (filter === "Awaiting review") return n.status === "Awaiting review";
    return n.authority === filter;
  }).sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  return (
    <div className="animate-in">
      <div className="topbar">
        <div>
          <div className="page-title">Notices</div>
          <div className="page-sub">
            {data.notices.length
              ? `${data.notices.filter(n => (n.date || "").startsWith(monthPrefix)).length} received this month · ${awaiting.length} awaiting review`
              : "Record incoming notices to track replies and hearings"}
          </div>
        </div>
        <div className="topbar-actions">
          <button className="btn btn-primary" onClick={() => onOpenNotice(null)}><Icon name="upload" size={14}/>Add notice</button>
        </div>
      </div>

      <div className="grid" style={{gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 18}}>
        <NoticeStat label="Awaiting review" value={awaiting.length} color="pink" icon="sparkle"/>
        <NoticeStat label="Reply drafted" value={drafted.length} color="info" icon="edit"/>
        <NoticeStat label="Submitted this month" value={submittedThisMonth.length} color="success" icon="check"/>
        <NoticeStat label="Hearing in 3 days" value={dueSoon.length} color="warning" icon="alert"/>
      </div>

      <div className="card" style={{padding: 0, overflow: "hidden"}}>
        <div className="row" style={{padding: "14px 18px", justifyContent: "space-between", borderBottom: "1px solid var(--p-line-2)", alignItems: "center"}}>
          <div className="row" style={{gap: 6}}>
            {FILTERS.map(f => (
              <span key={f} className={`fchip ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>{f}</span>
            ))}
          </div>
        </div>
        {filtered.length === 0 ? (
          <EmptyState
            icon="doc"
            title={data.notices.length === 0 ? "No notices recorded" : "No notices match this filter"}
            sub={data.notices.length === 0 ? "Add a notice to track its reply, hearing date and documents called for." : undefined}
            action={data.notices.length === 0 ? <button className="btn btn-primary" onClick={() => onOpenNotice(null)}><Icon name="upload" size={14}/>Add notice</button> : undefined}
          />
        ) : (
          <table className="tbl">
            <thead>
              <tr><th>Notice</th><th>Assessee / PAN</th><th>AY</th><th>Section</th><th>Authority</th><th>Notice date</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {filtered.map(n => (
                <tr key={n.id} onClick={() => onOpenNotice(n)} style={{cursor: "pointer"}}>
                  <td>
                    <div className="center" style={{gap: 10}}>
                      <div style={{width: 36, height: 44, borderRadius: 6, background: "var(--p-pink)", display: "grid", placeItems: "center", color: "#C13388", fontSize: 9, fontWeight: 800, position: "relative"}}>
                        PDF
                        <div style={{position: "absolute", top: 0, right: 0, width: 10, height: 10, background: "white", clipPath: "polygon(0 0, 100% 100%, 100% 0)"}}/>
                      </div>
                      <div>
                        <div className="strong">{n.din ? `DIN ending ${n.din.slice(-6)}` : (n.subject || "Notice")}</div>
                        <div className="muted" style={{fontSize: 11.5, fontFamily: "ui-monospace, monospace"}}>{n.din || n.fileName || "—"}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="strong">{n.assessee}</div>
                    <div className="muted" style={{fontFamily: "ui-monospace, monospace", fontSize: 11.5}}>{n.pan}</div>
                  </td>
                  <td>{n.ay}</td>
                  <td>{n.section ? <span className="pill pill-muted">u/s {n.section}</span> : <span className="muted">—</span>}</td>
                  <td>{n.authority}</td>
                  <td className="muted">{n.date ? fmtDateLong(n.date) : "—"}</td>
                  <td><StatusPill status={n.status}/></td>
                  <td onClick={e => e.stopPropagation()}>
                    <button className="btn btn-ghost btn-xs" title="Delete" onClick={() => { if (window.confirm("Delete this notice?")) { removeNotice(n.id); notify("Notice deleted"); } }}>
                      <Icon name="trash" size={12}/>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/* Full-screen notice entry / review */
const AUTHORITY_OPTIONS = ["Scrutiny", "CIT(A)", "ITAT", "Penalty", "Other"];
const STATUS_OPTIONS = ["Awaiting review", "Reply drafted", "Submitted"];
const MODE_OPTIONS = ["Physical", "Video Conference", "e-Proceeding"];

function Field({ label, value, onChange, mono, full, type = "text", options }) {
  return (
    <div className="field" style={{gridColumn: full ? "span 2" : "auto"}}>
      <label>{label}</label>
      {options
        ? <select value={value} onChange={e => onChange(e.target.value)}>{options.map(o => <option key={o} value={o}>{o}</option>)}</select>
        : <input type={type} value={value} onChange={e => onChange(e.target.value)} style={{fontFamily: mono ? "ui-monospace, monospace" : "inherit"}}/>}
    </div>
  );
}

function Toggle({ on, onToggle, icon, iconColor, title, desc, disabled }) {
  return (
    <div onClick={disabled ? undefined : onToggle} className="center" style={{gap: 12, padding: "12px 14px", borderRadius: 13, background: on ? "var(--p-card-tint)" : "white", border: `1px solid ${on ? "var(--p-primary-3)" : "var(--p-line-2)"}`, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1, transition: "all 0.15s ease"}}>
      <div style={{width: 34, height: 34, borderRadius: 11, background: on ? "white" : "var(--p-card-tint)", color: iconColor, display: "grid", placeItems: "center"}}>
        <Icon name={icon} size={16}/>
      </div>
      <div style={{flex: 1}}>
        <div style={{fontWeight: 700, fontSize: 13.5}}>{title}</div>
        <div className="muted" style={{fontSize: 12, marginTop: 2}}>{desc}</div>
      </div>
      <div style={{width: 38, height: 22, borderRadius: 12, background: on ? "var(--p-primary)" : "var(--p-line)", position: "relative", transition: "all 0.15s ease", flexShrink: 0}}>
        <div style={{position: "absolute", top: 2, left: on ? 18 : 2, width: 18, height: 18, borderRadius: "50%", background: "white", boxShadow: "0 2px 4px rgba(0,0,0,0.15)", transition: "all 0.15s ease"}}/>
      </div>
    </div>
  );
}

export function NoticeReview({ notice, onClose, onSaved }) {
  const { data, addNotice, updateNotice, addHearing, addCommunication, notify } = useData();
  const isNew = !notice?.id;
  const [edited, setEdited] = React.useState({
    assessee: "", pan: "", ay: "", authority: "Scrutiny", section: "", din: "",
    date: todayISO(), hearingDate: "", hearingTime: "", bench: "", mode: "e-Proceeding",
    ita: "", subject: "", status: "Awaiting review", documents: [], fileName: "",
    ...notice,
  });
  const [createHearing, setCreateHearing] = React.useState(isNew);
  const [requestDocs, setRequestDocs] = React.useState(false);
  const [newDoc, setNewDoc] = React.useState("");
  const fileRef = React.useRef(null);

  const update = (k, v) => setEdited(e => ({ ...e, [k]: v }));
  const pickAssessee = (name) => {
    const a = data.assessees.find(x => x.name === name);
    setEdited(e => ({ ...e, assessee: name, pan: a?.pan || e.pan }));
  };

  const valid = edited.assessee.trim() && edited.ay.trim() && edited.date;
  const canCreateHearing = Boolean(edited.hearingDate);

  const save = () => {
    if (!valid) return;
    const rec = { ...edited };
    if (isNew) addNotice(rec);
    else updateNotice(notice.id, rec);

    const done = ["Notice saved"];
    if (createHearing && canCreateHearing) {
      addHearing({
        assessee: rec.assessee, pan: rec.pan, ay: rec.ay,
        authority: rec.authority, bench: rec.bench, section: rec.section,
        date: rec.hearingDate, time: rec.hearingTime || "11:00",
        mode: rec.mode, status: "Upcoming", ita: rec.ita, staff: data.assessees.find(a => a.pan === rec.pan)?.staff || "",
      });
      done.push("Hearing created");
    }
    if (requestDocs && rec.documents.length > 0) {
      addCommunication({
        channel: "WhatsApp", to: rec.assessee,
        subject: `Documents required — ${rec.authority} ${rec.hearingDate ? `hearing on ${fmtDateLong(rec.hearingDate)}` : `notice AY ${rec.ay}`}`,
        body: rec.documents.map((d, i) => `${i + 1}. ${d}`).join("\n"),
        time: new Date().toISOString(), template: "Document request", status: "Draft",
      });
      done.push("Document request drafted");
    }
    notify(done.join(" · "));
    onSaved(createHearing && canCreateHearing ? "hearings" : null);
  };

  return (
    <div className="animate-in">
      <div className="center" style={{gap: 8, marginBottom: 16, fontSize: 13}}>
        <button className="btn btn-ghost btn-sm" onClick={onClose}><Icon name="arrow-left" size={14}/>Back</button>
        <span className="muted">Notices / </span>
        <span style={{fontWeight: 600}}>{isNew ? "Add notice" : "Review notice"}</span>
      </div>

      <div className="card" style={{background: "linear-gradient(120deg, #F8F6FF 0%, #FFEDF5 100%)", border: "1px solid var(--p-line)", marginBottom: 18}}>
        <div className="between" style={{alignItems: "flex-start"}}>
          <div className="center" style={{gap: 14}}>
            <div style={{width: 48, height: 48, borderRadius: 14, background: "white", display: "grid", placeItems: "center", color: "var(--p-primary)"}}>
              <Icon name="doc" size={22}/>
            </div>
            <div>
              <div style={{fontSize: 20, fontWeight: 800, letterSpacing: "-0.02em"}}>{isNew ? "Record a notice" : `Notice — ${edited.assessee}`}</div>
              <div className="card-sub" style={{marginTop: 4}}>
                Verify every field against the original notice before saving.
              </div>
            </div>
          </div>
          <div className="center" style={{gap: 8}}>
            <input ref={fileRef} type="file" accept=".pdf" style={{display: "none"}} onChange={e => { const f = e.target.files?.[0]; if (f) update("fileName", f.name); }}/>
            <button className="btn btn-secondary btn-sm" onClick={() => fileRef.current?.click()}>
              <Icon name="upload" size={14}/>{edited.fileName ? "Replace PDF" : "Attach PDF"}
            </button>
            {edited.fileName && <span className="pill pill-muted">{edited.fileName}</span>}
          </div>
        </div>
      </div>

      <div className="grid" style={{gridTemplateColumns: "1fr 1fr", gap: 18}}>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Notice details</div>
              <div className="card-sub">Assessee, AY and notice date are required</div>
            </div>
          </div>
          <div className="grid" style={{gridTemplateColumns: "1fr 1fr", gap: 12}}>
            <div className="field">
              <label>Assessee *</label>
              {data.assessees.length > 0
                ? <select value={edited.assessee} onChange={e => pickAssessee(e.target.value)}>
                    <option value="">Select assessee…</option>
                    {data.assessees.map(a => <option key={a.id} value={a.name}>{a.name}</option>)}
                  </select>
                : <input value={edited.assessee} onChange={e => update("assessee", e.target.value)} placeholder="Assessee name"/>}
            </div>
            <Field label="PAN" value={edited.pan} onChange={v => update("pan", v.toUpperCase())} mono/>
            <Field label="Assessment Year *" value={edited.ay} onChange={v => update("ay", v)}/>
            <Field label="Authority" value={edited.authority} onChange={v => update("authority", v)} options={AUTHORITY_OPTIONS}/>
            <Field label="Section" value={edited.section} onChange={v => update("section", v)}/>
            <Field label="ITA / Appeal No." value={edited.ita} onChange={v => update("ita", v)}/>
            <Field label="DIN" value={edited.din} onChange={v => update("din", v)} mono full/>
            <Field label="Notice date *" value={edited.date} onChange={v => update("date", v)} type="date"/>
            <Field label="Bench / Officer" value={edited.bench} onChange={v => update("bench", v)}/>
            <Field label="Hearing date" value={edited.hearingDate} onChange={v => update("hearingDate", v)} type="date"/>
            <Field label="Hearing time" value={edited.hearingTime} onChange={v => update("hearingTime", v)} type="time"/>
            <Field label="Mode" value={edited.mode} onChange={v => update("mode", v)} options={MODE_OPTIONS}/>
            <Field label="Status" value={edited.status} onChange={v => update("status", v)} options={STATUS_OPTIONS}/>
          </div>
          <div className="mt-4 field">
            <label>Subject</label>
            <input value={edited.subject} onChange={e => update("subject", e.target.value)} placeholder="e.g. Appeal hearing — addition u/s 68"/>
          </div>
        </div>

        <div className="col" style={{gap: 18}}>
          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Documents called for</div>
                <div className="card-sub">Used in the client document request</div>
              </div>
              <span className="pill pill-primary">{edited.documents.length} items</span>
            </div>
            <div className="col" style={{gap: 8}}>
              {edited.documents.map((d, i) => (
                <div key={i} className="center" style={{gap: 10, padding: "10px 12px", background: "var(--p-card-tint)", borderRadius: 11, border: "1px solid var(--p-line-2)"}}>
                  <div style={{width: 22, height: 22, borderRadius: 7, background: "white", display: "grid", placeItems: "center", fontSize: 11, fontWeight: 800, color: "var(--p-primary-2)"}}>{i + 1}</div>
                  <div style={{flex: 1, fontSize: 13}}>{d}</div>
                  <button className="btn btn-ghost btn-xs" onClick={() => update("documents", edited.documents.filter((_, j) => j !== i))}><Icon name="trash" size={12}/></button>
                </div>
              ))}
              <div className="center" style={{gap: 8}}>
                <div className="search" style={{flex: 1}}>
                  <Icon name="plus" size={14}/>
                  <input placeholder="Add a document item…" value={newDoc} onChange={e => setNewDoc(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && newDoc.trim()) { update("documents", [...edited.documents, newDoc.trim()]); setNewDoc(""); } }}/>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => { if (newDoc.trim()) { update("documents", [...edited.documents, newDoc.trim()]); setNewDoc(""); } }}>Add</button>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-title mb-3">On save, also</div>
            <div className="col" style={{gap: 10}}>
              <Toggle
                on={createHearing && canCreateHearing}
                onToggle={() => setCreateHearing(!createHearing)}
                disabled={!canCreateHearing}
                icon="calendar" iconColor="var(--p-primary)"
                title="Create hearing entry"
                desc={canCreateHearing ? `${edited.authority}${edited.bench ? ` · ${edited.bench}` : ""} · ${fmtDateLong(edited.hearingDate)}${edited.hearingTime ? `, ${edited.hearingTime}` : ""}` : "Set a hearing date above to enable"}
              />
              <Toggle
                on={requestDocs && edited.documents.length > 0}
                onToggle={() => setRequestDocs(!requestDocs)}
                disabled={edited.documents.length === 0}
                icon="whatsapp" iconColor="var(--p-success)"
                title="Draft client document request"
                desc={edited.documents.length ? `${edited.documents.length} items · saved as draft in Communications` : "Add document items to enable"}
              />
            </div>
            <div className="row" style={{gap: 8, marginTop: 18}}>
              <button className="btn btn-secondary" style={{flex: 1, justifyContent: "center"}} onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={!valid} style={{flex: 2, justifyContent: "center", opacity: valid ? 1 : 0.5}} onClick={save}>
                <Icon name="check" size={14}/>{isNew ? "Save notice" : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
