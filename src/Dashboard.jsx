import React from 'react';
import { Icon, Avatar, HEARINGS, INVOICES, fmtINR, daysFromNow } from './shared';

export default function Dashboard({ onNav, onOpenParsedNotice }) {
  return (
    <div className="animate-in">
      <div className="topbar">
        <div>
          <div className="page-title">Good morning, Jayesh 👋</div>
          <div className="page-sub">You have <b style={{color: "var(--p-primary-2)"}}>3 hearings this week</b> and <b style={{color: "#C13388"}}>4 notices</b> awaiting review.</div>
        </div>
        <div className="topbar-actions">
          <div className="search">
            <Icon name="search" size={16}/>
            <input placeholder="Search PAN, assessee, DIN, ITA No…"/>
            <span className="pill pill-muted" style={{fontSize: 10}}>⌘K</span>
          </div>
          <button className="icon-btn"><Icon name="bell" size={18}/><span className="dot"/></button>
          <div className="user-chip">
            <Avatar name="Jayesh Vyas" color="violet"/>
            <div style={{lineHeight: 1.2}}>
              <div style={{fontSize: 12.5, fontWeight: 700}}>Jayesh Vyas</div>
              <div style={{fontSize: 11, color: "var(--p-text-3)"}}>Owner · CA</div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid" style={{gridTemplateColumns: "repeat(4, 1fr)", marginBottom: 18}}>
        <Stat label="Active matters" value="42" delta="+6 this month" deltaKind="up" icon="scale" iconBg="var(--p-lavender-2)" iconColor="var(--p-primary-2)"/>
        <Stat label="Hearings this week" value="7" delta="3 in next 48h" deltaKind="neutral" icon="calendar" iconBg="var(--p-pink)" iconColor="#C13388"/>
        <Stat label="Outstanding fees" value="₹8.42L" delta="₹1.2L overdue" deltaKind="down" icon="wallet" iconBg="var(--p-amber)" iconColor="#B07512"/>
        <Stat label="Notices received" value="12" delta="4 awaiting AI review" deltaKind="neutral" icon="doc" iconBg="var(--p-mint)" iconColor="#1B8C5C"/>
      </div>

      <div className="grid" style={{gridTemplateColumns: "1.6fr 1fr", gap: 18}}>
        <div className="col" style={{gap: 18}}>
          {/* AI parsed notices banner */}
          <div className="card" style={{padding: 0, overflow: "hidden", border: "none", background: "linear-gradient(120deg, #2B2270 0%, #5146C6 55%, #8E7CFF 100%)", color: "white", position: "relative"}}>
            <div style={{position: "absolute", right: -40, top: -40, width: 200, height: 200, borderRadius: "50%", background: "rgba(255,180,220,0.25)", filter: "blur(20px)"}}/>
            <div style={{position: "absolute", right: 60, bottom: -30, width: 140, height: 140, borderRadius: "50%", background: "rgba(255,255,255,0.1)"}}/>
            <div style={{padding: "24px 26px", position: "relative"}}>
              <div className="center" style={{gap: 8}}>
                <Icon name="sparkle" size={16}/>
                <span style={{fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", opacity: 0.85}}>AI Parser · Awaiting review</span>
              </div>
              <div style={{fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em", marginTop: 8, lineHeight: 1.25}}>
                4 notices parsed.<br/>
                <span style={{opacity: 0.85}}>Verify extracted details before saving.</span>
              </div>
              <div className="row" style={{marginTop: 16, gap: 10, alignItems: "center"}}>
                <button className="btn" style={{background: "white", color: "var(--p-primary-2)"}} onClick={onOpenParsedNotice}>
                  Review parsed data <Icon name="arrow-right" size={14}/>
                </button>
                <button className="btn btn-ghost" style={{color: "white"}} onClick={() => onNav("notices")}>
                  See all notices
                </button>
                <div style={{marginLeft: "auto", display: "flex"}}>
                  {["RS", "NI", "MP", "HT"].map((t, i) => (
                    <div key={t} style={{width: 32, height: 32, borderRadius: 10, background: ["#FFB3D9","#FFD17A","#8EE7BC","#B8A8FF"][i], display: "grid", placeItems: "center", fontSize: 11, fontWeight: 800, color: "#2B2270", border: "2px solid #5146C6", marginLeft: i ? -10 : 0}}>{t}</div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Upcoming hearings */}
          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Upcoming hearings</div>
                <div className="card-sub">Next 14 days · across all authorities</div>
              </div>
              <div className="center" style={{gap: 8}}>
                <button className="btn btn-secondary btn-sm"><Icon name="download" size={14}/>Cause list PDF</button>
                <button className="btn btn-ghost btn-sm" onClick={() => onNav("hearings")}>View all <Icon name="arrow-right" size={14}/></button>
              </div>
            </div>
            <div className="col" style={{gap: 10}}>
              {HEARINGS.slice(0, 4).map(h => {
                const d = daysFromNow(h.date);
                const urgent = d <= 1;
                return (
                  <div key={h.id} className="hearing-card">
                    <div className={`hearing-date ${urgent ? "urgent" : d <= 4 ? "warning" : ""}`}>
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
                        {h.bench} · AY {h.ay} {h.section !== "—" && `· u/s ${h.section}`} · <Icon name="clock" size={11}/> {h.time}
                      </div>
                    </div>
                    <Icon name="chevron-right" size={16} className="muted"/>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Receivables by group */}
          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Receivables — Group-wise</div>
                <div className="card-sub">Outstanding professional fees this quarter</div>
              </div>
              <button className="btn btn-ghost btn-sm">This quarter <Icon name="chevron-down" size={14}/></button>
            </div>
            <div className="col" style={{gap: 12}}>
              <GroupBar name="Shah Group" pct={84} amount={245000} count={2} color="var(--p-primary)"/>
              <GroupBar name="Nirvana Group" pct={45} amount={132000} count={1} color="var(--p-primary-3)"/>
              <GroupBar name="Patel Family" pct={30} amount={86500} count={1} color="#FFB3D9"/>
              <GroupBar name="Vinod Bros." pct={19} amount={54200} count={1} color="#FFD17A"/>
              <GroupBar name="Others" pct={42} amount={124500} count={6} color="#8EE7BC"/>
            </div>
          </div>
        </div>

        <div className="col" style={{gap: 18}}>
          <MiniCalendar onNav={onNav}/>

          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Authority-wise matters</div>
                <div className="card-sub">42 active</div>
              </div>
              <span className="pill pill-primary">All staff</span>
            </div>
            <DonutMix/>
          </div>

          <div className="card">
            <div className="card-head">
              <div className="card-title">Today's checklist</div>
              <span className="pill pill-pink">3 left</span>
            </div>
            <div className="col" style={{gap: 8}}>
              <Todo done text="Submit Form 35 for Patel HUF appeal"/>
              <Todo text="Draft reply for Nirvana Infotech u/s 143(2)" tag="Due tomorrow" tagColor="danger"/>
              <Todo text="Send document request — Rajesh Shah (AY 17-18)" tag="WhatsApp" tagColor="info"/>
              <Todo text="Reconcile receipts ₹85,000 from Shah Textiles" tag="₹85,000" tagColor="success"/>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, delta, deltaKind, icon, iconBg, iconColor }) {
  return (
    <div className="stat">
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
    </div>
  );
}

function GroupBar({ name, pct, amount, count, color }) {
  return (
    <div>
      <div className="between" style={{marginBottom: 6}}>
        <div className="center" style={{gap: 8}}>
          <div style={{width: 8, height: 8, borderRadius: 3, background: color}}/>
          <span style={{fontWeight: 600, fontSize: 13}}>{name}</span>
          <span className="pill pill-muted" style={{fontSize: 10, padding: "1px 6px"}}>{count} assessees</span>
        </div>
        <div style={{fontWeight: 700, fontSize: 13}}>{fmtINR(amount)}</div>
      </div>
      <div style={{height: 8, borderRadius: 4, background: "var(--p-card-tint)", overflow: "hidden"}}>
        <div style={{height: "100%", width: `${pct}%`, background: color, borderRadius: 4, transition: "width 0.6s ease"}}/>
      </div>
    </div>
  );
}

function MiniCalendar({ onNav }) {
  const startDow = 5;
  const days = 31;
  const eventDays = [12, 19, 21, 22, 28, 29];
  const today = 27;
  const cells = [];
  const mondayOffset = (startDow + 6) % 7;
  for (let i = 0; i < mondayOffset; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);

  return (
    <div className="cal">
      <div className="cal-head">
        <div>
          <div style={{fontWeight: 800, fontSize: 17, letterSpacing: "-0.02em"}}>May 2026</div>
          <div className="card-sub">7 events</div>
        </div>
        <div className="center" style={{gap: 4}}>
          <button className="icon-btn" style={{width: 30, height: 30, borderRadius: 9}}><Icon name="chevron-left" size={14}/></button>
          <button className="icon-btn" style={{width: 30, height: 30, borderRadius: 9}}><Icon name="chevron-right" size={14}/></button>
        </div>
      </div>
      <div className="cal-grid">
        {["M","T","W","T","F","S","S"].map((d, i) => <div key={i} className="cal-dow">{d}</div>)}
        {cells.map((d, i) => {
          if (d === null) return <div key={i} className="cal-cell muted"/>;
          const hasEvent = eventDays.includes(d);
          return (
            <div
              key={i}
              className={`cal-cell ${d === today ? "today" : ""} ${hasEvent ? "has-event" : ""}`}
              onClick={() => onNav("hearings")}
            >{d}</div>
          );
        })}
      </div>
      <div className="row" style={{marginTop: 14, gap: 10}}>
        <div className="center" style={{gap: 6, fontSize: 11, color: "var(--p-text-3)"}}>
          <div style={{width: 7, height: 7, borderRadius: "50%", background: "var(--p-primary)"}}/>Hearing
        </div>
        <div className="center" style={{gap: 6, fontSize: 11, color: "var(--p-text-3)"}}>
          <div style={{width: 7, height: 7, borderRadius: "50%", background: "#C13388"}}/>Due date
        </div>
        <button className="btn btn-ghost btn-xs" style={{marginLeft: "auto"}} onClick={() => onNav("hearings")}>Open calendar →</button>
      </div>
    </div>
  );
}

function DonutMix() {
  const data = [
    { label: "Scrutiny", value: 14, color: "#6C5CE7" },
    { label: "CIT(A)", value: 11, color: "#8E7CFF" },
    { label: "ITAT", value: 9, color: "#FFB3D9" },
    { label: "Penalty", value: 5, color: "#FFD17A" },
    { label: "Rect./Rev.", value: 3, color: "#8EE7BC" },
  ];
  const total = data.reduce((s, d) => s + d.value, 0);
  const C = 2 * Math.PI * 36;
  let offset = 0;
  return (
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
  );
}

function Todo({ text, tag, tagColor, done }) {
  const [checked, setChecked] = React.useState(done || false);
  return (
    <div className="center" style={{gap: 10, padding: "10px 12px", borderRadius: 11, background: checked ? "var(--p-card-tint)" : "transparent", border: "1px solid var(--p-line-2)", cursor: "pointer"}} onClick={() => setChecked(!checked)}>
      <div style={{width: 18, height: 18, borderRadius: 6, border: "2px solid var(--p-line)", display: "grid", placeItems: "center", background: checked ? "var(--p-primary)" : "white", borderColor: checked ? "var(--p-primary)" : "var(--p-line)"}}>
        {checked && <Icon name="check" size={12} stroke={3}/>}
      </div>
      <div style={{flex: 1, fontSize: 13, fontWeight: 500, color: checked ? "var(--p-text-3)" : "var(--p-text)", textDecoration: checked ? "line-through" : "none"}}>{text}</div>
      {tag && <span className={`pill pill-${tagColor}`}>{tag}</span>}
    </div>
  );
}
