import React from 'react';
import { Icon, Avatar, StatusPill, EmptyState, fmtINR, fmtDate, fmtDateLong, fmtLakhs, daysFromNow } from './shared';
import { useData, assesseeStats, upcomingHearings, invoiceStatus, invoiceOutstanding, fyOf, todayISO } from './store';
import { MatterModal } from './Other';
import { AssesseeModal } from './AssesseeModal';

export { AssesseeModal };

const PAGE_SIZE = 25;

export function Assessees({ onOpen, initialSearch = "" }) {
  const { data } = useData();
  const [tab, setTab] = React.useState("All");
  const [search, setSearch] = React.useState(initialSearch);
  const [page, setPage] = React.useState(1);
  const [showAdd, setShowAdd] = React.useState(false);

  React.useEffect(() => { setSearch(initialSearch); }, [initialSearch]);
  React.useEffect(() => { setPage(1); }, [tab, search]);

  const matchesTab = (a) => {
    if (tab === "All") return true;
    if (tab === "Firm/LLP") return a.status === "Firm" || a.status === "LLP";
    return a.status === tab;
  };
  const q = search.toLowerCase();
  const filtered = data.assessees.filter(a =>
    matchesTab(a) &&
    (!q || a.name.toLowerCase().includes(q) || a.pan.toLowerCase().includes(q) || (a.group || "").toLowerCase().includes(q) || (a.mobile || "").includes(q))
  );
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const thisMonth = todayISO().slice(0, 7);
  const addedThisMonth = data.assessees.filter(a => (a.createdAt || "").startsWith(thisMonth)).length;

  const tabCount = (t) => data.assessees.filter(a => (t === "All" ? true : t === "Firm/LLP" ? a.status === "Firm" || a.status === "LLP" : a.status === t)).length;

  return (
    <div className="animate-in">
      <div className="topbar">
        <div>
          <div className="page-title">Assessees</div>
          <div className="page-sub">{data.assessees.length} active{addedThisMonth ? ` · ${addedThisMonth} added this month` : ""}</div>
        </div>
        <div className="topbar-actions">
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}><Icon name="plus" size={14}/>Add assessee</button>
        </div>
      </div>

      <div className="row" style={{justifyContent: "space-between", marginBottom: 16, alignItems: "center", flexWrap: "wrap", gap: 12}}>
        <div className="tabs">
          {["All", "Individual", "Company", "Firm/LLP", "HUF", "Trust"].map(t => (
            <div key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
              {t}
              <span style={{marginLeft: 6, opacity: 0.65, fontSize: 11}}>{tabCount(t)}</span>
            </div>
          ))}
        </div>
        <div className="center" style={{gap: 8}}>
          <div className="search" style={{width: 260}}>
            <Icon name="search" size={15}/>
            <input placeholder="Name, PAN, group, mobile…" value={search} onChange={e => setSearch(e.target.value)}/>
          </div>
        </div>
      </div>

      {data.assessees.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="users"
            title="No assessees yet"
            sub="Add your first assessee to start tracking matters, hearings, notices and fees."
            action={<button className="btn btn-primary" onClick={() => setShowAdd(true)}><Icon name="plus" size={14}/>Add assessee</button>}
          />
        </div>
      ) : (
        <>
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
                {pageRows.map(a => {
                  const s = assesseeStats(data, a);
                  const nextHearing = s.hearings[0];
                  return (
                    <tr key={a.id} onClick={() => onOpen(a)} style={{cursor: "pointer"}}>
                      <td>
                        <div className="center" style={{gap: 10}}>
                          <Avatar name={a.name} color={a.color} size="sm"/>
                          <div>
                            <div className="strong">{a.name}</div>
                            <div className="muted">{a.mobile || a.email || "—"}</div>
                          </div>
                        </div>
                      </td>
                      <td className="strong" style={{fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12.5}}>{a.pan}</td>
                      <td><span className="pill pill-muted">{a.status}</span></td>
                      <td className="semi">{a.group || "—"}</td>
                      <td>
                        <div className="center" style={{gap: 6}}>
                          <span className="strong">{s.matters}</span>
                          {s.hearings.length > 0 && <span className="pill pill-pink" style={{fontSize: 10, padding: "2px 6px"}}>{s.hearings.length} hearing{s.hearings.length > 1 ? "s" : ""}</span>}
                        </div>
                      </td>
                      <td>
                        {s.outstanding === 0
                          ? <span className="pill pill-success">Clear</span>
                          : <span className="strong" style={{color: s.outstanding > 100000 ? "#B8463A" : "var(--p-text)"}}>{fmtINR(s.outstanding)}</span>}
                      </td>
                      <td>
                        {nextHearing
                          ? <div>
                              <div className="strong" style={{fontSize: 12.5}}>{fmtDate(nextHearing.date)}</div>
                              <div className="muted">{nextHearing.authority}</div>
                            </div>
                          : <span className="muted">—</span>}
                      </td>
                      <td>
                        {a.staff
                          ? <div className="center" style={{gap: 6}}>
                              <Avatar name={a.staff} color="mint" size="sm"/>
                              <span style={{fontSize: 12}}>{a.staff.split(" ")[0]}</span>
                            </div>
                          : <span className="muted">—</span>}
                      </td>
                      <td><Icon name="chevron-right" size={16} className="muted"/></td>
                    </tr>
                  );
                })}
                {pageRows.length === 0 && (
                  <tr><td colSpan="9" style={{textAlign: "center", padding: 40, color: "var(--p-text-3)"}}>No assessees match this filter.</td></tr>
                )}
              </tbody>
            </table>
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
    </div>
  );
}

export function AssesseeProfile({ assessee, onBack, onNav }) {
  const { data, removeAssessee, updateAssessee, notify } = useData();
  const [tab, setTab] = React.useState("Overview");
  const [showEdit, setShowEdit] = React.useState(false);
  const [showMatter, setShowMatter] = React.useState(false);
  const a = assessee;
  const s = assesseeStats(data, a);
  const hearings = upcomingHearings(data).filter(h => h.pan === a.pan);
  const allHearings = data.hearings.filter(h => h.pan === a.pan).sort((x, y) => y.date.localeCompare(x.date));
  const notices = data.notices.filter(n => n.pan === a.pan);
  const matters = data.matters.filter(m => m.pan === a.pan);
  const invoices = data.invoices.filter(i => i.assessee === a.name);
  const comms = data.communications.filter(c => c.to === a.name || c.to === a.email || c.to === a.mobile);

  const fy = fyOf(todayISO());
  const billedFY = invoices.filter(i => fyOf(i.date) === fy).reduce((sum, i) => sum + i.amount, 0);
  const receivedFY = invoices.filter(i => fyOf(i.date) === fy).reduce((sum, i) => sum + (i.received || 0), 0);

  const waLink = a.mobile ? `https://wa.me/${a.mobile.replace(/\D/g, "")}` : null;

  const doDelete = async () => {
    if (!window.confirm(`Delete ${a.name}? Their matters, hearings, notices, invoices and messages will also be removed. This cannot be undone.`)) return;
    onBack();
    const removed = await removeAssessee(a);
    if (removed !== null) {
      notify(removed > 0
        ? `${a.name} deleted along with ${removed} linked record${removed > 1 ? "s" : ""}`
        : `${a.name} deleted`);
    }
  };

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
                {a.group && <span className="pill pill-primary">{a.group}</span>}
              </div>
              <div className="row" style={{gap: 18, marginTop: 8, fontSize: 13, color: "var(--p-text-2)"}}>
                <span><b style={{fontFamily: "ui-monospace, monospace"}}>{a.pan}</b></span>
                {a.mobile && <span><Icon name="phone" size={12}/> {a.mobile}</span>}
                {a.email && <span><Icon name="mail" size={12}/> {a.email}</span>}
              </div>
            </div>
          </div>
          <div className="center" style={{gap: 8}}>
            {waLink && <a className="btn btn-secondary btn-sm" href={waLink} target="_blank" rel="noreferrer"><Icon name="whatsapp" size={14}/>WhatsApp</a>}
            {a.email && <a className="btn btn-secondary btn-sm" href={`mailto:${a.email}`}><Icon name="mail" size={14}/>Email</a>}
            <button className="btn btn-primary btn-sm" onClick={() => setShowMatter(true)}><Icon name="plus" size={14}/>New matter</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setShowEdit(true)}><Icon name="edit" size={14}/>Edit</button>
            <button className="icon-btn" style={{width: 36, height: 36}} onClick={doDelete} title="Delete assessee"><Icon name="trash" size={15}/></button>
          </div>
        </div>
        <div className="grid-stats" style={{gap: 12, marginTop: 20}}>
          <MiniStat label="Active matters" value={s.matters} icon="scale"/>
          <MiniStat label="Upcoming hearings" value={hearings.length} icon="calendar" accent="pink"/>
          <MiniStat label="Outstanding" value={s.outstanding ? fmtINR(s.outstanding) : "—"} icon="wallet" accent={s.outstanding > 100000 ? "warn" : "default"}/>
          <MiniStat label="Notices on file" value={notices.length} icon="doc"/>
        </div>
      </div>

      <div className="utabs" style={{marginTop: 22}}>
        {["Overview","Matters","Hearings","Notices","Invoices","Communications","Notes"].map(t => (
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
            <div className="card">
              <div className="card-title mb-3">Particulars</div>
              <KV label="PAN" value={a.pan} mono/>
              <KV label="Status" value={a.status}/>
              <KV label="Group" value={a.group || "—"}/>
              <KV label="Mobile" value={a.mobile || "—"}/>
              <KV label="Email" value={a.email || "—"}/>
              <KV label="Address" value={a.address || "—"}/>
              <KV label="Assigned staff" value={a.staff || "—"}/>
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

      {tab === "Matters" && (
        <div className="card" style={{padding: 0}}>
          <table className="tbl">
            <thead><tr><th>Type</th><th>AY</th><th>Section</th><th>Reference</th><th>Bench / Officer</th><th>Status</th></tr></thead>
            <tbody>
              {matters.map(m => (
                <tr key={m.id}>
                  <td><span className="pill pill-primary">{m.type}</span></td>
                  <td>{m.ay}</td>
                  <td>{m.section ? <span className="pill pill-muted">u/s {m.section}</span> : <span className="muted">—</span>}</td>
                  <td className="muted" style={{fontFamily: "ui-monospace, monospace", fontSize: 11.5}}>{m.ref || "—"}</td>
                  <td className="semi">{m.bench || "—"}</td>
                  <td><StatusPill status={m.status}/></td>
                </tr>
              ))}
              {matters.length === 0 && <tr><td colSpan="6" style={{textAlign: "center", padding: 40, color: "var(--p-text-3)"}}>No matters for {a.name} yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === "Hearings" && (
        <div className="card" style={{padding: 0}}>
          <table className="tbl">
            <thead><tr><th>Date / Time</th><th>Authority</th><th>Bench</th><th>AY</th><th>Mode</th><th>Status</th></tr></thead>
            <tbody>
              {allHearings.map(h => (
                <tr key={h.id}>
                  <td><div className="strong">{fmtDateLong(h.date)}</div><div className="muted">{h.time}</div></td>
                  <td><span className="pill pill-primary">{h.authority}</span></td>
                  <td className="semi">{h.bench}</td>
                  <td>{h.ay}</td>
                  <td>{h.mode}</td>
                  <td><StatusPill status={h.date < todayISO() ? "Completed" : h.status}/></td>
                </tr>
              ))}
              {allHearings.length === 0 && <tr><td colSpan="6" style={{textAlign: "center", padding: 40, color: "var(--p-text-3)"}}>No hearings for {a.name} yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === "Notices" && (
        <div className="card" style={{padding: 0}}>
          <table className="tbl">
            <thead><tr><th>DIN</th><th>AY</th><th>Section</th><th>Authority</th><th>Date</th><th>Status</th></tr></thead>
            <tbody>
              {notices.map(n => (
                <tr key={n.id}>
                  <td className="muted" style={{fontFamily: "ui-monospace, monospace", fontSize: 11.5}}>{n.din || "—"}</td>
                  <td>{n.ay}</td>
                  <td>{n.section ? <span className="pill pill-muted">u/s {n.section}</span> : "—"}</td>
                  <td>{n.authority}</td>
                  <td className="muted">{n.date ? fmtDateLong(n.date) : "—"}</td>
                  <td><StatusPill status={n.status}/></td>
                </tr>
              ))}
              {notices.length === 0 && <tr><td colSpan="6" style={{textAlign: "center", padding: 40, color: "var(--p-text-3)"}}>No notices for {a.name} yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === "Invoices" && (
        <div className="card" style={{padding: 0}}>
          <table className="tbl">
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
          </table>
        </div>
      )}

      {tab === "Communications" && (
        <div className="card" style={{padding: 0}}>
          {comms.length === 0 && <EmptyState icon="chat" title="No messages logged" sub={`Messages sent to ${a.name} will appear here.`}/>}
          <div className="col">
            {comms.map(c => (
              <div key={c.id} className="row" style={{padding: "14px 18px", borderBottom: "1px solid var(--p-line-2)", gap: 12}}>
                <Icon name={c.channel === "WhatsApp" ? "whatsapp" : "mail"} size={16}/>
                <div style={{flex: 1}}>
                  <div className="strong" style={{fontSize: 13}}>{c.subject}</div>
                  <div className="muted" style={{fontSize: 11.5, marginTop: 2}}>{c.channel} · {new Date(c.time).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "Notes" && <NotesCard assessee={a} onSave={(notes) => { updateAssessee(a.id, { notes }); notify("Notes saved"); }}/>}

      {showEdit && <AssesseeModal initial={a} onClose={() => setShowEdit(false)}/>}
      {showMatter && <MatterModal initial={{ assessee: a.name, pan: a.pan, staff: a.staff }} onClose={() => setShowMatter(false)}/>}
    </div>
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
