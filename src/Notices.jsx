import React from 'react';
import { Icon, StatusPill, NOTICES, PARSED_NOTICE, fmtDateLong } from './shared';

export default function Notices({ onOpenParsed }) {
  return (
    <div className="animate-in">
      <div className="topbar">
        <div>
          <div className="page-title">Notices</div>
          <div className="page-sub">12 received this month · 4 awaiting AI review</div>
        </div>
        <div className="topbar-actions">
          <button className="btn btn-secondary"><Icon name="link" size={14}/>Fetch from ITD portal</button>
          <button className="btn btn-primary" onClick={onOpenParsed}><Icon name="upload" size={14}/>Upload notice</button>
        </div>
      </div>

      <div className="grid" style={{gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 18}}>
        <NoticeStat label="Awaiting AI review" value="4" color="pink" icon="sparkle"/>
        <NoticeStat label="Reply drafted" value="6" color="info" icon="edit"/>
        <NoticeStat label="Submitted this month" value="9" color="success" icon="check"/>
        <NoticeStat label="Due in 3 days" value="2" color="warning" icon="alert"/>
      </div>

      <div className="card" style={{padding: 0, overflow: "hidden"}}>
        <div className="row" style={{padding: "14px 18px", justifyContent: "space-between", borderBottom: "1px solid var(--p-line-2)", alignItems: "center"}}>
          <div className="row" style={{gap: 6}}>
            <span className="fchip active">All notices</span>
            <span className="fchip">Awaiting review</span>
            <span className="fchip">Scrutiny</span>
            <span className="fchip">CIT(A)</span>
            <span className="fchip">ITAT</span>
            <span className="fchip">Penalty</span>
          </div>
          <button className="btn btn-ghost btn-sm"><Icon name="filter" size={14}/>Sort: Newest</button>
        </div>
        <table className="tbl">
          <thead>
            <tr><th>Notice</th><th>Assessee / PAN</th><th>AY</th><th>Section</th><th>Authority</th><th>Notice date</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {NOTICES.map(n => (
              <tr key={n.id} onClick={n.awaiting ? onOpenParsed : undefined} style={{cursor: n.awaiting ? "pointer" : "default"}}>
                <td>
                  <div className="center" style={{gap: 10}}>
                    <div style={{width: 36, height: 44, borderRadius: 6, background: "var(--p-pink)", display: "grid", placeItems: "center", color: "#C13388", fontSize: 9, fontWeight: 800, position: "relative"}}>
                      PDF
                      <div style={{position: "absolute", top: 0, right: 0, width: 10, height: 10, background: "white", clipPath: "polygon(0 0, 100% 100%, 100% 0)"}}/>
                    </div>
                    <div>
                      <div className="strong">DIN ending {n.din.slice(-6)}</div>
                      <div className="muted" style={{fontSize: 11.5, fontFamily: "ui-monospace, monospace"}}>{n.din}</div>
                    </div>
                  </div>
                </td>
                <td>
                  <div className="strong">{n.assessee}</div>
                  <div className="muted" style={{fontFamily: "ui-monospace, monospace", fontSize: 11.5}}>{n.pan}</div>
                </td>
                <td>{n.ay}</td>
                <td><span className="pill pill-muted">u/s {n.section}</span></td>
                <td>{n.authority}</td>
                <td className="muted">{fmtDateLong(n.date)}</td>
                <td>
                  <div className="center" style={{gap: 6}}>
                    {n.status === "AI Parsed" && <Icon name="sparkle" size={12}/>}
                    <StatusPill status={n.status}/>
                  </div>
                </td>
                <td><Icon name="chevron-right" size={16} className="muted"/></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

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

export function ParsedNoticeReview({ onClose, onSaveAndCreate }) {
  const [edited, setEdited] = React.useState(PARSED_NOTICE);
  const [createHearing, setCreateHearing] = React.useState(true);
  const [syncCal, setSyncCal] = React.useState(true);
  const [requestDocs, setRequestDocs] = React.useState(true);

  const update = (k, v) => setEdited({ ...edited, [k]: v });

  return (
    <div className="animate-in">
      <div className="center" style={{gap: 8, marginBottom: 16, fontSize: 13}}>
        <button className="btn btn-ghost btn-sm" onClick={onClose}><Icon name="arrow-left" size={14}/>Back</button>
        <span className="muted">Notices / AI Parser / </span>
        <span style={{fontWeight: 600}}>Review parsed notice</span>
      </div>

      <div className="card" style={{background: "linear-gradient(120deg, #F8F6FF 0%, #FFEDF5 100%)", border: "1px solid var(--p-line)", marginBottom: 18}}>
        <div className="between" style={{alignItems: "flex-start"}}>
          <div className="center" style={{gap: 14}}>
            <div style={{width: 48, height: 48, borderRadius: 14, background: "white", display: "grid", placeItems: "center", color: "var(--p-primary)"}}>
              <Icon name="sparkle" size={22}/>
            </div>
            <div>
              <div className="center" style={{gap: 8}}>
                <div style={{fontSize: 20, fontWeight: 800, letterSpacing: "-0.02em"}}>AI parsed notice</div>
                <span className="pill pill-success">{edited.confidence.high} of {edited.confidence.high + edited.confidence.low} fields high confidence</span>
              </div>
              <div className="card-sub" style={{marginTop: 4}}>
                <Icon name="alert" size={12}/> AI extracted data may contain errors. Please verify before saving.
              </div>
            </div>
          </div>
          <div className="center" style={{gap: 8}}>
            <button className="btn btn-secondary btn-sm"><Icon name="download" size={14}/>Open PDF</button>
            <button className="btn btn-secondary btn-sm"><Icon name="sparkle" size={14}/>Re-run AI</button>
          </div>
        </div>
      </div>

      <div className="grid" style={{gridTemplateColumns: "1fr 1fr", gap: 18}}>
        <div className="card" style={{padding: 16}}>
          <div className="between" style={{marginBottom: 12}}>
            <div className="card-title">Source notice</div>
            <span className="pill pill-muted">notice_142(1)_ABCPS1234F.pdf · 412 KB</span>
          </div>
          <div className="pdf-preview">
            <span className="pdf-label">Page 1 of 3</span>
            <div style={{background: "white", borderRadius: 8, padding: "22px 24px", boxShadow: "var(--p-shadow-sm)"}}>
              <div className="center" style={{gap: 12, marginBottom: 16, paddingBottom: 14, borderBottom: "1px solid var(--p-line-2)"}}>
                <div style={{width: 36, height: 36, borderRadius: "50%", background: "var(--p-lavender-2)", display: "grid", placeItems: "center", fontSize: 12, fontWeight: 800, color: "var(--p-primary-2)"}}>ITD</div>
                <div>
                  <div style={{fontSize: 13, fontWeight: 800, letterSpacing: "-0.01em"}}>Income Tax Appellate Tribunal</div>
                  <div className="muted" style={{fontSize: 10.5}}>Ahmedabad Bench</div>
                </div>
              </div>
              <Hl t="Notice u/s 142(1) of the Income-tax Act, 1961" hl/>
              <Hl t="DIN: ITBA/AST/F/142(1)/2026-27/103412" mono hl/>
              <Hl t="Name: Rajesh M. Shah" hl/>
              <Hl t="PAN: ABCPS1234F" mono hl/>
              <Hl t="Assessment Year: 2017-18" hl/>
              <Hl t="ITA No. 1244/Ahd/2024 · 'A' Bench"/>
              <Hl t="Date: 12 May 2026"/>
              <div style={{height: 12}}/>
              <Hl t="Whereas in connection with the appeal pending before the undersigned for the assessment year mentioned above, you are required to attend hearing on:"/>
              <div style={{height: 8}}/>
              <Hl t="Date: 28 May 2026 at 11:30 AM" hl/>
              <div style={{height: 8}}/>
              <Hl t="You are required to produce or cause to be produced the following documents/details:"/>
              <div className="col" style={{gap: 4, marginTop: 8}}>
                {edited.documents.slice(0,4).map((d, i) => (
                  <div key={i} style={{fontSize: 10.5, color: "var(--p-text-2)"}}>{i+1}. {d}</div>
                ))}
                <div style={{fontSize: 10.5, color: "var(--p-text-3)"}}>5. … (cont. on next page)</div>
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Extracted details</div>
              <div className="card-sub">Edit any field before saving</div>
            </div>
            <span className="ai-badge"><Icon name="sparkle" size={10}/>AI</span>
          </div>
          <div className="grid" style={{gridTemplateColumns: "1fr 1fr", gap: 12}}>
            <Field label="Assessee" value={edited.assessee} onChange={v => update("assessee", v)} ai/>
            <Field label="PAN" value={edited.pan} onChange={v => update("pan", v)} ai mono/>
            <Field label="Assessment Year" value={edited.ay} onChange={v => update("ay", v)} ai/>
            <Field label="ITA / Appeal No." value={edited.itaNo} onChange={v => update("itaNo", v)} ai/>
            <Field label="Authority" value={edited.authority} onChange={v => update("authority", v)} ai full/>
            <Field label="Bench / Officer" value={edited.bench} onChange={v => update("bench", v)} ai/>
            <Field label="Section" value={edited.section} onChange={v => update("section", v)} ai/>
            <Field label="DIN" value={edited.din} onChange={v => update("din", v)} ai mono full/>
            <Field label="Notice date" value={edited.noticeDate} onChange={v => update("noticeDate", v)} ai/>
            <Field label="Hearing date" value={edited.hearingDate} onChange={v => update("hearingDate", v)} ai/>
            <Field label="Hearing time" value={edited.hearingTime} onChange={v => update("hearingTime", v)} ai/>
            <Field label="Mode" value={edited.mode} onChange={v => update("mode", v)} ai/>
          </div>
          <div className="mt-4">
            <label style={{fontSize: 12, fontWeight: 600, color: "var(--p-text-2)"}}>Subject</label>
            <input defaultValue={edited.subject} style={{display: "block", marginTop: 6, width: "100%", border: "1px solid var(--p-primary-3)", borderRadius: 12, padding: "11px 14px", fontSize: 13.5, background: "linear-gradient(90deg, rgba(108,92,231,0.04), white 30%)", outline: "none"}}/>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Documents called for</div>
              <div className="card-sub">Auto-extracted by AI · used in client communication</div>
            </div>
            <span className="ai-badge"><Icon name="sparkle" size={10}/>{edited.documents.length} items</span>
          </div>
          <div className="col" style={{gap: 8}}>
            {edited.documents.map((d, i) => (
              <div key={i} className="center" style={{gap: 10, padding: "10px 12px", background: "var(--p-card-tint)", borderRadius: 11, border: "1px solid var(--p-line-2)"}}>
                <div style={{width: 22, height: 22, borderRadius: 7, background: "white", display: "grid", placeItems: "center", fontSize: 11, fontWeight: 800, color: "var(--p-primary-2)"}}>{i + 1}</div>
                <div style={{flex: 1, fontSize: 13}}>{d}</div>
                <button className="btn btn-ghost btn-xs"><Icon name="edit" size={12}/></button>
                <button className="btn btn-ghost btn-xs"><Icon name="trash" size={12}/></button>
              </div>
            ))}
            <button className="btn btn-secondary btn-sm" style={{justifyContent: "center"}}><Icon name="plus" size={14}/>Add item</button>
          </div>
        </div>

        <div className="card">
          <div className="card-title mb-3">On save, also</div>
          <div className="col" style={{gap: 10}}>
            <Toggle on={createHearing} onToggle={() => setCreateHearing(!createHearing)} icon="calendar" iconColor="var(--p-primary)" title="Create hearing entry" desc="ITAT · Ahmedabad 'A' Bench · 28 May, 11:30 AM"/>
            <Toggle on={syncCal} onToggle={() => setSyncCal(!syncCal)} icon="link" iconColor="#2766C7" title="Sync to Google Calendar" desc="Will appear on jayesh@vyas-ca.in · default calendar"/>
            <Toggle on={requestDocs} onToggle={() => setRequestDocs(!requestDocs)} icon="whatsapp" iconColor="var(--p-success)" title="Draft client document request" desc="WhatsApp + Email · 6 items · Due 28 May"/>
            <Toggle on={false} onToggle={() => {}} icon="invoice" iconColor="#B07512" title="Pre-fill billing entry" desc="ITAT hearing fees · service template"/>
          </div>
          <div className="row" style={{gap: 8, marginTop: 18}}>
            <button className="btn btn-secondary" style={{flex: 1, justifyContent: "center"}} onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" style={{flex: 2, justifyContent: "center"}} onClick={onSaveAndCreate}>
              <Icon name="check" size={14}/>Save · Create hearing · Notify client
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Hl({ t, hl, mono }) {
  return (
    <div style={{fontSize: 10.5, lineHeight: 1.7, fontFamily: mono ? "ui-monospace, monospace" : "inherit", color: "var(--p-text-2)"}}>
      {hl
        ? <span style={{background: "rgba(108,92,231,0.18)", padding: "1px 4px", borderRadius: 3, fontWeight: 600, color: "var(--p-text)"}}>{t}</span>
        : t}
    </div>
  );
}

function Field({ label, value, onChange, ai, mono, full }) {
  return (
    <div className={`field ${ai ? "ai-extracted" : ""}`} style={{gridColumn: full ? "span 2" : "auto"}}>
      <div className="center" style={{justifyContent: "space-between"}}>
        <label>{label}</label>
        {ai && <span className="ai-badge" style={{fontSize: 9}}>AI</span>}
      </div>
      <input value={value} onChange={e => onChange(e.target.value)} style={{fontFamily: mono ? "ui-monospace, monospace" : "inherit"}}/>
    </div>
  );
}

function Toggle({ on, onToggle, icon, iconColor, title, desc }) {
  return (
    <div onClick={onToggle} className="center" style={{gap: 12, padding: "12px 14px", borderRadius: 13, background: on ? "var(--p-card-tint)" : "white", border: `1px solid ${on ? "var(--p-primary-3)" : "var(--p-line-2)"}`, cursor: "pointer", transition: "all 0.15s ease"}}>
      <div style={{width: 34, height: 34, borderRadius: 11, background: on ? "white" : "var(--p-card-tint)", color: iconColor, display: "grid", placeItems: "center"}}>
        <Icon name={icon} size={16}/>
      </div>
      <div style={{flex: 1}}>
        <div style={{fontWeight: 700, fontSize: 13.5}}>{title}</div>
        <div className="muted" style={{fontSize: 12, marginTop: 2}}>{desc}</div>
      </div>
      <div style={{width: 38, height: 22, borderRadius: 12, background: on ? "var(--p-primary)" : "var(--p-line)", position: "relative", transition: "all 0.15s ease"}}>
        <div style={{position: "absolute", top: 2, left: on ? 18 : 2, width: 18, height: 18, borderRadius: "50%", background: "white", boxShadow: "0 2px 4px rgba(0,0,0,0.15)", transition: "all 0.15s ease"}}/>
      </div>
    </div>
  );
}
