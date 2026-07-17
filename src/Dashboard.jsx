import React from 'react';
import { createPortal } from 'react-dom';
import { Icon, Avatar, fmtINR, fmtLakhs, fmtDate, daysFromNow } from './shared';
import { InstallAppButton } from './InstallApp';
import { useData, upcomingHearings, awaitingNotices, totalOutstanding, overdueAmount, invoiceOutstanding, toISO, todayISO } from './store';

export default function Dashboard({ onNav, onOpenNotice, onSearch }) {
  const { data, loadSampleData } = useData();
  const [query, setQuery] = React.useState("");
  const [showNotices, setShowNotices] = React.useState(false);

  const hearings = upcomingHearings(data);
  const awaiting = awaitingNotices(data);
  const activeMatters = data.matters.filter(m => !["Closed", "Decided"].includes(m.status));
  const weekAhead = hearings.filter(h => daysFromNow(h.date) <= 7);
  const next48h = hearings.filter(h => daysFromNow(h.date) <= 2);
  const outstanding = totalOutstanding(data);
  const overdue = overdueAmount(data);
  const monthStart = todayISO().slice(0, 7);
  const noticesThisMonth = data.notices.filter(n => (n.date || "").startsWith(monthStart));

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const firstName = (data.profile.ownerName || "").split(" ")[0];

  const isEmpty = data.assessees.length === 0 && data.hearings.length === 0 && data.notices.length === 0 && data.invoices.length === 0;

  return (
    <div className="animate-in">
      <div className="topbar">
        <div>
          <div className="page-title">{greeting}{firstName ? `, ${firstName}` : ""} 👋</div>
          <div className="page-sub">
            {isEmpty
              ? "Let's get your practice set up."
              : <>You have <b style={{color: "var(--p-primary-2)"}}>{weekAhead.length} hearing{weekAhead.length !== 1 ? "s" : ""} this week</b> and <b style={{color: "#C13388"}}>{awaiting.length} notice{awaiting.length !== 1 ? "s" : ""}</b> awaiting review.</>}
          </div>
        </div>
        <div className="topbar-actions">
          <div className="search">
            <Icon name="search" size={16}/>
            <input
              placeholder="Search PAN, assessee…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") onSearch(query); }}
            />
          </div>
          <InstallAppButton className="btn btn-secondary" label="Download app"/>
          <div className="user-chip">
            <Avatar name={data.profile.ownerName || "You"} color="violet"/>
            <div style={{lineHeight: 1.2}}>
              <div style={{fontSize: 12.5, fontWeight: 700}}>{data.profile.ownerName || "Welcome"}</div>
              <div style={{fontSize: 11, color: "var(--p-text-3)"}}>{data.profile.firmName || "Set up your firm"}</div>
            </div>
          </div>
        </div>
      </div>

      {isEmpty && (
        <div className="card" style={{padding: 0, overflow: "hidden", border: "none", background: "linear-gradient(120deg, #2B2270 0%, #5146C6 55%, #8E7CFF 100%)", color: "white", marginBottom: 18}}>
          <div style={{padding: "28px 30px"}}>
            <div style={{fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.3}}>
              Welcome to ProHippo.<br/>
              <span style={{opacity: 0.85}}>Add your first assessee, or explore with sample data.</span>
            </div>
            <div className="row" style={{marginTop: 18, gap: 10}}>
              <button className="btn" style={{background: "white", color: "var(--p-primary-2)"}} onClick={() => onNav("assessees")}>
                <Icon name="plus" size={14}/>Add assessee
              </button>
              <button className="btn btn-ghost" style={{color: "white"}} onClick={loadSampleData}>
                Load sample data
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="grid-stats" style={{marginBottom: 18}}>
        <Stat label="Active matters" value={activeMatters.length} delta={`${data.matters.length} total`} deltaKind="neutral" icon="scale" iconBg="var(--p-lavender-2)" iconColor="var(--p-primary-2)"
          glow="rgba(108, 92, 231, 0.24)" goLabel="Matters" onClick={() => onNav("matters")}/>
        <Stat label="Hearings this week" value={weekAhead.length} delta={next48h.length ? `${next48h.length} in next 48h` : "None in next 48h"} deltaKind="neutral" icon="calendar" iconBg="var(--p-pink)" iconColor="#C13388"
          glow="rgba(255, 140, 200, 0.30)" goLabel="Hearings" onClick={() => onNav("hearings")}/>
        <Stat label="Outstanding fees" value={fmtLakhs(outstanding)} delta={overdue ? `${fmtLakhs(overdue)} overdue` : "Nothing overdue"} deltaKind={overdue ? "down" : "up"} icon="wallet" iconBg="var(--p-amber)" iconColor="#B07512"
          glow="rgba(255, 193, 84, 0.32)" goLabel="Invoices" onClick={() => onNav("invoices")}/>
        <Stat label="Notices this month" value={noticesThisMonth.length} delta={awaiting.length ? `${awaiting.length} awaiting review` : "All reviewed"} deltaKind="neutral" icon="doc" iconBg="var(--p-mint)" iconColor="#1B8C5C"
          glow="rgba(74, 222, 164, 0.30)"/>
      </div>

      <div className="grid-main">
        <div className="col" style={{gap: 18}}>
          {awaiting.length > 0 && (
            <div
              className="card"
              style={{padding: 0, overflow: "hidden", border: "none", background: "linear-gradient(120deg, #2B2270 0%, #5146C6 55%, #8E7CFF 100%)", color: "white", position: "relative", cursor: "pointer"}}
              role="button"
              tabIndex={0}
              onClick={() => setShowNotices(true)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setShowNotices(true); } }}
              title="Open notices to review"
            >
              <div style={{position: "absolute", right: -40, top: -40, width: 200, height: 200, borderRadius: "50%", background: "rgba(255,180,220,0.25)", filter: "blur(20px)"}}/>
              <div style={{padding: "24px 26px", position: "relative"}}>
                <div className="center" style={{gap: 8}}>
                  <Icon name="sparkle" size={16}/>
                  <span style={{fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", opacity: 0.85}}>Notices · Awaiting review</span>
                </div>
                <div style={{fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em", marginTop: 8, lineHeight: 1.25}}>
                  {awaiting.length} notice{awaiting.length !== 1 ? "s" : ""} to review.<br/>
                  <span style={{opacity: 0.85}}>Recent, or with an upcoming hearing.</span>
                </div>
                <div className="row" style={{marginTop: 16, gap: 10, alignItems: "center"}}>
                  <span className="btn" style={{background: "white", color: "var(--p-primary-2)"}}>
                    Review &amp; mark as read <Icon name="arrow-right" size={14}/>
                  </span>
                </div>
              </div>
            </div>
          )}

          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Upcoming hearings</div>
                <div className="card-sub">{hearings.length ? `${hearings.length} scheduled · across all authorities` : "Nothing scheduled yet"}</div>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => onNav("hearings")}>View all <Icon name="arrow-right" size={14}/></button>
            </div>
            {hearings.length === 0 && (
              <div className="muted" style={{fontSize: 13, padding: "18px 0", textAlign: "center"}}>
                No upcoming hearings. Add one from the <b style={{cursor: "pointer", color: "var(--p-primary-2)"}} onClick={() => onNav("hearings")}>Hearings</b> page.
              </div>
            )}
            <div className="col" style={{gap: 10}}>
              {hearings.slice(0, 4).map(h => {
                const d = daysFromNow(h.date);
                return (
                  <div key={h.id} className="hearing-card">
                    <div className={`hearing-date ${d <= 1 ? "urgent" : d <= 4 ? "warning" : ""}`}>
                      <div className="d">{new Date(h.date).getDate()}</div>
                      <div className="m">{new Date(h.date).toLocaleString("en-IN",{month:"short"})}</div>
                    </div>
                    <div style={{flex: 1, minWidth: 0}}>
                      <div className="between">
                        <div style={{fontWeight: 700, fontSize: 14}}>{h.assessee}</div>
                        <div className="center" style={{gap: 6}}>
                          <span className="pill pill-primary">{h.authority}</span>
                          {h.mode === "Video Conference" && <span className="pill pill-info"><Icon name="video" size={11}/>VC</span>}
                        </div>
                      </div>
                      <div className="muted" style={{fontSize: 12, marginTop: 3}}>
                        {h.bench} · AY {h.ay} {h.section && `· u/s ${h.section}`} · <Icon name="clock" size={11}/> {h.time}
                      </div>
                    </div>
                    <Icon name="chevron-right" size={16} className="muted"/>
                  </div>
                );
              })}
            </div>
          </div>

          <ReceivablesCard data={data}/>
        </div>

        <div className="col" style={{gap: 18}}>
          <MiniCalendar hearings={data.hearings} onNav={onNav}/>
          <AuthorityMixCard matters={activeMatters}/>
          <ChecklistCard/>
        </div>
      </div>

      {showNotices && (
        <AwaitingNoticesModal
          awaiting={awaiting}
          onClose={() => setShowNotices(false)}
          onOpenNotice={(n) => { setShowNotices(false); onOpenNotice(n); }}
        />
      )}
    </div>
  );
}

// A small square checkbox matching the checklist style.
function Check({ checked, onChange }) {
  return (
    <div
      onClick={(e) => { e.stopPropagation(); onChange(); }}
      role="checkbox"
      aria-checked={checked}
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onChange(); } }}
      style={{width: 18, height: 18, borderRadius: 6, border: "2px solid var(--p-line)", display: "grid", placeItems: "center", cursor: "pointer", background: checked ? "var(--p-primary)" : "white", borderColor: checked ? "var(--p-primary)" : "var(--p-line)", flexShrink: 0}}
    >
      {checked && <Icon name="check" size={12} stroke={3}/>}
    </div>
  );
}

// Popup opened from the dashboard's "Notices · Awaiting review" card — the
// notices worth acting on now (recent, or with an upcoming hearing). Each can
// be ticked read individually or in bulk.
function AwaitingNoticesModal({ awaiting, onClose, onOpenNotice }) {
  const { updateNotice, notify } = useData();
  const [selected, setSelected] = React.useState(() => new Set());
  const [busy, setBusy] = React.useState(false);
  const today = todayISO();

  const rows = React.useMemo(
    () => [...awaiting].sort((a, b) => (b.date || "").localeCompare(a.date || "")),
    [awaiting]
  );

  const toggle = (id) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const allSelected = rows.length > 0 && rows.every((n) => selected.has(n.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((n) => n.id)));

  const markRead = async (ids) => {
    if (!ids.length || busy) return;
    setBusy(true);
    for (const id of ids) await updateNotice(id, { read: true });
    setBusy(false);
    setSelected(new Set());
    notify(ids.length > 1 ? `${ids.length} notices marked as read` : "Marked as read");
  };

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{maxWidth: 640, padding: "22px 24px"}} onClick={(e) => e.stopPropagation()}>
        <div className="between" style={{alignItems: "flex-start", gap: 12, marginBottom: 12}}>
          <div>
            <div style={{fontSize: 17, fontWeight: 800}}>Notices · Awaiting review</div>
            <div className="card-sub" style={{marginTop: 2}}>{rows.length} recent or with an upcoming hearing · tick to mark as read</div>
          </div>
          <button className="icon-btn" style={{width: 32, height: 32, borderRadius: 10, flexShrink: 0}} title="Close" onClick={onClose}><Icon name="x" size={15}/></button>
        </div>

        <div className="between" style={{padding: "2px 2px 12px", gap: 10}}>
          <div className="center" style={{gap: 10, justifyContent: "flex-start"}}>
            <Check checked={allSelected} onChange={toggleAll}/>
            <span className="muted" style={{fontSize: 12}}>Select all</span>
          </div>
          {selected.size > 0 && (
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => markRead([...selected])}>
              <Icon name="check" size={14}/>Mark {selected.size} as read
            </button>
          )}
        </div>

        <div className="col" style={{gap: 8, maxHeight: "60vh", overflowY: "auto"}}>
          {rows.map((n) => {
            const due = n.responseDueDate || n.hearingDate || "";
            const hasFutureHearing = due && due >= today;
            const isSel = selected.has(n.id);
            return (
              <div key={n.id} className="center" style={{gap: 12, padding: "10px 12px", border: "1px solid var(--p-line-2)", borderRadius: 11, background: isSel ? "var(--p-lavender-2)" : "transparent"}}>
                <Check checked={isSel} onChange={() => toggle(n.id)}/>
                <div style={{flex: 1, minWidth: 0, cursor: "pointer"}} onClick={() => onOpenNotice(n)} title="Open to review">
                  <div className="between" style={{gap: 8}}>
                    <span className="strong" style={{fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{n.assessee || "—"}</span>
                    <div className="center" style={{gap: 6, flexShrink: 0}}>
                      {n.section && <span className="pill pill-muted">u/s {n.section}</span>}
                      {hasFutureHearing && <span className="pill pill-pink"><Icon name="calendar" size={10}/>{fmtDate(due)}</span>}
                    </div>
                  </div>
                  <div className="muted" style={{fontSize: 11.5, marginTop: 3}}>
                    AY {n.ay || "—"}{n.din ? ` · DIN …${String(n.din).slice(-6)}` : ""}{n.date ? ` · ${fmtDate(n.date)}` : ""}
                  </div>
                </div>
                <button className="btn btn-ghost btn-xs" disabled={busy} title="Mark as read" onClick={() => markRead([n.id])}>
                  <Icon name="check" size={12}/>Read
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body
  );
}

function ReceivablesCard({ data }) {
  const byGroup = {};
  data.assessees.forEach(a => {
    const invs = data.invoices.filter(i => i.assessee === a.name);
    const out = invs.reduce((s, i) => s + invoiceOutstanding(i), 0);
    if (out <= 0) return;
    const g = a.group || "Others";
    byGroup[g] = byGroup[g] || { amount: 0, count: 0 };
    byGroup[g].amount += out;
    byGroup[g].count += 1;
  });
  // invoices for assessees not in the register still count
  const known = new Set(data.assessees.map(a => a.name));
  data.invoices.filter(i => !known.has(i.assessee)).forEach(i => {
    const out = invoiceOutstanding(i);
    if (out <= 0) return;
    byGroup["Others"] = byGroup["Others"] || { amount: 0, count: 0 };
    byGroup["Others"].amount += out;
  });
  const rows = Object.entries(byGroup).sort((a, b) => b[1].amount - a[1].amount).slice(0, 6);
  const max = rows.length ? rows[0][1].amount : 1;
  const palette = ["var(--p-primary)", "var(--p-primary-3)", "#FFB3D9", "#FFD17A", "#8EE7BC", "#B8A8FF"];

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">Receivables — Group-wise</div>
          <div className="card-sub">Outstanding professional fees</div>
        </div>
      </div>
      {rows.length === 0 && <div className="muted" style={{fontSize: 13, padding: "14px 0", textAlign: "center"}}>No outstanding receivables. 🎉</div>}
      <div className="col" style={{gap: 12}}>
        {rows.map(([name, g], i) => (
          <div key={name}>
            <div className="between" style={{marginBottom: 6}}>
              <div className="center" style={{gap: 8}}>
                <div style={{width: 8, height: 8, borderRadius: 3, background: palette[i % palette.length]}}/>
                <span style={{fontWeight: 600, fontSize: 13}}>{name}</span>
                {g.count > 0 && <span className="pill pill-muted" style={{fontSize: 10, padding: "1px 6px"}}>{g.count} assessee{g.count > 1 ? "s" : ""}</span>}
              </div>
              <div style={{fontWeight: 700, fontSize: 13}}>{fmtINR(g.amount)}</div>
            </div>
            <div style={{height: 8, borderRadius: 4, background: "var(--p-card-tint)", overflow: "hidden"}}>
              <div style={{height: "100%", width: `${Math.max(4, (g.amount / max) * 100)}%`, background: palette[i % palette.length], borderRadius: 4, transition: "width 0.6s ease"}}/>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, delta, deltaKind, icon, iconBg, iconColor, glow, goLabel, onClick }) {
  return (
    <div
      className={`stat ${onClick ? "clickable" : ""}`}
      style={glow ? { "--stat-glow": glow } : undefined}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
      title={onClick ? `Open ${goLabel || label}` : undefined}
    >
      <div className="stat-icon" style={{background: iconBg, color: iconColor}}>
        <Icon name={icon} size={18}/>
      </div>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className={`stat-delta ${deltaKind}`}>
        {deltaKind === "up" && <Icon name="trend-up" size={12}/>}
        {deltaKind === "down" && <Icon name="alert" size={12}/>}
        {delta}
      </div>
      {onClick && <span className="stat-go">{goLabel || "View"} <Icon name="arrow-right" size={11}/></span>}
    </div>
  );
}

function MiniCalendar({ hearings, onNav }) {
  const now = new Date();
  const [month, setMonth] = React.useState(new Date(now.getFullYear(), now.getMonth(), 1));

  const year = month.getFullYear();
  const m = month.getMonth();
  const daysInMonth = new Date(year, m + 1, 0).getDate();
  const mondayOffset = (new Date(year, m, 1).getDay() + 6) % 7;
  const monthPrefix = toISO(month).slice(0, 7);
  const eventDays = new Set(hearings.filter(h => (h.date || "").startsWith(monthPrefix)).map(h => new Date(h.date + "T00:00:00").getDate()));
  const isCurrentMonth = now.getFullYear() === year && now.getMonth() === m;
  const today = now.getDate();

  const cells = [];
  for (let i = 0; i < mondayOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  return (
    <div className="cal">
      <div className="cal-head">
        <div>
          <div style={{fontWeight: 800, fontSize: 17, letterSpacing: "-0.02em"}}>{month.toLocaleString("en-IN", { month: "long", year: "numeric" })}</div>
          <div className="card-sub">{eventDays.size ? `${eventDays.size} day${eventDays.size > 1 ? "s" : ""} with hearings` : "No hearings this month"}</div>
        </div>
        <div className="center" style={{gap: 4}}>
          <button className="icon-btn" style={{width: 30, height: 30, borderRadius: 9}} onClick={() => setMonth(new Date(year, m - 1, 1))}><Icon name="chevron-left" size={14}/></button>
          <button className="icon-btn" style={{width: 30, height: 30, borderRadius: 9}} onClick={() => setMonth(new Date(year, m + 1, 1))}><Icon name="chevron-right" size={14}/></button>
        </div>
      </div>
      <div className="cal-grid">
        {["M","T","W","T","F","S","S"].map((d, i) => <div key={i} className="cal-dow">{d}</div>)}
        {cells.map((d, i) => {
          if (d === null) return <div key={i} className="cal-cell muted"/>;
          const hasEvent = eventDays.has(d);
          return (
            <div
              key={i}
              className={`cal-cell ${isCurrentMonth && d === today ? "today" : ""} ${hasEvent ? "has-event" : ""}`}
              onClick={() => onNav("hearings")}
            >{d}</div>
          );
        })}
      </div>
      <div className="row" style={{marginTop: 14, gap: 10}}>
        <div className="center" style={{gap: 6, fontSize: 11, color: "var(--p-text-3)"}}>
          <div style={{width: 7, height: 7, borderRadius: "50%", background: "var(--p-primary)"}}/>Hearing
        </div>
        <button className="btn btn-ghost btn-xs" style={{marginLeft: "auto"}} onClick={() => onNav("hearings")}>Open calendar →</button>
      </div>
    </div>
  );
}

function AuthorityMixCard({ matters }) {
  const palette = { "Scrutiny": "#6C5CE7", "CIT(A)": "#8E7CFF", "ITAT": "#FFB3D9", "Penalty": "#FFD17A" };
  const byType = {};
  matters.forEach(mt => { byType[mt.type] = (byType[mt.type] || 0) + 1; });
  const data = Object.entries(byType).map(([label, value], i) => ({
    label, value,
    color: palette[label] || ["#8EE7BC", "#B8A8FF", "#FFC9A3"][i % 3],
  }));
  const total = data.reduce((s, d) => s + d.value, 0);
  const C = 2 * Math.PI * 36;
  let offset = 0;

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">Authority-wise matters</div>
          <div className="card-sub">{total} active</div>
        </div>
      </div>
      {total === 0 ? (
        <div className="muted" style={{fontSize: 13, padding: "14px 0", textAlign: "center"}}>No active matters yet.</div>
      ) : (
        <div className="row" style={{alignItems: "center", gap: 22}}>
          <svg viewBox="0 0 100 100" width="120" height="120">
            <circle cx="50" cy="50" r="36" fill="none" stroke="var(--p-card-tint)" strokeWidth="14"/>
            {data.map((d, i) => {
              const len = (d.value / total) * C;
              const el = (
                <circle key={i} cx="50" cy="50" r="36" fill="none" stroke={d.color} strokeWidth="14"
                  strokeDasharray={`${len} ${C - len}`}
                  strokeDashoffset={-offset}
                  transform="rotate(-90 50 50)"
                  strokeLinecap="butt"/>
              );
              offset += len;
              return el;
            })}
            <text x="50" y="48" textAnchor="middle" fontSize="14" fontWeight="800" fill="var(--p-text)">{total}</text>
            <text x="50" y="60" textAnchor="middle" fontSize="7" fill="var(--p-text-3)" fontWeight="600">MATTERS</text>
          </svg>
          <div className="col" style={{gap: 8, flex: 1}}>
            {data.map(d => (
              <div key={d.label} className="between" style={{fontSize: 12.5}}>
                <div className="center" style={{gap: 8}}>
                  <div style={{width: 8, height: 8, borderRadius: 3, background: d.color}}/>
                  <span style={{fontWeight: 600}}>{d.label}</span>
                </div>
                <span style={{fontWeight: 700}}>{d.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ChecklistCard() {
  const { data, addTodo, updateTodo, removeTodo } = useData();
  const [text, setText] = React.useState("");
  const left = data.todos.filter(t => !t.done).length;

  const submit = () => {
    const v = text.trim();
    if (!v) return;
    addTodo({ text: v, done: false });
    setText("");
  };

  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">Today's checklist</div>
        {left > 0 && <span className="pill pill-pink">{left} left</span>}
      </div>
      <div className="col" style={{gap: 8}}>
        {data.todos.map(t => (
          <div key={t.id} className="center" style={{gap: 10, padding: "10px 12px", borderRadius: 11, background: t.done ? "var(--p-card-tint)" : "transparent", border: "1px solid var(--p-line-2)"}}>
            <div
              onClick={() => updateTodo(t.id, { done: !t.done })}
              style={{width: 18, height: 18, borderRadius: 6, border: "2px solid var(--p-line)", display: "grid", placeItems: "center", cursor: "pointer", background: t.done ? "var(--p-primary)" : "white", borderColor: t.done ? "var(--p-primary)" : "var(--p-line)", flexShrink: 0}}
            >
              {t.done && <Icon name="check" size={12} stroke={3}/>}
            </div>
            <div style={{flex: 1, fontSize: 13, fontWeight: 500, color: t.done ? "var(--p-text-3)" : "var(--p-text)", textDecoration: t.done ? "line-through" : "none"}}>{t.text}</div>
            {t.tag && <span className={`pill pill-${t.tagColor || "muted"}`}>{t.tag}</span>}
            <button className="btn btn-ghost btn-xs" onClick={() => removeTodo(t.id)}><Icon name="x" size={11}/></button>
          </div>
        ))}
        {data.todos.length === 0 && <div className="muted" style={{fontSize: 12.5, textAlign: "center", padding: "6px 0"}}>Nothing on the list.</div>}
        <div className="center" style={{gap: 8}}>
          <div className="search" style={{flex: 1}}>
            <Icon name="plus" size={14}/>
            <input placeholder="Add a task…" value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === "Enter") submit(); }}/>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={submit}>Add</button>
        </div>
      </div>
    </div>
  );
}
