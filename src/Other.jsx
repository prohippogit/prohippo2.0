/* ProHippo — Invoices, Communications, Matters, Reports, Settings */
import React from 'react';
import { Icon, Avatar, StatusPill, Modal, FormField, TextInput, SelectInput, ComboBox, EmptyState, Toggle, Table, titleCase, fmtINR, fmtLakhs, fmtDate, fmtDateLong, daysFromNow } from './shared';
import { hapticsAvailable } from './haptics';
import { useData, invoiceStatus, invoiceOutstanding, totalOutstanding, upcomingHearings, downloadCSV, todayISO, daysAway, toISO,
  assesseeLedger, groupLedger, groupsOf, assesseeOutstanding, allocatePayment, docRequestProgress, derivedRequestStatus } from './store';
import DocumentRequestComposer, { RequestStatusPill } from './DocumentRequest';
import { useAuth } from './auth';
import { AssesseeModal, AssesseeRequiredNote } from './AssesseeModal';
import { downloadInvoicePDF, computeInvoiceTotals, invoicePDFDataUri, fmtRupee } from './invoicePdf';
import { downloadLedgerPDF, ledgerPDFDataUri, downloadReceiptPDF, receiptPDFDataUri } from './ledgerPdf';
import { useCalendarConfig, useCalendarActions, relativeSyncTime } from './googleCalendar';
import VoiceHelpLineCard from './voiceAssistant';

const PAY_MODES = ["Cash", "UPI", "Bank transfer", "Cheque", "Card", "Other"];

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

/* Record a payment against a single invoice — writes a numbered receipt and
   bumps the invoice's received amount, then hands the receipt back so the
   caller can offer the printable receipt PDF. */
function PaymentModal({ invoice, onClose, onReceipt }) {
  const { data, addReceipt, notify } = useData();
  const balance = invoiceOutstanding(invoice);
  const assessee = data.assessees.find(a => a.name === invoice.assessee);
  const [form, setForm] = React.useState({ amount: String(balance), date: todayISO(), mode: "UPI", note: "" });
  const set = (k) => (v) => setForm(f => ({ ...f, [k]: v }));
  const [busy, setBusy] = React.useState(false);
  const val = Number(form.amount);
  const valid = val > 0 && val <= balance + 0.01;

  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const rec = await addReceipt({
      assessee: invoice.assessee, group: assessee?.group || "",
      date: form.date, amount: val, mode: form.mode, note: form.note.trim(),
      allocations: [{ invoiceId: invoice.id, invoiceNumber: invoice.number, amount: val }],
    });
    setBusy(false);
    if (!rec) return;
    notify(`Receipt ${rec.number} — ${fmtINR(val)} against ${invoice.number}`);
    onReceipt?.(rec);
    onClose();
  };

  return (
    <Modal
      title="Record payment"
      sub={`${invoice.number} · ${titleCase(invoice.assessee)} · balance ${fmtINR(balance)}`}
      onClose={onClose}
      width={460}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid || busy} style={{opacity: valid && !busy ? 1 : 0.5}} onClick={save}><Icon name="check" size={14}/>{busy ? "Saving…" : "Record & receipt"}</button>
      </>}
    >
      <div className="form-grid">
        <FormField label="Amount received (₹)" required><TextInput type="number" value={form.amount} onChange={set("amount")}/></FormField>
        <FormField label="Payment date"><TextInput type="date" value={form.date} onChange={set("date")}/></FormField>
        <FormField label="Mode"><SelectInput value={form.mode} onChange={set("mode")} options={PAY_MODES}/></FormField>
        <FormField label="Reference / note"><TextInput value={form.note} onChange={set("note")} placeholder="e.g. NEFT ref, cheque no."/></FormField>
      </div>
    </Modal>
  );
}

/* Receive a payment against an assessee — auto-allocated across their open
   invoices oldest-first. Anything beyond the total outstanding is kept as an
   advance on the receipt. */
function AssesseePaymentModal({ assessee, onClose, onReceipt }) {
  const { data, addReceipt, notify } = useData();
  const outstanding = assesseeOutstanding(data, assessee.name);
  const [form, setForm] = React.useState({ amount: String(outstanding || ""), date: todayISO(), mode: "UPI", note: "" });
  const set = (k) => (v) => setForm(f => ({ ...f, [k]: v }));
  const [busy, setBusy] = React.useState(false);
  const val = Number(form.amount);
  const valid = val > 0;
  const { allocations, advance } = allocatePayment(data, assessee.name, val || 0);

  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const rec = await addReceipt({
      assessee: assessee.name, group: assessee.group || "",
      date: form.date, amount: val, mode: form.mode, note: form.note.trim(), allocations,
    });
    setBusy(false);
    if (!rec) return;
    notify(`Receipt ${rec.number} — ${fmtINR(val)} from ${titleCase(assessee.name)}`);
    onReceipt?.(rec);
    onClose();
  };

  return (
    <Modal
      title="Receive payment"
      sub={`${titleCase(assessee.name)} · outstanding ${fmtINR(outstanding)}`}
      onClose={onClose}
      width={480}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid || busy} style={{opacity: valid && !busy ? 1 : 0.5}} onClick={save}><Icon name="check" size={14}/>{busy ? "Saving…" : "Record & receipt"}</button>
      </>}
    >
      <div className="form-grid">
        <FormField label="Amount received (₹)" required><TextInput type="number" value={form.amount} onChange={set("amount")}/></FormField>
        <FormField label="Payment date"><TextInput type="date" value={form.date} onChange={set("date")}/></FormField>
        <FormField label="Mode"><SelectInput value={form.mode} onChange={set("mode")} options={PAY_MODES}/></FormField>
        <FormField label="Reference / note"><TextInput value={form.note} onChange={set("note")} placeholder="e.g. NEFT ref, cheque no."/></FormField>
      </div>
      {val > 0 && (
        <div style={{marginTop: 12, padding: "10px 12px", background: "var(--p-card-tint)", borderRadius: 11, border: "1px solid var(--p-line-2)"}}>
          <div className="muted" style={{fontSize: 11.5, marginBottom: 6, fontWeight: 700}}>APPLIED TO</div>
          {allocations.length === 0 && <div className="muted" style={{fontSize: 12.5}}>No open invoices — recorded as an advance.</div>}
          {allocations.map(a => (
            <div key={a.invoiceId} className="between" style={{fontSize: 12.5, padding: "2px 0"}}>
              <span style={{fontFamily: "ui-monospace, monospace"}}>{a.invoiceNumber}</span><span style={{fontWeight: 700}}>{fmtINR(a.amount)}</span>
            </div>
          ))}
          {advance > 0.01 && <div className="between" style={{fontSize: 12.5, padding: "2px 0", color: "var(--p-primary-2)"}}><span>Advance / on account</span><span style={{fontWeight: 700}}>{fmtINR(advance)}</span></div>}
        </div>
      )}
    </Modal>
  );
}

/* Take a payment against a whole group. It is recorded at the group level and
   appears only in the group ledger — it does not touch individual invoices. */
function GroupPaymentModal({ group, onClose, onReceipt }) {
  const { addReceipt, notify } = useData();
  const [form, setForm] = React.useState({ amount: String(group.outstanding || ""), date: todayISO(), mode: "UPI", note: "" });
  const set = (k) => (v) => setForm(f => ({ ...f, [k]: v }));
  const [busy, setBusy] = React.useState(false);
  const val = Number(form.amount);
  const valid = val > 0;

  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const rec = await addReceipt({
      assessee: "", group: group.name, date: form.date, amount: val, mode: form.mode, note: form.note.trim(),
    });
    setBusy(false);
    if (!rec) return;
    notify(`Receipt ${rec.number} — ${fmtINR(val)} for ${group.name}`);
    onReceipt?.(rec);
    onClose();
  };

  return (
    <Modal
      title="Group payment"
      sub={`${group.name} · outstanding ${fmtINR(group.outstanding)}`}
      onClose={onClose}
      width={480}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid || busy} style={{opacity: valid && !busy ? 1 : 0.5}} onClick={save}><Icon name="check" size={14}/>{busy ? "Saving…" : "Record & receipt"}</button>
      </>}
    >
      <div style={{marginBottom: 12, padding: "10px 12px", background: "var(--p-lavender-2)", borderRadius: 11, fontSize: 12, lineHeight: 1.5}}>
        <Icon name="info" size={12}/> This receipt is recorded against the group as a whole and shows only in the group ledger. To settle a specific invoice, take the payment on that assessee instead.
      </div>
      <div className="form-grid">
        <FormField label="Amount received (₹)" required><TextInput type="number" value={form.amount} onChange={set("amount")}/></FormField>
        <FormField label="Payment date"><TextInput type="date" value={form.date} onChange={set("date")}/></FormField>
        <FormField label="Mode"><SelectInput value={form.mode} onChange={set("mode")} options={PAY_MODES}/></FormField>
        <FormField label="Reference / note"><TextInput value={form.note} onChange={set("note")} placeholder="e.g. NEFT ref, cheque no."/></FormField>
      </div>
    </Modal>
  );
}

/* Preview a receipt / ledger vector PDF in an embedded viewer. */
function PdfPreviewModal({ title, sub, dataUri, onDownload, onClose }) {
  return (
    <Modal
      title={title}
      sub={sub}
      onClose={onClose}
      width={880}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Close</button>
        <button className="btn btn-primary" onClick={onDownload}><Icon name="download" size={14}/>Download PDF</button>
      </>}
    >
      <div style={{height: "72vh", border: "1px solid var(--p-line)", borderRadius: 12, overflow: "hidden", background: "#525659"}}>
        <iframe title={title} src={dataUri} style={{width: "100%", height: "100%", border: 0}}/>
      </div>
    </Modal>
  );
}

function ReceiptView({ receipt, onClose }) {
  const { data, profile } = useData();
  const outstandingAfter = receipt.assessee ? assesseeOutstanding(data, receipt.assessee) : undefined;
  const args = React.useMemo(() => ({
    receipt,
    party: { name: receipt.assessee ? titleCase(receipt.assessee) : receipt.group },
    profile, outstandingAfter,
  }), [receipt, profile, outstandingAfter]);
  const dataUri = React.useMemo(() => receiptPDFDataUri(args), [args]);
  return (
    <PdfPreviewModal
      title={`Receipt ${receipt.number || ""}`}
      sub="Payment receipt — curvy theme"
      dataUri={dataUri}
      onDownload={() => downloadReceiptPDF(args)}
      onClose={onClose}
    />
  );
}

function LedgerView({ ledger, party, isGroup, onClose }) {
  const { profile } = useData();
  const args = React.useMemo(() => ({ ledger, party, isGroup, profile }), [ledger, party, isGroup, profile]);
  const dataUri = React.useMemo(() => ledgerPDFDataUri(args), [args]);
  return (
    <PdfPreviewModal
      title={isGroup ? `Group ledger — ${party.name}` : `Ledger — ${titleCase(party.name)}`}
      sub="Statement of account — curvy theme"
      dataUri={dataUri}
      onDownload={() => downloadLedgerPDF(args)}
      onClose={onClose}
    />
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

/* Per-assessee ledgers: outstanding, statement download and payment intake. */
function LedgersPanel() {
  const { data } = useData();
  const [search, setSearch] = React.useState("");
  const [payFor, setPayFor] = React.useState(null);
  const [ledgerFor, setLedgerFor] = React.useState(null);
  const [receipt, setReceipt] = React.useState(null);

  const rows = data.assessees.map(a => {
    const invs = data.invoices.filter(i => i.assessee === a.name);
    const hasReceipts = (data.receipts || []).some(r => r.assessee === a.name);
    return { a, count: invs.length, hasReceipts, billed: invs.reduce((s, i) => s + (i.amount || 0), 0), outstanding: assesseeOutstanding(data, a.name) };
  }).filter(r => r.count > 0 || r.hasReceipts);

  const q = search.toLowerCase().trim();
  const filtered = rows
    .filter(r => !q || [r.a.name, r.a.pan, r.a.group].some(v => (v || "").toLowerCase().includes(q)))
    .sort((x, y) => y.outstanding - x.outstanding || x.a.name.localeCompare(y.a.name));

  const openLedger = (a) => setLedgerFor({ ledger: assesseeLedger(data, a.name), party: { name: a.name, pan: a.pan, group: a.group } });

  return (
    <div className="card" style={{padding: 0, overflow: "hidden"}}>
      <div className="row" style={{padding: "14px 18px", justifyContent: "space-between", borderBottom: "1px solid var(--p-line-2)", alignItems: "center", gap: 12, flexWrap: "wrap"}}>
        <div>
          <div className="card-title">Assessee ledgers</div>
          <div className="card-sub">Statement of account, payments & receipts per assessee</div>
        </div>
        <div className="search" style={{width: 250}}>
          <Icon name="search" size={15}/>
          <input placeholder="Name, PAN, group…" value={search} onChange={e => setSearch(e.target.value)}/>
        </div>
      </div>
      {filtered.length === 0 ? (
        <EmptyState icon="wallet" title="No billed assessees yet" sub="Raise an invoice and the assessee's ledger appears here."/>
      ) : (
        <Table>
          <thead><tr><th>Assessee</th><th>Group</th><th>Billed</th><th>Outstanding</th><th></th></tr></thead>
          <tbody>
            {filtered.map(({ a, billed, outstanding }) => (
              <tr key={a.id}>
                <td className="strong">{titleCase(a.name)}{a.pan && <div className="muted" style={{fontSize: 11, fontFamily: "ui-monospace, monospace"}}>{a.pan}</div>}</td>
                <td>{a.group ? <span className="pill pill-primary">{a.group}</span> : <span className="muted">—</span>}</td>
                <td className="strong">{fmtINR(billed)}</td>
                <td><span style={{fontWeight: 800, color: outstanding > 0 ? "#C13388" : "var(--p-success)"}}>{outstanding > 0 ? fmtINR(outstanding) : "Settled"}</span></td>
                <td>
                  <div className="row" style={{gap: 4, justifyContent: "flex-end"}}>
                    {outstanding > 0 && <button className="btn btn-secondary btn-xs" onClick={() => setPayFor(a)}><Icon name="wallet" size={12}/>Receive</button>}
                    <button className="btn btn-ghost btn-xs" title="Ledger PDF" onClick={() => openLedger(a)}><Icon name="doc" size={12}/>Ledger</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {payFor && <AssesseePaymentModal assessee={payFor} onClose={() => setPayFor(null)} onReceipt={setReceipt}/>}
      {ledgerFor && <LedgerView {...ledgerFor} onClose={() => setLedgerFor(null)}/>}
      {receipt && <ReceiptView receipt={receipt} onClose={() => setReceipt(null)}/>}
    </div>
  );
}

/* Group ledgers: consolidated statements and group-level payment intake. */
function GroupsPanel() {
  const { data } = useData();
  const groups = groupsOf(data);
  const [payFor, setPayFor] = React.useState(null);
  const [ledgerFor, setLedgerFor] = React.useState(null);
  const [receipt, setReceipt] = React.useState(null);

  const openLedger = (g) => {
    const gl = groupLedger(data, g.name);
    setLedgerFor({ ledger: gl, isGroup: true, party: { name: g.name, memberCount: gl.members.length, byParty: gl.byParty } });
  };

  if (groups.length === 0) {
    return (
      <div className="card">
        <EmptyState icon="group" title="No groups yet" sub="Tag assessees with a Group on their profile to build consolidated group ledgers here." />
      </div>
    );
  }

  return (
    <div className="grid-cards">
      {groups.map(g => (
        <div key={g.name} className="card">
          <div className="between" style={{marginBottom: 12}}>
            <div className="center" style={{gap: 12}}>
              <div style={{width: 42, height: 42, borderRadius: 13, background: "var(--p-lavender-2)", color: "var(--p-primary-2)", display: "grid", placeItems: "center"}}><Icon name="group" size={18}/></div>
              <div>
                <div style={{fontWeight: 800, fontSize: 15}}>{g.name}</div>
                <div className="muted" style={{fontSize: 12}}>{g.members.length} assessee{g.members.length === 1 ? "" : "s"}</div>
              </div>
            </div>
          </div>
          <div className="between" style={{padding: "10px 12px", background: "var(--p-card-tint)", borderRadius: 11, marginBottom: 12}}>
            <span className="muted" style={{fontSize: 12.5}}>Group outstanding</span>
            <span style={{fontWeight: 800, fontSize: 15, color: g.outstanding > 0 ? "#C13388" : "var(--p-success)"}}>{g.outstanding > 0 ? fmtINR(g.outstanding) : "Settled"}</span>
          </div>
          <div className="row" style={{gap: 8}}>
            <button className="btn btn-secondary btn-sm" style={{flex: 1, justifyContent: "center"}} onClick={() => setPayFor(g)}><Icon name="wallet" size={13}/>Group payment</button>
            <button className="btn btn-primary btn-sm" style={{flex: 1, justifyContent: "center"}} onClick={() => openLedger(g)}><Icon name="doc" size={13}/>Group ledger</button>
          </div>
        </div>
      ))}
      {payFor && <GroupPaymentModal group={payFor} onClose={() => setPayFor(null)} onReceipt={setReceipt}/>}
      {ledgerFor && <LedgerView {...ledgerFor} onClose={() => setLedgerFor(null)}/>}
      {receipt && <ReceiptView receipt={receipt} onClose={() => setReceipt(null)}/>}
    </div>
  );
}

export function Invoices() {
  const { data, profile, removeInvoice, notify } = useData();
  const [tab, setTab] = React.useState("invoices");
  const [filter, setFilter] = React.useState("All");
  const [search, setSearch] = React.useState("");
  const [showNew, setShowNew] = React.useState(false);
  const [payFor, setPayFor] = React.useState(null);
  const [editFor, setEditFor] = React.useState(null);
  const [viewFor, setViewFor] = React.useState(null);
  const [receipt, setReceipt] = React.useState(null);
  const [showSettings, setShowSettings] = React.useState(false);
  const groupCount = groupsOf(data).length;

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
          {tab === "invoices" && <button className="btn btn-secondary" onClick={exportCSV}><Icon name="download" size={14}/>Export</button>}
          <button className="btn btn-primary" onClick={() => setShowNew(true)}><Icon name="plus" size={14}/>New invoice</button>
        </div>
      </div>

      <div className="row" style={{gap: 6, marginBottom: 18, flexWrap: "wrap"}}>
        {[
          { k: "invoices", label: "Invoices", icon: "invoice", n: invoices.length },
          { k: "ledgers", label: "Assessee ledgers", icon: "wallet", n: null },
          { k: "groups", label: "Group ledgers", icon: "group", n: groupCount || null },
        ].map(t => (
          <button key={t.k} className={`fchip ${tab === t.k ? "active" : ""}`} style={{display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px"}} onClick={() => setTab(t.k)}>
            <Icon name={t.icon} size={13}/>{t.label}{t.n ? ` · ${t.n}` : ""}
          </button>
        ))}
      </div>

      {tab === "ledgers" && <LedgersPanel/>}
      {tab === "groups" && <GroupsPanel/>}

      {tab === "invoices" && <>
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
          <Table>
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
          </Table>
        )}
      </div>
      </>}

      {showNew && <InvoiceModal onClose={() => setShowNew(false)}/>}
      {showSettings && <InvoiceSettingsModal onClose={() => setShowSettings(false)}/>}
      {payFor && <PaymentModal invoice={payFor} onClose={() => setPayFor(null)} onReceipt={setReceipt}/>}
      {receipt && <ReceiptView receipt={receipt} onClose={() => setReceipt(null)}/>}
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
          <Table>
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
          </Table>
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

  /* An ad-hoc message is a hand-off to WhatsApp / the mail app, so the log
     records that it was opened there — not that it was delivered. Document
     requests sent by email go through Resend and do get a real status. */
  const save = (send) => {
    if (!valid) return;
    let status = "Draft";
    if (send) {
      const text = encodeURIComponent(`${form.subject}\n\n${form.body}`);
      if (form.channel === "WhatsApp" && linked?.mobile) {
        window.open(`https://wa.me/${linked.mobile.replace(/\D/g, "")}?text=${text}`, "_blank");
        status = "Opened in WhatsApp";
      } else if (form.channel === "Email" && linked?.email) {
        window.open(`mailto:${linked.email}?subject=${encodeURIComponent(form.subject)}&body=${encodeURIComponent(form.body)}`);
        status = "Opened in mail app";
      } else {
        notify(`No ${form.channel === "WhatsApp" ? "mobile number" : "email address"} on file for ${linked.name}`, "alert");
        return;
      }
    }
    addCommunication({ ...form, assesseeId: linked.id, assessee: linked.name, time: new Date().toISOString(), status });
    notify(send ? `Logged & opened in ${form.channel} — press send there` : "Draft saved");
    onClose();
  };

  return (
    <Modal
      title="New message"
      sub="Sending opens WhatsApp / your mail app with the message pre-filled"
      onClose={onClose}
      width={560}
      footer={<>
        <button className="btn btn-secondary" onClick={() => save(false)} disabled={!valid} style={{opacity: valid ? 1 : 0.5}}>Save draft</button>
        <button className="btn btn-primary" onClick={() => save(true)} disabled={!valid} style={{opacity: valid ? 1 : 0.5}}><Icon name="arrow-right" size={14}/>Open &amp; log</button>
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

/* A document request in the list — the whole row is the affordance, since the
   composer is where everything about a request happens. */
function RequestRow({ req, onOpen }) {
  const progress = docRequestProgress(req);
  const status = derivedRequestStatus(req);
  const overdue = req.dueDate && req.dueDate < todayISO() && !progress.done;
  return (
    <div
      className="row row-link"
      onClick={() => onOpen(req)}
      style={{padding: "14px 18px", borderBottom: "1px solid var(--p-line-2)", gap: 12, alignItems: "flex-start", cursor: "pointer"}}
    >
      <div style={{width: 38, height: 38, borderRadius: 11, background: "var(--p-lavender-2)", color: "var(--p-primary-2)", display: "grid", placeItems: "center", flexShrink: 0}}>
        <Icon name="doc" size={16}/>
      </div>
      <div style={{flex: 1, minWidth: 0}}>
        <div className="between">
          <div className="center" style={{gap: 8}}>
            <div style={{fontWeight: 700, fontSize: 13.5}}>{titleCase(req.assessee || "")}</div>
            <RequestStatusPill status={status}/>
          </div>
          <div className="muted" style={{fontSize: 11.5}}>
            {req.dueDate ? <span style={overdue ? {color: "var(--p-danger)", fontWeight: 700} : undefined}>due {fmtDateLong(req.dueDate)}</span> : ""}
          </div>
        </div>
        <div className="semi" style={{fontSize: 13, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
          {req.title || "Document request"}
        </div>
        <div className="muted" style={{fontSize: 11.5, marginTop: 4}}>
          {progress.total} item{progress.total === 1 ? "" : "s"}
          {req.sentAt ? ` · ${progress.received} received, ${progress.pending} pending` : " · not sent yet"}
          {(req.channels || []).length ? ` · ${(req.channels || []).map(c => c === "email" ? "Email" : "WhatsApp").join(" + ")}` : ""}
        </div>
      </div>
    </div>
  );
}

export function Communications() {
  const { data } = useData();
  const [filter, setFilter] = React.useState("Requests");
  const [showNew, setShowNew] = React.useState(false);
  const [compose, setCompose] = React.useState(null); // { request } | { seed }

  const comms = [...data.communications].sort((a, b) => (b.time || "").localeCompare(a.time || ""));
  const requests = [...(data.docRequests || [])].sort((a, b) =>
    (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || "")
  );

  const drafts = requests.filter(r => !r.sentAt);
  const openReqs = requests.filter(r => r.sentAt && !docRequestProgress(r).done);

  const counts = {
    Requests: requests.length,
    All: comms.length,
    WhatsApp: comms.filter(c => c.channel === "WhatsApp").length,
    Email: comms.filter(c => c.channel === "Email").length,
  };
  const filtered = comms.filter(c => {
    if (filter === "All") return true;
    return c.channel === filter;
  });

  return (
    <div className="animate-in">
      <div className="topbar">
        <div>
          <div className="page-title">Communications</div>
          <div className="page-sub">
            {drafts.length || openReqs.length
              ? `${drafts.length} draft${drafts.length === 1 ? "" : "s"} · ${openReqs.length} request${openReqs.length === 1 ? "" : "s"} awaiting documents`
              : "Document requests and the log of client messages"}
          </div>
        </div>
        <div className="topbar-actions">
          <button className="btn btn-secondary" onClick={() => setShowNew(true)}><Icon name="chat" size={14}/>New message</button>
          <button className="btn btn-primary" onClick={() => setCompose({ seed: {} })}><Icon name="plus" size={14}/>Document request</button>
        </div>
      </div>

      <div className="card" style={{padding: 0, marginBottom: 18}}>
        <div className="row" style={{padding: "14px 18px", borderBottom: "1px solid var(--p-line-2)", justifyContent: "space-between"}}>
          <div className="row" style={{gap: 6}}>
            {["Requests", "All", "WhatsApp", "Email"].map(f => (
              <span key={f} className={`fchip ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>
                {f === "All" ? "Message log" : f}{counts[f] ? ` · ${counts[f]}` : ""}
              </span>
            ))}
          </div>
        </div>

        {filter === "Requests" ? (
          requests.length === 0 ? (
            <EmptyState
              icon="doc"
              title="No document requests yet"
              sub="Open a notice and turn on “Draft client document request”, or start one here. The list is built from what the notice calls for."
              action={<button className="btn btn-primary" onClick={() => setCompose({ seed: {} })}><Icon name="plus" size={14}/>Document request</button>}
            />
          ) : (
            <div className="col">
              {drafts.length > 0 && (
                <div className="muted" style={{padding: "10px 18px 4px", fontSize: 11, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase"}}>
                  Drafts — not sent
                </div>
              )}
              {drafts.map(r => <RequestRow key={r.id} req={r} onOpen={(req) => setCompose({ request: req })}/>)}
              {requests.filter(r => r.sentAt).length > 0 && (
                <div className="muted" style={{padding: "14px 18px 4px", fontSize: 11, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase"}}>
                  Sent
                </div>
              )}
              {requests.filter(r => r.sentAt).map(r => <RequestRow key={r.id} req={r} onOpen={(req) => setCompose({ request: req })}/>)}
            </div>
          )
        ) : filtered.length === 0 ? (
          <EmptyState
            icon="chat"
            title={comms.length === 0 ? "No messages yet" : "No messages match this filter"}
            sub={comms.length === 0 ? "Every email and WhatsApp hand-off is logged here, with its delivery status." : undefined}
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
                      <div style={{fontWeight: 700, fontSize: 13.5}}>{titleCase(c.assessee || c.to)}</div>
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

      {showNew && <MessageModal onClose={() => setShowNew(false)}/>}
      {compose && (
        <DocumentRequestComposer
          key={compose.request?.id || "new"}
          request={compose.request}
          seed={compose.seed}
          onClose={() => setCompose(null)}
        />
      )}
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

// Attach & verify a mobile number for SMS sign-in, unifying phone + email into
// one account. Verified once via OTP (proves ownership) — pre-filled from an
// existing profile/firm mobile when we have one.
function LinkMobileCard() {
  const { profile, setProfile, notify } = useData();
  const { sendLinkCode, linkPhone } = useAuth();
  const [step, setStep] = React.useState("idle"); // idle | code
  // Seed from an existing profile/firm mobile — the profile is already loaded by
  // the time Settings is open, so a lazy initializer is enough (no effect needed).
  const [phone, setPhone] = React.useState(() => String(profile?.phone || profile?.firmMobile || "").replace(/\D/g, "").slice(-10));
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState("");
  const [editing, setEditing] = React.useState(false);

  const linked = Boolean(profile?.phoneVerified && profile?.phone);

  const send = async () => {
    const ten = phone.replace(/\D/g, "").slice(-10);
    if (!/^[6-9]\d{9}$/.test(ten)) { setErr("Enter a valid 10-digit mobile number."); return; }
    setErr(""); setBusy(true);
    try { await sendLinkCode("+91" + ten); setStep("code"); }
    catch (e) { setErr(e?.message || "Couldn't send the code."); }
    finally { setBusy(false); }
  };

  const verify = async () => {
    const ten = phone.replace(/\D/g, "").slice(-10);
    setErr(""); setBusy(true);
    try {
      const res = await linkPhone("+91" + ten, code);
      await setProfile({ phone: res?.phone || ("+91" + ten), phoneVerified: true });
      notify("Mobile number linked — you can now sign in with it");
      setStep("idle"); setEditing(false); setCode("");
    } catch (e) { setErr(e?.message || "That code didn't work."); }
    finally { setBusy(false); }
  };

  if (linked && !editing) {
    return (
      <KVRow label="Sign-in mobile" value={
        <span>{profile.phone} <span style={{ color: "#1B8C5C", fontWeight: 700 }}>· Verified</span>{" "}
          <button className="btn btn-ghost btn-xs" onClick={() => { setEditing(true); setStep("idle"); setCode(""); setErr(""); }}>Change</button>
        </span>
      }/>
    );
  }

  return (
    <div style={{ border: "1px dashed var(--p-line-2)", borderRadius: 12, padding: 12 }}>
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 2 }}>{editing ? "Change your sign-in mobile" : "Add your mobile for sign-in"}</div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        Verify your mobile once so you can sign in by SMS — and so phone and email both reach this same account.
      </div>
      {step === "idle" ? (
        <div className="center" style={{ gap: 8, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 6, flex: 1, minWidth: 180 }}>
            <div style={{ display: "grid", placeItems: "center", padding: "0 10px", borderRadius: 8, border: "1px solid var(--p-line-2)", background: "var(--p-card-tint)", fontSize: 13, fontWeight: 600 }}>+91</div>
            <input type="tel" inputMode="numeric" value={phone} placeholder="98250 11234" style={{ flex: 1 }} onChange={(e) => { setPhone(e.target.value.replace(/[^\d\s]/g, "")); setErr(""); }}/>
          </div>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={send}>{busy ? "Sending…" : "Send code"}</button>
          {editing && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setEditing(false); setErr(""); }}>Cancel</button>}
        </div>
      ) : (
        <div className="center" style={{ gap: 8, flexWrap: "wrap" }}>
          <input type="text" inputMode="numeric" maxLength={6} value={code} placeholder="6-digit code" style={{ flex: 1, minWidth: 130, letterSpacing: 4, textAlign: "center", fontWeight: 700 }} onChange={(e) => { setCode(e.target.value.replace(/\D/g, "")); setErr(""); }}/>
          <button className="btn btn-primary btn-sm" disabled={busy || code.length < 6} onClick={verify}>{busy ? "Verifying…" : "Verify & link"}</button>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setStep("idle"); setCode(""); }}>Back</button>
        </div>
      )}
      {err && <div style={{ marginTop: 8, color: "#B8463A", fontSize: 12 }}>{err}</div>}
    </div>
  );
}

/* ---- Google Calendar ----
   Connecting is a round trip through Google's consent screen, so this card is
   mostly about being honest while the user is away and after they come back:
   which account is syncing, when it last ran, and what to do when Google
   withdraws access. */

function CalendarSwitch({ name, sub, checked, onChange, disabled }) {
  return (
    <div className="between" style={{gap: 14, padding: "10px 0", borderTop: "1px solid var(--p-line-2)"}}>
      <div>
        <div style={{fontSize: 13.5, fontWeight: 650}}>{name}</div>
        <div className="muted" style={{fontSize: 12}}>{sub}</div>
      </div>
      <Toggle checked={checked} onChange={onChange} label={name} disabled={disabled}/>
    </div>
  );
}

function GoogleCalendarCard() {
  const { notify } = useData();
  const { user } = useAuth();
  const { cfg, loading, connected, needsReauth } = useCalendarConfig();
  const { connect, syncNow, disconnect, setOption, feedLink } = useCalendarActions();

  // Most practitioners sign in with the account they live in, so offer it —
  // but plenty keep the firm diary somewhere else, so this stays editable.
  // Settings only renders once the user is loaded, so the seed is never blank
  // by accident.
  const [email, setEmail] = React.useState(user?.email || "");
  const [busy, setBusy] = React.useState("");
  const [err, setErr] = React.useState("");
  const [feed, setFeed] = React.useState("");

  const run = async (label, fn) => {
    setBusy(label);
    setErr("");
    try { await fn(); }
    catch (e) { console.error(e); setErr(e?.message || "Something went wrong. Please try again."); }
    finally { setBusy(""); }
  };

  const startConnect = () => run("connect", async () => {
    const clean = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) throw new Error("Enter the Google account you want to sync.");
    await connect(clean); // navigates away to Google
  });

  const doSync = () => run("sync", async () => {
    const counts = await syncNow();
    const touched = (counts.created || 0) + (counts.updated || 0);
    notify(touched ? `Google Calendar updated — ${touched} event${touched === 1 ? "" : "s"}` : "Google Calendar already up to date");
  });

  const doDisconnect = () => {
    if (!window.confirm("Disconnect Google Calendar? Events already in Google stay there — delete the “ProHippo — Hearings” calendar yourself if you want them gone.")) return;
    run("disconnect", async () => { await disconnect(false); notify("Google Calendar disconnected"); });
  };

  const showFeed = () => run("feed", async () => setFeed(await feedLink(false)));
  const rotateFeed = () => run("feed", async () => { setFeed(await feedLink(true)); notify("Old calendar link disabled"); });

  const statusPill = loading ? <span className="pill pill-muted">Checking…</span>
    : needsReauth ? <span className="pill" style={{background: "var(--p-coral)", color: "#B8463A"}}>Access expired</span>
      : connected ? <span className="pill" style={{background: "var(--p-mint)", color: "#1B8C5C"}}>Connected</span>
        : <span className="pill pill-muted">Not connected</span>;

  return (
    <div className="card">
      <div className="between" style={{gap: 12, flexWrap: "wrap"}}>
        <div className="center" style={{gap: 12}}>
          <div style={{width: 42, height: 42, borderRadius: 12, background: "var(--p-card-tint)", color: "var(--p-primary)", display: "grid", placeItems: "center"}}>
            <Icon name="calendar" size={18}/>
          </div>
          <div>
            <div style={{fontWeight: 700, fontSize: 14}}>Google Calendar</div>
            <div className="muted" style={{fontSize: 12}}>
              {connected || needsReauth
                ? `${cfg?.email || "—"} · calendar “${cfg?.calendarSummary || "ProHippo — Hearings"}”`
                : "Push hearings and deadlines to your Google account"}
            </div>
          </div>
        </div>
        {statusPill}
      </div>

      {!loading && !connected && (
        <div style={{marginTop: 14}}>
          {needsReauth && (
            <div style={{marginBottom: 10, padding: "8px 12px", borderRadius: 10, background: "var(--p-coral)", color: "#B8463A", fontSize: 12.5}}>
              Google withdrew access, so syncing has stopped. Reconnect to start it again.
            </div>
          )}
          <div className="muted" style={{fontSize: 11.5, fontWeight: 700, marginBottom: 6}}>GOOGLE ACCOUNT TO SYNC</div>
          <div className="center" style={{gap: 8, flexWrap: "wrap"}}>
            <div style={{flex: 1, minWidth: 200}}>
              <TextInput value={email} onChange={setEmail} placeholder="you@yourfirm.in"/>
            </div>
            <button className="btn btn-primary" disabled={Boolean(busy)} onClick={startConnect}>
              <Icon name="link" size={14}/>{busy === "connect" ? "Opening Google…" : needsReauth ? "Reconnect" : "Connect Google Calendar"}
            </button>
          </div>
          <div className="muted" style={{fontSize: 12, marginTop: 8}}>
            You'll approve this on Google's own screen — ProHippo never sees your password. A Google Workspace address works too.
          </div>
        </div>
      )}

      {connected && (
        <div style={{marginTop: 8}}>
          <CalendarSwitch
            name="Sync automatically"
            sub="Every hearing you add, edit or delete updates Google within seconds"
            checked={cfg?.autoSync !== false}
            onChange={(v) => setOption({ autoSync: v })}
          />
          <CalendarSwitch
            name="Hearings"
            sub="ITAT, CIT(A), scrutiny and penalty hearings, at their listed time"
            checked={cfg?.syncHearings !== false}
            onChange={(v) => setOption({ syncHearings: v })}
          />
          <CalendarSwitch
            name="Deadlines"
            sub="Appeal limitation and notice reply dates, as all-day events"
            checked={cfg?.syncDeadlines !== false}
            onChange={(v) => setOption({ syncDeadlines: v })}
          />
          <CalendarSwitch
            name="Include client details in the event"
            sub={cfg?.includeClientDetails === false
              ? "Off — events read “ITAT hearing — AY 2017-18” with no client identity in Google"
              : "On — event titles carry the client's name, and the description their PAN and ITA number"}
            checked={cfg?.includeClientDetails !== false}
            onChange={(v) => setOption({ includeClientDetails: v })}
          />

          <div className="between" style={{marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--p-line-2)", gap: 10, flexWrap: "wrap"}}>
            <div className="muted" style={{fontSize: 12}}>
              Last synced {relativeSyncTime(cfg?.lastSyncAt)}
              {typeof cfg?.eventCount === "number" ? ` · ${cfg.eventCount} event${cfg.eventCount === 1 ? "" : "s"}` : ""}
            </div>
            <div className="row" style={{gap: 8}}>
              <button className="btn btn-secondary btn-sm" disabled={Boolean(busy)} onClick={doSync}>
                {busy === "sync" ? "Syncing…" : "Sync now"}
              </button>
              <button className="btn btn-ghost btn-sm" style={{color: "var(--p-danger)"}} disabled={Boolean(busy)} onClick={doDisconnect}>
                Disconnect
              </button>
            </div>
          </div>
        </div>
      )}

      {cfg?.lastError && connected && (
        <div className="muted" style={{marginTop: 8, fontSize: 12, color: "#B8463A"}}>Last sync problem: {cfg.lastError}</div>
      )}
      {err && <div style={{marginTop: 10, color: "#B8463A", fontSize: 12.5}}>{err}</div>}

      {/* The no-OAuth path. Slower to refresh, but it needs no permission at all
          and works in Apple Calendar and Outlook as well as Google. */}
      <div style={{marginTop: 14, paddingTop: 12, borderTop: "1px dashed var(--p-line-2)"}}>
        <div style={{fontSize: 13, fontWeight: 650}}>Subscribe from any calendar app</div>
        <div className="muted" style={{fontSize: 12, marginTop: 2}}>
          A read-only link for Google, Apple Calendar or Outlook. No sign-in needed — but calendar apps refresh it
          slowly, often only once or twice a day.
        </div>
        {feed ? (
          <div className="center" style={{gap: 8, marginTop: 8, flexWrap: "wrap"}}>
            <input readOnly value={feed} onFocus={(e) => e.target.select()} style={{flex: 1, minWidth: 220, fontSize: 12, fontFamily: "ui-monospace, monospace"}}/>
            <button className="btn btn-secondary btn-sm" onClick={() => { navigator.clipboard?.writeText(feed); notify("Calendar link copied"); }}>Copy</button>
            <button className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={rotateFeed} title="Disable the old link and make a new one">Reset link</button>
          </div>
        ) : (
          <button className="btn btn-secondary btn-sm" style={{marginTop: 8}} disabled={Boolean(busy)} onClick={showFeed}>
            {busy === "feed" ? "Preparing…" : "Show my calendar link"}
          </button>
        )}
      </div>
    </div>
  );
}


/* Reading red-flagged intimations without being asked.
 *
 * OFF UNTIL SOMEBODY TURNS IT ON, and the switch is here rather than buried on
 * the Intimations page because it is the only thing in that feature that spends
 * money on its own. What it costs is answerable — the admin console meters
 * automatic reads apart from manual ones — and turning it back off is this
 * toggle, not a deploy. */
/* Touch feedback, and an honest answer where it cannot happen.
 *
 * A toggle that controls nothing is worse than no toggle, so on a device with
 * no Vibration API this says so instead of pretending. That is most iPhones:
 * Apple has never shipped it, in Safari or in a standalone PWA. See
 * src/haptics.js for why the known workaround is not in here. */
function HapticsCard() {
  const { profile, setProfile, notify } = useData();
  const on = profile?.haptics !== false;
  const available = hapticsAvailable();
  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">Touch feedback</div>
      </div>
      <div className="muted" style={{fontSize: 12.5, lineHeight: 1.6}}>
        A short tick when you tap a control on a phone, and two when something saves or sends. Short enough to feel
        like a response rather than an alert — the longest is a third of a blink.
      </div>
      {available ? (
        <CalendarSwitch
          name="Vibrate on tap"
          sub={on ? "On — buttons, tabs and toasts answer back." : "Off — nothing vibrates."}
          checked={on}
          onChange={() => { setProfile({ haptics: !on }); notify(on ? "Touch feedback off" : "Touch feedback on"); }}
        />
      ) : (
        <div className="center" style={{gap: 8, padding: "9px 11px", background: "var(--p-card-tint)", borderRadius: 10, fontSize: 12, marginTop: 10}}>
          <Icon name="info" size={13}/>
          <span>
            This device can't vibrate from a web app. On iPhone that is Apple's decision, not a setting —
            iOS has never supported it in Safari or in an installed app. Everything still answers visually.
          </span>
        </div>
      )}
      <div className="muted" style={{fontSize: 11.5, marginTop: 8, lineHeight: 1.5}}>
        Off automatically if your phone is set to reduce motion.
      </div>
    </div>
  );
}

function AutoReadCard() {
  const { profile, setProfile, notify } = useData();
  const on = Boolean(profile?.autoReadIntimations);
  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">Read red-flagged intimations automatically</div>
      </div>
      <div className="muted" style={{fontSize: 12.5, lineHeight: 1.6}}>
        When CPC leaves an assessee materially worse off, read the order's comparison table without waiting to be
        asked — the same read the <b>Read the order</b> button makes. Everything else stays manual.
      </div>
      <div className="row" style={{gap: 6, flexWrap: "wrap", margin: "10px 0 4px"}}>
        <span className="pill pill-muted">Only where more is payable</span>
        <span className="pill pill-muted">Only over ₹1,000</span>
        <span className="pill pill-muted">Only orders under 14 months old</span>
        <span className="pill pill-muted">At most 50 a day</span>
      </div>
      <CalendarSwitch
        name="Automatic reads"
        sub={on
          ? "On — orders meeting all four conditions are read once, shortly after a sync."
          : "Off — nothing is read until you press the button on an order."}
        checked={on}
        onChange={() => { setProfile({ autoReadIntimations: !on }); notify(on ? "Automatic reads off" : "Automatic reads on"); }}
      />
      <div className="muted" style={{fontSize: 11.5, marginTop: 8, lineHeight: 1.5}}>
        A read costs a fraction of a rupee. Automatic ones are metered separately from the ones you ask for, so the
        Costs page answers what the automation is costing on its own.
      </div>
    </div>
  );
}

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
            <KVRow label="Signed in as" value={user?.email || user?.phoneNumber || "—"}/>
            <LinkMobileCard/>
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
      <div style={{marginBottom: 16}}><VoiceHelpLineCard/></div>
      <div style={{marginBottom: 16}}><GoogleCalendarCard/></div>
      <div style={{marginBottom: 16}}><AutoReadCard/></div>
      <div style={{marginBottom: 16}}><HapticsCard/></div>
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
