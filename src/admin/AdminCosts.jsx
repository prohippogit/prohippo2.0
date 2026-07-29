/*
 * Admin console — what ProHippo spends on outside APIs.
 *
 * Consolidated and per-account in one place, because that is the only way the
 * question "is this customer worth what they cost me" has an answer. Gemini,
 * 2Factor and Resend all write the same shape through functions/spend.js, so
 * the totals here are a sum rather than three vendor dashboards added up by
 * hand. Firebase is entered by hand each month — it isn't an API this app
 * calls, and a consolidated figure that quietly omits the hosting bill is not
 * consolidated.
 */
import React from "react";
import { orderBy, limit } from "firebase/firestore";
import { Icon, fmtDateLong, fmtDateTime, Modal, FormField, TextInput, SelectInput, EmptyState } from "../shared";
import { useCollection } from "./useCollection";
import {
  adminCostSummary,
  adminSetManualCost,
  adminRecentFailures,
  fmtInrMicroShort,
  VENDOR_LABEL,
  FEATURE_LABEL,
} from "./adminApi";

const TONE = { gemini: "primary", "2factor": "warning", resend: "info", firebase: "muted" };

function Tile({ label, value, sub, icon, tone = "primary" }) {
  const bg = { primary: "var(--p-lavender-2)", success: "var(--p-mint)", warning: "var(--p-amber)", danger: "var(--p-coral)" }[tone];
  return (
    <div className="stat">
      <div className="stat-icon" style={{ background: bg }}><Icon name={icon} size={17} /></div>
      <div style={{ minWidth: 0 }}>
        <div className="stat-label">{label}</div>
        <div className="stat-value" style={{ fontSize: 22 }}>{value}</div>
        {sub && <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>{sub}</div>}
      </div>
    </div>
  );
}

/* A plain proportional bar. The point of this table is ranking and share, and
   a bar communicates both without a charting library in the bundle. */
function Bars({ rows, total, labels }) {
  if (!rows.length) return <div className="muted" style={{ fontSize: 12.5, padding: "8px 2px" }}>Nothing recorded yet.</div>;
  return (
    <div className="col" style={{ gap: 10 }}>
      {rows.map(([key, v]) => {
        const pctOf = total > 0 ? Math.round((v.inrMicro / total) * 100) : 0;
        return (
          <div key={key}>
            <div className="between" style={{ fontSize: 12.5, marginBottom: 4 }}>
              <span style={{ fontWeight: 600 }}>{labels?.[key] || key}</span>
              <span className="muted">
                {fmtInrMicroShort(v.inrMicro)} · {v.calls.toLocaleString("en-IN")} calls
                {v.tokens ? ` · ${(v.tokens / 1000).toFixed(0)}k tok` : ""}
              </span>
            </div>
            <div style={{ height: 7, borderRadius: 4, background: "var(--p-line-2)", overflow: "hidden" }}>
              <div style={{ width: `${pctOf}%`, height: "100%", background: `var(--p-${TONE[key] === "muted" ? "text-3" : "primary"})`, borderRadius: 4 }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* Daily spend as a simple column chart — again, no library. */
function Sparkline({ series }) {
  if (!series.length) return null;
  const max = Math.max(...series.map((d) => d.inrMicro), 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 90, marginTop: 8 }}>
      {series.map((d) => (
        <div
          key={d.date}
          title={`${fmtDateLong(d.date)} — ${fmtInrMicroShort(d.inrMicro)} (${d.calls} calls${d.failures ? `, ${d.failures} failed` : ""})`}
          style={{
            flex: 1,
            minWidth: 3,
            height: `${Math.max(2, (d.inrMicro / max) * 100)}%`,
            background: d.failures > 0 ? "var(--p-danger)" : "var(--p-primary-3)",
            borderRadius: "3px 3px 0 0",
          }}
        />
      ))}
    </div>
  );
}

function ManualCostModal({ month, current, onClose, notify }) {
  const [vendor, setVendor] = React.useState("firebase");
  const [amount, setAmount] = React.useState(() => {
    const v = current?.[`firebase`]?.inrMicro;
    return v ? String(Math.round(v / 1e6)) : "";
  });
  const [note, setNote] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState(null);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      await adminSetManualCost({ month, vendor, amountInr: Number(amount), note });
      notify("Monthly cost saved");
      onClose(true);
    } catch (e) {
      setErr(e.message || "Could not save.");
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Enter a monthly invoice"
      sub={`For ${month}. Use this for costs the app can't meter itself.`}
      onClose={() => onClose(false)}
      width={480}
      footer={
        <>
          <button className="btn btn-ghost" onClick={() => onClose(false)}>Cancel</button>
          <button className="btn btn-primary" disabled={saving || !amount} onClick={save}>{saving ? "Saving…" : "Save"}</button>
        </>
      }
    >
      {err && <div className="mb-4" style={{ padding: "10px 12px", borderRadius: 10, background: "var(--p-coral)", color: "#B8463A", fontSize: 12.5 }}>{err}</div>}
      <div className="muted mb-4" style={{ fontSize: 12.5, lineHeight: 1.55 }}>
        Firebase isn't an API ProHippo calls, so there is no response to meter — Firestore reads, Storage and function
        invocations only appear on the monthly invoice. Type that figure in and it joins the same totals as everything else.
      </div>
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <FormField label="Vendor">
          <SelectInput value={vendor} onChange={setVendor} options={[{ value: "firebase", label: "Firebase" }, { value: "other", label: "Other" }]} />
        </FormField>
        <FormField label="Amount for the month (₹)">
          <TextInput type="number" value={amount} onChange={setAmount} placeholder="e.g. 2400" />
        </FormField>
        <FormField label="Note" full>
          <TextInput value={note} onChange={setNote} placeholder="e.g. Blaze invoice, incl. Storage" />
        </FormField>
      </div>
    </Modal>
  );
}

export default function AdminCosts({ notify, onOpenAccount }) {
  const [days, setDays] = React.useState(30);
  const [data, setData] = React.useState(null);
  const [err, setErr] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [failures, setFailures] = React.useState(null);
  const [manualOpen, setManualOpen] = React.useState(false);
  const [reload, setReload] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    adminCostSummary({ days })
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setErr(e.message || "Could not load costs."); setLoading(false); } });
    return () => { cancelled = true; };
  }, [days, reload]);

  React.useEffect(() => {
    let cancelled = false;
    adminRecentFailures().then((r) => { if (!cancelled) setFailures(r.rows); }).catch(() => {});
    return () => { cancelled = true; };
  }, [reload]);

  // Per-account spend rides along on the accounts documents, so the leaderboard
  // needs no extra query — the nightly rollup keeps last30 accurate and the
  // meter keeps it current within the day.
  const { rows: accounts } = useCollection("accounts", [orderBy("createdAt", "desc"), limit(500)], "accounts-costs");
  const top = [...accounts]
    .filter((a) => (a.spend?.last30InrMicro || a.spend?.mtdInrMicro || 0) > 0)
    .sort((a, b) => (b.spend?.last30InrMicro || 0) - (a.spend?.last30InrMicro || 0))
    .slice(0, 20);

  const sorted = (obj) => Object.entries(obj || {}).sort((a, b) => b[1].inrMicro - a[1].inrMicro);

  return (
    <div>
      <div className="topbar">
        <div>
          <div className="page-title">Costs</div>
          <div className="page-sub">What ProHippo spends on outside APIs</div>
        </div>
        <div className="topbar-actions">
          <select className="ph-select" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <button className="btn btn-secondary" onClick={() => setManualOpen(true)}>
            <Icon name="invoice" size={15} /> Monthly invoice
          </button>
        </div>
      </div>

      {err && (
        <div className="card mb-4" style={{ padding: 14, background: "var(--p-coral)", color: "#B8463A", fontSize: 13 }}>{err}</div>
      )}

      {data && !data.rates.verified && (
        <div className="card mb-4" style={{ padding: "12px 14px", background: "var(--p-amber)", border: "1px solid #E9B949", display: "flex", gap: 10, alignItems: "flex-start" }}>
          <Icon name="alert" size={16} />
          <div style={{ fontSize: 12.5, lineHeight: 1.55 }}>
            <b>These rates have not been verified.</b> Every figure below is computed from placeholder prices
            (<code>{data.rates.version}</code>). Put your real rates into <code>functions/pricing.js</code>, set
            <code> RATES_VERIFIED = true</code> and bump the version. Until then treat these as shape, not amount.
          </div>
        </div>
      )}

      <div className="grid mb-5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))" }}>
        <Tile label="Today" value={data ? fmtInrMicroShort(data.todayInrMicro) : "—"} icon="clock" />
        <Tile
          label="This month"
          value={data ? fmtInrMicroShort(data.consolidatedMtdInrMicro) : "—"}
          sub={data && data.manualInrMicro ? `incl. ${fmtInrMicroShort(data.manualInrMicro)} entered by hand` : "API spend only"}
          icon="wallet"
          tone="success"
        />
        <Tile label="Projected month-end" value={data ? fmtInrMicroShort(data.projectedInrMicro) : "—"} sub="Straight line from today" icon="trend-up" />
        <Tile
          label="Failed calls"
          value={data ? data.window.failures.toLocaleString("en-IN") : "—"}
          sub={data ? `of ${data.window.calls.toLocaleString("en-IN")} in ${days} days` : ""}
          icon="alert"
          tone={data && data.window.failures > 0 ? "danger" : "primary"}
        />
      </div>

      {data && data.window.unpriced > 0 && (
        <div className="card mb-4" style={{ padding: "10px 14px", fontSize: 12.5, background: "var(--p-coral)", color: "#B8463A" }}>
          <b>{data.window.unpriced}</b> calls had no rate in the price table and were counted as ₹0. Usually a model id
          that changed — add it to <code>GEMINI_RATES</code>.
        </div>
      )}

      {/* Resend Free costs nothing per message and then stops. The number that
          matters is volume against the allowance, and it has to be visible
          before the cliff rather than on the invoice after it. */}
      {data && (
        <div className="grid mb-5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Email allowance</div>
                <div className="card-sub">Resend {data.rates.resendPlan.name} · resets monthly</div>
              </div>
            </div>
            {(() => {
              const used = data.allowances.emailsThisMonth;
              const inc = data.allowances.emailIncluded;
              const pct = Math.min(100, Math.round((used / inc) * 100));
              const tone = pct >= 90 ? "danger" : pct >= 70 ? "warning" : "success";
              return (
                <>
                  <div className="between mb-2" style={{ alignItems: "baseline" }}>
                    <span style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.02em" }}>{used.toLocaleString("en-IN")}</span>
                    <span className="muted" style={{ fontSize: 12.5 }}>of {inc.toLocaleString("en-IN")} free</span>
                  </div>
                  <div style={{ height: 8, borderRadius: 4, background: "var(--p-line-2)", overflow: "hidden" }}>
                    <div style={{ width: `${pct}%`, height: "100%", background: `var(--p-${tone})`, borderRadius: 4 }} />
                  </div>
                  <div className="muted mt-2" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
                    {pct >= 70
                      ? `${pct}% used — the next step is Resend Pro at $20/month for 50,000.`
                      : `Also capped at ${data.allowances.emailDailyLimit}/day on Free. Marginal cost of a message today is ₹0.`}
                  </div>
                </>
              );
            })()}
          </div>

          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">SMS this month</div>
                <div className="card-sub">Prepaid credits · ₹{data.rates.smsInrPerSend} each</div>
              </div>
            </div>
            <div className="between mb-2" style={{ alignItems: "baseline" }}>
              <span style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.02em" }}>
                {data.allowances.smsThisMonth.toLocaleString("en-IN")}
              </span>
              <span className="muted" style={{ fontSize: 12.5 }}>
                {fmtInrMicroShort(data.allowances.smsThisMonth * data.rates.smsInrPerSend * 1e6)}
              </span>
            </div>
            <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
              Last pack: {data.rates.smsPack.credits.toLocaleString("en-IN")} credits for ₹
              {data.rates.smsPack.paidInr.toLocaleString("en-IN")} incl. GST. Only sends are billed —
              verification is free.
            </div>
          </div>
        </div>
      )}

      <div className="grid mb-5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
        <div className="card">
          <div className="card-head"><div className="card-title">By vendor</div></div>
          <Bars rows={sorted(data?.byVendor)} total={data?.window.inrMicro || 0} labels={VENDOR_LABEL} />
        </div>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">By model / SKU</div>
              <div className="card-sub">Escalations to the stronger model show up here</div>
            </div>
          </div>
          <Bars rows={sorted(data?.bySku)} total={data?.window.inrMicro || 0} />
        </div>
        <div className="card">
          <div className="card-head"><div className="card-title">By feature</div></div>
          <Bars rows={sorted(data?.byFeature)} total={data?.window.inrMicro || 0} labels={FEATURE_LABEL} />
        </div>
      </div>

      <div className="card mb-5">
        <div className="card-head">
          <div>
            <div className="card-title">Daily spend</div>
            <div className="card-sub">Red columns are days with failed calls · avg {data ? data.avgMs : "—"} ms per call</div>
          </div>
        </div>
        <Sparkline series={data?.series || []} />
      </div>

      <div className="card mb-5" style={{ padding: 0, overflow: "hidden" }}>
        <div className="card-head" style={{ padding: 16 }}>
          <div>
            <div className="card-title">Highest-cost accounts</div>
            <div className="card-sub">Last 30 days · click through to the account</div>
          </div>
        </div>
        {top.length === 0 ? (
          <EmptyState icon="users" title="No attributed spend yet" sub="Costs appear here as customers use AI parsing and client messaging." />
        ) : (
          <table className="tbl">
            <thead>
              <tr><th>Practice</th><th>Plan</th><th>Last 30 days</th><th>This month</th><th>Calls</th><th>Assessees</th></tr>
            </thead>
            <tbody>
              {top.map((a) => (
                <tr key={a.id} style={{ cursor: "pointer" }} onClick={() => onOpenAccount?.(a.id)}>
                  <td>
                    <div className="strong">{a.firmName || a.ownerName || "—"}</div>
                    <div className="muted">{a.email}</div>
                  </td>
                  <td className="semi" style={{ textTransform: "capitalize" }}>{a.plan || "—"}</td>
                  <td className="strong">{fmtInrMicroShort(a.spend?.last30InrMicro)}</td>
                  <td>{fmtInrMicroShort(a.spend?.mtdInrMicro)}</td>
                  <td className="muted">{a.spend?.last30Calls ?? "—"}</td>
                  <td className="muted">{a.counters?.assessees ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))" }}>
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div className="card-head" style={{ padding: 16 }}>
            <div>
              <div className="card-title">Recent failures</div>
              <div className="card-sub">A call that returned tokens and then failed still cost money</div>
            </div>
          </div>
          {!failures || failures.length === 0 ? (
            <EmptyState icon="check" title="No failures recorded" sub="Every metered call in the window succeeded." />
          ) : (
            <table className="tbl">
              <thead><tr><th>When</th><th>Vendor</th><th>Feature</th><th>Error</th><th>Cost</th></tr></thead>
              <tbody>
                {failures.slice(0, 15).map((f) => (
                  <tr key={f.id}>
                    <td className="muted" style={{ whiteSpace: "nowrap" }}>{fmtDateTime(f.at)}</td>
                    <td className="semi">{VENDOR_LABEL[f.vendor] || f.vendor}</td>
                    <td className="muted">{FEATURE_LABEL[f.feature] || f.feature}</td>
                    <td className="muted" style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.errorCode || "—"}</td>
                    <td>{fmtInrMicroShort(f.costMicroInr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <div className="card-head"><div className="card-title">Rates in force</div><div className="card-sub">All figures exclusive of GST</div></div>
          {data && (
            <div style={{ fontSize: 12.5 }}>
              <div className="between mb-2"><span className="muted">Version</span><b>{data.rates.version}</b></div>
              <div className="between mb-2"><span className="muted">USD → INR</span><b>{data.rates.usdInr}</b></div>
              {Object.entries(data.rates.gemini).map(([model, r]) => (
                <div className="between mb-2" key={model}>
                  <span className="muted" style={{ fontFamily: "ui-monospace, monospace", fontSize: 11 }}>{model}</span>
                  <b>${r.inUsdPerMTok} in / ${r.outUsdPerMTok} out per Mtok</b>
                </div>
              ))}
              <div className="between mb-2">
                <span className="muted">SMS per send</span>
                <b>₹{data.rates.smsInrPerSend}</b>
              </div>
              <div className="between mb-3">
                <span className="muted">Email plan</span>
                <b style={{ textTransform: "capitalize" }}>Resend {data.rates.resendPlan.name} — ₹0 / message</b>
              </div>
              {data.rates.notes.map((n, i) => (
                <div className="muted mt-2" key={i} style={{ fontSize: 11.5, lineHeight: 1.5 }}>{n}</div>
              ))}
              <div className="muted mt-2" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
                Reconcile against the real invoices monthly — a hand-kept rate table drifts.
              </div>
            </div>
          )}
        </div>
      </div>

      {loading && !data && <div className="muted mt-4" style={{ fontSize: 13 }}>Loading…</div>}

      {manualOpen && (
        <ManualCostModal
          month={data?.manual.month || new Date().toISOString().slice(0, 7)}
          current={data?.manual.byVendor}
          notify={notify}
          onClose={(saved) => { setManualOpen(false); if (saved) setReload((n) => n + 1); }}
        />
      )}
    </div>
  );
}
