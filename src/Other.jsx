/* ProHippo — Invoices, Communications, Matters, Reports, Settings */
import React from 'react';
import { Icon, Avatar, StatusPill, Modal, FormField, TextInput, SelectInput, ComboBox, EmptyState, fmtINR, fmtLakhs, fmtDate, fmtDateLong, daysFromNow } from './shared';
import { useData, invoiceStatus, invoiceOutstanding, totalOutstanding, upcomingHearings, downloadCSV, todayISO, daysAway, toISO } from './store';
import { useAuth } from './auth';
import { AssesseeModal, AssesseeRequiredNote } from './AssesseeModal';
import { downloadInvoicePDF, amountInWords } from './invoicePdf';
import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';

const NEEDS_ASSESSEE = "Every record in ProHippo is linked to an assessee profile. Add the assessee first — this form unlocks once they're on file.";

function KVRow({ label, value }) {
  return (
    <div style={{fontSize: 13, display: "flex", gap: 10, alignItems: "baseline"}}>
      <span className="muted" style={{fontSize: 12, minWidth: 110, flexShrink: 0}}>{label}</span>
      <span style={{fontWeight: 600, overflowWrap: "anywhere"}}>{value}</span>
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

/* ---------------- Invoices ---------------- */

export function InvoiceModal({ initial, onClose }) {
  const { data, addInvoice, updateInvoice, notify } = useData();
  const isEdit = Boolean(initial?.id);
  const [form, setForm] = React.useState({
    assessee: "", date: todayISO(), ay: "", service: "", amount: "", due: daysAway(30),
    ...initial,
  });
  const [showAddAssessee, setShowAddAssessee] = React.useState(false);
  const set = (k) => (v) => setForm(f => ({ ...f, [k]: v }));
  const amount = Number(form.amount);
  const linked = data.assessees.find(a => a.name === form.assessee);
  const valid = Boolean(linked) && form.date && amount > 0;

  const assesseeOptions = data.assessees.map(a => ({ value: a.name, label: a.name, sub: a.pan }));
  // Ongoing proceedings of the selected assessee feed the service and AY
  // suggestions; both fields still accept free text.
  const proceedings = linked ? data.matters.filter(m => m.pan === linked.pan && !["Closed", "Decided"].includes(m.status)) : [];
  const serviceOptions = proceedings.map(m => ({
    value: `${m.type}${m.section ? ` u/s ${m.section}` : ""} — professional fees`,
    label: `${m.type}${m.section ? ` u/s ${m.section}` : ""} — AY ${m.ay}`,
    sub: [m.ref, m.bench, m.status].filter(Boolean).join(" · "),
    ay: m.ay,
  }));
  const ayOptions = [...new Set([
    ...proceedings.map(m => m.ay),
    ...(linked ? data.notices.filter(n => n.pan === linked.pan).map(n => n.ay) : []),
    ...(linked ? data.hearings.filter(h => h.pan === linked.pan).map(h => h.ay) : []),
  ].filter(Boolean))].sort().reverse();

  const save = async () => {
    if (!valid) return;
    const rec = { assessee: form.assessee, date: form.date, ay: form.ay, service: form.service, amount, due: form.due };
    if (isEdit) {
      updateInvoice(initial.id, rec);
      notify(`Invoice ${initial.number} updated`);
    } else {
      const inv = await addInvoice(rec);
      if (!inv) return;
      notify(`Invoice ${inv.number || ""} raised — ${fmtINR(amount)}`);
    }
    onClose();
  };

  return (
    <Modal
      title={isEdit ? "Edit invoice" : "New invoice"}
      sub={isEdit ? `${initial.number} — the invoice number stays unchanged` : "The invoice number is assigned automatically"}
      onClose={onClose}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid} style={{opacity: valid ? 1 : 0.5}} onClick={save}><Icon name="check" size={14}/>{isEdit ? "Save changes" : "Raise invoice"}</button>
      </>}
    >
      {data.assessees.length === 0 && (
        <div style={{marginBottom: 14}}>
          <AssesseeRequiredNote message={NEEDS_ASSESSEE} onCreate={() => setShowAddAssessee(true)}/>
        </div>
      )}
      <div className="form-grid">
        <FormField label="Assessee" required full>
          <ComboBox value={form.assessee} onChange={set("assessee")} options={assesseeOptions} subMono placeholder={data.assessees.length ? "Search name or PAN…" : "No assessees yet"}/>
        </FormField>
        <FormField label="Service description" full>
          <ComboBox
            value={form.service}
            onChange={set("service")}
            options={serviceOptions}
            onPick={(o) => { if (o.ay) set("ay")(o.ay); }}
            placeholder={linked ? (serviceOptions.length ? "Pick an ongoing proceeding or type your own…" : "e.g. ITAT appeal — drafting & hearing fees") : "Select an assessee to see their proceedings…"}
          />
        </FormField>
        <FormField label="Assessment year">
          <ComboBox value={form.ay} onChange={set("ay")} options={ayOptions} placeholder={ayOptions.length ? "Pick or type an AY…" : "2021-22"}/>
        </FormField>
        <FormField label="Amount (₹)" required><TextInput type="number" value={form.amount} onChange={set("amount")} placeholder="0"/></FormField>
        <FormField label="Invoice date"><TextInput type="date" value={form.date} onChange={set("date")}/></FormField>
        <FormField label="Due date"><TextInput type="date" value={form.due} onChange={set("due")}/></FormField>
      </div>
      {showAddAssessee && (
        <AssesseeModal
          onClose={() => setShowAddAssessee(false)}
          onSaved={(a) => set("assessee")(a.name)}
        />
      )}
    </Modal>
  );
}

function PaymentModal({ invoice, onClose }) {
  const { updateInvoice, notify } = useData();
  const balance = invoiceOutstanding(invoice);
  const [amount, setAmount] = React.useState(String(balance));
  const val = Number(amount);
  const valid = val > 0 && val <= balance;

  const save = () => {
    if (!valid) return;
    updateInvoice(invoice.id, { received: (invoice.received || 0) + val });
    notify(`Payment of ${fmtINR(val)} recorded against ${invoice.number}`);
    onClose();
  };

  return (
    <Modal
      title="Record payment"
      sub={`${invoice.number} · ${invoice.assessee} · balance ${fmtINR(balance)}`}
      onClose={onClose}
      width={420}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid} style={{opacity: valid ? 1 : 0.5}} onClick={save}><Icon name="check" size={14}/>Record payment</button>
      </>}
    >
      <FormField label="Amount received (₹)" required>
        <TextInput type="number" value={amount} onChange={setAmount}/>
      </FormField>
    </Modal>
  );
}

function MetaCell({ label, value }) {
  return (
    <div>
      <div style={{fontSize: 10, fontWeight: 700, letterSpacing: "0.07em", color: "var(--p-text-3)"}}>{label}</div>
      <div style={{fontSize: 13.5, fontWeight: 800, marginTop: 3}}>{value}</div>
    </div>
  );
}

/* On-screen preview of the vector PDF invoice, with download / edit actions. */
function InvoiceView({ invoice, onClose, onEdit }) {
  const { data, profile } = useData();
  const assessee = data.assessees.find(a => a.name === invoice.assessee);
  const firmName = (profile?.firmName || "").trim() || (profile?.ownerName || "").trim() || "Tax practice";
  const balance = invoiceOutstanding(invoice);
  const fmt2 = (n) => new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  return (
    <Modal
      title={`Invoice ${invoice.number}`}
      sub="Preview of the PDF that will be downloaded"
      onClose={onClose}
      width={660}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Close</button>
        <button className="btn btn-secondary" onClick={onEdit}><Icon name="edit" size={14}/>Edit</button>
        <button className="btn btn-primary" onClick={() => downloadInvoicePDF({ invoice, assessee, profile })}><Icon name="download" size={14}/>Download PDF</button>
      </>}
    >
      <div style={{border: "1px solid var(--p-line)", borderRadius: 14, padding: "22px 24px", background: "white"}}>
        <div className="between" style={{alignItems: "flex-start"}}>
          <div>
            <div style={{fontSize: 19, fontWeight: 800, letterSpacing: "-0.02em"}}>{firmName}</div>
            {profile?.ownerName && profile.ownerName !== firmName && <div className="muted" style={{fontSize: 12, marginTop: 2}}>{profile.ownerName}</div>}
            {profile?.firmAddress && <div className="muted" style={{fontSize: 11.5, marginTop: 2}}>{profile.firmAddress}</div>}
            {(profile?.email || profile?.firmMobile) && <div className="muted" style={{fontSize: 11.5, marginTop: 2}}>{[profile?.email, profile?.firmMobile].filter(Boolean).join("  ·  ")}</div>}
          </div>
          <div style={{fontSize: 19, fontWeight: 800, letterSpacing: "0.12em", color: "var(--p-primary)"}}>INVOICE</div>
        </div>
        <div style={{height: 3, background: "var(--p-primary)", borderRadius: 2, margin: "14px 0 16px"}}/>
        <div className="grid" style={{gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12}}>
          <MetaCell label="INVOICE NO." value={invoice.number}/>
          <MetaCell label="INVOICE DATE" value={fmtDateLong(invoice.date)}/>
          <MetaCell label="DUE DATE" value={invoice.due ? fmtDateLong(invoice.due) : "—"}/>
        </div>
        <div style={{marginTop: 18}}>
          <div style={{fontSize: 10, fontWeight: 700, letterSpacing: "0.07em", color: "var(--p-text-3)"}}>BILLED TO</div>
          <div style={{fontSize: 15, fontWeight: 800, marginTop: 4}}>{invoice.assessee}</div>
          {assessee?.pan && <div style={{fontSize: 12, marginTop: 2, fontFamily: "ui-monospace, monospace"}}>PAN: {assessee.pan}</div>}
          {assessee?.address && <div className="muted" style={{fontSize: 12, marginTop: 2}}>{assessee.address}</div>}
        </div>
        <table style={{width: "100%", marginTop: 16, borderCollapse: "collapse", fontSize: 13}}>
          <thead>
            <tr style={{background: "var(--p-lavender-2)"}}>
              <th style={{textAlign: "left", padding: "8px 10px", fontSize: 10.5, letterSpacing: "0.06em", color: "var(--p-text-3)"}}>PARTICULARS</th>
              <th style={{textAlign: "left", padding: "8px 10px", fontSize: 10.5, letterSpacing: "0.06em", color: "var(--p-text-3)", width: 90}}>AY</th>
              <th style={{textAlign: "right", padding: "8px 10px", fontSize: 10.5, letterSpacing: "0.06em", color: "var(--p-text-3)", width: 130}}>AMOUNT (₹)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{padding: "10px", borderBottom: "1px solid var(--p-line-2)"}}>{invoice.service || "Professional fees"}</td>
              <td style={{padding: "10px", borderBottom: "1px solid var(--p-line-2)"}}>{invoice.ay || "—"}</td>
              <td style={{padding: "10px", borderBottom: "1px solid var(--p-line-2)", textAlign: "right", fontWeight: 700}}>{fmt2(invoice.amount)}</td>
            </tr>
          </tbody>
        </table>
        <div style={{display: "flex", justifyContent: "flex-end", marginTop: 12}}>
          <div style={{minWidth: 240}}>
            <div className="between" style={{padding: "4px 10px"}}>
              <span style={{fontWeight: 800, fontSize: 14}}>Total</span>
              <span style={{fontWeight: 800, fontSize: 15}}>₹ {fmt2(invoice.amount)}</span>
            </div>
            {(invoice.received || 0) > 0 && <>
              <div className="between" style={{padding: "3px 10px", fontSize: 12.5}}>
                <span className="muted">Received</span><span style={{fontWeight: 700}}>₹ {fmt2(invoice.received)}</span>
              </div>
              <div className="between" style={{padding: "3px 10px", fontSize: 12.5}}>
                <span className="muted">Balance due</span>
                <span style={{fontWeight: 800, color: balance > 0 ? "#C13388" : "var(--p-success)"}}>₹ {fmt2(balance)}</span>
              </div>
            </>}
          </div>
        </div>
        <div style={{marginTop: 14}}>
          <div style={{fontSize: 10, fontWeight: 700, letterSpacing: "0.07em", color: "var(--p-text-3)"}}>AMOUNT IN WORDS</div>
          <div style={{fontSize: 12.5, marginTop: 3}}>{amountInWords(invoice.amount)}</div>
        </div>
        <div className="between" style={{marginTop: 20, alignItems: "flex-end"}}>
          <StatusPill status={invoiceStatus(invoice)}/>
          <div style={{textAlign: "right"}}>
            <div style={{fontWeight: 800, fontSize: 12.5}}>For {firmName}</div>
            <div className="muted" style={{fontSize: 11, marginTop: 26, borderTop: "1px solid var(--p-line)", paddingTop: 5}}>Authorised Signatory</div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export function Invoices() {
  const { data, profile, removeInvoice, notify } = useData();
  const [filter, setFilter] = React.useState("All");
  const [search, setSearch] = React.useState("");
  const [showNew, setShowNew] = React.useState(false);
  const [payFor, setPayFor] = React.useState(null);
  const [editFor, setEditFor] = React.useState(null);
  const [viewFor, setViewFor] = React.useState(null);

  const assesseeOf = (inv) => data.assessees.find(a => a.name === inv.assessee);
  const invoices = [...data.invoices].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const monthPrefix = todayISO().slice(0, 7);
  const billedThisMonth = invoices.filter(i => (i.date || "").startsWith(monthPrefix)).reduce((s, i) => s + i.amount, 0);
  const receivedTotal = invoices.reduce((s, i) => s + (i.received || 0), 0);
  const outstanding = totalOutstanding(data);

  const counts = { All: invoices.length };
  ["Outstanding", "Overdue", "Partial", "Paid"].forEach(st => { counts[st] = invoices.filter(i => invoiceStatus(i) === st).length; });
  const q = search.toLowerCase().trim();
  const filtered = invoices.filter(i =>
    (filter === "All" || invoiceStatus(i) === filter) &&
    (!q || [i.number, i.assessee, i.service, i.ay, assesseeOf(i)?.pan].some(v => (v || "").toLowerCase().includes(q)))
  );

  // billing trend — last 6 calendar months
  const months = [];
  for (let k = 5; k >= 0; k--) {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - k);
    const prefix = toISO(d).slice(0, 7);
    const monthInvs = invoices.filter(i => (i.date || "").startsWith(prefix));
    months.push({
      l: d.toLocaleString("en-IN", { month: "short" }),
      billed: monthInvs.reduce((s, i) => s + i.amount, 0),
      received: monthInvs.reduce((s, i) => s + (i.received || 0), 0),
    });
  }
  const maxMonth = Math.max(1, ...months.map(mo => Math.max(mo.billed, mo.received)));

  const topOutstanding = invoices
    .filter(i => invoiceOutstanding(i) > 0)
    .sort((a, b) => (a.due || "").localeCompare(b.due || ""))
    .slice(0, 4);

  const exportCSV = () => downloadCSV(
    "invoices.csv",
    ["Invoice #", "Assessee", "Date", "AY", "Service", "Amount", "Received", "Balance", "Due", "Status"],
    filtered.map(i => [i.number, i.assessee, i.date, i.ay, i.service, i.amount, i.received || 0, invoiceOutstanding(i), i.due, invoiceStatus(i)])
  );

  return (
    <div className="animate-in">
      <div className="topbar">
        <div>
          <div className="page-title">Invoices</div>
          <div className="page-sub">
            {invoices.length
              ? `${fmtLakhs(billedThisMonth)} billed this month · ${fmtLakhs(receivedTotal)} received · ${fmtLakhs(outstanding)} outstanding`
              : "Raise invoices and track receipts"}
          </div>
        </div>
        <div className="topbar-actions">
          <button className="btn btn-secondary" onClick={exportCSV}><Icon name="download" size={14}/>Export</button>
          <button className="btn btn-primary" onClick={() => setShowNew(true)}><Icon name="plus" size={14}/>New invoice</button>
        </div>
      </div>

      {invoices.length > 0 && (
        <div className="grid-main" style={{marginBottom: 18}}>
          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Billing trend</div>
                <div className="card-sub">Last 6 months</div>
              </div>
              <div className="row" style={{gap: 14}}>
                <Legend color="var(--p-primary)" label="Billed"/>
                <Legend color="#FFB3D9" label="Received"/>
              </div>
            </div>
            <div className="bars" style={{height: 140, marginTop: 8}}>
              {months.map(mo => (
                <div key={mo.l} style={{flex: 1, height: "100%", display: "flex", gap: 4, alignItems: "flex-end", position: "relative"}}>
                  <div className="bar accent" style={{height: `${Math.max(3, (mo.billed / maxMonth) * 100)}%`}} title={`Billed ${fmtINR(mo.billed)}`}/>
                  <div className="bar" style={{height: `${Math.max(3, (mo.received / maxMonth) * 100)}%`, background: "#FFB3D9"}} title={`Received ${fmtINR(mo.received)}`}/>
                  <div className="bar-label">{mo.l}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="card" style={{background: "linear-gradient(120deg, #F8F6FF 0%, #FFEDF5 100%)"}}>
            <div className="card-head">
              <div>
                <div className="card-title">Top outstanding</div>
                <div className="card-sub">Sorted by due date</div>
              </div>
            </div>
            {topOutstanding.length === 0 && <div className="muted" style={{fontSize: 13, textAlign: "center", padding: "16px 0"}}>Nothing outstanding. 🎉</div>}
            <div className="col" style={{gap: 8}}>
              {topOutstanding.map(inv => (
                <div key={inv.id} className="between" style={{padding: "10px 12px", background: "white", borderRadius: 11, border: "1px solid var(--p-line-2)"}}>
                  <div>
                    <div style={{fontWeight: 700, fontSize: 13}}>{inv.assessee}</div>
                    <div className="muted" style={{fontSize: 11.5}}>{inv.number}{inv.due ? ` · due ${fmtDateLong(inv.due)}` : ""}</div>
                  </div>
                  <div style={{textAlign: "right"}}>
                    <div className="strong" style={{fontSize: 14}}>{fmtINR(invoiceOutstanding(inv))}</div>
                    <StatusPill status={invoiceStatus(inv)}/>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="card" style={{padding: 0, overflow: "hidden"}}>
        <div className="row" style={{padding: "14px 18px", justifyContent: "space-between", borderBottom: "1px solid var(--p-line-2)", alignItems: "center", gap: 12, flexWrap: "wrap"}}>
          <div className="row" style={{gap: 6}}>
            {["All", "Outstanding", "Overdue", "Partial", "Paid"].map(f => (
              <span key={f} className={`fchip ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>
                {f}{counts[f] ? ` · ${counts[f]}` : ""}
              </span>
            ))}
          </div>
          <div className="search" style={{width: 250}}>
            <Icon name="search" size={15}/>
            <input placeholder="Invoice #, assessee, PAN, service…" value={search} onChange={e => setSearch(e.target.value)}/>
          </div>
        </div>
        {filtered.length === 0 ? (
          <EmptyState
            icon="invoice"
            title={invoices.length === 0 ? "No invoices yet" : "No invoices match this filter"}
            sub={invoices.length === 0 ? "Raise your first invoice to start tracking fees." : undefined}
            action={invoices.length === 0 ? <button className="btn btn-primary" onClick={() => setShowNew(true)}><Icon name="plus" size={14}/>New invoice</button> : undefined}
          />
        ) : (
          <table className="tbl">
            <thead><tr><th>Invoice #</th><th>Assessee</th><th>Service</th><th>AY</th><th>Issued</th><th>Due</th><th>Amount</th><th>Balance</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {filtered.map(inv => (
                <tr key={inv.id} onClick={() => setViewFor(inv)} style={{cursor: "pointer"}}>
                  <td className="strong" style={{fontFamily: "ui-monospace, monospace", fontSize: 12.5}}>{inv.number}</td>
                  <td className="strong">{inv.assessee}</td>
                  <td className="semi" style={{maxWidth: 280}}>{inv.service}</td>
                  <td>{inv.ay || "—"}</td>
                  <td className="muted">{fmtDateLong(inv.date)}</td>
                  <td className="muted">{inv.due ? fmtDateLong(inv.due) : "—"}</td>
                  <td className="strong">{fmtINR(inv.amount)}</td>
                  <td>{invoiceOutstanding(inv) ? fmtINR(invoiceOutstanding(inv)) : "—"}</td>
                  <td><StatusPill status={invoiceStatus(inv)}/></td>
                  <td onClick={e => e.stopPropagation()}>
                    <div className="row" style={{gap: 4}}>
                      {invoiceOutstanding(inv) > 0 && (
                        <button className="btn btn-ghost btn-xs" title="Record payment" onClick={() => setPayFor(inv)}><Icon name="wallet" size={12}/></button>
                      )}
                      <button className="btn btn-ghost btn-xs" title="Download PDF" onClick={() => downloadInvoicePDF({ invoice: inv, assessee: assesseeOf(inv), profile })}><Icon name="download" size={12}/></button>
                      <button className="btn btn-ghost btn-xs" title="Edit" onClick={() => setEditFor(inv)}><Icon name="edit" size={12}/></button>
                      <button className="btn btn-ghost btn-xs" title="Delete" onClick={() => { if (window.confirm(`Delete invoice ${inv.number}?`)) { removeInvoice(inv.id); notify("Invoice deleted"); } }}><Icon name="trash" size={12}/></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showNew && <InvoiceModal onClose={() => setShowNew(false)}/>}
      {payFor && <PaymentModal invoice={payFor} onClose={() => setPayFor(null)}/>}
      {editFor && <InvoiceModal initial={editFor} onClose={() => setEditFor(null)}/>}
      {viewFor && (
        <InvoiceView
          invoice={viewFor}
          onClose={() => setViewFor(null)}
          onEdit={() => { setEditFor(viewFor); setViewFor(null); }}
        />
      )}
    </div>
  );
}

/* ---------------- Matters ---------------- */

const MATTER_TYPES = ["Scrutiny", "CIT(A)", "ITAT", "Penalty", "Rectification", "High Court"];
const MATTER_STATUSES = ["Active", "Pending", "Submitted", "Decided", "Closed"];

export function MatterModal({ initial, onClose }) {
  const { data, addMatter, updateMatter, notify } = useData();
  const [form, setForm] = React.useState({
    type: "Scrutiny", assessee: "", pan: "", ay: "", section: "", ref: "", bench: "",
    status: "Active", priority: "medium", staff: "",
    ...initial,
  });
  const [showAddAssessee, setShowAddAssessee] = React.useState(false);
  const set = (k) => (v) => setForm(f => ({ ...f, [k]: v }));
  const pickAssessee = (name) => {
    const a = data.assessees.find(x => x.name === name);
    setForm(f => ({ ...f, assessee: name, pan: a?.pan || f.pan, staff: f.staff || a?.staff || "" }));
  };
  const linked = data.assessees.find(a => a.name === form.assessee);
  const valid = Boolean(linked) && form.ay.trim();

  const save = () => {
    if (!valid) return;
    const rec = { ...form, pan: linked.pan };
    if (initial?.id) {
      updateMatter(initial.id, rec);
      notify("Matter updated");
    } else {
      addMatter(rec);
      notify(`${rec.type} matter added for ${rec.assessee}`);
    }
    onClose();
  };

  return (
    <Modal
      title={initial?.id ? "Edit matter" : "New matter"}
      sub="A matter tracks one proceeding for one assessment year"
      onClose={onClose}
      width={620}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid} style={{opacity: valid ? 1 : 0.5}} onClick={save}><Icon name="check" size={14}/>{initial?.id ? "Save changes" : "Add matter"}</button>
      </>}
    >
      {data.assessees.length === 0 && (
        <div style={{marginBottom: 14}}>
          <AssesseeRequiredNote message={NEEDS_ASSESSEE} onCreate={() => setShowAddAssessee(true)}/>
        </div>
      )}
      <div className="form-grid">
        <FormField label="Assessee" required full>
          <SelectInput value={linked ? linked.name : ""} onChange={pickAssessee} options={data.assessees.map(a => a.name)} placeholder={data.assessees.length ? "Select assessee…" : "No assessees yet"}/>
        </FormField>
        <FormField label="Type"><SelectInput value={form.type} onChange={set("type")} options={MATTER_TYPES}/></FormField>
        <FormField label="Assessment year" required><TextInput value={form.ay} onChange={set("ay")} placeholder="2021-22"/></FormField>
        <FormField label="Section"><TextInput value={form.section} onChange={set("section")} placeholder="e.g. 143(2)"/></FormField>
        <FormField label="Reference / ITA No."><TextInput value={form.ref} onChange={set("ref")} placeholder="ITA No. …"/></FormField>
        <FormField label="Bench / Officer"><TextInput value={form.bench} onChange={set("bench")} placeholder="e.g. Circle 4(1), Ahmedabad"/></FormField>
        <FormField label="Status"><SelectInput value={form.status} onChange={set("status")} options={MATTER_STATUSES}/></FormField>
        <FormField label="Priority"><SelectInput value={form.priority} onChange={set("priority")} options={["high", "medium", "low"]}/></FormField>
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

export function Matters({ onOpenMatter }) {
  const { data, removeMatter, notify } = useData();
  const [tab, setTab] = React.useState("All");
  const [search, setSearch] = React.useState("");
  const [modal, setModal] = React.useState(null);

  const typeColor = (t) => {
    if (t === "ITAT") return "primary";
    if (t === "CIT(A)") return "pink";
    if (t === "Scrutiny") return "warning";
    if (t === "Penalty") return "danger";
    return "muted";
  };

  const active = data.matters.filter(m => !["Closed", "Decided"].includes(m.status));
  const q = search.toLowerCase();
  const filtered = data.matters.filter(m => {
    if (tab === "Closed") { if (!["Closed", "Decided"].includes(m.status)) return false; }
    else if (tab !== "All") { if (m.type !== tab || ["Closed", "Decided"].includes(m.status)) return false; }
    if (q && ![m.assessee, m.pan, m.ref, m.ay, m.section].some(v => (v || "").toLowerCase().includes(q))) return false;
    return true;
  });

  const nextHearingFor = (m) =>
    upcomingHearings(data).find(h => h.pan === m.pan && (h.ay === m.ay || h.authority === m.type));

  return (
    <div className="animate-in">
      <div className="topbar">
        <div>
          <div className="page-title">Matters</div>
          <div className="page-sub">{active.length ? `${active.length} active proceeding${active.length > 1 ? "s" : ""}` : "Track each proceeding from notice to disposal"}</div>
        </div>
        <div className="topbar-actions">
          <button className="btn btn-secondary" onClick={() => downloadCSV("matters.csv", ["Type", "Assessee", "PAN", "AY", "Section", "Reference", "Bench", "Status", "Staff"], filtered.map(m => [m.type, m.assessee, m.pan, m.ay, m.section, m.ref, m.bench, m.status, m.staff]))}><Icon name="download" size={14}/>Export CSV</button>
          <button className="btn btn-primary" onClick={() => setModal({})}><Icon name="plus" size={14}/>New matter</button>
        </div>
      </div>

      <div className="row" style={{marginBottom: 16, alignItems: "center", justifyContent: "space-between"}}>
        <div className="tabs">
          {["All", ...MATTER_TYPES, "Closed"].map(t => (
            <div key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{t}</div>
          ))}
        </div>
        <div className="search" style={{width: 240}}>
          <Icon name="search" size={15}/>
          <input placeholder="Search ITA, PAN, assessee…" value={search} onChange={e => setSearch(e.target.value)}/>
        </div>
      </div>

      <div className="card" style={{padding: 0}}>
        {filtered.length === 0 ? (
          <EmptyState
            icon="scale"
            title={data.matters.length === 0 ? "No matters yet" : "No matters match this filter"}
            sub={data.matters.length === 0 ? "Add a matter to track a scrutiny, appeal or penalty proceeding." : undefined}
            action={data.matters.length === 0 ? <button className="btn btn-primary" onClick={() => setModal({})}><Icon name="plus" size={14}/>New matter</button> : undefined}
          />
        ) : (
          <table className="tbl">
            <thead><tr><th>Matter</th><th>Assessee</th><th>AY</th><th>Section</th><th>Bench / Officer</th><th>Status</th><th>Next hearing</th><th>Staff</th><th></th></tr></thead>
            <tbody>
              {filtered.map(m => {
                const nh = nextHearingFor(m);
                const days = nh ? daysFromNow(nh.date) : null;
                return (
                  <tr key={m.id} className={onOpenMatter ? "row-link" : undefined} onClick={onOpenMatter ? () => onOpenMatter(m) : undefined} style={onOpenMatter ? {cursor: "pointer"} : undefined} title={onOpenMatter ? "Open proceeding" : undefined}>
                    <td>
                      <div className="center" style={{gap: 10}}>
                        <span className={`pill pill-${typeColor(m.type)}`}>{m.type}</span>
                        {m.priority === "high" && <span style={{width: 6, height: 6, borderRadius: "50%", background: "var(--p-danger)"}} title="High priority"/>}
                      </div>
                      {m.ref && <div className="muted" style={{fontSize: 11, marginTop: 4, fontFamily: "ui-monospace, monospace"}}>{m.ref}</div>}
                    </td>
                    <td className="strong">{m.assessee}</td>
                    <td>{m.ay}</td>
                    <td>{m.section ? <span className="pill pill-muted">u/s {m.section}</span> : <span className="muted">—</span>}</td>
                    <td className="semi">{m.bench || "—"}</td>
                    <td><StatusPill status={m.status}/></td>
                    <td>
                      {nh
                        ? <div>
                            <div className="strong">{fmtDate(nh.date)}</div>
                            <div className="muted">{days === 0 ? "today" : days === 1 ? "in 1 day" : `in ${days} days`}</div>
                          </div>
                        : <span className="muted">—</span>}
                    </td>
                    <td>{m.staff ? <Avatar name={m.staff} color="mint" size="sm"/> : <span className="muted">—</span>}</td>
                    <td>
                      <div className="row" style={{gap: 4}}>
                        <button className="btn btn-ghost btn-xs" title="Edit" onClick={(e) => { e.stopPropagation(); setModal(m); }}><Icon name="edit" size={12}/></button>
                        <button className="btn btn-ghost btn-xs" title="Delete" onClick={(e) => { e.stopPropagation(); if (window.confirm("Delete this matter?")) { removeMatter(m.id); notify("Matter deleted"); } }}><Icon name="trash" size={12}/></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {modal && <MatterModal initial={modal.id ? modal : undefined} onClose={() => setModal(null)}/>}
    </div>
  );
}

/* ---------------- Communications ---------------- */

function MessageModal({ onClose }) {
  const { data, addCommunication, notify } = useData();
  const [form, setForm] = React.useState({ channel: "WhatsApp", to: "", subject: "", body: "", template: "Custom" });
  const [showAddAssessee, setShowAddAssessee] = React.useState(false);
  const set = (k) => (v) => setForm(f => ({ ...f, [k]: v }));
  const linked = data.assessees.find(a => a.name === form.to);
  const valid = Boolean(linked) && form.subject.trim();

  const save = (status) => {
    if (!valid) return;
    addCommunication({ ...form, time: new Date().toISOString(), status });
    if (status === "Sent") {
      const text = encodeURIComponent(`${form.subject}\n\n${form.body}`);
      if (form.channel === "WhatsApp" && linked?.mobile) {
        window.open(`https://wa.me/${linked.mobile.replace(/\D/g, "")}?text=${text}`, "_blank");
      } else if (form.channel === "Email" && linked?.email) {
        window.open(`mailto:${linked.email}?subject=${encodeURIComponent(form.subject)}&body=${encodeURIComponent(form.body)}`);
      }
    }
    notify(status === "Sent" ? "Message logged & opened in " + form.channel : "Draft saved");
    onClose();
  };

  return (
    <Modal
      title="New message"
      sub="Sending opens WhatsApp / your mail app with the message pre-filled"
      onClose={onClose}
      width={560}
      footer={<>
        <button className="btn btn-secondary" onClick={() => save("Draft")} disabled={!valid} style={{opacity: valid ? 1 : 0.5}}>Save draft</button>
        <button className="btn btn-primary" onClick={() => save("Sent")} disabled={!valid} style={{opacity: valid ? 1 : 0.5}}><Icon name="arrow-right" size={14}/>Send</button>
      </>}
    >
      {data.assessees.length === 0 && (
        <div style={{marginBottom: 14}}>
          <AssesseeRequiredNote message={NEEDS_ASSESSEE} onCreate={() => setShowAddAssessee(true)}/>
        </div>
      )}
      <div className="form-grid">
        <FormField label="Channel"><SelectInput value={form.channel} onChange={set("channel")} options={["WhatsApp", "Email"]}/></FormField>
        <FormField label="To" required>
          <SelectInput value={linked ? linked.name : ""} onChange={set("to")} options={data.assessees.map(a => a.name)} placeholder={data.assessees.length ? "Select assessee…" : "No assessees yet"}/>
        </FormField>
        <FormField label="Subject" required full><TextInput value={form.subject} onChange={set("subject")} placeholder="Subject"/></FormField>
        <div className="field" style={{gridColumn: "1 / -1"}}>
          <label>Message</label>
          <textarea value={form.body} onChange={e => set("body")(e.target.value)} rows={6} placeholder="Message body…"/>
        </div>
      </div>
      {showAddAssessee && (
        <AssesseeModal
          onClose={() => setShowAddAssessee(false)}
          onSaved={(a) => set("to")(a.name)}
        />
      )}
    </Modal>
  );
}

export function Communications() {
  const { data, notify } = useData();
  const [filter, setFilter] = React.useState("All");
  const [showNew, setShowNew] = React.useState(false);

  const comms = [...data.communications].sort((a, b) => (b.time || "").localeCompare(a.time || ""));
  const counts = {
    All: comms.length,
    WhatsApp: comms.filter(c => c.channel === "WhatsApp").length,
    Email: comms.filter(c => c.channel === "Email").length,
    Drafts: comms.filter(c => c.status === "Draft").length,
  };
  const filtered = comms.filter(c => {
    if (filter === "All") return true;
    if (filter === "Drafts") return c.status === "Draft";
    return c.channel === filter;
  });

  const draft = comms.find(c => c.status === "Draft");
  const draftAssessee = draft && data.assessees.find(a => a.name === draft.to);

  const openDraft = (channel) => {
    if (!draft) return;
    const text = `${draft.subject}\n\n${draft.body || ""}`;
    if (channel === "WhatsApp" && draftAssessee?.mobile) {
      window.open(`https://wa.me/${draftAssessee.mobile.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`, "_blank");
    } else if (channel === "Email" && draftAssessee?.email) {
      window.open(`mailto:${draftAssessee.email}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body || "")}`);
    } else {
      notify("No contact details on file for " + (draft.to || "recipient"), "alert");
    }
  };

  return (
    <div className="animate-in">
      <div className="topbar">
        <div>
          <div className="page-title">Communications</div>
          <div className="page-sub">Log of client messages and drafts</div>
        </div>
        <div className="topbar-actions">
          <button className="btn btn-primary" onClick={() => setShowNew(true)}><Icon name="plus" size={14}/>New message</button>
        </div>
      </div>

      <div className={draft ? "grid-main" : "grid"} style={{gap: 18}}>
        <div className="card" style={{padding: 0}}>
          <div className="row" style={{padding: "14px 18px", borderBottom: "1px solid var(--p-line-2)", justifyContent: "space-between"}}>
            <div className="row" style={{gap: 6}}>
              {["All", "WhatsApp", "Email", "Drafts"].map(f => (
                <span key={f} className={`fchip ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>
                  {f}{counts[f] ? ` · ${counts[f]}` : ""}
                </span>
              ))}
            </div>
          </div>
          {filtered.length === 0 ? (
            <EmptyState
              icon="chat"
              title={comms.length === 0 ? "No messages yet" : "No messages match this filter"}
              sub={comms.length === 0 ? "Messages you log or draft — including document requests generated from notices — appear here." : undefined}
              action={comms.length === 0 ? <button className="btn btn-primary" onClick={() => setShowNew(true)}><Icon name="plus" size={14}/>New message</button> : undefined}
            />
          ) : (
            <div className="col">
              {filtered.map(c => (
                <div key={c.id} className="row" style={{padding: "14px 18px", borderBottom: "1px solid var(--p-line-2)", gap: 12, alignItems: "flex-start"}}>
                  <div style={{width: 38, height: 38, borderRadius: 11, background: c.channel === "WhatsApp" ? "var(--p-mint)" : "#E1EEFF", color: c.channel === "WhatsApp" ? "#1B8C5C" : "#2766C7", display: "grid", placeItems: "center", flexShrink: 0}}>
                    <Icon name={c.channel === "WhatsApp" ? "whatsapp" : "mail"} size={16}/>
                  </div>
                  <div style={{flex: 1, minWidth: 0}}>
                    <div className="between">
                      <div className="center" style={{gap: 8}}>
                        <div style={{fontWeight: 700, fontSize: 13.5}}>{c.to}</div>
                        {c.template && <span className="pill pill-muted" style={{fontSize: 10}}>{c.template}</span>}
                      </div>
                      <div className="muted" style={{fontSize: 11.5}}>{new Date(c.time).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</div>
                    </div>
                    <div className="semi" style={{fontSize: 13, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{c.subject}</div>
                    <div className="muted" style={{fontSize: 11.5, marginTop: 4}}>{c.channel} · <StatusPill status={c.status}/></div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {draft && (
          <div className="card">
            <div className="card-title mb-3">{draft.template || "Draft"} — draft</div>
            <div className="card-sub mb-4">For {draft.to}</div>
            <div className="col" style={{gap: 12, padding: 16, background: "var(--p-card-tint)", borderRadius: 14, border: "1px solid var(--p-line-2)"}}>
              <div style={{fontSize: 12.5, fontWeight: 700}}>Subject</div>
              <div style={{fontSize: 13}}>{draft.subject}</div>
              {draft.body && <>
                <div style={{height: 1, background: "var(--p-line)"}}/>
                <div style={{fontSize: 12.5, fontWeight: 700}}>Body</div>
                <div style={{fontSize: 12.5, lineHeight: 1.6, color: "var(--p-text-2)", whiteSpace: "pre-wrap"}}>{draft.body}</div>
              </>}
            </div>
            <div className="row" style={{gap: 8, marginTop: 14}}>
              <button className="btn btn-primary" style={{flex: 1, justifyContent: "center"}} onClick={() => openDraft("WhatsApp")}><Icon name="whatsapp" size={14}/>Send WhatsApp</button>
              <button className="btn btn-secondary" style={{flex: 1, justifyContent: "center"}} onClick={() => openDraft("Email")}><Icon name="mail" size={14}/>Send Email</button>
            </div>
          </div>
        )}
      </div>

      {showNew && <MessageModal onClose={() => setShowNew(false)}/>}
    </div>
  );
}

/* ---------------- AI Parser ---------------- */

/* Read a File as a bare base64 string (no data: prefix). */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.readAsDataURL(file);
  });
}

const ALLOWED_TYPES = /^(application\/pdf|image\/(jpeg|png|webp))$/;
const isHeic = (f) => /heic|heif/i.test(f.type) || /\.(heic|heif)$/i.test(f.name);
const MAX_PAGES = 10;
const MAX_TOTAL = 9 * 1024 * 1024;
const kb = (n) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function AiParser({ onOpenNotice }) {
  const { data, notify } = useData();
  const fileRef = React.useRef(null);
  const [dragOver, setDragOver] = React.useState(false);
  const [parsing, setParsing] = React.useState(false);
  // Files staged to be parsed together as ONE notice (a PDF, or page images).
  const [staged, setStaged] = React.useState([]);

  const addFiles = (list) => {
    const incoming = Array.from(list || []);
    if (!incoming.length || parsing) return;
    let heic = false, bad = false;
    const next = [...staged];
    for (const f of incoming) {
      if (isHeic(f)) { heic = true; continue; }
      if (!ALLOWED_TYPES.test(f.type)) { bad = true; continue; }
      if (next.some(x => x.name === f.name && x.size === f.size)) continue; // dedupe
      next.push(f);
    }
    if (next.length > MAX_PAGES) { notify(`You can attach at most ${MAX_PAGES} pages.`, "alert"); return; }
    if (next.reduce((s, f) => s + f.size, 0) > MAX_TOTAL) {
      notify("Total size over 9 MB — use smaller images or fewer pages.", "alert");
      return;
    }
    setStaged(next);
    if (heic) notify("iPhone HEIC photos aren't supported — share as JPG.", "alert");
    else if (bad) notify("Only PDF or JPG/PNG/WebP images can be attached.", "alert");
  };
  const removeStaged = (i) => setStaged(s => s.filter((_, j) => j !== i));

  const parseStaged = async () => {
    if (!staged.length || parsing) return;
    setParsing(true);
    const label = staged.length === 1 ? staged[0].name : `${staged.length} images`;
    try {
      const files = await Promise.all(staged.map(async (f) => ({
        mimeType: f.type, data: await fileToBase64(f),
      })));
      // Also send the legacy single-PDF field so a not-yet-redeployed backend
      // still parses a lone PDF. Images/multi-page need the new backend.
      const payload = { files };
      if (files.length === 1 && files[0].mimeType === "application/pdf") {
        payload.pdfBase64 = files[0].data;
      }
      const res = await httpsCallable(functions, "parseNotice", { timeout: 120000 })(payload);
      const { fields, warnings } = res.data || {};
      // Keep only fields the AI actually read, so form defaults survive.
      const filled = Object.fromEntries(
        Object.entries(fields || {}).filter(([, v]) => (Array.isArray(v) ? v.length > 0 : Boolean(v)))
      );
      onOpenNotice({ ...filled, fileName: label, aiParsed: true, aiWarnings: warnings || [] });
      notify("Notice parsed — verify the highlighted details");
      setStaged([]);
    } catch (err) {
      // Backend missing / not deployed / model error: fall back to manual entry.
      console.error("AI parse failed:", err);
      notify(err?.message?.slice(0, 140) || "AI parsing failed — enter the details manually.", "alert");
      onOpenNotice({ fileName: label });
    } finally {
      setParsing(false);
    }
  };
  const recent = [...data.notices].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).slice(0, 6);

  return (
    <div className="animate-in">
      <div className="topbar">
        <div>
          <div className="page-title">Notice intake</div>
          <div className="page-sub">Attach a notice PDF or page photos and record its details in one flow</div>
        </div>
      </div>
      <div className="grid-split">
        <div
          className="card"
          style={{padding: 28, border: `2px dashed ${dragOver ? "var(--p-primary)" : "var(--p-primary-3)"}`, background: "linear-gradient(180deg, #F8F6FF, white)", cursor: parsing ? "wait" : "pointer", opacity: parsing ? 0.75 : 1}}
          onClick={() => { if (!parsing) fileRef.current?.click(); }}
          onDragOver={e => { e.preventDefault(); if (!parsing) setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
        >
          <input ref={fileRef} type="file" accept=".pdf,image/jpeg,image/png,image/webp" multiple style={{display: "none"}} onChange={e => { addFiles(e.target.files); e.target.value = ""; }}/>
          <div style={{textAlign: "center", padding: staged.length ? "10px 10px 4px" : "30px 20px"}}>
            <div style={{width: 64, height: 64, borderRadius: 18, background: "var(--p-primary)", color: "white", display: "grid", placeItems: "center", margin: "0 auto 16px", animation: parsing ? "pulse 1.2s ease-in-out infinite" : "none"}}>
              <Icon name={parsing ? "sparkle" : "upload"} size={28}/>
            </div>
            <div style={{fontSize: 17, fontWeight: 800, letterSpacing: "-0.02em"}}>
              {parsing ? "Reading the notice…" : staged.length ? `${staged.length} page${staged.length > 1 ? "s" : ""} ready` : "Drop notice PDF or photos here"}
            </div>
            <div className="card-sub mt-1">
              {parsing
                ? "AI is extracting the section, AY, dates and DIN — usually a few seconds"
                : staged.length
                  ? "Add more pages, or parse them together as one notice"
                  : "PDF or JPG/PNG photos — click to browse. Drop several photos to combine them into one notice."}
            </div>
            {parsing && <style>{`@keyframes pulse { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(0.92); opacity: 0.75; } }`}</style>}
          </div>

          {staged.length > 0 && !parsing && (
            <div className="col" style={{gap: 8, margin: "6px 0 14px"}} onClick={e => e.stopPropagation()}>
              {staged.map((f, i) => (
                <div key={`${f.name}-${i}`} className="center" style={{gap: 10, padding: "9px 12px", background: "white", borderRadius: 11, border: "1px solid var(--p-line-2)"}}>
                  <div style={{width: 26, height: 26, borderRadius: 8, background: "var(--p-card-tint)", color: "var(--p-primary)", display: "grid", placeItems: "center", flexShrink: 0}}>
                    <Icon name={f.type === "application/pdf" ? "pdf" : "doc"} size={13}/>
                  </div>
                  <div style={{flex: 1, minWidth: 0}}>
                    <div style={{fontSize: 12.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{f.name}</div>
                    <div className="muted" style={{fontSize: 11}}>{kb(f.size)}</div>
                  </div>
                  <button className="btn btn-ghost btn-xs" title="Remove" onClick={() => removeStaged(i)}><Icon name="trash" size={12}/></button>
                </div>
              ))}
            </div>
          )}

          <div className="center" style={{gap: 8, justifyContent: "center", flexWrap: "wrap"}} onClick={e => e.stopPropagation()}>
            {staged.length > 0 && !parsing ? (
              <>
                <button className="btn btn-secondary btn-sm" onClick={() => fileRef.current?.click()}><Icon name="upload" size={13}/>Add more</button>
                <button className="btn btn-primary btn-sm" onClick={parseStaged}><Icon name="sparkle" size={13}/>Parse {staged.length} page{staged.length > 1 ? "s" : ""}</button>
              </>
            ) : (
              <button className="btn btn-primary" disabled={parsing} onClick={() => onOpenNotice(null)}><Icon name="edit" size={14}/>Enter details manually</button>
            )}
          </div>

          <div style={{borderTop: "1px solid var(--p-line)", paddingTop: 16, marginTop: 16}}>
            <div style={{fontSize: 12, fontWeight: 700, color: "var(--p-text-2)", marginBottom: 8}}>WHAT GETS RECORDED</div>
            <div className="row" style={{gap: 6, flexWrap: "wrap"}}>
              {["Assessee","PAN","AY","Section","DIN","Notice date","Hearing date","Hearing time","ITA No.","Bench / AO","Mode","Documents called for","Subject"].map(t => <span key={t} className="pill pill-primary">{t}</span>)}
            </div>
            <div className="muted" style={{fontSize: 11.5, marginTop: 10}}>
              <Icon name="info" size={11}/> AI reads the notice (PDF or photos) and pre-fills the intake form — always verify every field against the original before saving.
              iPhone HEIC photos aren't supported — share as JPG. If the PAN isn't in your assessee list, you'll be prompted to create that assessee first.
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <div className="card-title">Recently recorded notices</div>
            {data.notices.filter(n => n.status === "Awaiting review").length > 0 && (
              <span className="pill pill-pink">{data.notices.filter(n => n.status === "Awaiting review").length} awaiting review</span>
            )}
          </div>
          {recent.length === 0 && <EmptyState icon="doc" title="No notices recorded yet" sub="Notices you record appear here with their review status."/>}
          <div className="col" style={{gap: 8}}>
            {recent.map(n => (
              <div key={n.id} className="between" onClick={() => onOpenNotice(n)} style={{padding: "12px 14px", background: "var(--p-card-tint)", borderRadius: 12, border: "1px solid var(--p-line-2)", cursor: "pointer"}}>
                <div className="center" style={{gap: 10}}>
                  <div style={{width: 32, height: 32, borderRadius: 10, background: "white", color: "var(--p-primary)", display: "grid", placeItems: "center"}}>
                    <Icon name="doc" size={14}/>
                  </div>
                  <div>
                    <div style={{fontWeight: 700, fontSize: 13}}>{n.assessee}</div>
                    <div className="muted" style={{fontSize: 11.5}}>{n.section ? `u/s ${n.section} · ` : ""}AY {n.ay} · {n.authority}</div>
                  </div>
                </div>
                <div style={{textAlign: "right"}}>
                  <StatusPill status={n.status}/>
                  {n.date && <div className="muted" style={{fontSize: 11, marginTop: 3}}>{fmtDate(n.date)}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Reports ---------------- */

export function Reports() {
  const { data, notify } = useData();

  const reports = [
    {
      t: "Outstanding receivables", d: "Assessee-wise outstanding fees", icon: "wallet", color: "warning",
      file: "receivables.csv", headers: ["Assessee", "Invoice #", "Due date", "Amount", "Received", "Outstanding"],
      rows: () => data.invoices.filter(i => invoiceOutstanding(i) > 0).map(i => [i.assessee, i.number, i.due, i.amount, i.received || 0, invoiceOutstanding(i)]),
    },
    {
      t: "Billing report", d: "All invoices raised with status", icon: "invoice", color: "primary",
      file: "billing.csv", headers: ["Invoice #", "Assessee", "Date", "AY", "Service", "Amount", "Status"],
      rows: () => data.invoices.map(i => [i.number, i.assessee, i.date, i.ay, i.service, i.amount, invoiceStatus(i)]),
    },
    {
      t: "Payments received", d: "Invoices with amounts received", icon: "trend-up", color: "success",
      file: "payments.csv", headers: ["Invoice #", "Assessee", "Invoice date", "Amount", "Received"],
      rows: () => data.invoices.filter(i => (i.received || 0) > 0).map(i => [i.number, i.assessee, i.date, i.amount, i.received]),
    },
    {
      t: "Authority-wise case load", d: "Active matters by authority", icon: "scale", color: "primary",
      file: "matters.csv", headers: ["Type", "Assessee", "PAN", "AY", "Section", "Bench", "Status", "Staff"],
      rows: () => data.matters.filter(m => !["Closed", "Decided"].includes(m.status)).map(m => [m.type, m.assessee, m.pan, m.ay, m.section, m.bench, m.status, m.staff]),
    },
    {
      t: "Upcoming hearings", d: "Cause list of scheduled hearings", icon: "calendar", color: "pink",
      file: "cause-list.csv", headers: ["Date", "Time", "Assessee", "PAN", "AY", "Authority", "Bench", "Mode", "Staff"],
      rows: () => upcomingHearings(data).map(h => [h.date, h.time, h.assessee, h.pan, h.ay, h.authority, h.bench, h.mode, h.staff]),
    },
    {
      t: "Notice register", d: "All notices with review status", icon: "doc", color: "danger",
      file: "notices.csv", headers: ["Assessee", "PAN", "AY", "Section", "Authority", "DIN", "Notice date", "Hearing date", "Status"],
      rows: () => data.notices.map(n => [n.assessee, n.pan, n.ay, n.section, n.authority, n.din, n.date, n.hearingDate, n.status]),
    },
    {
      t: "Assessee master", d: "Full assessee register", icon: "users", color: "primary",
      file: "assessees.csv", headers: ["Name", "PAN", "Status", "Group", "Mobile", "Email", "Staff", "Address"],
      rows: () => data.assessees.map(a => [a.name, a.pan, a.status, a.group, a.mobile, a.email, a.staff, a.address]),
    },
    {
      t: "Communication log", d: "Messages sent and drafted", icon: "chat", color: "pink",
      file: "communications.csv", headers: ["Time", "Channel", "To", "Subject", "Template", "Status"],
      rows: () => data.communications.map(c => [c.time, c.channel, c.to, c.subject, c.template, c.status]),
    },
  ];

  const run = (r) => {
    const rows = r.rows();
    if (rows.length === 0) {
      notify("No data for this report yet", "info");
      return;
    }
    downloadCSV(r.file, r.headers, rows);
    notify(`${r.t} exported — ${rows.length} row${rows.length > 1 ? "s" : ""}`);
  };

  return (
    <div className="animate-in">
      <div className="topbar">
        <div>
          <div className="page-title">Reports</div>
          <div className="page-sub">Export CSV reports across the practice — opens in Excel</div>
        </div>
      </div>
      <div className="grid-cards">
        {reports.map(r => {
          const colors = { warning: ["var(--p-amber)","#B07512"], primary: ["var(--p-lavender-2)","var(--p-primary-2)"], success: ["var(--p-mint)","#1B8C5C"], pink: ["var(--p-pink)","#C13388"], danger: ["var(--p-coral)","#B8463A"] }[r.color];
          const count = r.rows().length;
          return (
            <div key={r.t} className="card">
              <div className="center" style={{gap: 12, marginBottom: 14}}>
                <div style={{width: 40, height: 40, borderRadius: 12, background: colors[0], color: colors[1], display: "grid", placeItems: "center"}}>
                  <Icon name={r.icon} size={18}/>
                </div>
                <div style={{flex: 1}}>
                  <div style={{fontWeight: 700, fontSize: 14}}>{r.t}</div>
                </div>
              </div>
              <div className="card-sub mb-4">{r.d} · {count} row{count !== 1 ? "s" : ""}</div>
              <button className="btn btn-secondary btn-sm" style={{width: "100%", justifyContent: "center"}} onClick={() => run(r)}>
                <Icon name="download" size={12}/>Export CSV
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- Settings ---------------- */

export function SettingsPage() {
  const { data, profile, setProfile, loadSampleData, clearAllData, notify } = useData();
  const { user, signOutUser } = useAuth();
  const [owner, setOwner] = React.useState(data.profile.ownerName);
  const [firm, setFirm] = React.useState(data.profile.firmName);
  const [firmAddress, setFirmAddress] = React.useState(profile?.firmAddress || "");
  const [firmMobile, setFirmMobile] = React.useState(profile?.firmMobile || "");

  // Profile streams in from Firestore after mount — sync the form when it lands.
  React.useEffect(() => {
    setOwner(data.profile.ownerName);
    setFirm(data.profile.firmName);
    setFirmAddress(profile?.firmAddress || "");
    setFirmMobile(profile?.firmMobile || "");
  }, [data.profile.ownerName, data.profile.firmName, profile?.firmAddress, profile?.firmMobile]);

  const saveProfile = () => {
    setProfile({ ownerName: owner.trim(), firmName: firm.trim(), firmAddress: firmAddress.trim(), firmMobile: firmMobile.trim() });
    notify("Profile saved");
  };

  const exportBackup = () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `prohippo-backup-${todayISO()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    notify("Backup downloaded");
  };

  const integrations = [
    { t: "Google Calendar", d: "Sync hearings to your Google account", icon: "calendar" },
    { t: "Income-tax portal fetch", d: "Auto-fetch notices from the ITD portal", icon: "link" },
    { t: "WhatsApp Business Cloud", d: "Send notices and reminders in-app", icon: "whatsapp" },
    { t: "Transactional email", d: "Send emails from your own domain", icon: "mail" },
    { t: "Tally / Zoho Books", d: "Push invoices to accounting", icon: "invoice" },
  ];

  return (
    <div className="animate-in">
      <div className="topbar">
        <div>
          <div className="page-title">Settings</div>
          <div className="page-sub">Profile, data and integrations</div>
        </div>
      </div>

      <div className="grid-split" style={{gap: 16, marginBottom: 16}}>
        <div className="card">
          <div className="card-title mb-3">Practice profile</div>
          <div className="col" style={{gap: 12}}>
            <FormField label="Your name"><TextInput value={owner} onChange={setOwner} placeholder="e.g. Jayesh Vyas"/></FormField>
            <FormField label="Firm name"><TextInput value={firm} onChange={setFirm} placeholder="e.g. Jayesh Vyas & Co."/></FormField>
            <FormField label="Firm address (shown on invoice PDFs)"><TextInput value={firmAddress} onChange={setFirmAddress} placeholder="Office address"/></FormField>
            <FormField label="Firm phone (shown on invoice PDFs)"><TextInput value={firmMobile} onChange={setFirmMobile} placeholder="+91 …"/></FormField>
            <button className="btn btn-primary" style={{alignSelf: "flex-start"}} onClick={saveProfile}><Icon name="check" size={14}/>Save profile</button>
          </div>
        </div>
        <div className="card">
          <div className="card-title mb-3">Account</div>
          <div className="col" style={{gap: 10}}>
            <KVRow label="Signed in as" value={user?.email || "—"}/>
            <KVRow label="Sign-in method" value={user?.providerData?.[0]?.providerId === "google.com" ? "Google" : "Email link"}/>
            <KVRow label="Data storage" value="Cloud Firestore — private to your account, synced across your devices"/>
            <button className="btn btn-secondary" style={{alignSelf: "flex-start", marginTop: 4}} onClick={() => { if (window.confirm("Sign out of ProHippo?")) signOutUser(); }}>
              <Icon name="logout" size={14}/>Sign out
            </button>
          </div>
        </div>
      </div>

      <div className="grid-split" style={{gap: 16, marginBottom: 16}}>
        <div className="card">
          <div className="card-title mb-3">Your data</div>
          <div className="card-sub mb-4">Records are saved securely in the cloud under your account. You can still download a JSON backup anytime.</div>
          <div className="col" style={{gap: 8}}>
            <button className="btn btn-secondary" onClick={exportBackup}><Icon name="download" size={14}/>Download backup (JSON)</button>
            <button className="btn btn-secondary" onClick={() => { if (window.confirm("Add sample data to your practice?")) loadSampleData(); }}><Icon name="sparkle" size={14}/>Load sample data</button>
            <button className="btn btn-secondary" style={{color: "var(--p-danger)"}} onClick={() => { if (window.confirm("Delete ALL practice data? This cannot be undone.")) clearAllData(); }}><Icon name="trash" size={14}/>Clear all data</button>
          </div>
        </div>
      </div>

      <div className="card-title mb-3" style={{fontSize: 15}}>Integrations</div>
      <div className="grid-split" style={{gap: 16}}>
        {integrations.map(i => (
          <div key={i.t} className="card">
            <div className="between">
              <div className="center" style={{gap: 12}}>
                <div style={{width: 42, height: 42, borderRadius: 12, background: "var(--p-card-tint)", color: "var(--p-primary)", display: "grid", placeItems: "center"}}>
                  <Icon name={i.icon} size={18}/>
                </div>
                <div>
                  <div style={{fontWeight: 700, fontSize: 14}}>{i.t}</div>
                  <div className="muted" style={{fontSize: 12}}>{i.d}</div>
                </div>
              </div>
              <span className="pill pill-muted">Coming soon</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
