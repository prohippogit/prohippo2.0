/* ProHippo — Hearings calendar + list */
import React from 'react';
import { Icon, Avatar, StatusPill, HEARINGS, fmtDateLong, daysFromNow } from './shared';

function WeekView({ hearings }) {
  // Week of 25-31 May 2026 (Mon-Sun)
  const days = [
    { label: "Mon", date: 25, dow: "Mon", iso: "2026-05-25" },
    { label: "Tue", date: 26, dow: "Tue", iso: "2026-05-26" },
    { label: "Wed", date: 27, dow: "Wed", iso: "2026-05-27", today: true },
    { label: "Thu", date: 28, dow: "Thu", iso: "2026-05-28" },
    { label: "Fri", date: 29, dow: "Fri", iso: "2026-05-29" },
    { label: "Sat", date: 30, dow: "Sat", iso: "2026-05-30" },
    { label: "Sun", date: 31, dow: "Sun", iso: "2026-05-31" },
  ];

  const colorFor = (h) => {
    if (h.authority === "ITAT") return { bg: "var(--p-lavender-2)", fg: "var(--p-primary-2)", bar: "var(--p-primary)" };
    if (h.authority === "CIT(A)") return { bg: "var(--p-pink)", fg: "#C13388", bar: "#C13388" };
    if (h.authority === "Scrutiny") return { bg: "var(--p-amber)", fg: "#B07512", bar: "#F39C12" };
    return { bg: "var(--p-mint)", fg: "#1B8C5C", bar: "#20B978" };
  };

  return (
    <div className="card" style={{padding: 18}}>
      <div className="between" style={{marginBottom: 14}}>
        <div style={{fontWeight: 800, fontSize: 17, letterSpacing: "-0.02em"}}>Week of 25 May 2026</div>
        <div className="center" style={{gap: 4}}>
          <button className="icon-btn" style={{width: 32, height: 32, borderRadius: 9}}><Icon name="chevron-left" size={14}/></button>
          <button className="btn btn-secondary btn-sm">Today</button>
          <button className="icon-btn" style={{width: 32, height: 32, borderRadius: 9}}><Icon name="chevron-right" size={14}/></button>
        </div>
      </div>
      <div className="grid" style={{gridTemplateColumns: "repeat(7, 1fr)", gap: 8}}>
        {days.map(day => {
          const dayHearings = hearings.filter(h => h.date === day.iso);
          return (
            <div key={day.iso} style={{minHeight: 360, background: day.today ? "linear-gradient(180deg, var(--p-lavender) 0%, white 100%)" : "var(--p-card-tint)", borderRadius: 14, padding: 10, border: day.today ? "2px solid var(--p-primary)" : "1px solid var(--p-line-2)"}}>
              <div className="between" style={{marginBottom: 10, paddingBottom: 8, borderBottom: "1px solid var(--p-line-2)"}}>
                <div>
                  <div className="muted" style={{fontSize: 10, fontWeight: 700, letterSpacing: "0.08em"}}>{day.dow.toUpperCase()}</div>
                  <div style={{fontSize: 18, fontWeight: 800, color: day.today ? "var(--p-primary)" : "var(--p-text)"}}>{day.date}</div>
                </div>
                {day.today && <span className="pill pill-primary" style={{fontSize: 9}}>Today</span>}
              </div>
              <div className="col" style={{gap: 6}}>
                {dayHearings.map(h => {
                  const c = colorFor(h);
                  return (
                    <div key={h.id} style={{background: c.bg, borderRadius: 10, padding: "8px 10px", borderLeft: `3px solid ${c.bar}`, cursor: "pointer"}}>
                      <div style={{fontSize: 10, fontWeight: 700, color: c.fg, marginBottom: 2}}>{h.time}</div>
                      <div style={{fontSize: 11.5, fontWeight: 700, lineHeight: 1.25, marginBottom: 2}}>{h.assessee}</div>
                      <div style={{fontSize: 10, color: "var(--p-text-3)"}}>{h.authority} · AY {h.ay}</div>
                      {h.mode === "Video Conference" && <div className="center" style={{gap: 4, fontSize: 9, color: "#2766C7", marginTop: 2}}><Icon name="video" size={10}/>VC</div>}
                    </div>
                  );
                })}
                {dayHearings.length === 0 && <div className="muted" style={{fontSize: 11, textAlign: "center", padding: "20px 0"}}>—</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CalendarView({ hearings }) {
  const today = 27;
  const eventDays = hearings.map(h => parseInt(h.date.slice(-2)));
  const days = 31;
  const mondayOffset = 4; // May 1 2026 is Friday => Mon-first offset = 4
  const cells = [];
  for (let i = 0; i < mondayOffset; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  const [selected, setSelected] = React.useState(28);
  const selectedISO = `2026-05-${String(selected).padStart(2, "00")}`;
  const selectedHearings = hearings.filter(h => h.date === selectedISO);

  return (
    <div className="grid" style={{gridTemplateColumns: "1.6fr 1fr", gap: 18}}>
      <div className="card">
        <div className="cal-head" style={{marginBottom: 16}}>
          <div>
            <div style={{fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em"}}>May 2026</div>
            <div className="card-sub">{hearings.length} hearings scheduled</div>
          </div>
          <div className="center" style={{gap: 4}}>
            <button className="icon-btn" style={{width: 32, height: 32, borderRadius: 9}}><Icon name="chevron-left" size={14}/></button>
            <button className="icon-btn" style={{width: 32, height: 32, borderRadius: 9}}><Icon name="chevron-right" size={14}/></button>
          </div>
        </div>
        <div className="cal-grid" style={{gap: 6}}>
          {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(d => <div key={d} className="cal-dow">{d}</div>)}
          {cells.map((d, i) => {
            if (d === null) return <div key={i}/>;
            const hasEvent = eventDays.includes(d);
            const isToday = d === today;
            const isSelected = d === selected;
            return (
              <div
                key={i}
                onClick={() => setSelected(d)}
                style={{
                  aspectRatio: "1.05",
                  borderRadius: 12,
                  padding: 8,
                  background: isToday ? "var(--p-primary)" : isSelected ? "var(--p-lavender-2)" : "var(--p-card-tint)",
                  color: isToday ? "white" : "var(--p-text)",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  border: isSelected && !isToday ? "1px solid var(--p-primary-3)" : "none",
                }}
              >
                <div style={{fontSize: 13, fontWeight: 700}}>{d}</div>
                {hasEvent && (
                  <div className="col" style={{gap: 2, marginTop: 4}}>
                    {hearings.filter(h => parseInt(h.date.slice(-2)) === d).slice(0,2).map(h => (
                      <div key={h.id} style={{fontSize: 9, fontWeight: 600, padding: "1px 4px", borderRadius: 4, background: isToday ? "rgba(255,255,255,0.22)" : "white", color: isToday ? "white" : "var(--p-primary-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                        {h.time} {h.authority}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="col" style={{gap: 16}}>
        <div className="card">
          <div className="card-title mb-3">{new Date(selectedISO).toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" })}</div>
          {selectedHearings.length === 0 && <div className="muted" style={{padding: "20px 0", textAlign: "center", fontSize: 13}}>No hearings on this date.</div>}
          <div className="col" style={{gap: 10}}>
            {selectedHearings.map(h => (
              <div key={h.id} className="hearing-card" style={{padding: 12}}>
                <div style={{width: 52, textAlign: "center"}}>
                  <div style={{fontSize: 14, fontWeight: 800, color: "var(--p-primary-2)"}}>{h.time}</div>
                  <div style={{fontSize: 9, color: "var(--p-text-3)", fontWeight: 700, textTransform: "uppercase"}}>{h.mode === "Video Conference" ? "VC" : h.mode === "e-Proceeding" ? "e-Proc" : "Phys"}</div>
                </div>
                <div style={{flex: 1, minWidth: 0}}>
                  <div style={{fontWeight: 700, fontSize: 13}}>{h.assessee}</div>
                  <div className="muted" style={{fontSize: 11.5}}>{h.authority} · {h.bench}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-title mb-3">Legend</div>
          <div className="col" style={{gap: 8}}>
            <Legend color="var(--p-primary)" label="ITAT — 2 matters"/>
            <Legend color="#C13388" label="CIT(A) — 1 matter"/>
            <Legend color="#F39C12" label="Scrutiny — 3 matters"/>
            <Legend color="#20B978" label="Synced with Google Calendar"/>
          </div>
        </div>
      </div>
    </div>
  );
}

function Legend({ color, label }) {
  return (
    <div className="center" style={{gap: 8, fontSize: 12.5}}>
      <div style={{width: 8, height: 8, borderRadius: 3, background: color}}/>
      <span>{label}</span>
    </div>
  );
}

function ListView({ hearings }) {
  return (
    <div className="card" style={{padding: 0}}>
      <table className="tbl">
        <thead><tr><th>Date / Time</th><th>Assessee</th><th>Authority</th><th>Bench / Officer</th><th>AY</th><th>Mode</th><th>Staff</th><th>Status</th></tr></thead>
        <tbody>
          {hearings.map(h => (
            <tr key={h.id}>
              <td>
                <div className="strong">{fmtDateLong(h.date)}</div>
                <div className="muted">{h.time}</div>
              </td>
              <td>
                <div className="strong">{h.assessee}</div>
                <div className="muted" style={{fontFamily: "ui-monospace, monospace"}}>{h.pan}</div>
              </td>
              <td><span className="pill pill-primary">{h.authority}</span></td>
              <td className="semi">{h.bench}</td>
              <td>{h.ay}</td>
              <td>
                <div className="center" style={{gap: 6, fontSize: 12.5}}>
                  {h.mode === "Video Conference" && <Icon name="video" size={12}/>}
                  {h.mode}
                </div>
              </td>
              <td><Avatar name={h.staff} color="mint" size="sm"/></td>
              <td><StatusPill status={h.status}/></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AuthorityView({ hearings }) {
  const grouped = hearings.reduce((acc, h) => {
    acc[h.authority] = acc[h.authority] || [];
    acc[h.authority].push(h);
    return acc;
  }, {});
  return (
    <div className="col" style={{gap: 16}}>
      {Object.entries(grouped).map(([auth, items]) => (
        <div key={auth} className="card">
          <div className="card-head">
            <div>
              <div className="card-title">{auth}</div>
              <div className="card-sub">{items.length} upcoming · across {new Set(items.map(i => i.bench)).size} benches</div>
            </div>
            <span className="pill pill-primary">{items.length}</span>
          </div>
          <div className="col" style={{gap: 8}}>
            {items.map(h => {
              const d = daysFromNow(h.date);
              return (
                <div key={h.id} className="hearing-card">
                  <div className={`hearing-date ${d <= 1 ? "urgent" : d <= 4 ? "warning" : ""}`}>
                    <div className="d">{new Date(h.date).getDate()}</div>
                    <div className="m">{new Date(h.date).toLocaleString("en-IN",{month:"short"})}</div>
                  </div>
                  <div style={{flex: 1}}>
                    <div className="between">
                      <div style={{fontWeight: 700}}>{h.assessee}</div>
                      <div className="muted" style={{fontSize: 12}}><Icon name="clock" size={11}/> {h.time} · {h.mode}</div>
                    </div>
                    <div className="muted" style={{fontSize: 12, marginTop: 2}}>{h.bench} · AY {h.ay} {h.section !== "—" && `· u/s ${h.section}`}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Hearings() {
  const [view, setView] = React.useState("Week"); // Calendar | Week | List
  const [filterAuthority, setFilterAuthority] = React.useState("All");
  const filtered = HEARINGS.filter(h => filterAuthority === "All" || h.authority === filterAuthority);

  return (
    <div className="animate-in">
      <div className="topbar">
        <div>
          <div className="page-title">Hearings & Calendar</div>
          <div className="page-sub">7 upcoming · 3 in the next 48 hours · Google Calendar synced 2 min ago</div>
        </div>
        <div className="topbar-actions">
          <span className="pill pill-success" style={{padding: "6px 10px"}}>
            <Icon name="check" size={11}/> Google Calendar
          </span>
          <button className="btn btn-secondary"><Icon name="download" size={14}/>Cause list PDF</button>
          <button className="btn btn-primary"><Icon name="plus" size={14}/>Add hearing</button>
        </div>
      </div>

      <div className="between" style={{marginBottom: 16, alignItems: "center", flexWrap: "wrap", gap: 12}}>
        <div className="tabs">
          {["Calendar","Week","List","Authority-wise","Staff-wise"].map(v => (
            <div key={v} className={`tab ${view === v ? "active" : ""}`} onClick={() => setView(v)}>{v}</div>
          ))}
        </div>
        <div className="row" style={{gap: 6}}>
          {["All","Scrutiny","CIT(A)","ITAT"].map(a => (
            <span key={a} className={`fchip ${filterAuthority === a ? "active" : ""}`} onClick={() => setFilterAuthority(a)}>{a}</span>
          ))}
        </div>
      </div>

      {view === "Week" && <WeekView hearings={filtered}/>}
      {view === "Calendar" && <CalendarView hearings={filtered}/>}
      {view === "List" && <ListView hearings={filtered}/>}
      {view === "Authority-wise" && <AuthorityView hearings={filtered}/>}
      {view === "Staff-wise" && <AuthorityView hearings={filtered}/>}
    </div>
  );
}
