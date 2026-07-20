/* ProHippo — Hearings calendar + list */
import React from 'react';
import { Icon, Avatar, StatusPill, Modal, FormField, TextInput, SelectInput, EmptyState, titleCase, fmtDateLong, daysFromNow } from './shared';
import { useData, downloadCSV, toISO, todayISO } from './store';
import { AssesseeModal, AssesseeRequiredNote } from './AssesseeModal';

const AUTHORITIES = ["Scrutiny", "CIT(A)", "ITAT", "Penalty", "Other"];
const MODES = ["Physical", "Video Conference", "e-Proceeding"];

export function HearingModal({ initial, onClose }) {
  const { data, addHearing, updateHearing, notify } = useData();
  const [form, setForm] = React.useState({
    assessee: "", pan: "", ay: "", authority: "Scrutiny", bench: "", section: "",
    date: todayISO(), time: "11:00", mode: "Physical", status: "Upcoming", ita: "", staff: "",
    ...initial,
  });
  const [showAddAssessee, setShowAddAssessee] = React.useState(false);
  const set = (k) => (v) => setForm(f => ({ ...f, [k]: v }));
  const pickAssessee = (name) => {
    const a = data.assessees.find(x => x.name === name);
    setForm(f => ({ ...f, assessee: name, pan: a?.pan || f.pan, staff: f.staff || a?.staff || "" }));
  };
  const linked = data.assessees.find(a => a.name === form.assessee);
  const valid = Boolean(linked) && form.date && form.time && form.ay.trim();

  const save = () => {
    if (!valid) return;
    const rec = { ...form, pan: linked.pan };
    if (initial?.id) {
      updateHearing(initial.id, rec);
      notify("Hearing updated");
    } else {
      addHearing(rec);
      notify(`Hearing added — ${fmtDateLong(rec.date)} at ${rec.time}`);
    }
    onClose();
  };

  return (
    <Modal
      title={initial?.id ? "Edit hearing" : "Add hearing"}
      sub="Appears on the calendar, dashboard and assessee profile"
      onClose={onClose}
      width={620}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid} style={{opacity: valid ? 1 : 0.5}} onClick={save}>
          <Icon name="check" size={14}/>{initial?.id ? "Save changes" : "Add hearing"}
        </button>
      </>}
    >
      {data.assessees.length === 0 && (
        <div style={{marginBottom: 14}}>
          <AssesseeRequiredNote
            message="Every hearing is linked to an assessee profile. Add the assessee first — this form unlocks once they're on file."
            onCreate={() => setShowAddAssessee(true)}
          />
        </div>
      )}
      <div className="form-grid">
        <FormField label="Assessee" required full>
          <SelectInput value={linked ? linked.name : ""} onChange={pickAssessee} options={data.assessees.map(a => ({ value: a.name, label: titleCase(a.name) }))} placeholder={data.assessees.length ? "Select assessee…" : "No assessees yet"}/>
        </FormField>
        <FormField label="PAN"><TextInput value={linked ? linked.pan : form.pan} onChange={(v) => set("pan")(v.toUpperCase())} placeholder="ABCPS1234F" mono/></FormField>
        <FormField label="Assessment year" required><TextInput value={form.ay} onChange={set("ay")} placeholder="2021-22"/></FormField>
        <FormField label="Authority"><SelectInput value={form.authority} onChange={set("authority")} options={AUTHORITIES}/></FormField>
        <FormField label="Bench / Officer"><TextInput value={form.bench} onChange={set("bench")} placeholder="e.g. Ahmedabad 'A' Bench"/></FormField>
        <FormField label="Date" required><TextInput type="date" value={form.date} onChange={set("date")}/></FormField>
        <FormField label="Time" required><TextInput type="time" value={form.time} onChange={set("time")}/></FormField>
        <FormField label="Mode"><SelectInput value={form.mode} onChange={set("mode")} options={MODES}/></FormField>
        <FormField label="Section"><TextInput value={form.section} onChange={set("section")} placeholder="e.g. 143(2)"/></FormField>
        <FormField label="ITA / Appeal No."><TextInput value={form.ita} onChange={set("ita")} placeholder="ITA No. …"/></FormField>
        <FormField label="Staff"><TextInput value={form.staff} onChange={set("staff")} placeholder="Assigned staff"/></FormField>
      </div>
      {showAddAssessee && (
        <AssesseeModal
          onClose={() => setShowAddAssessee(false)}
          onSaved={(a) => setForm(f => ({ ...f, assessee: a.name, pan: a.pan, staff: f.staff || a.staff || "" }))}
        />
      )}
    </Modal>
  );
}

function startOfWeek(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // back to Monday
  return x;
}

function WeekView({ hearings, onOpenHearing }) {
  const [weekStart, setWeekStart] = React.useState(() => startOfWeek(new Date()));
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return { date: d.getDate(), dow: d.toLocaleString("en-IN", { weekday: "short" }), iso: toISO(d), today: toISO(d) === todayISO() };
  });
  const shift = (n) => setWeekStart(w => { const d = new Date(w); d.setDate(d.getDate() + n * 7); return d; });

  const colorFor = (h) => {
    if (h.authority === "ITAT") return { bg: "var(--p-lavender-2)", fg: "var(--p-primary-2)", bar: "var(--p-primary)" };
    if (h.authority === "CIT(A)") return { bg: "var(--p-pink)", fg: "#C13388", bar: "#C13388" };
    if (h.authority === "Scrutiny") return { bg: "var(--p-amber)", fg: "#B07512", bar: "#F39C12" };
    return { bg: "var(--p-mint)", fg: "#1B8C5C", bar: "#20B978" };
  };

  return (
    <div className="card week-scroll" style={{padding: 18}}>
      <div className="between" style={{marginBottom: 14}}>
        <div style={{fontWeight: 800, fontSize: 17, letterSpacing: "-0.02em"}}>Week of {fmtDateLong(toISO(weekStart))}</div>
        <div className="center" style={{gap: 4}}>
          <button className="icon-btn" style={{width: 32, height: 32, borderRadius: 9}} onClick={() => shift(-1)}><Icon name="chevron-left" size={14}/></button>
          <button className="btn btn-secondary btn-sm" onClick={() => setWeekStart(startOfWeek(new Date()))}>Today</button>
          <button className="icon-btn" style={{width: 32, height: 32, borderRadius: 9}} onClick={() => shift(1)}><Icon name="chevron-right" size={14}/></button>
        </div>
      </div>
      <div className="grid week-grid" style={{gridTemplateColumns: "repeat(7, 1fr)", gap: 8}}>
        {days.map(day => {
          const dayHearings = hearings.filter(h => h.date === day.iso).sort((a, b) => a.time.localeCompare(b.time));
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
                    <div key={h.id} className={onOpenHearing ? "hearing-clickable" : undefined} onClick={onOpenHearing ? () => onOpenHearing(h) : undefined} style={{background: c.bg, borderRadius: 10, padding: "8px 10px", borderLeft: `3px solid ${c.bar}`, cursor: onOpenHearing ? "pointer" : "default"}} title={onOpenHearing ? "Open proceeding" : undefined}>
                      <div style={{fontSize: 10, fontWeight: 700, color: c.fg, marginBottom: 2}}>{h.time}</div>
                      <div style={{fontSize: 11.5, fontWeight: 700, lineHeight: 1.25, marginBottom: 2}}>{titleCase(h.assessee)}</div>
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

function CalendarView({ hearings, onOpenHearing }) {
  const now = new Date();
  const [month, setMonth] = React.useState(new Date(now.getFullYear(), now.getMonth(), 1));
  const [selected, setSelected] = React.useState(todayISO());

  const year = month.getFullYear();
  const m = month.getMonth();
  const daysInMonth = new Date(year, m + 1, 0).getDate();
  const mondayOffset = (new Date(year, m, 1).getDay() + 6) % 7;
  const monthPrefix = toISO(month).slice(0, 7);
  const monthHearings = hearings.filter(h => (h.date || "").startsWith(monthPrefix));
  const isoFor = (d) => `${monthPrefix}-${String(d).padStart(2, "0")}`;

  const cells = [];
  for (let i = 0; i < mondayOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const selectedHearings = hearings.filter(h => h.date === selected).sort((a, b) => a.time.localeCompare(b.time));

  const byAuthority = {};
  monthHearings.forEach(h => { byAuthority[h.authority] = (byAuthority[h.authority] || 0) + 1; });
  const legendColor = { "ITAT": "var(--p-primary)", "CIT(A)": "#C13388", "Scrutiny": "#F39C12", "Penalty": "#B8463A" };

  return (
    <div className="grid-main">
      <div className="card">
        <div className="cal-head" style={{marginBottom: 16}}>
          <div>
            <div style={{fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em"}}>{month.toLocaleString("en-IN", { month: "long", year: "numeric" })}</div>
            <div className="card-sub">{monthHearings.length} hearing{monthHearings.length !== 1 ? "s" : ""} this month</div>
          </div>
          <div className="center" style={{gap: 4}}>
            <button className="icon-btn" style={{width: 32, height: 32, borderRadius: 9}} onClick={() => setMonth(new Date(year, m - 1, 1))}><Icon name="chevron-left" size={14}/></button>
            <button className="icon-btn" style={{width: 32, height: 32, borderRadius: 9}} onClick={() => setMonth(new Date(year, m + 1, 1))}><Icon name="chevron-right" size={14}/></button>
          </div>
        </div>
        <div className="cal-grid" style={{gap: 6}}>
          {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(d => <div key={d} className="cal-dow">{d}</div>)}
          {cells.map((d, i) => {
            if (d === null) return <div key={i}/>;
            const iso = isoFor(d);
            const dayHearings = monthHearings.filter(h => h.date === iso);
            const isToday = iso === todayISO();
            const isSelected = iso === selected;
            return (
              <div
                key={i}
                onClick={() => setSelected(iso)}
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
                {dayHearings.length > 0 && (
                  <div className="col" style={{gap: 2, marginTop: 4}}>
                    {dayHearings.slice(0, 2).map(h => (
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
          <div className="card-title mb-3">{new Date(selected + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" })}</div>
          {selectedHearings.length === 0 && <div className="muted" style={{padding: "20px 0", textAlign: "center", fontSize: 13}}>No hearings on this date.</div>}
          <div className="col" style={{gap: 10}}>
            {selectedHearings.map(h => (
              <div key={h.id} className={`hearing-card${onOpenHearing ? " hearing-clickable" : ""}`} onClick={onOpenHearing ? () => onOpenHearing(h) : undefined} style={{padding: 12, cursor: onOpenHearing ? "pointer" : "default"}} title={onOpenHearing ? "Open proceeding" : undefined}>
                <div style={{width: 52, textAlign: "center"}}>
                  <div style={{fontSize: 14, fontWeight: 800, color: "var(--p-primary-2)"}}>{h.time}</div>
                  <div style={{fontSize: 9, color: "var(--p-text-3)", fontWeight: 700, textTransform: "uppercase"}}>{h.mode === "Video Conference" ? "VC" : h.mode === "e-Proceeding" ? "e-Proc" : "Phys"}</div>
                </div>
                <div style={{flex: 1, minWidth: 0}}>
                  <div style={{fontWeight: 700, fontSize: 13}}>{titleCase(h.assessee)}</div>
                  <div className="muted" style={{fontSize: 11.5}}>{h.authority} · {h.bench}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        {Object.keys(byAuthority).length > 0 && (
          <div className="card">
            <div className="card-title mb-3">This month</div>
            <div className="col" style={{gap: 8}}>
              {Object.entries(byAuthority).map(([auth, count]) => (
                <Legend key={auth} color={legendColor[auth] || "#20B978"} label={`${auth} — ${count} hearing${count > 1 ? "s" : ""}`}/>
              ))}
            </div>
          </div>
        )}
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

function ListView({ hearings, onEdit, onOpenHearing }) {
  const { updateHearing, removeHearing, notify } = useData();
  return (
    <div className="card" style={{padding: 0}}>
      <table className="tbl">
        <thead><tr><th>Date / Time</th><th>Assessee</th><th>Authority</th><th>Bench / Officer</th><th>AY</th><th>Mode</th><th>Staff</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {hearings.map(h => (
            <tr key={h.id} className={onOpenHearing ? "row-link" : undefined} onClick={onOpenHearing ? () => onOpenHearing(h) : undefined} style={onOpenHearing ? {cursor: "pointer"} : undefined} title={onOpenHearing ? "Open proceeding" : undefined}>
              <td>
                <div className="strong">{fmtDateLong(h.date)}</div>
                <div className="muted">{h.time}</div>
              </td>
              <td>
                <div className="strong">{titleCase(h.assessee)}</div>
                <div className="muted" style={{fontFamily: "ui-monospace, monospace"}}>{h.pan}</div>
              </td>
              <td><span className="pill pill-primary">{h.authority}</span></td>
              <td className="semi">{h.bench || "—"}</td>
              <td>{h.ay}</td>
              <td>
                <div className="center" style={{gap: 6, fontSize: 12.5}}>
                  {h.mode === "Video Conference" && <Icon name="video" size={12}/>}
                  {h.mode}
                </div>
              </td>
              <td>{h.staff ? <Avatar name={h.staff} color="mint" size="sm"/> : <span className="muted">—</span>}</td>
              <td><StatusPill status={h.date < todayISO() && h.status === "Upcoming" ? "Completed" : h.status}/></td>
              <td>
                <div className="row" style={{gap: 4}}>
                  <button className="btn btn-ghost btn-xs" title="Edit" onClick={(e) => { e.stopPropagation(); onEdit(h); }}><Icon name="edit" size={12}/></button>
                  {h.status !== "Adjourned" && h.date >= todayISO() && (
                    <button className="btn btn-ghost btn-xs" title="Mark adjourned" onClick={(e) => { e.stopPropagation(); updateHearing(h.id, { status: "Adjourned" }); notify("Hearing marked adjourned"); }}><Icon name="clock" size={12}/></button>
                  )}
                  <button className="btn btn-ghost btn-xs" title="Delete" onClick={(e) => { e.stopPropagation(); if (window.confirm("Delete this hearing?")) { removeHearing(h.id); notify("Hearing deleted"); } }}><Icon name="trash" size={12}/></button>
                </div>
              </td>
            </tr>
          ))}
          {hearings.length === 0 && <tr><td colSpan="9" style={{textAlign: "center", padding: 40, color: "var(--p-text-3)"}}>No hearings recorded.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function GroupedView({ hearings, groupBy, onOpenHearing }) {
  const grouped = hearings.reduce((acc, h) => {
    const key = (groupBy === "staff" ? h.staff : h.authority) || "Unassigned";
    acc[key] = acc[key] || [];
    acc[key].push(h);
    return acc;
  }, {});
  return (
    <div className="col" style={{gap: 16}}>
      {Object.entries(grouped).map(([group, items]) => (
        <div key={group} className="card">
          <div className="card-head">
            <div>
              <div className="card-title">{group}</div>
              <div className="card-sub">{items.length} hearing{items.length > 1 ? "s" : ""}{groupBy === "authority" ? ` · across ${new Set(items.map(i => i.bench)).size} benches` : ""}</div>
            </div>
            <span className="pill pill-primary">{items.length}</span>
          </div>
          <div className="col" style={{gap: 8}}>
            {items.map(h => {
              const d = daysFromNow(h.date);
              return (
                <div key={h.id} className={`hearing-card${onOpenHearing ? " hearing-clickable" : ""}`} onClick={onOpenHearing ? () => onOpenHearing(h) : undefined} style={onOpenHearing ? {cursor: "pointer"} : undefined} title={onOpenHearing ? "Open proceeding" : undefined}>
                  <div className={`hearing-date ${d <= 1 ? "urgent" : d <= 4 ? "warning" : ""}`}>
                    <div className="d">{new Date(h.date).getDate()}</div>
                    <div className="m">{new Date(h.date).toLocaleString("en-IN",{month:"short"})}</div>
                  </div>
                  <div style={{flex: 1}}>
                    <div className="between">
                      <div style={{fontWeight: 700}}>{titleCase(h.assessee)}</div>
                      <div className="muted" style={{fontSize: 12}}><Icon name="clock" size={11}/> {h.time} · {h.mode}</div>
                    </div>
                    <div className="muted" style={{fontSize: 12, marginTop: 2}}>{h.bench} · AY {h.ay} {h.section && `· u/s ${h.section}`}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {Object.keys(grouped).length === 0 && (
        <div className="card"><EmptyState icon="calendar" title="No hearings" sub="Add a hearing to see it grouped here."/></div>
      )}
    </div>
  );
}

export default function Hearings({ onOpenHearing }) {
  const { data } = useData();
  const [view, setView] = React.useState("Week");
  const [filterAuthority, setFilterAuthority] = React.useState("All");
  const [modal, setModal] = React.useState(null); // null | {} | hearing record

  const filtered = data.hearings.filter(h => filterAuthority === "All" || h.authority === filterAuthority);
  const upcoming = data.hearings.filter(h => h.date >= todayISO() && h.status !== "Adjourned");
  const next48 = upcoming.filter(h => daysFromNow(h.date) <= 2);

  const exportCSV = () => downloadCSV(
    "hearings.csv",
    ["Date", "Time", "Assessee", "PAN", "AY", "Authority", "Bench", "Section", "Mode", "Staff", "Status"],
    filtered.map(h => [h.date, h.time, h.assessee, h.pan, h.ay, h.authority, h.bench, h.section, h.mode, h.staff, h.status])
  );

  return (
    <div className="animate-in">
      <div className="topbar">
        <div>
          <div className="page-title">Hearings & Calendar</div>
          <div className="page-sub">
            {upcoming.length ? `${upcoming.length} upcoming${next48.length ? ` · ${next48.length} in the next 48 hours` : ""}` : "No upcoming hearings"}
          </div>
        </div>
        <div className="topbar-actions">
          <button className="btn btn-secondary" onClick={exportCSV}><Icon name="download" size={14}/>Export CSV</button>
          <button className="btn btn-primary" onClick={() => setModal({})}><Icon name="plus" size={14}/>Add hearing</button>
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

      {view === "Week" && <WeekView hearings={filtered} onOpenHearing={onOpenHearing}/>}
      {view === "Calendar" && <CalendarView hearings={filtered} onOpenHearing={onOpenHearing}/>}
      {view === "List" && <ListView hearings={[...filtered].sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time))} onEdit={(h) => setModal(h)} onOpenHearing={onOpenHearing}/>}
      {view === "Authority-wise" && <GroupedView hearings={filtered.filter(h => h.date >= todayISO())} groupBy="authority" onOpenHearing={onOpenHearing}/>}
      {view === "Staff-wise" && <GroupedView hearings={filtered.filter(h => h.date >= todayISO())} groupBy="staff" onOpenHearing={onOpenHearing}/>}

      {modal && <HearingModal initial={modal.id ? modal : undefined} onClose={() => setModal(null)}/>}
    </div>
  );
}
