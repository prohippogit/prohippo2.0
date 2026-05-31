import React from 'react';
import { Icon, Avatar, StatusPill, NOTICES, INVOICES, fmtINR, fmtDate, fmtDateLong } from './shared';

export function Invoices() {
  return (
    <div className="animate-in">
      <div className="topbar">
        <div>
          <div className="page-title">Invoices</div>
          <div className="page-sub">May 2026 · ₹6.42L billed · ₹4.96L received · ₹8.42L outstanding</div>
        </div>
        <div className="topbar-actions">
          <button className="btn btn-secondary"><Icon name="download" size={14}/>Export</button>
          <button className="btn btn-primary"><Icon name="plus" size={14}/>New invoice</button>
        </div>
      </div>

      <div className="grid" style={{gridTemplateColumns: "1.6fr 1fr", gap: 18, marginBottom: 18}}>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Billing trend</div>
              <div className="card-sub">Last 6 months · ₹ in lakhs</div>
            </div>
            <div className="row" style={{gap: 14}}>
              <Legend color="var(--p-primary)" label="Billed"/>
              <Legend color="#FFB3D9" label="Received"/>
            </div>
          </div>
          <div className="bars" style={{height: 140, marginTop: 8}}>
            {[
              { l: "Dec", a: 70, b: 65 },
              { l: "Jan", a: 60, b: 70 },
              { l: "Feb", a: 85, b: 75 },
              { l: "Mar", a: 92, b: 78 },
              { l: "Apr", a: 78, b: 88 },
              { l: "May", a: 100, b: 82 },
            ].map(m => (
              <div key={m.l} style={{flex: 1, display: "flex", gap: 4, alignItems: "flex-end", position: "relative"}}>
                <div className="bar accent" style={{height: `${m.a}%`}}/>
                <div className="bar" style={{height: `${m.b}%`, background: "#FFB3D9"}}/>
                <div className="bar-label">{m.l}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="card" style={{background: "linear-gradient(120deg, #F8F6FF 0%, #FFEDF5 100%)"}}>
          <div className="card-head">
            <div>
              <div className="card-title">Top outstanding</div>
              <div className="card-sub">5 oldest invoices · ageing 30+ days</div>
            </div>
            <button className="btn btn-ghost btn-sm"><Icon name="whatsapp" size={14}/>Send reminders</button>
          </div>
          <div className="col" style={{gap: 8}}>
            {INVOICES.filter(i => i.status !== "Paid").slice(0,4).map(inv => (
              <div key={inv.id} className="between" style={{padding: "10px 12px", background: "white", borderRadius: 11, border: "1px solid var(--p-line-2)"}}>
                <div>
                  <div style={{fontWeight: 700, fontSize: 13}}>{inv.assessee}</div>
                  <div className="muted" style={{fontSize: 11.5}}>{inv.id} · {fmtDateLong(inv.due)} due</div>
                </div>
                <div style={{textAlign: "right"}}>
                  <div className="strong" style={{fontSize: 14}}>{fmtINR(inv.amount)}</div>
                  <StatusPill status={inv.status}/>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card" style={{padding: 0, overflow: "hidden"}}>
        <div className="row" style={{padding: "14px 18px", justifyContent: "space-between", borderBottom: "1px solid var(--p-line-2)", alignItems: "center"}}>
          <div className="row" style={{gap: 6}}>
            <span className="fchip active">All invoices</span>
            <span className="fchip">Outstanding · 23</span>
            <span className="fchip">Overdue · 4</span>
            <span className="fchip">Paid · 18</span>
            <span className="fchip">Drafts · 2</span>
          </div>
          <div className="row" style={{gap: 6}}>
            <button className="fchip"><Icon name="filter" size={14}/>This month</button>
            <button className="fchip"><Icon name="filter" size={14}/>All staff</button>
          </div>
        </div>
        <table className="tbl">
          <thead><tr><th>Invoice #</th><th>Assessee</th><th>Service</th><th>AY</th><th>Issued</th><th>Due</th><th>Amount</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {INVOICES.map(inv => (
              <tr key={inv.id}>
                <td className="strong" style={{fontFamily: "ui-monospace, monospace", fontSize: 12.5}}>{inv.id}</td>
                <td className="strong">{inv.assessee}</td>
                <td className="semi" style={{maxWidth: 280}}>{inv.service}</td>
                <td>{inv.ay}</td>
                <td className="muted">{fmtDateLong(inv.date)}</td>
                <td className="muted">{fmtDateLong(inv.due)}</td>
                <td className="strong">{fmtINR(inv.amount)}</td>
                <td><StatusPill status={inv.status}/></td>
                <td>
                  <div className="row" style={{gap: 4}}>
                    <button className="btn btn-ghost btn-xs"><Icon name="download" size={12}/></button>
                    <button className="btn btn-ghost btn-xs"><Icon name="more" size={12}/></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Legend({ color, label }) {
  return (
    <div className="center" style={{gap: 6, fontSize: 12}}>
      <div style={{width: 10, height: 10, borderRadius: 3, background: color}}/>
      <span className="semi">{label}</span>
    </div>
  );
}

export function Matters() {
  const matters = [
    { id: "m1", type: "ITAT", assessee: "Rajesh M. Shah", ay: "2017-18", section: "—", ita: "ITA No. 1244/Ahd/2024", bench: "Ahmedabad 'A'", status: "Active", priority: "high", next: "28 May", staff: "Priya Mehta", days: 1 },
    { id: "m2", type: "Scrutiny", assessee: "Shah Textiles Pvt. Ltd.", ay: "2021-22", section: "142(1)", ita: "—", bench: "Circle 4(1), Ahd", status: "Pending", priority: "medium", next: "29 May", staff: "Priya Mehta", days: 2 },
    { id: "m3", type: "CIT(A)", assessee: "Mehul Patel & Sons HUF", ay: "2019-20", section: "250", ita: "Appeal 1029/AHD/CIT(A)/2024-25", bench: "NFAC", status: "Submitted", priority: "medium", next: "02 Jun", staff: "Arjun Desai", days: 6 },
    { id: "m4", type: "Scrutiny", assessee: "Nirvana Infotech LLP", ay: "2020-21", section: "143(2)", ita: "—", bench: "Circle 2(2), Surat", status: "Active", priority: "low", next: "04 Jun", staff: "Arjun Desai", days: 8 },
    { id: "m5", type: "Penalty", assessee: "Vinod Bros. Trading", ay: "2018-19", section: "271(1)(c)", ita: "—", bench: "Circle 3, Mumbai", status: "Pending", priority: "high", next: "—", staff: "Riya Kapoor", days: null },
    { id: "m6", type: "ITAT", assessee: "Vinod Bros. Trading", ay: "2018-19", section: "—", ita: "ITA No. 0987/Mum/2024", bench: "Mumbai 'C'", status: "Active", priority: "high", next: "09 Jun", staff: "Riya Kapoor", days: 13 },
    { id: "m7", type: "Rectification", assessee: "Kavita R. Joshi", ay: "2023-24", section: "154", ita: "—", bench: "CPC, Bengaluru", status: "Submitted", priority: "low", next: "—", staff: "Priya Mehta", days: null },
    { id: "m8", type: "Scrutiny", assessee: "Hari Om Charitable Trust", ay: "2022-23", section: "143(2)", ita: "—", bench: "Exemption Ward, Ahd", status: "Active", priority: "low", next: "11 Jun", staff: "Riya Kapoor", days: 15 },
  ];
  const [tab, setTab] = React.useState("All");
  const typeColor = (t) => {
    if (t === "ITAT") return "primary";
    if (t === "CIT(A)") return "pink";
    if (t === "Scrutiny") return "warning";
    if (t === "Penalty") return "danger";
    return "muted";
  };

  return (
    <div className="animate-in">
      <div className="topbar">
        <div>
          <div className="page-title">Matters</div>
          <div className="page-sub">42 active proceedings across 7 authorities</div>
        </div>
        <div className="topbar-actions">
          <button className="btn btn-secondary"><Icon name="download" size={14}/>Matter summary PDF</button>
          <button className="btn btn-primary"><Icon name="plus" size={14}/>New matter</button>
        </div>
      </div>

      <div className="row" style={{marginBottom: 16, alignItems: "center", justifyContent: "space-between"}}>
        <div className="tabs">
          {["All","Scrutiny","CIT(A)","ITAT","Penalty","Rectification","High Court","Closed"].map(t => (
            <div key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{t}</div>
          ))}
        </div>
        <div className="search" style={{width: 240}}>
          <Icon name="search" size={15}/>
          <input placeholder="Search ITA, PAN, assessee…"/>
        </div>
      </div>

      <div className="card" style={{padding: 0}}>
        <table className="tbl">
          <thead><tr><th>Matter</th><th>Assessee</th><th>AY</th><th>Section</th><th>Bench / Officer</th><th>Status</th><th>Next hearing</th><th>Staff</th></tr></thead>
          <tbody>
            {matters.map(m => (
              <tr key={m.id}>
                <td>
                  <div className="center" style={{gap: 10}}>
                    <span className={`pill pill-${typeColor(m.type)}`}>{m.type}</span>
                    {m.priority === "high" && <span style={{width: 6, height: 6, borderRadius: "50%", background: "var(--p-danger)"}} title="High priority"/>}
                  </div>
                  {m.ita !== "—" && <div className="muted" style={{fontSize: 11, marginTop: 4, fontFamily: "ui-monospace, monospace"}}>{m.ita}</div>}
                </td>
                <td className="strong">{m.assessee}</td>
                <td>{m.ay}</td>
                <td>{m.section !== "—" ? <span className="pill pill-muted">u/s {m.section}</span> : <span className="muted">—</span>}</td>
                <td className="semi">{m.bench}</td>
                <td><StatusPill status={m.status}/></td>
                <td>
                  {m.next === "—"
                    ? <span className="muted">—</span>
                    : <div>
                        <div className="strong">{m.next}</div>
                        <div className="muted">{m.days === 1 ? "in 1 day" : m.days != null ? `in ${m.days} days` : ""}</div>
                      </div>}
                </td>
                <td><Avatar name={m.staff} color="mint" size="sm"/></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Communications() {
  const items = [
    { id: 1, channel: "WhatsApp", to: "Rajesh M. Shah", subject: "Documents required for AY 2017-18 — ITAT hearing on 28 May", time: "Today, 09:42", status: "Delivered ✓✓", icon: "whatsapp", color: "success", template: "Document request" },
    { id: 2, channel: "Email", to: "accounts@nirvanainfotech.com", subject: "Income Tax Notice u/s 143(2) — submission of details", time: "Yesterday", status: "Read", icon: "mail", color: "info", template: "Reminder" },
    { id: 3, channel: "WhatsApp", to: "Mehul Patel & Sons HUF", subject: "CIT(A) appeal hearing on 02 Jun — please confirm attendance", time: "24 May, 14:20", status: "Sent", icon: "whatsapp", color: "success", template: "Hearing confirmation" },
    { id: 4, channel: "Email", to: "trust@hariomtrust.org", subject: "Notice u/s 143(2) received — please send 8 documents", time: "23 May", status: "Delivered", icon: "mail", color: "info", template: "Document request" },
    { id: 5, channel: "WhatsApp", to: "Shah Textiles Pvt. Ltd.", subject: "Invoice PH/26-27/0123 — Payment received ₹85,000 ✓", time: "21 May", status: "Read", icon: "whatsapp", color: "success", template: "Receipt ack." },
  ];
  return (
    <div className="animate-in">
      <div className="topbar">
        <div>
          <div className="page-title">Communications</div>
          <div className="page-sub">All client messages, drafts and templates</div>
        </div>
        <div className="topbar-actions">
          <button className="btn btn-secondary"><Icon name="doc" size={14}/>Manage templates</button>
          <button className="btn btn-primary"><Icon name="plus" size={14}/>New message</button>
        </div>
      </div>

      <div className="grid" style={{gridTemplateColumns: "1.5fr 1fr", gap: 18}}>
        <div className="card" style={{padding: 0}}>
          <div className="row" style={{padding: "14px 18px", borderBottom: "1px solid var(--p-line-2)", justifyContent: "space-between"}}>
            <div className="row" style={{gap: 6}}>
              <span className="fchip active">All</span>
              <span className="fchip">WhatsApp · 18</span>
              <span className="fchip">Email · 9</span>
              <span className="fchip">Drafts · 2</span>
            </div>
          </div>
          <div className="col">
            {items.map(c => (
              <div key={c.id} className="row" style={{padding: "14px 18px", borderBottom: "1px solid var(--p-line-2)", gap: 12, alignItems: "flex-start", cursor: "pointer"}}>
                <div style={{width: 38, height: 38, borderRadius: 11, background: c.color === "success" ? "var(--p-mint)" : "#E1EEFF", color: c.color === "success" ? "#1B8C5C" : "#2766C7", display: "grid", placeItems: "center", flexShrink: 0}}>
                  <Icon name={c.icon} size={16}/>
                </div>
                <div style={{flex: 1, minWidth: 0}}>
                  <div className="between">
                    <div className="center" style={{gap: 8}}>
                      <div style={{fontWeight: 700, fontSize: 13.5}}>{c.to}</div>
                      <span className="pill pill-muted" style={{fontSize: 10}}>{c.template}</span>
                    </div>
                    <div className="muted" style={{fontSize: 11.5}}>{c.time}</div>
                  </div>
                  <div className="semi" style={{fontSize: 13, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{c.subject}</div>
                  <div className="muted" style={{fontSize: 11.5, marginTop: 4}}>{c.channel} · {c.status}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-title mb-3">Document request — draft</div>
          <div className="card-sub mb-4">Auto-prepared from AI-parsed notice for Rajesh M. Shah</div>
          <div className="col" style={{gap: 12, padding: 16, background: "var(--p-card-tint)", borderRadius: 14, border: "1px solid var(--p-line-2)"}}>
            <div style={{fontSize: 12.5, fontWeight: 700}}>Subject</div>
            <div style={{fontSize: 13}}>Details required for ITAT hearing — AY 2017-18</div>
            <div style={{height: 1, background: "var(--p-line)"}}/>
            <div style={{fontSize: 12.5, fontWeight: 700}}>Body</div>
            <div style={{fontSize: 12.5, lineHeight: 1.6, color: "var(--p-text-2)"}}>
              Dear Sir,<br/><br/>
              The Income Tax Appellate Tribunal has fixed your appeal for hearing on <b>28 May 2026 at 11:30 AM</b> before the Ahmedabad &apos;A&apos; Bench. Kindly arrange the following at the earliest:<br/><br/>
              1. Audited financials AY 17-18<br/>
              2. Bank statements FY 16-17<br/>
              3. Lender confirmations + PAN<br/>
              4. Source of cash deposits<br/>
              5. Ledger of sundry creditors<br/>
              6. ITR &amp; computation<br/><br/>
              Please share by <b>26 May 2026</b>.<br/><br/>
              Regards,<br/>
              Jayesh Vyas, CA
            </div>
          </div>
          <div className="row" style={{gap: 8, marginTop: 14}}>
            <button className="btn btn-primary" style={{flex: 1, justifyContent: "center"}}><Icon name="whatsapp" size={14}/>Send WhatsApp</button>
            <button className="btn btn-secondary" style={{flex: 1, justifyContent: "center"}}><Icon name="mail" size={14}/>Send Email</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AiParser({ onOpenParsed }) {
  return (
    <div className="animate-in">
      <div className="topbar">
        <div>
          <div className="page-title">AI Parser</div>
          <div className="page-sub">Extract structured details from any Income-tax notice PDF</div>
        </div>
      </div>
      <div className="grid" style={{gridTemplateColumns: "1fr 1fr", gap: 18}}>
        <div className="card" style={{padding: 28, border: "2px dashed var(--p-primary-3)", background: "linear-gradient(180deg, #F8F6FF, white)"}}>
          <div style={{textAlign: "center", padding: "30px 20px"}}>
            <div style={{width: 64, height: 64, borderRadius: 18, background: "var(--p-primary)", color: "white", display: "grid", placeItems: "center", margin: "0 auto 16px"}}>
              <Icon name="upload" size={28}/>
            </div>
            <div style={{fontSize: 17, fontWeight: 800, letterSpacing: "-0.02em"}}>Drop notice PDF here</div>
            <div className="card-sub mt-1">or click to browse — supports up to 20 MB</div>
            <button className="btn btn-primary mt-4" onClick={onOpenParsed}><Icon name="sparkle" size={14}/>Parse with AI</button>
          </div>
          <div style={{borderTop: "1px solid var(--p-line)", paddingTop: 16, marginTop: 16}}>
            <div style={{fontSize: 12, fontWeight: 700, color: "var(--p-text-2)", marginBottom: 8}}>WHAT THE AI EXTRACTS</div>
            <div className="row" style={{gap: 6, flexWrap: "wrap"}}>
              {["Assessee","PAN","AY","Section","DIN","Notice date","Hearing date","Hearing time","ITA No.","Bench / AO","Mode (VC / Physical)","Documents called for","Subject","Important instructions"].map(t => <span key={t} className="pill pill-primary">{t}</span>)}
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <div className="card-title">Recent AI runs</div>
            <span className="pill pill-pink">4 pending review</span>
          </div>
          <div className="col" style={{gap: 8}}>
            {NOTICES.map((n) => (
              <div key={n.id} className="between" onClick={n.awaiting ? onOpenParsed : undefined} style={{padding: "12px 14px", background: "var(--p-card-tint)", borderRadius: 12, border: "1px solid var(--p-line-2)", cursor: n.awaiting ? "pointer" : "default"}}>
                <div className="center" style={{gap: 10}}>
                  <div style={{width: 32, height: 32, borderRadius: 10, background: "white", color: "var(--p-primary)", display: "grid", placeItems: "center"}}>
                    <Icon name="sparkle" size={14}/>
                  </div>
                  <div>
                    <div style={{fontWeight: 700, fontSize: 13}}>{n.assessee}</div>
                    <div className="muted" style={{fontSize: 11.5}}>u/s {n.section} · AY {n.ay} · {n.authority}</div>
                  </div>
                </div>
                <div style={{textAlign: "right"}}>
                  <StatusPill status={n.status}/>
                  <div className="muted" style={{fontSize: 11, marginTop: 3}}>{fmtDate(n.date)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function Reports() {
  return (
    <div className="animate-in">
      <div className="topbar">
        <div>
          <div className="page-title">Reports</div>
          <div className="page-sub">Generate PDF / Excel reports across the practice</div>
        </div>
      </div>
      <div className="grid" style={{gridTemplateColumns: "repeat(3, 1fr)", gap: 16}}>
        {[
          { t: "Outstanding receivables", d: "Assessee-wise and group-wise ageing", icon: "wallet", color: "warning" },
          { t: "Monthly billing report", d: "Invoices raised, GST collected, services", icon: "invoice", color: "primary" },
          { t: "Payments received", d: "Mode-wise, bank-wise reconciliation", icon: "trend-up", color: "success" },
          { t: "Authority-wise case load", d: "Active matters by ITAT/CIT(A)/Scrutiny", icon: "scale", color: "primary" },
          { t: "Upcoming hearings", d: "Cause list — 7/15/30 days", icon: "calendar", color: "pink" },
          { t: "Overdue replies", d: "Notices nearing due-date", icon: "alert", color: "danger" },
          { t: "Staff allocation", d: "Hours, matters and load per staff", icon: "users", color: "primary" },
          { t: "Notice parsing accuracy", d: "AI confidence vs manual corrections", icon: "sparkle", color: "pink" },
          { t: "Group ledger", d: "Consolidated for selected period", icon: "doc", color: "primary" },
        ].map(r => {
          const colorMap = { warning: ["var(--p-amber)","#B07512"], primary: ["var(--p-lavender-2)","var(--p-primary-2)"], success: ["var(--p-mint)","#1B8C5C"], pink: ["var(--p-pink)","#C13388"], danger: ["var(--p-coral)","#B8463A"] };
          const colors = colorMap[r.color];
          return (
            <div key={r.t} className="card" style={{cursor: "pointer", transition: "all 0.15s"}}>
              <div className="center" style={{gap: 12, marginBottom: 14}}>
                <div style={{width: 40, height: 40, borderRadius: 12, background: colors[0], color: colors[1], display: "grid", placeItems: "center"}}>
                  <Icon name={r.icon} size={18}/>
                </div>
                <div style={{flex: 1}}>
                  <div style={{fontWeight: 700, fontSize: 14}}>{r.t}</div>
                </div>
              </div>
              <div className="card-sub mb-4">{r.d}</div>
              <div className="row" style={{gap: 6}}>
                <button className="btn btn-secondary btn-sm" style={{flex: 1, justifyContent: "center"}}><Icon name="pdf" size={12}/>PDF</button>
                <button className="btn btn-secondary btn-sm" style={{flex: 1, justifyContent: "center"}}><Icon name="download" size={12}/>Excel</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function SettingsPage() {
  return (
    <div className="animate-in">
      <div className="topbar">
        <div>
          <div className="page-title">Integrations</div>
          <div className="page-sub">Connect ProHippo to portals and channels</div>
        </div>
      </div>
      <div className="grid" style={{gridTemplateColumns: "repeat(2, 1fr)", gap: 16}}>
        {[
          { t: "Google Calendar", d: "Sync hearings to your Google account", status: "Connected", last: "Synced 2 min ago", icon: "calendar", color: "success" },
          { t: "Income-tax notice fetch API", d: "Auto-fetch notices from the ITD portal", status: "Connected", last: "Last run: today 06:00 IST · 3 new", icon: "link", color: "success" },
          { t: "AI parsing engine", d: "PDF → structured fields", status: "Connected", last: "GPT-class · 99.1% extraction accuracy", icon: "sparkle", color: "success" },
          { t: "WhatsApp Business Cloud", d: "Send notices and reminders", status: "Connected", last: "Sender: +91 87654 03210", icon: "whatsapp", color: "success" },
          { t: "Email (Postmark)", d: "Transactional emails from your domain", status: "Connected", last: "From: jayesh@vyas-ca.in", icon: "mail", color: "success" },
          { t: "Tally / Zoho Books", d: "Push invoices to accounting", status: "Not connected", last: "—", icon: "invoice", color: "warning" },
        ].map(i => (
          <div key={i.t} className="card">
            <div className="between" style={{marginBottom: 10}}>
              <div className="center" style={{gap: 12}}>
                <div style={{width: 42, height: 42, borderRadius: 12, background: "var(--p-card-tint)", color: "var(--p-primary)", display: "grid", placeItems: "center"}}>
                  <Icon name={i.icon} size={18}/>
                </div>
                <div>
                  <div style={{fontWeight: 700, fontSize: 14}}>{i.t}</div>
                  <div className="muted" style={{fontSize: 12}}>{i.d}</div>
                </div>
              </div>
              <span className={`pill pill-${i.color === "success" ? "success" : "warning"}`}>
                {i.color === "success" ? <Icon name="check" size={10}/> : <Icon name="alert" size={10}/>}
                {i.status}
              </span>
            </div>
            <div className="between" style={{paddingTop: 12, borderTop: "1px solid var(--p-line-2)"}}>
              <div className="muted" style={{fontSize: 12}}>{i.last}</div>
              <div className="row" style={{gap: 6}}>
                <button className="btn btn-secondary btn-sm">Test</button>
                <button className="btn btn-secondary btn-sm">Configure</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
