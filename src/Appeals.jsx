/* ProHippo — Appeals workspace.
 *
 * A separate page that turns every appealable order already on file into a
 * prepared appeal: a live filing-deadline countdown (with the date math shown),
 * the applicable statutory regime & form, the fee, a document checklist, and a
 * pre-filled Form 35/36 (→ 99/115) worksheet. Fully deterministic — no AI.
 */
import React from 'react';
import { Icon, EmptyState, titleCase, fmtDateLong, fmtINR } from './shared';
import { useData } from './store';
import { appealableOrders, checklistFor, appealFee, FEE_SLABS } from './appeals';

const URG = {
  red: { bg: "var(--p-coral)", fg: "var(--p-danger)", pill: "danger", lbl: "days left" },
  amber: { bg: "var(--p-amber)", fg: "#B07512", pill: "warning", lbl: "days left" },
  green: { bg: "var(--p-mint)", fg: "#1B8C5C", pill: "success", lbl: "days left" },
  lapsed: { bg: "var(--p-card-tint)", fg: "var(--p-text-3)", pill: "muted", lbl: "days overdue" },
  none: { bg: "var(--p-card-tint)", fg: "var(--p-text-3)", pill: "muted", lbl: "" },
};

const STYLE = `
.ap-grid { display: grid; grid-template-columns: minmax(0, 380px) minmax(0, 1fr); gap: 20px; align-items: start; }
@media (max-width: 900px) { .ap-grid { grid-template-columns: 1fr; } }
.ap-order { text-align: left; width: 100%; background: var(--p-card); border: 1px solid var(--p-line); border-left: 4px solid var(--p-text-3); border-radius: var(--radius); padding: 13px 14px; box-shadow: var(--p-shadow-sm); cursor: pointer; transition: box-shadow .15s, transform .15s, border-color .15s; }
.ap-order:hover { box-shadow: var(--p-shadow); transform: translateY(-1px); }
.ap-order.sel { border-color: var(--p-primary-3); box-shadow: var(--p-shadow); background: var(--p-card-tint); }
.ap-count { text-align: center; padding: 14px 18px; border-radius: var(--radius); min-width: 120px; }
.ap-count .big { font-size: 40px; font-weight: 800; line-height: 1; letter-spacing: -0.03em; }
.ap-count .lbl { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; margin-top: 6px; font-weight: 700; }
.ap-frow { display: grid; grid-template-columns: 190px 1fr; border-top: 1px solid var(--p-line-2); font-size: 12.5px; }
@media (max-width: 540px) { .ap-frow { grid-template-columns: 128px 1fr; } }
.ap-frow .k { padding: 7px 11px; color: var(--p-text-3); background: var(--p-card-tint); border-right: 1px solid var(--p-line-2); }
.ap-frow .v { padding: 7px 11px; font-weight: 600; }
.ap-toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; }
.ap-toolbar .search { flex: 1; min-width: 200px; }
.ap-sort { font-family: inherit; font-size: 12.5px; color: var(--p-text-2); background: var(--p-card); border: 1px solid var(--p-line-2); border-radius: 10px; padding: 8px 10px; }
.ap-head { display: flex; align-items: baseline; gap: 10px; }
.ap-head .ap-name { flex: 1; min-width: 0; font-weight: 700; font-size: 14.5px; letter-spacing: -0.01em; overflow-wrap: anywhere; }
.ap-head .pill { flex-shrink: 0; white-space: nowrap; }
.ap-sub { font-size: 12px; margin-top: 3px; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ap-subject { overflow-wrap: anywhere; min-width: 0; }
`;

const SORTS = {
  deadline: { label: "Deadline — soonest first", fn: (a, b) => (a.daysLeft == null ? 1e9 : a.daysLeft) - (b.daysLeft == null ? 1e9 : b.daysLeft) },
  orderNew: { label: "Order date — newest first", fn: (a, b) => (b.notice.date || "").localeCompare(a.notice.date || "") },
  orderOld: { label: "Order date — oldest first", fn: (a, b) => (a.notice.date || "").localeCompare(b.notice.date || "") },
  name: { label: "Assessee — A to Z", fn: (a, b) => titleCase(a.notice.assessee || "").localeCompare(titleCase(b.notice.assessee || "")) },
};

function matchesQuery(o, q) {
  if (!q) return true;
  const n = o.notice;
  return [n.assessee, n.pan, n.ay, n.section, n.subject, o.route]
    .some((f) => String(f || "").toLowerCase().includes(q));
}

export default function Appeals({ onOpenNotice }) {
  const { data } = useData();
  const [selId, setSelId] = React.useState(null);
  const [query, setQuery] = React.useState("");
  const [sortBy, setSortBy] = React.useState("deadline");
  const [forum, setForum] = React.useState("All");
  const [showAll, setShowAll] = React.useState(false); // include orders older than 365 days

  const orders = React.useMemo(
    () => appealableOrders(data, { withinDays: showAll ? null : 365 }),
    [data, showAll]
  );
  // How many are hidden purely by the 365-day cutoff (offer to reveal them).
  const totalUnbounded = React.useMemo(() => appealableOrders(data, { withinDays: null }).length, [data]);
  const hiddenOlder = Math.max(0, totalUnbounded - orders.length);

  const q = query.trim().toLowerCase();
  const view = React.useMemo(
    () => orders
      .filter((o) => forum === "All" || o.route === forum)
      .filter((o) => matchesQuery(o, q))
      .sort(SORTS[sortBy].fn),
    [orders, forum, q, sortBy]
  );

  const selected = view.find((o) => o.notice.id === selId) || view[0] || null;

  const soon = orders.filter((o) => o.daysLeft != null && o.daysLeft >= 0 && o.daysLeft <= 15).length;
  const lapsed = orders.filter((o) => o.daysLeft != null && o.daysLeft < 0).length;

  return (
    <div className="animate-in">
      <style>{STYLE}</style>
      <div className="topbar">
        <div>
          <div className="page-title">Appeals</div>
          <div className="page-sub">
            {orders.length
              ? <>{orders.length} appealable order{orders.length !== 1 ? "s" : ""}{showAll ? " (all)" : " in the last 365 days"} · <b style={{color: "var(--p-primary-2)"}}>{soon} within 15 days</b>{lapsed ? <> · <b style={{color: "var(--p-danger)"}}>{lapsed} lapsed</b></> : ""}</>
              : showAll ? "No appealable orders on file." : "No appealable orders in the last 365 days."}
          </div>
        </div>
      </div>

      <div className="ap-toolbar">
        <div className="search">
          <Icon name="search" size={16}/>
          <input placeholder="Search assessee, PAN, AY, section…" value={query} onChange={(e) => setQuery(e.target.value)}/>
        </div>
        <div className="row" style={{gap: 6}}>
          {["All", "CIT(A)", "ITAT"].map((f) => (
            <span key={f} className={`fchip ${forum === f ? "active" : ""}`} onClick={() => setForum(f)}>{f}</span>
          ))}
        </div>
        <select className="ap-sort" value={sortBy} onChange={(e) => setSortBy(e.target.value)} title="Sort by">
          {Object.entries(SORTS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
        </select>
        <span
          className={`fchip ${showAll ? "active" : ""}`}
          onClick={() => setShowAll((v) => !v)}
          title="Include orders older than 365 days"
        >
          {showAll ? "Last 365 days" : "Show all dates"}
        </span>
      </div>

      {view.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="gavel"
            title={q || forum !== "All" ? "No orders match your filters" : "Nothing awaiting an appeal"}
            sub={
              q || forum !== "All"
                ? "Clear the search or forum filter to see all appealable orders."
                : hiddenOlder > 0 && !showAll
                  ? `No orders in the last 365 days. ${hiddenOlder} older order${hiddenOlder !== 1 ? "s are" : " is"} hidden.`
                  : "When an assessment, penalty or CIT(A) order is on file and not yet appealed, it appears here with its filing deadline, fee, checklist and a pre-filled form worksheet."
            }
            action={hiddenOlder > 0 && !showAll && !q && forum === "All"
              ? <button className="btn btn-secondary" onClick={() => setShowAll(true)}>Show {hiddenOlder} older order{hiddenOlder !== 1 ? "s" : ""}</button>
              : undefined}
          />
        </div>
      ) : (
        <div className="ap-grid">
          <div className="col" style={{gap: 12}}>
            <div className="between" style={{padding: "2px 2px"}}>
              <span className="muted" style={{fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em"}}>
                {view.length} order{view.length !== 1 ? "s" : ""} · {SORTS[sortBy].label.split(" — ")[0]}
              </span>
            </div>
            {view.map((o) => (
              <OrderCard key={o.notice.id} o={o} selected={selected?.notice.id === o.notice.id} onClick={() => setSelId(o.notice.id)}/>
            ))}
            {!showAll && hiddenOlder > 0 && (
              <button className="btn btn-ghost btn-sm" style={{alignSelf: "flex-start"}} onClick={() => setShowAll(true)}>
                Show {hiddenOlder} older order{hiddenOlder !== 1 ? "s" : ""} (beyond 365 days)
              </button>
            )}
          </div>
          {selected && <Workspace key={selected.notice.id} x={selected} allNotices={data.notices} onOpenNotice={onOpenNotice}/>}
        </div>
      )}
    </div>
  );
}

function OrderCard({ o, selected, onClick }) {
  const u = URG[o.urgency];
  const n = o.notice;
  const pillTxt = o.daysLeft == null ? "no date"
    : o.daysLeft < 0 ? `${Math.abs(o.daysLeft)}d over` : `${o.daysLeft}d left`;
  return (
    <button
      type="button"
      className={`ap-order ${selected ? "sel" : ""}`}
      style={{borderLeftColor: u.fg}}
      onClick={onClick}
    >
      <div className="ap-head">
        <span className="ap-name">{titleCase(n.assessee || "—")}</span>
        <span className={`pill pill-${u.pill}`}><span className="pill-dot" style={{background: "currentColor"}}/>{pillTxt}</span>
      </div>
      <div className="ap-sub muted">
        AY {n.ay || "—"} · {n.subject || `Order u/s ${n.section || "—"}`}
      </div>
      <div className="center" style={{gap: 8, marginTop: 10, flexWrap: "wrap", justifyContent: "flex-start"}}>
        <span className="pill pill-primary">Appeal to {o.route}</span>
        <span className="pill pill-muted">{o.reg.act} · {o.form}</span>
        {o.deadline && <span className="muted" style={{marginLeft: "auto", fontSize: 11.5, fontVariantNumeric: "tabular-nums"}}>due {fmtDateLong(o.deadline)}</span>}
      </div>
    </button>
  );
}

function Workspace({ x, allNotices, onOpenNotice }) {
  const { updateNotice, notify } = useData();
  const n = x.notice;
  const u = URG[x.urgency];
  const reg = x.reg;

  // Workspace is keyed by notice id in the parent, so this initialises fresh
  // for each order — no effect needed to resync when the selection changes.
  const [incomeText, setIncomeText] = React.useState(n.assessedIncome != null ? String(n.assessedIncome) : "");

  const income = incomeText.trim() === "" ? null : Number(incomeText.replace(/[^\d]/g, "")) || null;
  const fee = appealFee(x.route, income);

  const items = checklistFor(x, allNotices);
  const ticks = n.appealChecklist || {};
  const isDone = (it) => it.auto || Boolean(ticks[it.key]);
  const doneCount = items.filter(isDone).length;

  const toggle = (it) => {
    if (it.auto) return;
    updateNotice(n.id, { appealChecklist: { ...ticks, [it.key]: !ticks[it.key] } });
  };
  const saveServed = (v) => { if (v) updateNotice(n.id, { appealServedDate: v }); };
  const saveIncome = () => {
    const val = incomeText.trim() === "" ? null : Number(incomeText.replace(/[^\d]/g, "")) || null;
    updateNotice(n.id, { assessedIncome: val });
  };
  const markFiled = () => { updateNotice(n.id, { appealStatus: "filed" }); notify("Marked as filed — removed from the appeals list"); };
  const dismiss = () => { updateNotice(n.id, { appealStatus: "dismissed" }); notify("Dismissed from the appeals list"); };

  return (
    <div className="card" style={{padding: 0, overflow: "hidden"}}>
      <div style={{padding: "18px 20px", background: "var(--p-card-tint)", borderBottom: "1px solid var(--p-line)"}}>
        <div className="between" style={{gap: 10, alignItems: "flex-start"}}>
          <div style={{fontSize: 18, fontWeight: 800, letterSpacing: "-0.02em"}}>{titleCase(n.assessee || "—")}</div>
          <span className="pill pill-primary">Appeal to {x.route}</span>
        </div>
        <div className="muted" style={{fontSize: 12.5, marginTop: 4, display: "flex", gap: 14, flexWrap: "wrap"}}>
          <span>PAN <b style={{color: "var(--p-text-2)"}}>{n.pan || "—"}</b></span>
          <span>AY <b style={{color: "var(--p-text-2)"}}>{n.ay || "—"}</b></span>
          <span className="ap-subject">{n.subject || `Order u/s ${n.section || "—"}`}</span>
          {n.din && <span>DIN …{String(n.din).slice(-6)}</span>}
        </div>
      </div>

      <div className="col" style={{gap: 16, padding: "18px 20px 22px"}}>

        {/* Deadline */}
        <div className="card" style={{background: "var(--p-card-tint)"}}>
          <div className="center" style={{gap: 9, marginBottom: 13, justifyContent: "flex-start"}}>
            <span style={{width: 28, height: 28, borderRadius: 9, background: "var(--p-lavender-2)", color: "var(--p-primary-2)", display: "grid", placeItems: "center"}}><Icon name="clock" size={15}/></span>
            <div className="card-title" style={{fontSize: 14}}>Filing deadline — appeal to {x.route}</div>
            <span className="muted" style={{marginLeft: "auto", fontSize: 11.5}}>{reg.act} · {x.form}</span>
          </div>
          <div className="row" style={{gap: 16, alignItems: "center", flexWrap: "wrap"}}>
            <div className="ap-count" style={{background: u.bg, color: u.fg}}>
              <div className="big" style={{fontVariantNumeric: "tabular-nums"}}>{x.daysLeft == null ? "—" : Math.abs(x.daysLeft)}</div>
              <div className="lbl">{u.lbl || "no date"}</div>
            </div>
            <div style={{flex: 1, minWidth: 220, fontSize: 13, color: "var(--p-text-2)"}}>
              <Row k={`Order ${x.servedField}`} v={x.served ? fmtDateLong(x.served) : "—"}/>
              <Row k="Limitation" v={x.limitLabel || "—"}/>
              <Row k="Last date to file" v={x.deadline ? fmtDateLong(x.deadline) : "—"} strong/>
              {x.route === "ITAT" && !reg.newAct && x.served && (
                <div style={{fontSize: 11.5, color: "var(--p-text-3)", marginTop: 8, fontStyle: "italic"}}>
                  For AY 2026-27+ (Act 2025) this becomes 2 months from the end of the month of communication → {fmtDateLong(endOfMonth2(x.served))}.
                </div>
              )}
              {x.urgency === "lapsed" && (
                <div style={{fontSize: 12, color: "var(--p-danger)", fontWeight: 600, marginTop: 8}}>
                  Limitation lapsed — a condonation-of-delay application is required.
                </div>
              )}
              <div className="center" style={{gap: 8, marginTop: 12, justifyContent: "flex-start", flexWrap: "wrap"}}>
                <label className="muted" style={{fontSize: 12, fontWeight: 600}}>Actual {x.servedField} date</label>
                <input
                  type="date"
                  defaultValue={x.served || ""}
                  onChange={(e) => saveServed(e.target.value)}
                  style={{fontSize: 12.5, padding: "6px 9px", border: "1px solid var(--p-line-2)", borderRadius: 9, background: "white", color: "var(--p-text)"}}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Fee & challan */}
        <div className="card">
          <div className="center" style={{gap: 9, marginBottom: 13, justifyContent: "flex-start"}}>
            <span style={{width: 28, height: 28, borderRadius: 9, background: "var(--p-lavender-2)", color: "var(--p-primary-2)", display: "grid", placeItems: "center", fontWeight: 800}}>₹</span>
            <div className="card-title" style={{fontSize: 14}}>Appeal fee &amp; challan</div>
            <span className="muted" style={{marginLeft: "auto", fontSize: 11.5}}>Major Head 0021 · ITNS 280</span>
          </div>
          <div className="row" style={{gap: 20, flexWrap: "wrap", alignItems: "flex-start"}}>
            <div style={{minWidth: 160}}>
              <div style={{fontSize: 26, fontWeight: 800, letterSpacing: "-0.02em"}}>{fee == null ? "—" : fmtINR(fee)}</div>
              <div className="center" style={{gap: 6, marginTop: 6, justifyContent: "flex-start"}}>
                <label className="muted" style={{fontSize: 12}}>Assessed income</label>
                <input
                  value={incomeText}
                  onChange={(e) => setIncomeText(e.target.value)}
                  onBlur={saveIncome}
                  placeholder="e.g. 480000"
                  inputMode="numeric"
                  style={{width: 120, fontSize: 12.5, padding: "6px 9px", border: "1px solid var(--p-line-2)", borderRadius: 9, background: "white", color: "var(--p-text)"}}
                />
              </div>
              <div className="col" style={{gap: 3, marginTop: 10}}>
                {FEE_SLABS[x.route].map(([band, amt], i) => {
                  const hit = income != null && slabHit(x.route, income, i);
                  return (
                    <div key={band} style={{fontSize: 11.5, color: hit ? "var(--p-primary-2)" : "var(--p-text-3)", fontWeight: hit ? 700 : 400}}>
                      {band} → {amt}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="col" style={{gap: 5, fontSize: 12.5, color: "var(--p-text-2)"}}>
              <div><span className="muted">PAN</span> {n.pan || "—"}</div>
              <div><span className="muted">Assessment year</span> {n.ay || "—"}</div>
              <div><span className="muted">Type of payment</span> Fee / Other Receipts</div>
            </div>
          </div>
        </div>

        {/* Checklist */}
        <div className="card">
          <div className="center" style={{gap: 9, marginBottom: 12, justifyContent: "flex-start"}}>
            <span style={{width: 28, height: 28, borderRadius: 9, background: "var(--p-lavender-2)", color: "var(--p-primary-2)", display: "grid", placeItems: "center"}}><Icon name="check" size={15}/></span>
            <div className="card-title" style={{fontSize: 14}}>Document checklist</div>
            <span className="muted" style={{marginLeft: "auto", fontSize: 11.5}}>{doneCount} / {items.length} ready</span>
          </div>
          <div className="col" style={{gap: 0}}>
            {items.map((it) => {
              const done = isDone(it);
              return (
                <div key={it.key} className="center" style={{gap: 11, padding: "9px 0", borderTop: "1px solid var(--p-line-2)", justifyContent: "flex-start"}}>
                  <div
                    onClick={() => toggle(it)}
                    role={it.auto ? undefined : "checkbox"}
                    aria-checked={done}
                    tabIndex={it.auto ? undefined : 0}
                    onKeyDown={(e) => { if (!it.auto && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggle(it); } }}
                    style={{width: 19, height: 19, borderRadius: 6, flexShrink: 0, display: "grid", placeItems: "center", cursor: it.auto ? "default" : "pointer",
                      background: it.auto ? "var(--p-primary)" : done ? "var(--p-success)" : "white",
                      border: `1.5px solid ${it.auto ? "var(--p-primary)" : done ? "var(--p-success)" : "var(--p-line)"}`, color: "white"}}
                  >
                    {done && <Icon name="check" size={12} stroke={3}/>}
                  </div>
                  <span style={{flex: 1, fontSize: 13, color: done ? "var(--p-text-2)" : "var(--p-text)"}}>
                    {it.label}
                    {it.auto && <span className="pill pill-primary" style={{marginLeft: 8, fontSize: 10, padding: "1px 7px"}}>on file</span>}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Mock form */}
        <div className="card">
          <div className="center" style={{gap: 9, marginBottom: 12, justifyContent: "flex-start"}}>
            <span style={{width: 28, height: 28, borderRadius: 9, background: "var(--p-lavender-2)", color: "var(--p-primary-2)", display: "grid", placeItems: "center"}}><Icon name="doc" size={15}/></span>
            <div className="card-title" style={{fontSize: 14}}>{x.form} worksheet — pre-filled</div>
            <span className="muted" style={{marginLeft: "auto", fontSize: 11.5}}>preview</span>
          </div>
          <div style={{border: "1px solid var(--p-line-2)", borderRadius: 10, overflow: "hidden"}}>
            <div style={{background: "var(--p-lavender-2)", color: "var(--p-primary-2)", fontWeight: 700, textAlign: "center", padding: 8, fontSize: 12}}>
              {x.form.toUpperCase()} · {x.route} · AY {n.ay || "—"}
            </div>
            {mockRows(x, n, fee).map(([k, v]) => (
              <div key={k} className="ap-frow"><div className="k">{k}</div><div className="v">{v}</div></div>
            ))}
            <div style={{textAlign: "center", fontSize: 10.5, color: "var(--p-text-3)", padding: 8, background: "var(--p-card-tint)", borderTop: "1px solid var(--p-line-2)"}}>
              Worksheet from records on file — verify and e-file on the income-tax portal with DSC. Not a substitute for the portal form.
            </div>
          </div>
        </div>

        {/* Drafting — planned, not built */}
        <div className="center" style={{gap: 11, justifyContent: "flex-start", border: "1px dashed var(--p-line-2)", borderRadius: "var(--radius)", padding: "13px 15px", background: "var(--p-card-tint)"}}>
          <span style={{width: 30, height: 30, borderRadius: 9, background: "var(--p-line)", color: "var(--p-text-3)", display: "grid", placeItems: "center", flexShrink: 0}}><Icon name="edit" size={15}/></span>
          <div style={{flex: 1}}>
            <div style={{fontSize: 13.5, fontWeight: 700}}>Draft Grounds of Appeal &amp; Statement of Facts → Word</div>
            <div className="muted" style={{fontSize: 12, marginTop: 2}}>Where drafting will slot in later. Not part of this build.</div>
          </div>
          <span className="pill pill-muted">Planned</span>
        </div>

        {/* Actions */}
        <div className="row" style={{gap: 10, flexWrap: "wrap"}}>
          {onOpenNotice && <button className="btn btn-secondary" onClick={() => onOpenNotice(n)}><Icon name="doc" size={14}/>Open the order</button>}
          <button className="btn btn-secondary" onClick={markFiled}><Icon name="check" size={14}/>Mark appeal filed</button>
          <button className="btn btn-ghost" onClick={dismiss}>Dismiss</button>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v, strong }) {
  return (
    <div className="between" style={{padding: "5px 0", borderBottom: "1px dashed var(--p-line-2)", gap: 12}}>
      <span className="muted" style={{fontSize: 12.5}}>{k}</span>
      <span style={{fontWeight: strong ? 800 : 600, color: "var(--p-text)", fontVariantNumeric: "tabular-nums", textAlign: "right"}}>{v}</span>
    </div>
  );
}

// last day of month, 2 months on — the Act-2025 ITAT computation (for the note).
function endOfMonth2(iso) {
  const d = new Date(iso + "T00:00:00");
  const e = new Date(d.getFullYear(), d.getMonth() + 3, 0);
  return `${e.getFullYear()}-${String(e.getMonth() + 1).padStart(2, "0")}-${String(e.getDate()).padStart(2, "0")}`;
}

function slabHit(route, inc, i) {
  const bands = route === "CIT(A)"
    ? [inc <= 100000, inc > 100000 && inc <= 200000, inc > 200000]
    : [inc <= 100000, inc > 100000 && inc <= 200000, inc > 200000];
  return bands[i];
}

function mockRows(x, n, fee) {
  const forumLine = x.route === "CIT(A)" ? "Appeal to Commissioner (Appeals)" : "Appeal to the Appellate Tribunal";
  return [
    ["Form", `${x.form} — ${forumLine}`],
    ["Name of the appellant", titleCase(n.assessee || "—")],
    ["PAN", n.pan || "—"],
    ["Assessment year", n.ay || "—"],
    ["Order appealed against", n.subject || `Order u/s ${n.section || "—"}`],
    [x.route === "ITAT" ? "Date of communication of order" : "Date of service of order", x.served ? fmtDateLong(x.served) : "—"],
    ["Section", n.section || "—"],
    ["Total income assessed", n.assessedIncome != null ? fmtINR(n.assessedIncome) : "—"],
    [x.route === "ITAT" ? "Tribunal fee" : "Appeal filing fee", fee == null ? "—" : fmtINR(fee)],
    ["Last date for filing", x.deadline ? fmtDateLong(x.deadline) : "—"],
  ];
}
