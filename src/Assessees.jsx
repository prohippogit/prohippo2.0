import React from 'react';
import { Icon, Avatar, StatusPill, ASSESSEES, HEARINGS, INVOICES, fmtINR, fmtDate, fmtDateLong, daysFromNow } from './shared';

export function Assessees({ onOpen }) {
  const [tab, setTab] = React.useState("All");
  const [search, setSearch] = React.useState("");
  const filtered = ASSESSEES.filter(a => {
    const q = search.toLowerCase();
    return !q || a.name.toLowerCase().includes(q) || a.pan.toLowerCase().includes(q) || a.group.toLowerCase().includes(q);
  });

  return (
    <div className="animate-in">
      <div className="topbar">
        <div>
          <div className="page-title">Assessees</div>
          <div className="page-sub">247 active · 18 added this month</div>
        </div>
        <div className="topbar-actions">
          <button className="btn btn-secondary"><Icon name="upload" size={14}/>Import</button>
          <button className="btn btn-primary"><Icon name="plus" size={14}/>Add assessee</button>
        </div>
      </div>

      <div className="row" style={{justifyContent: "space-between", marginBottom: 16, alignItems: "center", flexWrap: "wrap", gap: 12}}>
        <div className="tabs">
          {["All", "Individual", "Company", "Firm/LLP", "HUF", "Trust", "Inactive"].map(t => (
            <div key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
              {t}
              {t === "All" && <span style={{marginLeft: 6, opacity: 0.65, fontSize: 11}}>247</span>}
            </div>
          ))}
        </div>
        <div className="center" style={{gap: 8}}>
          <div className="search" style={{width: 260}}>
            <Icon name="search" size={15}/>
            <input placeholder="Name, PAN, mobile…" value={search} onChange={e => setSearch(e.target.value)}/>
          </div>
          <button className="fchip"><Icon name="filter" size={14}/>Filters · 2</button>
        </div>
      </div>

      <div className="card" style={{padding: 0, overflow: "hidden"}}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Assessee</th>
              <th>PAN</th>
              <th>Status</th>
              <th>Group</th>
              <th>Active matters</th>
              <th>Outstanding</th>
              <th>Next hearing</th>
              <th>Staff</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(a => (
              <tr key={a.id} onClick={() => onOpen(a)} style={{cursor: "pointer"}}>
                <td>
                  <div className="center" style={{gap: 10}}>
                    <Avatar name={a.name} color={a.color} size="sm"/>
                    <div>
                      <div className="strong">{a.name}</div>
                      <div className="muted">{a.mobile}</div>
                    </div>
                  </div>
                </td>
                <td className="strong" style={{fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12.5}}>{a.pan}</td>
                <td><span className="pill pill-muted">{a.status}</span></td>
                <td className="semi">{a.group}</td>
                <td>
                  <div className="center" style={{gap: 6}}>
                    <span className="strong">{a.matters}</span>
                    {a.hearings > 0 && <span className="pill pill-pink" style={{fontSize: 10, padding: "2px 6px"}}>{a.hearings} hearing{a.hearings > 1 ? "s" : ""}</span>}
                  </div>
                </td>
                <td>
                  {a.outstanding === 0
                    ? <span className="pill pill-success">Clear</span>
                    : <span className="strong" style={{color: a.outstanding > 100000 ? "#B8463A" : "var(--p-text)"}}>{fmtINR(a.outstanding)}</span>}
                </td>
                <td>
                  {a.hearings > 0
                    ? <div>
                        <div className="strong" style={{fontSize: 12.5}}>{(() => { const h = HEARINGS.find(x => x.pan === a.pan); return h ? fmtDate(h.date) : "—"; })()}</div>
                        <div className="muted">{(() => { const h = HEARINGS.find(x => x.pan === a.pan); return h ? h.authority : ""; })()}</div>
                      </div>
                    : <span className="muted">—</span>}
                </td>
                <td>
                  <div className="center" style={{gap: 6}}>
                    <Avatar name={a.staff} color="mint" size="sm"/>
                    <span style={{fontSize: 12}}>{a.staff.split(" ")[0]}</span>
                  </div>
                </td>
                <td><Icon name="chevron-right" size={16} className="muted"/></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="between" style={{marginTop: 14}}>
        <div className="muted" style={{fontSize: 12.5}}>Showing 1–{filtered.length} of 247</div>
        <div className="center" style={{gap: 4}}>
          <button className="btn btn-secondary btn-sm"><Icon name="chevron-left" size={14}/></button>
          <button className="btn btn-primary btn-sm" style={{minWidth: 32, justifyContent: "center"}}>1</button>
          <button className="btn btn-secondary btn-sm" style={{minWidth: 32, justifyContent: "center"}}>2</button>
          <button className="btn btn-secondary btn-sm" style={{minWidth: 32, justifyContent: "center"}}>3</button>
          <button className="btn btn-secondary btn-sm"><Icon name="chevron-right" size={14}/></button>
        </div>
      </div>
    </div>
  );
}

export function AssesseeProfile({ assessee, onBack, onNav }) {
  const [tab, setTab] = React.useState("Overview");
  const a = assessee;
  const hearings = HEARINGS.filter(h => h.pan === a.pan);
  const invoices = INVOICES.filter(i => i.assessee === a.name);

  return (
    <div className="animate-in">
      <div className="center" style={{gap: 8, marginBottom: 16, fontSize: 13}}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}><Icon name="arrow-left" size={14}/>Back</button>
        <span className="muted">Assessees / </span>
        <span style={{fontWeight: 600}}>{a.name}</span>
      </div>

      <div className="card" style={{background: "linear-gradient(120deg, #F8F6FF 0%, #FFEDF5 100%)", border: "1px solid var(--p-line)"}}>
        <div className="between" style={{alignItems: "flex-start"}}>
          <div className="center" style={{gap: 16}}>
            <Avatar name={a.name} color={a.color} size="lg"/>
            <div>
              <div className="center" style={{gap: 8}}>
                <div style={{fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em"}}>{a.name}</div>
                <span className="pill pill-muted">{a.status}</span>
                <span className="pill pill-primary">{a.group}</span>
              </div>
              <div className="row" style={{gap: 18, marginTop: 8, fontSize: 13, color: "var(--p-text-2)"}}>
                <span><b style={{fontFamily: "ui-monospace, monospace"}}>{a.pan}</b></span>
                <span><Icon name="phone" size={12}/> {a.mobile}</span>
                <span><Icon name="mail" size={12}/> {a.email}</span>
              </div>
            </div>
          </div>
          <div className="center" style={{gap: 8}}>
            <button className="btn btn-secondary btn-sm"><Icon name="whatsapp" size={14}/>WhatsApp</button>
            <button className="btn btn-secondary btn-sm"><Icon name="mail" size={14}/>Email</button>
            <button className="btn btn-primary btn-sm"><Icon name="plus" size={14}/>New matter</button>
            <button className="icon-btn" style={{width: 36, height: 36}}><Icon name="more" size={16}/></button>
          </div>
        </div>
        <div className="grid" style={{gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginTop: 20}}>
          <MiniStat label="Active matters" value={a.matters} icon="scale"/>
          <MiniStat label="Upcoming hearings" value={a.hearings} icon="calendar" accent="pink"/>
          <MiniStat label="Outstanding" value={a.outstanding ? fmtINR(a.outstanding) : "—"} icon="wallet" accent={a.outstanding > 100000 ? "warn" : "default"}/>
          <MiniStat label="Last filed" value="ITR-3, AY 24-25" icon="doc"/>
        </div>
      </div>

      <div className="utabs" style={{marginTop: 22}}>
        {["Overview","Hearings","Notices","Scrutiny","CIT(A)","ITAT","Invoices","Ledger","Documents","Communications","Notes"].map(t => (
          <div key={t} className={`utab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{t}</div>
        ))}
      </div>

      {tab === "Overview" && (
        <div className="grid" style={{gridTemplateColumns: "1.4fr 1fr", gap: 18}}>
          <div className="col" style={{gap: 18}}>
            <div className="card">
              <div className="card-head">
                <div className="card-title">Recent activity</div>
                <button className="btn btn-ghost btn-sm">All activity →</button>
              </div>
              <Timeline/>
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
                          {h.ita || (h.section !== "—" ? `u/s ${h.section}` : "")} · {h.mode} · <Icon name="clock" size={11}/>{h.time}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="col" style={{gap: 18}}>
            <div className="card">
              <div className="card-title mb-3">Particulars</div>
              <KV label="PAN" value={a.pan} mono/>
              <KV label="Status" value={a.status}/>
              <KV label="Group" value={a.group}/>
              <KV label="DOB / DOI" value="14 Feb 1968"/>
              <KV label="Address" value="B-204, Mahalaxmi Heights, Navrangpura, Ahmedabad 380009"/>
              <KV label="Referred by" value="Sanjay Mehta (CA)"/>
              <KV label="Assigned staff" value={a.staff}/>
              <KV label="ITR portal login" value={
                <span className="center" style={{gap: 8}}>
                  <span style={{fontFamily: "ui-monospace, monospace"}}>{a.pan}</span>
                  <span className="muted">·</span>
                  <span style={{fontFamily: "ui-monospace, monospace"}}>••••••••</span>
                  <Icon name="shield" size={12}/>
                  <span className="pill pill-success" style={{fontSize: 10, padding: "1px 6px"}}>Encrypted</span>
                </span>
              }/>
            </div>
            <div className="card">
              <div className="card-title mb-3">Ledger snapshot</div>
              <div className="row" style={{gap: 16}}>
                <MiniStat label="Billed YTD" value="₹3.85L" icon="invoice"/>
                <MiniStat label="Received YTD" value="₹3.61L" icon="wallet" accent="success"/>
              </div>
              <div className="mt-4" style={{borderTop: "1px dashed var(--p-line)", paddingTop: 14}}>
                <div className="between">
                  <div className="muted" style={{fontSize: 12}}>Outstanding</div>
                  <div style={{fontWeight: 800, fontSize: 18, color: a.outstanding ? "#C13388" : "var(--p-success)"}}>{a.outstanding ? fmtINR(a.outstanding) : "₹0"}</div>
                </div>
                <button className="btn btn-secondary btn-sm" style={{width: "100%", justifyContent: "center", marginTop: 12}}>
                  <Icon name="download" size={14}/>Download ledger PDF
                </button>
              </div>
            </div>
            <div className="card" style={{background: "var(--p-card-tint)"}}>
              <div className="center" style={{gap: 10, marginBottom: 8}}>
                <Icon name="tag" size={14}/>
                <div style={{fontSize: 12, fontWeight: 700, color: "var(--p-text-2)"}}>TAGS</div>
              </div>
              <div className="row" style={{gap: 6, flexWrap: "wrap"}}>
                {["VIP","Recurring","Group lead","ITR-3","Capital gains"].map(t => <span key={t} className="pill pill-primary">{t}</span>)}
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === "Invoices" && (
        <div className="card" style={{padding: 0}}>
          <table className="tbl">
            <thead><tr><th>Invoice #</th><th>Date</th><th>Service</th><th>AY</th><th>Amount</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {invoices.map(inv => (
                <tr key={inv.id}>
                  <td className="strong" style={{fontFamily: "ui-monospace, monospace", fontSize: 12.5}}>{inv.id}</td>
                  <td className="muted">{fmtDateLong(inv.date)}</td>
                  <td>{inv.service}</td>
                  <td>{inv.ay}</td>
                  <td className="strong">{fmtINR(inv.amount)}</td>
                  <td><StatusPill status={inv.status}/></td>
                  <td><Icon name="chevron-right" size={14} className="muted"/></td>
                </tr>
              ))}
              {invoices.length === 0 && <tr><td colSpan="7" style={{textAlign: "center", padding: 40, color: "var(--p-text-3)"}}>No invoices yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab !== "Overview" && tab !== "Invoices" && (
        <div className="card" style={{padding: 60, textAlign: "center"}}>
          <div style={{fontSize: 40, marginBottom: 10}}>🍃</div>
          <div className="card-title">{tab} — coming online soon</div>
          <div className="card-sub mt-2">This tab is wired to Firestore but no records for {a.name} yet.</div>
        </div>
      )}
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
        <div style={{fontWeight: 800, fontSize: 16, letterSpacing: "-0.02em"}}>{value}</div>
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

function Timeline() {
  const items = [
    { time: "Today, 09:42", icon: "sparkle", color: "primary", title: "AI parsed ITAT hearing notice", desc: "Hearing date: 28 May · Auto-created event awaiting your confirmation." },
    { time: "Yesterday", icon: "whatsapp", color: "success", title: "Document request sent via WhatsApp", desc: "6 items requested · Delivered ✓✓ · Awaiting response." },
    { time: "23 May", icon: "invoice", color: "info", title: "Invoice PH/26-27/0124 raised", desc: "₹1,25,000 · ITAT appeal drafting & hearing fees · Due 14 Jun" },
    { time: "22 May", icon: "doc", color: "primary", title: "Notice u/s 142(1) received from ITAT", desc: "DIN ITBA/AST/F/142(1)/2026-27/103412 · ITA No. 1244/Ahd/2024" },
    { time: "15 May", icon: "calendar", color: "pink", title: "Hearing adjourned", desc: "Earlier hearing on 15 May adjourned to 28 May at request of revenue." },
  ];
  const colorMap = { primary: "var(--p-primary)", success: "var(--p-success)", info: "var(--p-info)", pink: "#C13388" };
  return (
    <div style={{position: "relative", paddingLeft: 8}}>
      <div style={{position: "absolute", left: 17, top: 8, bottom: 8, width: 2, background: "var(--p-lavender-2)"}}/>
      <div className="col" style={{gap: 14}}>
        {items.map((it, i) => (
          <div key={i} className="center" style={{gap: 14, alignItems: "flex-start", position: "relative"}}>
            <div style={{width: 28, height: 28, borderRadius: 9, background: "white", border: `2px solid ${colorMap[it.color]}`, color: colorMap[it.color], display: "grid", placeItems: "center", flexShrink: 0, zIndex: 1}}>
              <Icon name={it.icon} size={13}/>
            </div>
            <div style={{flex: 1}}>
              <div className="between">
                <div style={{fontWeight: 700, fontSize: 13.5}}>{it.title}</div>
                <div className="muted" style={{fontSize: 11.5}}>{it.time}</div>
              </div>
              <div className="muted" style={{fontSize: 12.5, marginTop: 2}}>{it.desc}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
