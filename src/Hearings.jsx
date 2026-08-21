/* ProHippo — Hearings calendar + list */
import React from 'react';
import { Icon, Avatar, StatusPill, Modal, FormField, TextInput, SelectInput, EmptyState, Toggle, useIsPhone, titleCase, fmtDateLong, daysFromNow } from './shared';
import { useData, downloadCSV, toISO, todayISO } from './store';
import { AssesseeModal, AssesseeRequiredNote } from './AssesseeModal';
import { useCalendarConfig, useCalendarActions, relativeSyncTime } from './googleCalendar';
import ItatInbox from './ItatInbox';
import { downloadCauseListPDF } from './causeListPdf';
import { weekRange, monthRange, addDays, causeListRows, causeListSummary, rangeDays, MAX_RANGE_DAYS } from './causeList';

const AUTHORITIES = ["Scrutiny", "CIT(A)", "ITAT", "Penalty", "Other"];
const MODES = ["Physical", "Video Conference", "e-Proceeding"];

export function HearingModal({ initial, onClose }) {
  const { data, addHearing, updateHearing, notify } = useData();
  const { connected: calendarOn } = useCalendarConfig();
  const [form, setForm] = React.useState({
    assessee: "", pan: "", ay: "", authority: "Scrutiny", bench: "", section: "",
    date: todayISO(), time: "11:00", mode: "Physical", status: "Upcoming", ita: "", staff: "",
    gcalSkip: false,
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
      {calendarOn && (
        <div className="between" style={{marginTop: 14, padding: "10px 12px", borderRadius: 10, background: "var(--p-card-tint)", gap: 12}}>
          <div className="center" style={{gap: 8}}>
            <Icon name="calendar" size={14} className="muted"/>
            <div style={{fontSize: 12.5}}>
              {form.gcalSkip ? "Kept out of your Google Calendar" : "Will appear in your Google Calendar"}
            </div>
          </div>
          <div className="center" style={{gap: 8}}>
            <span className="muted" style={{fontSize: 12}}>Skip this one</span>
            <Toggle checked={Boolean(form.gcalSkip)} onChange={set("gcalSkip")} label="Skip this hearing in Google Calendar"/>
          </div>
        </div>
      )}
      {showAddAssessee && (
        <AssesseeModal
          onClose={() => setShowAddAssessee(false)}
          onSaved={(a) => setForm(f => ({ ...f, assessee: a.name, pan: a.pan, staff: f.staff || a.staff || "" }))}
        />
      )}
    </Modal>
  );
}

/* Adjourning a hearing is TWO records, not one edit.
 *
 * A matter put off four times has been heard on four dates, and that history is
 * what a practitioner is asked about across the table — "when was it last
 * listed, and why did it not proceed?". Moving the date on the existing record
 * answers none of that: it leaves one hearing that appears never to have been
 * adjourned at all. So the old date is closed as Adjourned and the new one is
 * opened beside it, carrying everything except the things that must not travel:
 * the document's own identity, and the Google Calendar event it is synced to.
 *
 * This is the same shape the Tribunal's own notices produce. When a fresh notice
 * arrives for an appeal already on file, applyItatMail marks the earlier date
 * Adjourned and writes the new one — a hearing adjourned in court and a hearing
 * adjourned by notice end up indistinguishable, which is right, because they
 * are the same event reaching us by two routes.
 */
const CARRIED_TO_NEW_DATE = [
  "assessee", "pan", "ay", "authority", "bench", "section",
  "mode", "staff", "ita", "venue", "caseType", "gcalSkip",
];

export function AdjournModal({ hearing, onClose }) {
  const { addHearing, updateHearing, notify } = useData();
  const [date, setDate] = React.useState("");
  const [time, setTime] = React.useState(hearing.time || "10:30");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  // Forward only. An adjournment moves a matter later; a date before the one
  // being adjourned is a typo every time, and it would sort the new hearing
  // above the old one and read as the history running backwards.
  const valid = Boolean(date) && date > hearing.date && !busy;

  const save = async () => {
    if (!valid) return;
    setBusy(true);
    /* Named fields rather than "everything except". A hearing grows fields over
       time, and the ones that must NOT travel are exactly the ones nobody
       remembers to exclude: `gcal` holds the Google Calendar event this record
       is synced to, and carrying it would point two hearings at one event. An
       allowlist cannot be wrong about a field invented next year. */
    const carried = {};
    for (const k of CARRIED_TO_NEW_DATE) if (hearing[k] !== undefined) carried[k] = hearing[k];

    await updateHearing(hearing.id, { status: "Adjourned", adjournedTo: date });
    await addHearing({
      ...carried,
      date,
      time,
      status: "Upcoming",
      adjournedFrom: hearing.date,
      ...(note.trim() ? { note: note.trim() } : {}),
      source: "adjournment",
    });
    notify(`Adjourned to ${fmtDateLong(date)}`);
    onClose();
  };

  return (
    <Modal
      title="Adjourn hearing"
      sub={`${titleCase(hearing.assessee)} · ${hearing.authority}${hearing.ita ? ` · ${hearing.ita}` : ""}`}
      onClose={onClose}
      width={520}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid} style={{ opacity: valid ? 1 : 0.5 }} onClick={save}>
          <Icon name="check" size={14} />{busy ? "Saving…" : "Adjourn"}
        </button>
      </>}
    >
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 14, lineHeight: 1.6 }}>
        The hearing listed for <b>{fmtDateLong(hearing.date)}</b> will be marked Adjourned and kept,
        and a new one opened on the date below with the same assessee, bench and appeal number.
      </div>
      <div className="form-grid">
        <FormField label="Adjourned to" required><TextInput type="date" value={date} onChange={setDate} /></FormField>
        <FormField label="Time"><TextInput type="time" value={time} onChange={setTime} /></FormField>
        <FormField label="Note" full><TextInput value={note} onChange={setNote} placeholder="e.g. bench not sitting, adjournment sought" /></FormField>
      </div>
      {date && date <= hearing.date && (
        <div style={{ fontSize: 12.5, color: "var(--p-danger)", marginTop: 10 }}>
          The new date has to be after {fmtDateLong(hearing.date)}.
        </div>
      )}
    </Modal>
  );
}

/* One colour per forum, used by every view of a hearing. Was a closure inside
   the week grid; the phone's views need the same three fields. */
const colorFor = (h) => {
  if (h.authority === "ITAT") return { bg: "var(--p-lavender-2)", fg: "var(--p-primary-2)", bar: "var(--p-primary)" };
  if (h.authority === "CIT(A)") return { bg: "var(--p-pink)", fg: "#C13388", bar: "#C13388" };
  if (h.authority === "Scrutiny") return { bg: "var(--p-amber)", fg: "#B07512", bar: "#F39C12" };
  return { bg: "var(--p-mint)", fg: "#1B8C5C", bar: "#20B978" };
};

function startOfWeek(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // back to Monday
  return x;
}

/* THE HEARING, ON A PHONE.
 *
 * Tapping a hearing used to jump straight to the proceeding it belongs to,
 * which is the right destination from a desk — the calendar is beside the
 * record there. On a phone it is a jump out of the calendar into a different
 * page of a different assessee, and what was actually wanted nine times out of
 * ten was the four lines this shows: when, where, under what, and who is
 * taking it.
 *
 * WHAT IS NOT HERE. Everything on this screen is a field the hearing carries.
 * There are no reminders to toggle, no per-hearing sync state and no notes,
 * because the record has none of those — a screen that draws them would be
 * drawing controls that answer to nothing. The three actions at its foot are
 * the three that exist: open the proceeding, move the date, edit the record.
 */
function HearingSheet({ hearing: h, onOpenHearing, onEdit, onAdjourn, onClose }) {
  const c = colorFor(h);
  const day = h.date ? new Date(h.date) : null;
  const facts = [
    { icon: "calendar", value: h.date ? `${day.toLocaleString("en-IN", { weekday: "short" })}, ${fmtDateLong(h.date)}` : "No date" },
    { icon: "clock", value: [h.time, h.mode].filter(Boolean).join("  ·  ") || "—" },
    { icon: "scale", value: [h.authority, h.bench].filter(Boolean).join(" — ") || "—" },
    h.section || h.ita ? { icon: "doc", value: [h.ita, h.section ? `u/s ${h.section}` : ""].filter(Boolean).join("  ·  ") } : null,
    h.staff ? { icon: "user", value: h.staff } : null,
  ].filter(Boolean);

  return (
    <Modal
      className="pm-full hsheet"
      title="Hearing Details"
      closeIcon="arrow-left"
      onClose={onClose}
      width={620}
      footer={null}
    >
      <div className="col" style={{gap: 16}}>
        <div className="hsheet-id">
          <span className="pill" style={{background: c.bg, color: c.fg, fontWeight: 800}}>{h.authority} hearing</span>
          <h2 className="hsheet-name">{titleCase(h.assessee || "—")}</h2>
          <div className="hsheet-sub">{[h.ay ? `AY ${h.ay}` : "", h.pan].filter(Boolean).join("  ·  ")}</div>
          <StatusPill status={h.date && h.date < todayISO() && h.status === "Upcoming" ? "Completed" : h.status}/>
        </div>

        <div className="hsheet-facts">
          {facts.map((f, i) => (
            <div key={i} className="hsheet-fact">
              <span className="hsheet-fact-ico"><Icon name={f.icon} size={16}/></span>
              <span>{f.value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Pinned to the floor: on a page you have scrolled to the end of, the
          thing you do next should not be somewhere back up it. */}
      <div className="hsheet-actions">
        {onOpenHearing && <button className="btn btn-secondary" onClick={() => { onClose(); onOpenHearing(h); }}><Icon name="scale" size={14}/>Matter</button>}
        {h.status !== "Adjourned" && <button className="btn btn-secondary" onClick={() => { onClose(); onAdjourn(h); }}><Icon name="clock" size={14}/>Adjourn</button>}
        <button className="btn btn-primary" onClick={() => { onClose(); onEdit(h); }}><Icon name="edit" size={14}/>Edit</button>
      </div>
    </Modal>
  );
}

/* THE WEEK, ON A PHONE.
 *
 * The desk view is seven columns held at 960px, which is right for a wall of
 * a screen and is a sideways scroll on 390px — you can see Monday and half of
 * Tuesday, and finding Friday means swiping past three days you did not want.
 *
 * The week does not stop being a week when it is a column. Each day is a row:
 * the day on the left in the margin, what is listed that day beside it, and a
 * dash where nothing is. A week with two hearings in it should be readable
 * without moving your thumb, and this is the shape that does that.
 */
function MobileWeek({ hearings, onOpenHearing, weekStart, setWeekStart }) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return { date: d.getDate(), dow: d.toLocaleString("en-IN", { weekday: "short" }), iso: toISO(d), today: toISO(d) === todayISO() };
  });
  const shift = (n) => setWeekStart((w) => { const d = new Date(w); d.setDate(d.getDate() + n * 7); return d; });

  return (
    <div className="mweek">
      <div className="mweek-head">
        <div className="mweek-title">Week of {fmtDateLong(toISO(weekStart))}</div>
        <div className="mweek-nav">
          <button className="mweek-arrow" aria-label="Previous week" onClick={() => shift(-1)}><Icon name="chevron-left" size={15}/></button>
          <button className="mweek-today" onClick={() => setWeekStart(startOfWeek(new Date()))}>Today</button>
          <button className="mweek-arrow" aria-label="Next week" onClick={() => shift(1)}><Icon name="chevron-right" size={15}/></button>
        </div>
      </div>

      <div className="mweek-days">
        {days.map((day) => {
          const list = hearings.filter((h) => h.date === day.iso).sort((a, b) => (a.time || "").localeCompare(b.time || ""));
          return (
            <div key={day.iso} className={`mday ${day.today ? "today" : ""} ${list.length ? "" : "empty"}`}>
              <div className="mday-when">
                <span className="mday-dow">{day.dow.toUpperCase()}</span>
                <span className="mday-num">{day.date}</span>
              </div>
              <div className="mday-list">
                {list.length === 0 && <span className="mday-none">—</span>}
                {list.map((h) => {
                  const c = colorFor(h);
                  return (
                    <div
                      key={h.id}
                      className="mhear"
                      role="button"
                      tabIndex={0}
                      style={{background: c.bg, borderLeftColor: c.bar}}
                      onClick={() => onOpenHearing && onOpenHearing(h)}
                      onKeyDown={(e) => { if (onOpenHearing && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onOpenHearing(h); } }}
                    >
                      <div className="mhear-top">
                        <span className="mhear-time" style={{color: c.fg}}>{h.time}</span>
                        <span className="pill" style={{background: "white", color: c.fg, fontWeight: 700}}>{h.authority}</span>
                      </div>
                      <div className="mhear-who">{titleCase(h.assessee || "—")}</div>
                      <div className="mhear-meta">
                        {[h.ay ? `AY ${h.ay}` : "", h.mode === "Video Conference" ? "VC" : h.bench || ""].filter(Boolean).join("  ·  ")}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* The week grid. `weekStart` is owned by the page rather than by this view,
   because the cause list offers "the week you are looking at" and cannot ask a
   child component which week that is. */
function WeekView({ hearings, onOpenHearing, weekStart, setWeekStart }) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return { date: d.getDate(), dow: d.toLocaleString("en-IN", { weekday: "short" }), iso: toISO(d), today: toISO(d) === todayISO() };
  });
  const shift = (n) => setWeekStart(w => { const d = new Date(w); d.setDate(d.getDate() + n * 7); return d; });

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
  const { removeHearing, notify } = useData();
  const [adjourning, setAdjourning] = React.useState(null);
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
                  {/* Available on a hearing whose date has passed as well as one
                      still ahead: an adjournment is usually recorded after the
                      event, on the way out of court. */}
                  {h.status !== "Adjourned" && (
                    <button className="btn btn-ghost btn-xs" title="Adjourn to another date" onClick={(e) => { e.stopPropagation(); setAdjourning(h); }}><Icon name="clock" size={12}/></button>
                  )}
                  <button className="btn btn-ghost btn-xs" title="Delete" onClick={(e) => { e.stopPropagation(); if (window.confirm("Delete this hearing?")) { removeHearing(h.id); notify("Hearing deleted"); } }}><Icon name="trash" size={12}/></button>
                </div>
              </td>
            </tr>
          ))}
          {hearings.length === 0 && <tr><td colSpan="9" style={{textAlign: "center", padding: 40, color: "var(--p-text-3)"}}>No hearings recorded.</td></tr>}
        </tbody>
      </table>
      {adjourning && <AdjournModal hearing={adjourning} onClose={() => setAdjourning(null)} />}
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

/* The everyday calendar control, next to the calendar itself. Setup lives in
   Settings; this is only ever "how are we doing, and push it again now". */
function GoogleSyncChip({ onNav }) {
  const { notify } = useData();
  const { cfg, loading, connected, needsReauth } = useCalendarConfig();
  const { syncNow } = useCalendarActions();
  const [syncing, setSyncing] = React.useState(false);

  // Nothing at all until we know — a chip that flickers "not connected" on
  // every page load is worse than a beat of silence.
  if (loading) return null;

  const shell = {
    display: "inline-flex", alignItems: "center", gap: 8,
    background: "white", border: "1px solid var(--p-line)", borderRadius: 10,
    padding: "6px 10px", fontSize: 12.5, fontWeight: 650, color: "var(--p-text-2)",
  };

  if (!connected && !needsReauth) {
    return (
      <button style={{...shell, cursor: "pointer"}} onClick={() => onNav && onNav("settings")}>
        <Icon name="calendar" size={13} className="muted"/>
        <span style={{color: "var(--p-primary-2)"}}>Connect Google Calendar</span>
      </button>
    );
  }

  if (needsReauth) {
    return (
      <button style={{...shell, borderColor: "var(--p-danger)", cursor: "pointer"}} onClick={() => onNav && onNav("settings")}>
        <Icon name="alert" size={13} style={{color: "var(--p-danger)"}}/>
        Google access expired
        <span style={{color: "var(--p-primary-2)"}}>Reconnect</span>
      </button>
    );
  }

  const push = async () => {
    setSyncing(true);
    try {
      const counts = await syncNow();
      const touched = (counts.created || 0) + (counts.updated || 0);
      notify(touched ? `Google Calendar updated — ${touched} event${touched === 1 ? "" : "s"}` : "Google Calendar already up to date");
    } catch (e) {
      console.error("sync now:", e);
      notify(e?.message || "Couldn't reach Google Calendar", "alert");
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div style={shell}>
      <Icon name={syncing ? "clock" : "check"} size={13} style={{color: syncing ? "var(--p-text-3)" : "var(--p-success)"}}/>
      {syncing ? "Syncing…" : `Google · synced ${relativeSyncTime(cfg?.lastSyncAt)}`}
      <span style={{width: 1, height: 18, background: "var(--p-line)"}}/>
      <button
        className="btn btn-ghost btn-xs"
        style={{color: "var(--p-primary-2)", padding: "2px 6px"}}
        disabled={syncing}
        onClick={push}
      >
        Sync now
      </button>
    </div>
  );
}


/* ---------------- Cause list ---------------- */

/* The week's hearings as a document you can print, file or send on.
 *
 * The week on screen is the default because that is what somebody has in front
 * of them when the thought occurs; any other stretch of dates is two fields
 * away. The sheet itself is drawn in causeListPdf.js.
 *
 * The counts update as the dates and filters change, so nobody downloads a
 * cause list to find out it was empty. */
function CauseListModal({ weekStart, authority, onClose }) {
  // The whole profile, not data.profile's two-field summary — the letterhead
  // wants the firm's address and phone.
  const { data, profile, notify } = useData();
  const week = weekRange(weekStart || new Date());
  const [from, setFrom] = React.useState(week.from);
  const [to, setTo] = React.useState(week.to);
  const [auth, setAuth] = React.useState(authority || "All");
  const [includeAdjourned, setIncludeAdjourned] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const preset = (range) => { setFrom(range.from); setTo(range.to); };
  const presets = [
    { label: "Week shown", range: week },
    { label: "Next week", range: weekRange(addDays(week.from, 7)) },
    { label: "Next 7 days", range: { from: todayISO(), to: addDays(todayISO(), 6) } },
    { label: "This month", range: monthRange(new Date()) },
  ];
  const active = presets.find((p) => p.range.from === from && p.range.to === to);

  const rows = React.useMemo(
    () => causeListRows(data.hearings, { from, to, authority: auth, includeAdjourned }),
    [data.hearings, from, to, auth, includeAdjourned]
  );
  const s = causeListSummary(rows);
  const spanDays = rangeDays(from, to).length;
  const badRange = !from || !to || to < from;

  const download = () => {
    if (badRange || busy) return;
    setBusy(true);
    try {
      downloadCauseListPDF({ hearings: data.hearings, from, to, authority: auth, includeAdjourned, profile });
      notify(rows.length ? `Cause list downloaded — ${rows.length} hearing${rows.length === 1 ? "" : "s"}` : "Cause list downloaded — nothing listed in those dates");
      onClose();
    } catch (e) {
      console.error("cause list failed", e);
      notify("Couldn't build the cause list — try a shorter range.", "alert");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Download cause list"
      sub="Every hearing in the dates you choose, as a printable PDF"
      onClose={onClose}
      width={560}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={badRange || busy} style={{opacity: badRange || busy ? 0.5 : 1}} onClick={download}>
          <Icon name="download" size={14}/>{busy ? "Building…" : "Download PDF"}
        </button>
      </>}
    >
      <div className="row" style={{gap: 6, flexWrap: "wrap", marginBottom: 14}}>
        {presets.map((p) => (
          <span key={p.label} className={`fchip ${active?.label === p.label ? "active" : ""}`} onClick={() => preset(p.range)}>{p.label}</span>
        ))}
      </div>

      <div className="form-grid">
        <FormField label="From" required><TextInput value={from} onChange={setFrom} type="date"/></FormField>
        <FormField label="To" required><TextInput value={to} onChange={setTo} type="date"/></FormField>
        <FormField label="Authority">
          <SelectInput value={auth} onChange={setAuth} options={["All", "Scrutiny", "CIT(A)", "ITAT", "Penalty", "High Court"]}/>
        </FormField>
        <FormField label="Adjourned hearings">
          <Toggle checked={includeAdjourned} onChange={setIncludeAdjourned} label={includeAdjourned ? "Included" : "Left out"}/>
        </FormField>
      </div>

      {/* What the button is about to produce. A cause list nobody can check
          before downloading is one that gets downloaded twice. */}
      <div style={{marginTop: 14, padding: "12px 14px", background: "var(--p-card-tint)", border: "1px solid var(--p-line-2)", borderRadius: 12}}>
        {badRange ? (
          <div className="center" style={{gap: 8, justifyContent: "flex-start", fontSize: 12.5, color: "#B8463A"}}>
            <Icon name="alert" size={14}/>The "to" date falls before the "from" date.
          </div>
        ) : (
          <>
            <div className="center" style={{gap: 8, justifyContent: "flex-start"}}>
              <Icon name="calendar" size={14}/>
              <div style={{fontSize: 13, fontWeight: 700}}>
                {s.hearings ? `${s.hearings} hearing${s.hearings === 1 ? "" : "s"} · ${s.days} day${s.days === 1 ? "" : "s"} · ${s.assessees} assessee${s.assessees === 1 ? "" : "s"}` : "Nothing listed in these dates"}
              </div>
            </div>
            <div className="muted" style={{fontSize: 11.5, marginTop: 6, lineHeight: 1.5}}>
              {spanDays} day{spanDays === 1 ? "" : "s"} covered{s.videoConference ? ` · ${s.videoConference} by video conference` : ""}.
              {" "}{includeAdjourned ? "Adjourned hearings are included." : "Adjourned hearings are left out — the new date is listed on its own."}
              {spanDays >= MAX_RANGE_DAYS ? " Only the first year of the range is printed." : ""}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

export default function Hearings({ onOpenHearing, onNav }) {
  const { data } = useData();
  const isPhone = useIsPhone();
  const [view, setView] = React.useState("Week");
  const [filterAuthority, setFilterAuthority] = React.useState("All");
  const [modal, setModal] = React.useState(null); // null | {} | hearing record
  const [causeList, setCauseList] = React.useState(false);
  /* On a phone a hearing opens its own details first; from a desk it still
     jumps straight to the proceeding, where the calendar sits beside the
     record anyway. */
  const [sheet, setSheet] = React.useState(null);
  const [adjourning, setAdjourning] = React.useState(null);
  const openHearing = isPhone ? setSheet : onOpenHearing;
  // Owned here, not in WeekView, so "the week shown" is something the cause
  // list can offer — see WeekView.
  const [weekStart, setWeekStart] = React.useState(() => startOfWeek(new Date()));

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
          <GoogleSyncChip onNav={onNav}/>
          <button className="btn btn-secondary" onClick={() => setCauseList(true)} title="Print the week's hearings, or any dates you choose"><Icon name="doc" size={14}/>Cause list</button>
          <button className="btn btn-secondary" onClick={exportCSV}><Icon name="download" size={14}/>Export CSV</button>
          <button className="btn btn-primary" onClick={() => setModal({})}><Icon name="plus" size={14}/>Add hearing</button>
        </div>
      </div>

      {/* Above the calendar rather than beside it: an email waiting to be
          confirmed is a hearing that is NOT yet on any of the views below, and
          the whole point is that it does not sit there unnoticed. Renders
          nothing at all when the queue is empty. */}
      <ItatInbox/>

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

      {view === "Week" && (isPhone
        ? <MobileWeek hearings={filtered} onOpenHearing={openHearing} weekStart={weekStart} setWeekStart={setWeekStart}/>
        : <WeekView hearings={filtered} onOpenHearing={onOpenHearing} weekStart={weekStart} setWeekStart={setWeekStart}/>)}
      {view === "Calendar" && <CalendarView hearings={filtered} onOpenHearing={openHearing}/>}
      {view === "List" && <ListView hearings={[...filtered].sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time))} onEdit={(h) => setModal(h)} onOpenHearing={openHearing}/>}
      {view === "Authority-wise" && <GroupedView hearings={filtered.filter(h => h.date >= todayISO())} groupBy="authority" onOpenHearing={openHearing}/>}
      {view === "Staff-wise" && <GroupedView hearings={filtered.filter(h => h.date >= todayISO())} groupBy="staff" onOpenHearing={openHearing}/>}

      {sheet && (
        <HearingSheet
          hearing={sheet}
          onOpenHearing={onOpenHearing}
          onEdit={(h) => setModal(h)}
          onAdjourn={(h) => setAdjourning(h)}
          onClose={() => setSheet(null)}
        />
      )}
      {adjourning && <AdjournModal hearing={adjourning} onClose={() => setAdjourning(null)}/>}
      {modal && <HearingModal initial={modal.id ? modal : undefined} onClose={() => setModal(null)}/>}
      {causeList && (
        <CauseListModal
          weekStart={weekStart}
          authority={filterAuthority}
          onClose={() => setCauseList(false)}
        />
      )}
    </div>
  );
}
