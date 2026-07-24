/* ProHippo — Invoices, Communications, Matters, Reports, Settings */
import React from 'react';
import { Icon, Avatar, StatusPill, Modal, FormField, TextInput, SelectInput, ComboBox, EmptyState, Toggle, titleCase, fmtINR, fmtLakhs, fmtDate, fmtDateLong, daysFromNow } from './shared';
import { useData, invoiceStatus, invoiceOutstanding, totalOutstanding, upcomingHearings, downloadCSV, todayISO, daysAway, toISO } from './store';
import { useAuth } from './auth';
import { AssesseeModal, AssesseeRequiredNote } from './AssesseeModal';
import { downloadInvoicePDF, computeInvoiceTotals, invoicePDFDataUri, fmtRupee } from './invoicePdf';

/* ---- invoice appearance / defaults, persisted in profile.invoiceSettings ---- */
export const ACCENT_PRESETS = [
  { name: "Violet", hex: "#6C5CE7" },
  { name: "Crimson", hex: "#E11D48" },
  { name: "Blue", hex: "#2563EB" },
  { name: "Emerald", hex: "#059669" },
  { name: "Amber", hex: "#D97706" },
  { name: "Fuchsia", hex: "#C026D3" },
  { name: "Teal", hex: "#0D9488" },
  { name: "Slate", hex: "#334155" },
];
export const DEFAULT_INVOICE_SETTINGS = {
  accent: "#6C5CE7", firmGstin: "",
  bankName: "", bankAccount: "", bankIfsc: "", bankUpi: "",
  terms: "1. Goods once sold will not be taken back.",
  notes: "Thank you for your business.",
  placeOfSupply: "", countryOfSupply: "India",
  gstEnabledDefault: true, defaultGstRate: 18, gstType: "CGST_SGST",
  showBankDetails: true, signatoryLabel: "Authorised Signatory",
};
const resolveInvoiceSettings = (profile) => ({ ...DEFAULT_INVOICE_SETTINGS, ...(profile?.invoiceSettings || {}) });
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

/* Invoice Maker — build a full GST tax invoice with multiple line items,
   a GST on/off toggle and a per-page settings gear for colours & defaults. */
export function InvoiceModal({ initial, onClose }) {
  const { data, profile, addInvoice, updateInvoice, notify } = useData();
  const settings = resolveInvoiceSettings(profile);
  const isEdit = Boolean(initial?.id);
  const blankItem = () => ({ description: "", note: "", hsn: "", qty: 1, rate: "", gst: settings.defaultGstRate });

  const [form, setForm] = React.useState(() => {
    if (initial?.id) {
      const items = (initial.items && initial.items.length)
        ? initial.items.map(x => ({ ...blankItem(), ...x }))
        : [{ ...blankItem(), description: initial.service || "", note: initial.ay ? `AY ${initial.ay}` : "", rate: initial.amount || "", gst: 0 }];
      return {
        assessee: initial.assessee || "",
        date: initial.date || todayISO(), due: initial.due || daysAway(30),
        gstEnabled: initial.gstEnabled !== false && (initial.gstEnabled === true || Boolean(initial.items?.length)),
        gstType: initial.gstType || settings.gstType || "CGST_SGST",
        customerGstin: initial.customerGstin || "",
        notes: initial.notes || "",
        items,
      };
    }
    return {
      assessee: "", date: todayISO(), due: daysAway(30),
      gstEnabled: settings.gstEnabledDefault, gstType: settings.gstType || "CGST_SGST",
      customerGstin: "", notes: "", items: [blankItem()],
    };
  });

  const [showAddAssessee, setShowAddAssessee] = React.useState(false);
  const [showSettings, setShowSettings] = React.useState(false);
  const [previewInv, setPreviewInv] = React.useState(null);

  const set = (k) => (v) => setForm(f => ({ ...f, [k]: v }));
  const linked = data.assessees.find(a => a.name === form.assessee);
  const assesseeOptions = data.assessees.map(a => ({ value: a.name, label: titleCase(a.name), sub: a.pan }));

  const pickAssessee = (name) => {
    const a = data.assessees.find(x => x.name === name);
    setForm(f => ({ ...f, assessee: name, customerGstin: f.customerGstin || a?.gstin || "" }));
  };
  const setItem = (i, k, v) => setForm(f => ({ ...f, items: f.items.map((it, idx) => idx === i ? { ...it, [k]: v } : it) }));
  const addItem = () => setForm(f => ({ ...f, items: [...f.items, blankItem()] }));
  const removeItem = (i) => setForm(f => ({ ...f, items: f.items.length > 1 ? f.items.filter((_, idx) => idx !== i) : f.items }));

  const totals = computeInvoiceTotals(form);
  const valid = Boolean(linked) && form.date && totals.grandTotal > 0 && form.items.some(it => (it.description || "").trim());

  const buildRec = () => {
    const items = form.items
      .filter(it => (it.description || "").trim() || Number(it.rate) > 0)
      .map(it => ({
        description: (it.description || "").trim(), note: (it.note || "").trim(), hsn: (it.hsn || "").trim(),
        qty: Number(it.qty) || 0, rate: Number(it.rate) || 0, gst: form.gstEnabled ? (Number(it.gst) || 0) : 0,
      }));
    const t = computeInvoiceTotals({ ...form, items });
    const summary = items.map(x => x.description).filter(Boolean);
    return {
      assessee: form.assessee,
      customerName: linked?.name || form.assessee,
      customerAddress: linked?.address || "",
      customerGstin: (form.customerGstin || "").trim(),
      date: form.date, due: form.due,
      gstEnabled: form.gstEnabled, gstType: form.gstType,
      items, notes: (form.notes || "").trim(),
      service: summary.length > 1 ? `${summary[0]} +${summary.length - 1} more` : (summary[0] || "Professional fees"),
      amount: t.grandTotal, subTotal: t.subTotal, taxTotal: t.taxTotal,
    };
  };

  const openPreview = () => {
    if (!valid) { notify("Add a customer and at least one priced line item first.", "alert"); return; }
    setPreviewInv({ ...buildRec(), number: initial?.number || "DRAFT", received: initial?.received || 0 });
  };

  const save = async () => {
    if (!valid) return;
    const rec = buildRec();
    if (isEdit) {
      updateInvoice(initial.id, rec);
      notify(`Invoice ${initial.number} updated`);
    } else {
      const inv = await addInvoice(rec);
      if (!inv) return;
      notify(`Invoice ${inv.number || ""} raised — ${fmtINR(rec.amount)}`);
    }
    onClose();
  };

  const gstOn = form.gstEnabled;

  return (
    <Modal
      title={<span className="center" style={{gap: 10, justifyContent: "flex-start"}}>
        <span>{isEdit ? "Edit invoice" : "Invoice Maker"}</span>
        <button className="icon-btn" style={{width: 30, height: 30}} title="Invoice settings" onClick={() => setShowSettings(true)}><Icon name="settings" size={15}/></button>
      </span>}
      sub={isEdit ? `${initial.number} — the invoice number stays unchanged` : "The invoice number is assigned automatically on save"}
      onClose={onClose}
      width={860}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-secondary" onClick={openPreview}><Icon name="doc" size={14}/>Preview</button>
        <button className="btn btn-primary" disabled={!valid} style={{opacity: valid ? 1 : 0.5}} onClick={save}><Icon name="check" size={14}/>{isEdit ? "Save changes" : "Finalize invoice"}</button>
      </>}
    >
      {data.assessees.length === 0 && (
        <div style={{marginBottom: 14}}>
          <AssesseeRequiredNote message={NEEDS_ASSESSEE} onCreate={() => setShowAddAssessee(true)}/>
        </div>
      )}

      <div className="form-grid">
        <FormField label="Party / Customer" required full>
          <ComboBox value={form.assessee} onChange={pickAssessee} options={assesseeOptions} subMono placeholder={data.assessees.length ? "Search name or PAN…" : "No customers yet"}/>
        </FormField>
        <FormField label="Invoice date"><TextInput type="date" value={form.date} onChange={set("date")}/></FormField>
        <FormField label="Due date"><TextInput type="date" value={form.due} onChange={set("due")}/></FormField>
      </div>

      {/* GST controls */}
      <div className="between" style={{marginTop: 14, padding: "12px 14px", background: "var(--p-card-tint)", borderRadius: 12, border: "1px solid var(--p-line-2)", flexWrap: "wrap", gap: 12}}>
        <div className="center" style={{gap: 12, justifyContent: "flex-start"}}>
          <Toggle checked={gstOn} onChange={set("gstEnabled")} label="GST applicable"/>
          <div>
            <div style={{fontWeight: 700, fontSize: 13}}>GST applicable</div>
            <div className="muted" style={{fontSize: 11.5}}>{gstOn ? "Tax is calculated per line item" : "Plain bill — no tax columns"}</div>
          </div>
        </div>
        {gstOn && (
          <div className="center" style={{gap: 10, flexWrap: "wrap"}}>
            <div className="field" style={{gap: 4}}>
              <label style={{fontSize: 11}}>Tax logic</label>
              <SelectInput value={form.gstType} onChange={set("gstType")} options={[{ value: "CGST_SGST", label: "CGST + SGST (intra-state)" }, { value: "IGST", label: "IGST (inter-state)" }]}/>
            </div>
            <div className="field" style={{gap: 4}}>
              <label style={{fontSize: 11}}>Customer GSTIN</label>
              <TextInput value={form.customerGstin} onChange={set("customerGstin")} placeholder="e.g. 24ABCDE1234F1Z5" mono/>
            </div>
          </div>
        )}
      </div>

      {/* Line items */}
      <div style={{marginTop: 16}}>
        <div className="between" style={{marginBottom: 8}}>
          <div style={{fontWeight: 800, fontSize: 13.5}}>Particulars</div>
          <span className="pill pill-muted">{form.items.length} item{form.items.length !== 1 ? "s" : ""}</span>
        </div>
        <div style={{overflowX: "auto"}}>
          <table className="lineitems">
            <thead>
              <tr>
                <th style={{width: "38%"}}>Description</th>
                <th style={{width: 96}}>HSN/SAC</th>
                <th className="num" style={{width: 64}}>Qty</th>
                <th className="num" style={{width: 96}}>Rate (₹)</th>
                {gstOn && <th className="num" style={{width: 70}}>GST %</th>}
                <th className="num" style={{width: 104}}>Amount</th>
                <th style={{width: 34}}/>
              </tr>
            </thead>
            <tbody>
              {form.items.map((it, i) => {
                const rowTotal = totals.rows[i]?.total || 0;
                return (
                  <tr key={i}>
                    <td>
                      <input placeholder="Product or service" value={it.description} onChange={e => setItem(i, "description", e.target.value)}/>
                      <input className="note" placeholder="Add a note or specification (optional)" value={it.note} onChange={e => setItem(i, "note", e.target.value)}/>
                    </td>
                    <td><input placeholder="e.g. 9982" value={it.hsn} onChange={e => setItem(i, "hsn", e.target.value)}/></td>
                    <td><input className="right" type="number" value={it.qty} onChange={e => setItem(i, "qty", e.target.value)}/></td>
                    <td><input className="right" type="number" placeholder="0" value={it.rate} onChange={e => setItem(i, "rate", e.target.value)}/></td>
                    {gstOn && <td><input className="right" type="number" value={it.gst} onChange={e => setItem(i, "gst", e.target.value)}/></td>}
                    <td className="num" style={{paddingTop: 15, fontWeight: 700, fontSize: 12.5, whiteSpace: "nowrap"}}>{fmtRupee(rowTotal)}</td>
                    <td style={{paddingTop: 10}}>
                      <button className="btn btn-ghost btn-xs" title="Remove line" style={{color: "var(--p-danger)"}} onClick={() => removeItem(i)} disabled={form.items.length <= 1}><Icon name="trash" size={13}/></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <button className="btn btn-secondary btn-sm" style={{marginTop: 10}} onClick={addItem}><Icon name="plus" size={13}/>Add line item</button>
      </div>

      {/* Additional notes + live summary */}
      <div className="grid-split" style={{gap: 16, marginTop: 18, alignItems: "start"}}>
        <FormField label="Notes on this invoice">
          <textarea rows={3} value={form.notes} onChange={e => set("notes")(e.target.value)} placeholder="Shown under the totals on the PDF" style={{border: "1px solid var(--p-line)", background: "white", borderRadius: 12, padding: "11px 14px", fontSize: 13.5, outline: "none", resize: "vertical", fontFamily: "inherit"}}/>
        </FormField>
        <div style={{background: "var(--p-card-tint)", border: "1px solid var(--p-line-2)", borderRadius: 14, padding: "14px 16px"}}>
          <div className="between" style={{fontSize: 13, padding: "3px 0"}}><span className="muted">Sub Total</span><span style={{fontWeight: 700}}>{fmtRupee(totals.subTotal)}</span></div>
          {gstOn && totals.gstType === "IGST" && <div className="between" style={{fontSize: 13, padding: "3px 0"}}><span className="muted">IGST</span><span style={{fontWeight: 700}}>{fmtRupee(totals.igst)}</span></div>}
          {gstOn && totals.gstType === "CGST_SGST" && <>
            <div className="between" style={{fontSize: 13, padding: "3px 0"}}><span className="muted">CGST</span><span style={{fontWeight: 700}}>{fmtRupee(totals.cgst)}</span></div>
            <div className="between" style={{fontSize: 13, padding: "3px 0"}}><span className="muted">SGST</span><span style={{fontWeight: 700}}>{fmtRupee(totals.sgst)}</span></div>
          </>}
          {Math.abs(totals.roundOff) >= 0.005 && <div className="between" style={{fontSize: 13, padding: "3px 0"}}><span className="muted">Round Off</span><span style={{fontWeight: 700}}>{totals.roundOff >= 0 ? "+" : "−"}{fmtRupee(Math.abs(totals.roundOff))}</span></div>}
          <div className="between" style={{borderTop: "1px solid var(--p-line)", marginTop: 8, paddingTop: 10}}>
            <span style={{fontWeight: 800, fontSize: 15}}>Grand Total</span>
            <span style={{fontWeight: 800, fontSize: 17, color: "var(--p-primary)"}}>{fmtRupee(totals.grandTotal)}</span>
          </div>
        </div>
      </div>

      {showAddAssessee && (
        <AssesseeModal onClose={() => setShowAddAssessee(false)} onSaved={(a) => pickAssessee(a.name)}/>
      )}
      {showSettings && <InvoiceSettingsModal onClose={() => setShowSettings(false)}/>}
      {previewInv && <InvoiceView invoice={previewInv} onClose={() => setPreviewInv(null)} onEdit={() => setPreviewInv(null)}/>}
    </Modal>
  );
}

/* Invoice appearance & defaults — colours, firm GSTIN, bank details, terms. */
export function InvoiceSettingsModal({ onClose }) {
  const { profile, setProfile, notify } = useData();
  const [s, setS] = React.useState(() => resolveInvoiceSettings(profile));
  const set = (k) => (v) => setS(x => ({ ...x, [k]: v }));

  const save = () => {
    setProfile({ invoiceSettings: { ...s, defaultGstRate: Number(s.defaultGstRate) || 0 } });
    notify("Invoice settings saved");
    onClose();
  };

  return (
    <Modal
      title="Invoice settings"
      sub="Colours, tax defaults and the details printed on every invoice PDF"
      onClose={onClose}
      width={640}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save}><Icon name="check" size={14}/>Save settings</button>
      </>}
    >
      <div style={{fontWeight: 800, fontSize: 13, marginBottom: 8}}>Accent colour</div>
      <div className="row" style={{gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 6}}>
        {ACCENT_PRESETS.map(p => (
          <button key={p.hex} type="button" title={p.name} className={`swatch ${s.accent?.toLowerCase() === p.hex.toLowerCase() ? "active" : ""}`} style={{background: p.hex}} onClick={() => set("accent")(p.hex)}/>
        ))}
        <label className="center" style={{gap: 6, fontSize: 12}}>
          <input type="color" value={s.accent} onChange={e => set("accent")(e.target.value)} style={{width: 34, height: 30, border: "none", background: "none", cursor: "pointer", padding: 0}}/>
          <span className="muted" style={{fontFamily: "ui-monospace, monospace"}}>{s.accent}</span>
        </label>
      </div>

      <div style={{height: 1, background: "var(--p-line)", margin: "16px 0"}}/>

      <div className="between" style={{marginBottom: 14}}>
        <div>
          <div style={{fontWeight: 700, fontSize: 13}}>GST applicable by default</div>
          <div className="muted" style={{fontSize: 11.5}}>New invoices start with GST {s.gstEnabledDefault ? "on" : "off"}</div>
        </div>
        <Toggle checked={s.gstEnabledDefault} onChange={set("gstEnabledDefault")} label="GST default"/>
      </div>

      <div className="form-grid">
        <FormField label="Default tax logic"><SelectInput value={s.gstType} onChange={set("gstType")} options={[{ value: "CGST_SGST", label: "CGST + SGST" }, { value: "IGST", label: "IGST" }]}/></FormField>
        <FormField label="Default GST rate (%)"><TextInput type="number" value={s.defaultGstRate} onChange={set("defaultGstRate")} placeholder="18"/></FormField>
        <FormField label="Your firm GSTIN"><TextInput value={s.firmGstin} onChange={set("firmGstin")} placeholder="e.g. 24ABCDE1234F1Z5" mono/></FormField>
        <FormField label="Signatory label"><TextInput value={s.signatoryLabel} onChange={set("signatoryLabel")} placeholder="Authorised Signatory"/></FormField>
        <FormField label="Place of supply"><TextInput value={s.placeOfSupply} onChange={set("placeOfSupply")} placeholder="e.g. Gujarat"/></FormField>
        <FormField label="Country of supply"><TextInput value={s.countryOfSupply} onChange={set("countryOfSupply")} placeholder="India"/></FormField>
      </div>

      <div style={{height: 1, background: "var(--p-line)", margin: "16px 0"}}/>
      <div className="between" style={{marginBottom: 12}}>
        <div style={{fontWeight: 800, fontSize: 13}}>Bank & payment details</div>
        <div className="center" style={{gap: 8}}>
          <span className="muted" style={{fontSize: 11.5}}>Show on PDF</span>
          <Toggle checked={s.showBankDetails !== false} onChange={set("showBankDetails")} label="Show bank details"/>
        </div>
      </div>
      <div className="form-grid">
        <FormField label="Bank name"><TextInput value={s.bankName} onChange={set("bankName")} placeholder="e.g. HDFC Bank"/></FormField>
        <FormField label="Account number"><TextInput value={s.bankAccount} onChange={set("bankAccount")} placeholder="Account no."/></FormField>
        <FormField label="IFSC"><TextInput value={s.bankIfsc} onChange={set("bankIfsc")} placeholder="IFSC code" mono/></FormField>
        <FormField label="UPI ID"><TextInput value={s.bankUpi} onChange={set("bankUpi")} placeholder="name@bank"/></FormField>
      </div>

      <div style={{height: 1, background: "var(--p-line)", margin: "16px 0"}}/>
      <div className="col" style={{gap: 12}}>
        <FormField label="Terms & conditions">
          <textarea rows={2} value={s.terms} onChange={e => set("terms")(e.target.value)} placeholder="1. Goods once sold will not be taken back." style={{border: "1px solid var(--p-line)", background: "white", borderRadius: 12, padding: "11px 14px", fontSize: 13.5, outline: "none", resize: "vertical", fontFamily: "inherit"}}/>
        </FormField>
        <FormField label="Default notes">
          <textarea rows={2} value={s.notes} onChange={e => set("notes")(e.target.value)} placeholder="Thank you for your business." style={{border: "1px solid var(--p-line)", background: "white", borderRadius: 12, padding: "11px 14px", fontSize: 13.5, outline: "none", resize: "vertical", fontFamily: "inherit"}}/>
        </FormField>
      </div>
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
      sub={`${invoice.number} · ${titleCase(invoice.assessee)} · balance ${fmtINR(balance)}`}
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

/* On-screen preview of the actual vector PDF invoice (rendered in an
   embedded viewer), with download / edit actions. */
function InvoiceView({ invoice, onClose, onEdit }) {
  const { data, profile } = useData();
  const assessee = data.assessees.find(a => a.name === invoice.assessee);
  const dataUri = React.useMemo(
    () => invoicePDFDataUri({ invoice, assessee, profile }),
    [invoice, assessee, profile]
  );
  return (
    <Modal
      title={`Invoice ${invoice.number || "preview"}`}
      sub="Vector PDF — exactly what downloads"
      onClose={onClose}
      width={880}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Close</button>
        {onEdit && <button className="btn btn-secondary" onClick={onEdit}><Icon name="edit" size={14}/>Edit</button>}
        <button className="btn btn-primary" onClick={() => downloadInvoicePDF({ invoice, assessee, profile })}><Icon name="download" size={14}/>Download PDF</button>
      </>}
    >
      <div style={{height: "72vh", border: "1px solid var(--p-line)", borderRadius: 12, overflow: "hidden", background: "#525659"}}>
        <iframe title={`Invoice ${invoice.number || ""}`} src={dataUri} style={{width: "100%", height: "100%", border: 0}}/>
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
  const [showSettings, setShowSettings] = React.useState(false);

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
          <button className="btn btn-secondary" title="Invoice settings" onClick={() => setShowSettings(true)}><Icon name="settings" size={14}/>Settings</button>
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
                    <div style={{fontWeight: 700, fontSize: 13}}>{titleCase(inv.assessee)}</div>
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
                  <td className="strong">{titleCase(inv.assessee)}</td>
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
      {showSettings && <InvoiceSettingsModal onClose={() => setShowSettings(false)}/>}
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
          <SelectInput value={linked ? linked.name : ""} onChange={pickAssessee} options={data.assessees.map(a => ({ value: a.name, label: titleCase(a.name) }))} placeholder={data.assessees.length ? "Select assessee…" : "No assessees yet"}/>
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
                    <td className="strong">{titleCase(m.assessee)}</td>
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
          <SelectInput value={linked ? linked.name : ""} onChange={set("to")} options={data.assessees.map(a => ({ value: a.name, label: titleCase(a.name) }))} placeholder={data.assessees.length ? "Select assessee…" : "No assessees yet"}/>
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
                        <div style={{fontWeight: 700, fontSize: 13.5}}>{titleCase(c.to)}</div>
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
                    <div style={{fontWeight: 700, fontSize: 13}}>{titleCase(n.assessee)}</div>
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
