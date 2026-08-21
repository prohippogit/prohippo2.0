/* ProHippo — Appeals workspace.
 *
 * A separate page that turns every appealable order already on file into a
 * prepared appeal: a live filing-deadline countdown (with the date math shown),
 * the applicable statutory regime & form, the fee, a document checklist, and a
 * pre-filled Form 35/36 (→ 99/115) worksheet. Fully deterministic — no AI.
 */
import React from 'react';
import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';
import { downloadFromStorage } from './downloadFile';
import { noticeFilename } from './downloadNames';
import { Icon, EmptyState, titleCase, fmtDateLong, fmtINR } from './shared';
import { useData } from './store';
import { appealableOrders, checklistFor, appealFee, FEE_SLABS, PENALTY_FEE, orderDocType, DOC_TYPE_LABEL } from './appeals';

// Save an order's PDF to the user's computer. This used to be a local copy of
// the same eight lines the Notices and Assessees pages kept — deliberately
// duplicated, because sharing them was not worth coupling the pages. Naming the
// file properly changed that calculus: the naming rules have to agree across
// every screen or the same order downloads under two different names.
async function downloadOrder(notice) {
  if (!notice?.storagePath) return;
  try {
    await downloadFromStorage(notice.storagePath, noticeFilename(notice, notice.assessee));
  } catch (e) {
    console.error("download order pdf", e);
  }
}

const URG = {
  red: { bg: "var(--p-coral)", fg: "var(--p-danger)", pill: "danger", lbl: "days left" },
  amber: { bg: "var(--p-amber)", fg: "#B07512", pill: "warning", lbl: "days left" },
  green: { bg: "var(--p-mint)", fg: "#1B8C5C", pill: "success", lbl: "days left" },
  lapsed: { bg: "var(--p-card-tint)", fg: "var(--p-text-3)", pill: "muted", lbl: "days overdue" },
  none: { bg: "var(--p-card-tint)", fg: "var(--p-text-3)", pill: "muted", lbl: "" },
};

const STYLE = `
/* One full-width row per order: a large countdown on the left, the order it
   arises from in the middle, and the detail expanding underneath on click. */
.ap-row { background: var(--p-card); border: 1px solid var(--p-line); border-radius: var(--radius); box-shadow: var(--p-shadow-sm); overflow: hidden; transition: box-shadow .15s, border-color .15s; }
.ap-row.open { border-color: var(--p-primary-3); box-shadow: var(--p-shadow); }
.ap-rowhead { display: grid; grid-template-columns: 96px minmax(0, 1fr) auto; gap: 16px; align-items: center; width: 100%; text-align: left; background: none; border: 0; padding: 14px 16px; cursor: pointer; font: inherit; color: inherit; }
.ap-rowhead:hover { background: var(--p-card-tint); }
@media (max-width: 720px) {
  .ap-rowhead { grid-template-columns: 74px minmax(0, 1fr); gap: 12px; }
  .ap-rowhead .ap-due { grid-column: 2; text-align: left; }
}
.ap-count { text-align: center; padding: 12px 8px; border-radius: 14px; }
.ap-count .big { font-size: 34px; font-weight: 800; line-height: 1; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
.ap-count .lbl { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.06em; margin-top: 4px; font-weight: 800; }
.ap-name { font-weight: 800; font-size: 15px; letter-spacing: -0.01em; overflow-wrap: anywhere; }
.ap-meta { font-size: 12px; margin-top: 3px; color: var(--p-text-3); overflow-wrap: anywhere; }
.ap-tags { display: flex; gap: 6px; margin-top: 7px; flex-wrap: wrap; }
.ap-due { text-align: right; font-size: 12.5px; white-space: nowrap; }
.ap-body { border-top: 1px solid var(--p-line-2); padding: 16px; background: var(--p-card-tint); }
.ap-frow { display: grid; grid-template-columns: 190px 1fr; border-top: 1px solid var(--p-line-2); font-size: 12.5px; }
@media (max-width: 540px) { .ap-frow { grid-template-columns: 128px 1fr; } }
.ap-frow .k { padding: 7px 11px; color: var(--p-text-3); background: var(--p-card-tint); border-right: 1px solid var(--p-line-2); }
.ap-frow .v { padding: 7px 11px; font-weight: 600; }
.ap-toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; }
.ap-toolbar .search { flex: 1; min-width: 200px; }
.ap-sort { font-family: inherit; font-size: 12.5px; color: var(--p-text-2); background: var(--p-card); border: 1px solid var(--p-line-2); border-radius: 10px; padding: 8px 10px; }
.ap-subject { overflow-wrap: anywhere; min-width: 0; }
/* The two limitation computations, shown side by side — see appeals.js. */
.ap-basis { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
@media (max-width: 620px) { .ap-basis { grid-template-columns: 1fr; } }
.ap-basis .b { padding: 9px 11px; border-radius: 11px; border: 1px solid var(--p-line-2); background: white; }
.ap-basis .b.on { border-color: var(--p-primary-3); background: var(--p-lavender-2); }
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
  // Which row is expanded. Nothing is open on arrival: the list is the page, and
  // auto-opening the first row buries the rest under a long detail panel.
  const [openId, setOpenId] = React.useState(null);
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
        <div className="col" style={{gap: 10}}>
          <div className="between" style={{padding: "2px 2px"}}>
            <span className="muted" style={{fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em"}}>
              {view.length} order{view.length !== 1 ? "s" : ""} · {SORTS[sortBy].label.split(" — ")[0]}
            </span>
          </div>
          {view.map((o) => (
            <OrderRow
              key={o.notice.id}
              o={o}
              open={openId === o.notice.id}
              onToggle={() => setOpenId(openId === o.notice.id ? null : o.notice.id)}
              allNotices={data.notices}
              onOpenNotice={onOpenNotice}
            />
          ))}
          {!showAll && hiddenOlder > 0 && (
            <button className="btn btn-ghost btn-sm" style={{alignSelf: "flex-start"}} onClick={() => setShowAll(true)}>
              Show {hiddenOlder} older order{hiddenOlder !== 1 ? "s" : ""} (beyond 365 days)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* A single order in the list. The head is always visible; the workspace mounts
   only while expanded, so a long list stays cheap. */
function OrderRow({ o, open, onToggle, allNotices, onOpenNotice }) {
  const u = URG[o.urgency];
  const n = o.notice;
  const docType = orderDocType(n);
  return (
    <div className={`ap-row ${open ? "open" : ""}`}>
      <button type="button" className="ap-rowhead" onClick={onToggle} aria-expanded={open}>
        <div className="ap-count" style={{background: u.bg, color: u.fg}}>
          <div className="big">{o.daysLeft == null ? "—" : Math.abs(o.daysLeft)}</div>
          <div className="lbl">{u.lbl || "no date"}</div>
        </div>

        <div style={{minWidth: 0}}>
          <div className="ap-name">{titleCase(n.assessee || "—")}</div>
          {/* Which order this appeal is against — the thing the old card left
              the practitioner guessing at. */}
          <div className="ap-meta">
            {[
              DOC_TYPE_LABEL[docType] || "Order",
              n.date ? fmtDateLong(n.date) : null,
              n.section ? `u/s ${n.section}` : null,
              `AY ${n.ay || "—"}`,
            ].filter(Boolean).join(" · ")}
          </div>
          <div className="ap-tags">
            <span className="pill pill-primary">Appeal to {o.route}</span>
            <span className="pill pill-muted">{o.reg.act} · {o.form}</span>
            {o.basesDiffer && (
              <span className="pill pill-warning" title="The 1961 and 2025 Acts give different last dates for this order">
                <Icon name="alert" size={10}/>two possible dates
              </span>
            )}
            {/* A contested year holds more than one order — the assessment and
                its penalty, a set-aside and the fresh assessment, the appeal on
                the quantum and the one on the penalty. Each is its own appeal
                with its own deadline, and on a list read by assessee and year
                they look like duplicates unless the card says which is which. */}
            {o.ayCount > 1 && (
              <span
                className="pill pill-info"
                title={`${o.ayCount} appealable orders on file for AY ${n.ay || "—"} — separate orders, separate appeals, separate deadlines. This is the ${o.ayIndex}${o.ayIndex === 1 ? "st" : o.ayIndex === 2 ? "nd" : o.ayIndex === 3 ? "rd" : "th"} by date of order.`}
              >
                order {o.ayIndex} of {o.ayCount} this year{o.ayLatest ? " · latest" : ""}
              </span>
            )}
          </div>
        </div>

        <div className="ap-due">
          {o.deadline
            ? <><span className="muted">due </span><b style={{fontVariantNumeric: "tabular-nums"}}>{fmtDateLong(o.deadline)}</b></>
            : <span className="muted">no date on file</span>}
          <div className="muted" style={{marginTop: 4, display: "flex", gap: 5, alignItems: "center", justifyContent: "flex-end"}}>
            {open ? "Hide details" : "Show details"}
            <span style={{display: "flex", transform: open ? "rotate(180deg)" : "none", transition: "transform .15s"}}>
              <Icon name="chevron-down" size={13}/>
            </span>
          </div>
        </div>
      </button>

      {open && (
        <div className="ap-body">
          <Workspace x={o} allNotices={allNotices} onOpenNotice={onOpenNotice}/>
        </div>
      )}
    </div>
  );
}

/* The order the appeal is against: what it is, what it decided, what it costs.
   Everything here already existed on the notice — the aiSummary in particular
   is written by summarizePortalNotice and was simply never shown on this page,
   so the practitioner had to leave and open the PDF to know what they were
   appealing. */
function OrderCard({ n }) {
  const { notify } = useData();
  const [busy, setBusy] = React.useState(false);
  const docType = orderDocType(n);
  const summary = n.aiSummary || null;
  const points = (summary && summary.items) || [];
  const demand = n.parsed && n.parsed.disputedDemand;

  const summarise = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await httpsCallable(functions, "summarizePortalNotice", { timeout: 120000 })({ noticeId: n.id });
      notify("Order summarised");
    } catch (e) {
      console.error("summarizePortalNotice", e);
      notify(e?.message?.slice(0, 140) || "Couldn't read the order PDF", "alert");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="center" style={{gap: 9, marginBottom: 13, justifyContent: "flex-start", flexWrap: "wrap"}}>
        <span style={{width: 28, height: 28, borderRadius: 9, background: "var(--p-lavender-2)", color: "var(--p-primary-2)", display: "grid", placeItems: "center"}}><Icon name="gavel" size={15}/></span>
        <div className="card-title" style={{fontSize: 14}}>Order appealed against</div>
        <span className="pill pill-muted" style={{marginLeft: "auto"}}>{DOC_TYPE_LABEL[docType] || "Order"}</span>
      </div>

      <div className="col" style={{gap: 5, fontSize: 12.5, color: "var(--p-text-2)"}}>
        <Row k="Date of order" v={n.date ? fmtDateLong(n.date) : "—"}/>
        <Row k="Passed under section" v={n.section ? `u/s ${n.section}` : "—"}/>
        <Row k="DIN" v={n.din || "—"}/>
        {n.assessedIncome != null && <Row k="Total income assessed" v={fmtINR(n.assessedIncome)} strong/>}
        {demand ? <Row k="Demand raised" v={fmtINR(demand)} strong/> : null}
      </div>

      {(n.subject || n.fileName) && (
        <div className="muted ap-subject" style={{fontSize: 11.5, marginTop: 9, lineHeight: 1.5}}>
          {n.subject || n.fileName}
        </div>
      )}

      {summary && (summary.summary || points.length > 0) ? (
        <div style={{marginTop: 12, padding: "11px 13px", background: "var(--p-card-tint)", border: "1px solid var(--p-line-2)", borderRadius: 11}}>
          <div className="center" style={{gap: 7, justifyContent: "flex-start", marginBottom: points.length ? 7 : 0}}>
            <Icon name="sparkle" size={12}/>
            <span style={{fontWeight: 700, fontSize: 12.5}}>{summary.summary || "What this order holds"}</span>
          </div>
          {points.length > 0 && (
            <ul style={{margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6, color: "var(--p-text-2)"}}>
              {points.map((it, i) => <li key={i}>{it}</li>)}
            </ul>
          )}
          <div className="muted" style={{fontSize: 10.5, marginTop: 8, fontStyle: "italic"}}>
            Read from the PDF by AI — verify against the order before drafting grounds.
          </div>
        </div>
      ) : n.storagePath ? (
        <div className="center" style={{gap: 9, marginTop: 12, padding: "10px 12px", background: "var(--p-card-tint)", borderRadius: 11, justifyContent: "flex-start"}}>
          <div style={{flex: 1, fontSize: 12.5}} className="muted">
            No summary yet — read the order to see the additions and findings it turns on.
          </div>
          <button className="btn btn-secondary btn-xs" disabled={busy} onClick={summarise}>
            <Icon name="sparkle" size={12}/>{busy ? "Reading…" : "Summarise order"}
          </button>
        </div>
      ) : null}

      {n.storagePath && (
        <button className="btn btn-secondary btn-sm" style={{marginTop: 12}} onClick={() => downloadOrder(n)}>
          <Icon name="doc" size={13}/>Download the order PDF
        </button>
      )}
    </div>
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
  const penalty = x.penalty;
  const fee = appealFee(x.route, income, { penalty });

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
    <div className="col" style={{gap: 16}}>

        {/* What is being appealed, and what it decided */}
        <OrderCard n={n}/>

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

              {/* Both computations, always — a limitation date shown later than
                  the true one is what costs an appeal, so neither is hidden. */}
              {x.bases.length > 0 && (
                <>
                  <div className="ap-basis">
                    {x.bases.map((b) => {
                      const on = b.newAct === reg.newAct;
                      return (
                        <div key={b.act} className={`b ${on ? "on" : ""}`}>
                          <div className="between" style={{gap: 8}}>
                            <span style={{fontSize: 11, fontWeight: 800, color: on ? "var(--p-primary-2)" : "var(--p-text-3)"}}>{b.act}</span>
                            {on && <span className="pill pill-primary" style={{fontSize: 9.5}}>applied</span>}
                          </div>
                          <div style={{fontSize: 13, fontWeight: 800, marginTop: 3, fontVariantNumeric: "tabular-nums", color: on ? "var(--p-text)" : "var(--p-text-3)"}}>
                            {fmtDateLong(b.date)}
                          </div>
                          <div className="muted" style={{fontSize: 10.5, marginTop: 2, lineHeight: 1.45}}>{b.label}</div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="muted" style={{fontSize: 11, marginTop: 8, lineHeight: 1.5}}>
                    The 2025 Act applies to orders communicated on or after 1 Apr 2026, whatever the assessment year.
                    {x.basesDiffer && <> The two Acts differ by {Math.abs(Math.round((new Date(x.bases[1].date) - new Date(x.bases[0].date)) / 86400000))} days here — <b>verify which governs before relying on the later date.</b></>}
                  </div>
                </>
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
            <div style={{minWidth: 190}}>
              <div style={{fontSize: 26, fontWeight: 800, letterSpacing: "-0.02em"}}>{fee == null ? "—" : fmtINR(fee)}</div>

              {penalty ? (
                /* A penalty appeal is a flat fee, so the assessed income and the
                   slab table are not just unnecessary — showing them invites
                   someone to compute the wrong number. */
                <div className="muted" style={{fontSize: 11.5, marginTop: 6, lineHeight: 1.5}}>
                  Flat fee — appeal against a penalty order.<br/>
                  Assessed income does not affect it.
                </div>
              ) : (
                <>
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
                </>
              )}

              {/* Detection reads the order's type and text; the practitioner
                  knows what it actually decided, and a wrong fee makes the
                  appeal defective. So it is always overridable. */}
              <label className="center" style={{gap: 7, marginTop: 12, fontSize: 11.5, cursor: "pointer", justifyContent: "flex-start", alignItems: "flex-start"}}>
                <input
                  type="checkbox"
                  checked={penalty}
                  onChange={(e) => updateNotice(n.id, { appealFeePenalty: e.target.checked })}
                  style={{marginTop: 2}}
                />
                <span className="muted">Appeal against a penalty order — flat {fmtINR(PENALTY_FEE[x.route])}</span>
              </label>
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
          {onOpenNotice && <button className="btn btn-secondary" onClick={() => onOpenNotice(n)}><Icon name="edit" size={14}/>Open the order record</button>}
          <button className="btn btn-secondary" onClick={markFiled}><Icon name="check" size={14}/>Mark appeal filed</button>
          <button className="btn btn-ghost" onClick={dismiss}>Dismiss</button>
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
