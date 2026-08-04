/*
 * ProHippo — Intimations & rectification orders (CPC).
 *
 * Every s.143(1) intimation and s.154 order the portal sync has brought in, as a
 * place to WORK rather than a place to look.
 *
 * THREE SCREENS, THREE QUESTIONS — the reason this is not the Returns tab and
 * not the dashboard card:
 *
 *   dashboard card    "what landed recently that I have not seen?" — an alert,
 *                     six months, deliberately small
 *   Returns tab       "what does THIS client's file look like?" — one assessee,
 *                     by year, beside the ITR and the ITR-V
 *   this page         "what does my practice owe its clients?" — every client,
 *                     every year, each order carrying a decision
 *
 * WHY IT DRILLS DOWN INSTEAD OF EXPANDING.
 *
 * The first build put every client's every order on one scrolling page with
 * expandable rows. On a real practice that is hundreds of rows deep and reads as
 * a wall — you cannot find one client, and nothing tells you where to start. So
 * it now works the way the Matters tab does, which practitioners already know:
 *
 *   a searchable list of CLIENTS, one row each, saying how much is at stake
 *     → one client's ORDERS, one row per assessment year
 *       → one order's full card, in a pop-up
 *
 * Two views cut the same rows a different way: BY CAUSE, which puts every client
 * hit by the same CPC adjustment together, and BY STAFF, which answers what each
 * person is holding and how much of it they have finished.
 *
 * The visual language is deliberately the Matters tab's — the lavender stage,
 * white rows with a coloured left bar, the "View →" chip that fills on hover —
 * because this is the same kind of work and should not feel like a new app.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 *   No client messaging. A sync can pull a dozen new PANs at once, and a screen
 *   that could fire messages off the back of that will one day message a dozen
 *   people nobody meant to contact.
 *
 *   No s.220(2) interest projection. It would be our arithmetic sitting beside
 *   figures the department stated, and here the two must not be confusable.
 */
import React from "react";
import { Icon, EmptyState, Modal, Avatar, titleCase, fmtINR, fmtDate, fmtDateLong } from "./shared";
import { useData } from "./store";
import { openFromStorage } from "./downloadFile";
import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase";
import {
  allIntimations, groupByAssessee, groupByCause, groupByStaff, practiceSummary, matchesFilter,
  clocksFor, refundPosition, describeVariance, staleRefunds, staffRoster,
  DECISIONS, DECISION_LABEL, CAUSES, CAUSE_LABEL, FILTERS, REFUND_STALE_DAYS, SOURCE_LABEL,
  changedLines, readingTrust, pendingCauseSuggestion, bulkClearable,
} from "./intimations";

/* Section accents, in the Matters tab's idiom: an intimation is the violet the
   app uses for proceedings; a rectification gets the teal so the two read apart
   at a glance in a year list that mixes them. */
const SECTION_ACCENT = {
  "143(1)": { bar: "#6C5CE7", tint: "#F0EBFB", fg: "#46389C", label: "Intimation" },
  "154": { bar: "#1AA6A0", tint: "#E3F6F5", fg: "#0F6E6A", label: "Rectification" },
};
const accentFor = (section) => SECTION_ACCENT[section] || { bar: "var(--p-primary-3)", tint: "var(--p-lavender-2)", fg: "var(--p-primary-2)", label: "Order" };

const FLAG_TONE = {
  red: { bg: "#FDECEC", fg: "#B23B3B", word: "More payable" },
  green: { bg: "#E7F7F0", fg: "#13795C", word: "In your favour" },
  neutral: { bg: "var(--p-line-2)", fg: "var(--p-text-3)", word: "Agrees" },
  unknown: { bg: "#FFF3D6", fg: "#B07512", word: "Not compared" },
};
const toneOf = (v) => FLAG_TONE[v?.flag] || FLAG_TONE.unknown;

/* Only a live clock gets colour. An appeal window that shut three years ago is
   archaeology, not a warning, and painting it red taught the eye to skip red. */
const APPEAL_STALE_DAYS = 90;
const appealTone = (appeal) => {
  if (!appeal.deadline || appeal.daysLeft == null) return null;
  if (appeal.daysLeft < -APPEAL_STALE_DAYS) return { colour: "var(--p-text-3)", loud: false };
  if (appeal.daysLeft < 0) return { colour: "#B23B3B", loud: true };
  if (appeal.daysLeft <= 15) return { colour: "#B23B3B", loud: true };
  if (appeal.daysLeft <= 45) return { colour: "#B07512", loud: true };
  return { colour: "var(--p-text-3)", loud: false };
};

const signed = (v) =>
  v && v.amount != null && v.flag !== "neutral" && v.flag !== "unknown"
    ? `${v.amount < 0 ? "−" : "+"}${fmtINR(Math.abs(v.amount))}`
    : null;

export default function Intimations() {
  const { data, updateReturn, notify } = useData();
  const [filter, setFilter] = React.useState("All");
  const [view, setView] = React.useState("clients"); // clients | cause
  const [search, setSearch] = React.useState("");
  const [openClient, setOpenClient] = React.useState(null); // group key
  const [openRow, setOpenRow] = React.useState(null); // row key → pop-up
  const [busy, setBusy] = React.useState(false);
  const [readingKey, setReadingKey] = React.useState("");

  const rows = React.useMemo(() => allIntimations({ returns: data.returns }), [data.returns]);
  const filtered = React.useMemo(() => rows.filter((r) => matchesFilter(r, filter)), [rows, filter]);
  const summary = React.useMemo(() => practiceSummary(rows), [rows]);
  const clients = React.useMemo(() => groupByAssessee(filtered), [filtered]);
  /* Every name the practice already puts work to, from anywhere in the app —
     so allocating the first intimation needs no set-up. */
  const roster = React.useMemo(() => staffRoster(data, rows), [data, rows]);

  /* Name or PAN, case- and space-insensitive. A practitioner searching for a
     client types either without thinking about which. */
  const needle = search.trim().toLowerCase().replace(/\s+/g, "");
  const shown = needle
    ? clients.filter((c) =>
      `${c.assessee || ""}${c.pan || ""}`.toLowerCase().replace(/\s+/g, "").includes(needle))
    : clients;

  const client = openClient ? clients.find((c) => c.key === openClient) : null;
  const row = openRow ? rows.find((r) => r.key === openRow) : null;

  const setTracking = async (target, patch) => {
    if (busy) return;
    setBusy(true);
    try {
      const ret = data.returns.find((r) => r.id === target.returnId) || {};
      const tracking = ret.intimationTracking || {};
      const write = {
        intimationTracking: {
          ...tracking,
          [target.commRefNo]: { ...(tracking[target.commRefNo] || {}), ...patch, updatedAt: new Date().toISOString() },
        },
      };
      // A decision means somebody has looked; it should stop nagging from the
      // dashboard card too.
      if (patch.decision && patch.decision !== "pending") {
        write.varianceReviewed = { ...(ret.varianceReviewed || {}), [target.commRefNo]: true };
      }
      await updateReturn(target.returnId, write);
    } finally {
      setBusy(false);
    }
  };

  /* One paid read, on one order, only when asked. */
  const readOrder = async (target) => {
    if (readingKey) return;
    setReadingKey(target.key);
    try {
      await httpsCallable(functions, "readIntimationOrder", { timeout: 120000 })({
        returnId: target.returnId, commRefNo: target.commRefNo,
      });
      notify("Order read — check the breakdown against the PDF");
    } catch (e) {
      notify(e?.message?.slice(0, 140) || "Couldn't read that order", "alert");
    } finally {
      setReadingKey("");
    }
  };

  const viewPdf = async (target) => {
    try {
      await openFromStorage(target.storagePath);
    } catch {
      notify("That order PDF could not be opened", "alert");
    }
  };

  /* Clear a practice's refund history in one go.
     On first use every refund CPC ever determined looks outstanding, because the
     portal never says whether the bank paid it. Marking the old ones settled is
     a single decision, not one per row. */
  const settleStale = async () => {
    const stale = staleRefunds(rows);
    if (!stale.length || busy) return;
    setBusy(true);
    try {
      const byReturn = new Map();
      for (const r of stale) {
        if (!byReturn.has(r.returnId)) byReturn.set(r.returnId, []);
        byReturn.get(r.returnId).push(r);
      }
      const today = new Date().toISOString().slice(0, 10);
      for (const [returnId, items] of byReturn) {
        const ret = data.returns.find((x) => x.id === returnId) || {};
        const tracking = { ...(ret.intimationTracking || {}) };
        for (const item of items) {
          tracking[item.commRefNo] = { ...(tracking[item.commRefNo] || {}), refundReceivedOn: today, updatedAt: new Date().toISOString() };
        }
        await updateReturn(returnId, { intimationTracking: tracking });
      }
      notify(`${stale.length} older refund${stale.length > 1 ? "s" : ""} marked received`);
    } finally {
      setBusy(false);
    }
  };

  /* Settle every order where CPC agreed, in one write per return.
     Scoped to whatever is on screen: on the client list that is the practice,
     inside a client it is that client. */
  const clearAgreeing = async (scope) => {
    const clearable = bulkClearable(scope);
    if (!clearable.length || busy) return;
    setBusy(true);
    try {
      const byReturn = new Map();
      for (const r of clearable) {
        if (!byReturn.has(r.returnId)) byReturn.set(r.returnId, []);
        byReturn.get(r.returnId).push(r);
      }
      const at = new Date().toISOString();
      for (const [returnId, items] of byReturn) {
        const ret = data.returns.find((x) => x.id === returnId) || {};
        const tracking = { ...(ret.intimationTracking || {}) };
        const reviewed = { ...(ret.varianceReviewed || {}) };
        for (const item of items) {
          tracking[item.commRefNo] = { ...(tracking[item.commRefNo] || {}), decision: "none", updatedAt: at };
          reviewed[item.commRefNo] = true;
        }
        await updateReturn(returnId, { intimationTracking: tracking, varianceReviewed: reviewed });
      }
      notify(`${clearable.length} agreeing order${clearable.length > 1 ? "s" : ""} cleared`);
    } finally {
      setBusy(false);
    }
  };

  if (rows.length === 0) {
    return (
      <div className="animate-in">
        <Topbar summary={summary}/>
        <div className="card">
          <EmptyState
            icon="doc"
            title="No intimations on file yet"
            sub="Sync an assessee's filed returns and any intimation u/s 143(1) or rectification order u/s 154 CPC has issued will be listed here, compared against the return, and given a decision to make."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="animate-in">
      <Topbar summary={summary} client={client} onBack={() => setOpenClient(null)}/>

      {!client && (
        <>
          <div className="grid-stats" style={{gap: 14, marginBottom: 16}}>
            <Stat label="Needs a decision" value={summary.pending} sub={`across ${summary.assessees} assessee${summary.assessees !== 1 ? "s" : ""}`} colour="#B07512"/>
            <Stat label="More payable" value={fmtINR(summary.additionalDemand)} sub="than the returns claimed" colour="#B23B3B"/>
            <Stat label="In the assessee's favour" value={fmtINR(summary.extraRefund)} sub="over the returns claimed" colour="#13795C"/>
            <Stat label="Refund awaited" value={summary.refundAwaited + summary.refundOverdue} sub={summary.refundOverdue ? `${summary.refundOverdue} over 30 days` : "determined, not yet received"} colour={summary.refundOverdue ? "#B23B3B" : "var(--p-text-2)"}/>
            {/* Allocation, stated as work still IN HAND rather than work
                allocated: the number a principal wants is what has not come
                back yet. */}
            <Stat
              label="With staff"
              value={summary.workOpen}
              sub={summary.unallocated ? `${summary.unallocated} not allocated to anybody` : summary.workDone ? `${summary.workDone} marked done` : "all allocated"}
              colour={summary.workOpen ? "var(--p-primary-2)" : "var(--p-text-2)"}
            />
          </div>

          {(summary.appealLapsing > 0 || summary.disposalOverdue > 0) && (
            <div className="card" style={{marginBottom: 16, borderLeft: "3px solid #B23B3B", padding: "13px 18px"}}>
              <div className="center" style={{gap: 8, justifyContent: "flex-start", flexWrap: "wrap"}}>
                <Icon name="alert" size={15}/>
                <span style={{fontWeight: 700, fontSize: 13.5}}>
                  {summary.appealLapsing > 0 && `${summary.appealLapsing} appeal window${summary.appealLapsing > 1 ? "s" : ""} closing within 7 days`}
                  {summary.appealLapsing > 0 && summary.disposalOverdue > 0 && " · "}
                  {summary.disposalOverdue > 0 && `${summary.disposalOverdue} rectification${summary.disposalOverdue > 1 ? "s" : ""} past the s.154(8) six-month limit`}
                </span>
              </div>
              <div className="muted" style={{fontSize: 12, marginTop: 5}}>
                Rectification u/s 154 stays open for four years; the appeal to CIT(A) does not.
              </div>
            </div>
          )}

          {bulkClearable(rows).length > 0 && (
            <div className="card" style={{marginBottom: 16, padding: "12px 18px"}}>
              <div className="between" style={{gap: 12, flexWrap: "wrap", alignItems: "center"}}>
                <div style={{fontSize: 12.5}}>
                  <b>{bulkClearable(rows).length} order{bulkClearable(rows).length > 1 ? "s" : ""}</b> where CPC agreed with the return.
                  <span className="muted"> Nothing to decide on those — clear them and only the orders that need you are left.</span>
                </div>
                <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => clearAgreeing(rows)}>
                  <Icon name="check" size={13}/>Mark as no action needed
                </button>
              </div>
            </div>
          )}

          {summary.refundStale > 0 && (
            <div className="card" style={{marginBottom: 16, padding: "12px 18px"}}>
              <div className="between" style={{gap: 12, flexWrap: "wrap", alignItems: "center"}}>
                <div style={{fontSize: 12.5}}>
                  <b>{summary.refundStale} refund{summary.refundStale > 1 ? "s" : ""}</b> determined more than {Math.round(REFUND_STALE_DAYS / 30)} months ago.
                  <span className="muted"> The portal never says whether the bank paid out, so these are not chased — clear them once and only recent ones will be tracked.</span>
                </div>
                <button className="btn btn-secondary btn-sm" disabled={busy} onClick={settleStale}>
                  <Icon name="check" size={13}/>Mark as received
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Search + filters. Search is only meaningful on the client list; inside
          one client the list is already short. */}
      <div className="between" style={{marginBottom: 14, gap: 12, flexWrap: "wrap"}}>
        <div className="row" style={{gap: 6, flexWrap: "wrap"}}>
          {FILTERS.map((f) => (
            <span key={f} className={`fchip ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>{f}</span>
          ))}
        </div>
        {!client && (
          <div className="center" style={{gap: 8}}>
            <div className="search" style={{minWidth: 230}}>
              <Icon name="search" size={15}/>
              <input placeholder="Search assessee or PAN…" value={search} onChange={(e) => setSearch(e.target.value)}/>
            </div>
            <span className={`fchip ${view === "clients" ? "active" : ""}`} onClick={() => setView("clients")}>By client</span>
            <span className={`fchip ${view === "cause" ? "active" : ""}`} onClick={() => setView("cause")}
              title="Every client hit by the same CPC adjustment — one position to research, not one per client">
              By cause
            </span>
            <span className={`fchip ${view === "staff" ? "active" : ""}`} onClick={() => setView("staff")}
              title="What each person is holding, and how much of it they have finished">
              By staff
            </span>
          </div>
        )}
      </div>

      {client && bulkClearable(client.rows).length > 0 && (
        <div className="card" style={{marginBottom: 14, padding: "11px 18px"}}>
          <div className="between" style={{gap: 12, flexWrap: "wrap", alignItems: "center"}}>
            <span style={{fontSize: 12.5}}>
              {bulkClearable(client.rows).length} of this assessee's orders agree with the return.
            </span>
            <button className="btn btn-secondary btn-xs" disabled={busy} onClick={() => clearAgreeing(client.rows)}>
              <Icon name="check" size={12}/>Clear them
            </button>
          </div>
        </div>
      )}

      {client
        ? <OrderList
          client={client}
          readingKey={readingKey}
          onOpen={(r) => setOpenRow(r.key)}
        />
        : view === "clients"
          ? <ClientList clients={shown} search={search} onOpen={(c) => setOpenClient(c.key)}/>
          : view === "staff"
            ? <StaffList groups={groupByStaff(filtered)} onOpenRow={(r) => setOpenRow(r.key)}/>
            : <CauseList groups={groupByCause(filtered)} onOpenRow={(r) => setOpenRow(r.key)}/>}

      {row && (
        <OrderModal
          row={row}
          busy={busy}
          roster={roster}
          readingNow={readingKey === row.key}
          onClose={() => setOpenRow(null)}
          onTrack={(patch) => setTracking(row, patch)}
          onRead={() => readOrder(row)}
          onViewPdf={() => viewPdf(row)}
        />
      )}
    </div>
  );
}

function Topbar({ summary, client, onBack }) {
  return (
    <div className="topbar">
      <div>
        {client ? (
          <>
            <button className="btn btn-ghost btn-sm" style={{marginBottom: 6, paddingLeft: 0}} onClick={onBack}>
              <Icon name="arrow-left" size={14}/>All assessees
            </button>
            <div className="page-title">{titleCase(client.assessee) || client.pan}</div>
            <div className="page-sub">
              {client.pan || "PAN not on file"} · {client.count} order{client.count !== 1 ? "s" : ""} from CPC
              {client.pending ? <> · <b style={{color: "#B07512"}}>{client.pending} awaiting a decision</b></> : " · all decided"}
            </div>
          </>
        ) : (
          <>
            <div className="page-title">Intimations &amp; rectifications</div>
            <div className="page-sub">
              {summary.total} order{summary.total !== 1 ? "s" : ""} from CPC across {summary.assessees} assessee{summary.assessees !== 1 ? "s" : ""}
              {summary.pending ? <> · <b style={{color: "#B07512"}}>{summary.pending} awaiting a decision</b></> : " · all decided"}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, sub, colour }) {
  return (
    <div className="card" style={{padding: "14px 16px"}}>
      <div className="muted" style={{fontSize: 11, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase"}}>{label}</div>
      <div style={{fontSize: 21, fontWeight: 800, marginTop: 3, color: colour || "inherit", letterSpacing: "-0.02em"}}>{value}</div>
      <div className="muted" style={{fontSize: 11.5, marginTop: 2}}>{sub}</div>
    </div>
  );
}

/* ---------------- level 1: the clients ---------------- */

const CLIENT_GRID = "minmax(170px, 1fr) 126px 76px 150px 116px 96px 96px";

function ClientList({ clients, search, onOpen }) {
  if (clients.length === 0) {
    return (
      <div className="card">
        <EmptyState icon="search" title={search ? `No assessee matches “${search}”` : "Nothing under this filter"} sub={search ? "Try part of the name, or the PAN." : "Try another filter, or All."}/>
      </div>
    );
  }
  return (
    <div className="matters-surface" style={{overflowX: "auto"}}>
      <div className="col" style={{gap: 10, minWidth: 720}}>
        <div style={{display: "grid", gridTemplateColumns: CLIENT_GRID, gap: 14, alignItems: "center", padding: "0 18px", fontSize: 10.5, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", color: "#46389C"}}>
          <span>Assessee</span><span>PAN</span><span>Orders</span><span>Position</span><span>With</span><span>To decide</span><span/>
        </div>
        {clients.map((c) => {
          // A client's own colour comes from what they need, not from a type:
          // undecided work leads, then money at stake, then settled.
          const bar = c.pending ? "#E0A93B" : c.atStake ? "#B23B3B" : "#8E7CFF";
          return (
            <div
              key={c.key}
              className="card matter-row"
              role="button"
              tabIndex={0}
              onClick={() => onOpen(c)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(c); } }}
              style={{display: "grid", gridTemplateColumns: CLIENT_GRID, gap: 14, alignItems: "center", padding: "14px 18px", cursor: "pointer", borderLeft: `4px solid ${bar}`}}
            >
              <span style={{minWidth: 0}}>
                <span className="strong" style={{fontSize: 13.5, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                  {titleCase(c.assessee) || "—"}
                </span>
                <span className="muted" style={{fontSize: 11}}>A.Y. {c.years.slice(0, 4).join(", ")}{c.years.length > 4 ? ` +${c.years.length - 4}` : ""}</span>
              </span>
              <span className="muted" style={{fontSize: 12, fontFamily: "ui-monospace, monospace"}}>{c.pan || "—"}</span>
              <span style={{fontSize: 13, fontWeight: 700}}>{c.count}</span>
              <span>
                {c.atStake > 0
                  ? <span className="pill" style={{background: "#FDECEC", color: "#B23B3B", fontWeight: 700}}>{fmtINR(c.atStake)} more payable</span>
                  : <span className="muted" style={{fontSize: 12}}>Nothing adverse</span>}
              </span>
              <span style={{minWidth: 0}}><StaffCell staff={c.staff} unallocated={c.unallocated}/></span>
              <span>
                {c.pending
                  ? <span className="pill" style={{background: "#FFF3D6", color: "#B07512", fontWeight: 700}}>{c.pending}</span>
                  : <span className="pill pill-muted">All done</span>}
              </span>
              <span className="matter-view center" style={{gap: 5, justifySelf: "end", padding: "6px 11px", borderRadius: 999, background: "var(--p-lavender-2)", color: "var(--p-primary-2)", fontSize: 11.5, fontWeight: 700, whiteSpace: "nowrap"}}>
                View <Icon name="arrow-right" size={13}/>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* Who is carrying this. The mint avatar is the app's own convention for a staff
   member — the same one the Matters table, the Hearings list and the assessee
   card use — so a name means a person here too without anybody being told.
   First name only: the column is 96px and a surname does not identify anybody
   in a practice of six that a first name does not. */
function StaffCell({ staff, unallocated }) {
  if (!staff?.length) {
    return <span className="muted" style={{fontSize: 11.5}}>Not allocated</span>;
  }
  return (
    <span className="center" style={{gap: 6, justifyContent: "flex-start", minWidth: 0}}>
      <Avatar name={staff[0]} color="mint" size="sm"/>
      <span style={{fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
        {staff.length > 1 ? `${staff.length} people` : staff[0].split(" ")[0]}
        {unallocated > 0 && <span className="muted"> +{unallocated}</span>}
      </span>
    </span>
  );
}

/* ---------------- the by-staff view ---------------- */

/* What each person is holding.
 *
 * The counts are OPEN first and finished second, because the question a
 * principal opens this for is "what is still with Priya", not "what has Priya
 * ever done". The unallocated group is last and is styled as work rather than
 * as somebody's list — nobody has picked it up yet.
 */
function StaffList({ groups, onOpenRow }) {
  if (!groups.length) return <div className="card"><EmptyState icon="users" title="Nothing under this filter"/></div>;
  return (
    <div className="col" style={{gap: 12}}>
      {groups.map((g) => (
        <div key={g.key || "unallocated"} className="card" style={{padding: 0, overflow: "hidden"}}>
          <div className="between" style={{padding: "13px 18px", background: g.key ? "var(--p-card-tint)" : "transparent", gap: 12, flexWrap: "wrap"}}>
            <div className="center" style={{gap: 10, justifyContent: "flex-start"}}>
              {g.key ? <Avatar name={g.staff} color="mint"/> : <Icon name="alert" size={16}/>}
              <div>
                <div style={{fontSize: 14.5, fontWeight: 800}}>{g.staff || "Not allocated to anybody"}</div>
                <div className="muted" style={{fontSize: 11.5, marginTop: 2}}>
                  {g.count} order{g.count !== 1 ? "s" : ""} · {g.assessees} assessee{g.assessees !== 1 ? "s" : ""}
                  {g.atStake > 0 ? ` · ${fmtINR(g.atStake)} more payable` : ""}
                </div>
              </div>
            </div>
            <span className="center" style={{gap: 7}}>
              {g.open > 0 && (
                <span className="pill" style={{background: "#FFF3D6", color: "#B07512", fontWeight: 700}}>{g.open} still open</span>
              )}
              {g.done > 0 && (
                <span className="pill" style={{background: "#E7F7F0", color: "#13795C", fontWeight: 700}}>{g.done} done</span>
              )}
            </span>
          </div>
          <div>
            {g.rows.map((r) => {
              const tone = toneOf(r.variance);
              return (
                <div
                  key={r.key}
                  className="between row-link"
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenRow(r)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenRow(r); } }}
                  style={{padding: "10px 18px", borderTop: "1px solid var(--p-line-2)", cursor: "pointer", gap: 12, flexWrap: "wrap"}}
                >
                  <span style={{fontSize: 12.5}}>
                    {r.workDone && <Icon name="check" size={12}/>}{" "}
                    <b style={{opacity: r.workDone ? 0.6 : 1}}>{titleCase(r.assessee) || r.pan}</b>
                    <span className="muted"> · A.Y. {r.ay} · u/s {r.section} · {DECISION_LABEL[r.decision]}</span>
                  </span>
                  <span style={{background: tone.bg, color: tone.fg, borderRadius: 7, padding: "2px 7px", fontWeight: 800, fontSize: 12}}>
                    {signed(r.variance) || tone.word}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------------- level 2: one client's orders ---------------- */


/* What CPC actually determined on this order — the Returns tab's figure.
 *
 * DISTINCT FROM THE VARIANCE, and both are worth a column. The variance says how
 * far CPC moved from the return; this says where they landed. A practitioner
 * ringing a client says the second one out loud: "your refund is ₹15,005", not
 * "you are ₹0 away from what we claimed".
 *
 * Read off variance.cpcNet, which is already the status-driven figure — positive
 * is a refund, negative a demand — so this can never disagree with the flag
 * beside it.
 *
 * Set in Plus Jakarta Sans 800, the app's own extra-bold, at 15px. Poppins or
 * Montserrat would give the same weight but would be the only place in the app
 * using them, and would cost every page a second font download for one column.
 */
function CpcAmount({ variance, size = 15 }) {
  const net = variance?.cpcNet;
  if (net === null || net === undefined) return <span className="muted" style={{fontSize: 12.5}}>—</span>;
  if (net === 0) return <span className="muted" style={{fontSize: 12.5, fontWeight: 700}}>Nil</span>;
  const refund = net > 0;
  return (
    <span style={{
      display: "block",
      fontSize: size,
      fontWeight: 800,
      letterSpacing: "-0.02em",
      color: refund ? "#13795C" : "#B23B3B",
      whiteSpace: "nowrap",
      lineHeight: 1.2,
    }}>
      {fmtINR(Math.abs(net))}
      <span style={{display: "block", fontSize: 10.5, fontWeight: 700, letterSpacing: ".03em", textTransform: "uppercase", opacity: 0.75}}>
        {refund ? "refund" : "demand"}
      </span>
    </span>
  );
}

const ORDER_GRID = "104px 68px 82px minmax(180px, 1fr) 118px 104px 122px 92px";

function OrderList({ client, readingKey, onOpen }) {
  const ordered = [...client.rows].sort((a, b) =>
    (b.ay || "").localeCompare(a.ay || "") || (b.orderDate || "").localeCompare(a.orderDate || ""));

  return (
    <div className="matters-surface" style={{overflowX: "auto"}}>
      <div className="col" style={{gap: 10, minWidth: 960}}>
        <div style={{display: "grid", gridTemplateColumns: ORDER_GRID, gap: 14, alignItems: "center", padding: "0 18px", fontSize: 10.5, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", color: "#46389C"}}>
          <span>Order</span><span>A.Y.</span><span>Dated</span><span>What it did</span><span>Demand / Refund</span><span>With</span><span>Decision</span><span/>
        </div>
        {ordered.map((r) => {
          const accent = accentFor(r.section);
          const tone = toneOf(r.variance);
          const amt = signed(r.variance);
          const clocks = clocksFor(r);
          const at = appealTone(clocks.appeal);
          const refund = refundPosition(r);
          const live = r.variance?.flag === "red" && r.decision === "pending" && at?.loud;
          return (
            <div
              key={r.key}
              className="card matter-row"
              role="button"
              tabIndex={0}
              onClick={() => onOpen(r)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(r); } }}
              style={{display: "grid", gridTemplateColumns: ORDER_GRID, gap: 14, alignItems: "center", padding: "14px 18px", cursor: "pointer", borderLeft: `4px solid ${accent.bar}`}}
            >
              <span>
                <span className="pill" style={{background: accent.tint, color: accent.fg, fontWeight: 700}}>u/s {r.section}</span>
              </span>
              <span style={{fontSize: 13, fontWeight: 700}}>{r.ay || "—"}</span>
              <span className="muted" style={{fontSize: 12}}>{r.orderDate ? fmtDate(r.orderDate) : "—"}</span>
              <span style={{minWidth: 0}}>
                <span style={{fontSize: 12.5, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                  {describeVariance(r.variance)}
                </span>
                <span className="center" style={{gap: 6, justifyContent: "flex-start", flexWrap: "wrap", marginTop: 2}}>
                  {r.variance?.adjusted && <span className="pill pill-muted" style={{fontSize: 10}}>adjusted u/s 245</span>}
                  {live && <span style={{fontSize: 10.5, fontWeight: 700, color: at.colour}}>appeal {clocks.appeal.daysLeft < 0 ? "just closed" : `${clocks.appeal.daysLeft}d left`}</span>}
                  {refund.state === "overdue" && <span style={{fontSize: 10.5, fontWeight: 700, color: "#B23B3B"}}>refund not received</span>}
                  {r.reading && readingTrust(r.reading) === "ok" && r.reading.headline && (
                    <span className="muted" style={{fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 240}}>{r.reading.headline}</span>
                  )}
                  {readingKey === r.key && <span className="muted" style={{fontSize: 10.5}}>reading…</span>}
                </span>
              </span>
              <span><CpcAmount variance={r.variance}/></span>
              <span style={{minWidth: 0}}>
                <StaffCell staff={r.assignedTo ? [r.assignedTo] : []} unallocated={0}/>
                {r.assignedTo && (
                  <span style={{fontSize: 10, fontWeight: 700, display: "block", marginTop: 2, color: r.workDone ? "#13795C" : "#B07512"}}>
                    {r.workDone ? "done" : "in hand"}
                  </span>
                )}
              </span>
              <span>
                <span style={{display: "inline-block", background: tone.bg, color: tone.fg, borderRadius: 8, padding: "3px 8px", fontWeight: 800, fontSize: 12}}>
                  {amt || tone.word}
                </span>
                <span className="muted" style={{fontSize: 10.5, display: "block", marginTop: 3}}>{DECISION_LABEL[r.decision]}</span>
              </span>
              <span className="matter-view center" style={{gap: 5, justifySelf: "end", padding: "6px 11px", borderRadius: 999, background: "var(--p-lavender-2)", color: "var(--p-primary-2)", fontSize: 11.5, fontWeight: 700, whiteSpace: "nowrap"}}>
                View <Icon name="arrow-right" size={13}/>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- the by-cause view ---------------- */

function CauseList({ groups, onOpenRow }) {
  if (!groups.length) return <div className="card"><EmptyState icon="chart" title="Nothing under this filter"/></div>;
  return (
    <div className="col" style={{gap: 12}}>
      {groups.map((g) => (
        <div key={g.cause || "untagged"} className="card" style={{padding: 0, overflow: "hidden"}}>
          <div className="between" style={{padding: "13px 18px", background: g.cause ? "var(--p-card-tint)" : "transparent", gap: 12, flexWrap: "wrap"}}>
            <div>
              <div style={{fontSize: 14.5, fontWeight: 800}}>{g.label}</div>
              <div className="muted" style={{fontSize: 11.5, marginTop: 2}}>
                {g.assessees} assessee{g.assessees !== 1 ? "s" : ""} · {g.count} order{g.count !== 1 ? "s" : ""}
                {g.atStake > 0 ? ` · ${fmtINR(g.atStake)} more payable` : ""}
              </div>
            </div>
            {g.cause && g.assessees > 1 && (
              <span className="pill" style={{background: "var(--p-lavender-2)", color: "var(--p-primary-2)", fontWeight: 700}}>
                One position, {g.assessees} clients
              </span>
            )}
          </div>
          <div>
            {g.rows.map((r) => {
              const tone = toneOf(r.variance);
              return (
                <div
                  key={r.key}
                  className="between row-link"
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenRow(r)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenRow(r); } }}
                  style={{padding: "10px 18px", borderTop: "1px solid var(--p-line-2)", cursor: "pointer", gap: 12, flexWrap: "wrap"}}
                >
                  <span style={{fontSize: 12.5}}>
                    <b>{titleCase(r.assessee) || r.pan}</b>
                    <span className="muted"> · A.Y. {r.ay} · u/s {r.section}</span>
                  </span>
                  <span style={{background: tone.bg, color: tone.fg, borderRadius: 7, padding: "2px 7px", fontWeight: 800, fontSize: 12}}>
                    {signed(r.variance) || tone.word}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------------- one order, in full ---------------- */

function OrderModal({ row, busy, roster, readingNow, onClose, onTrack, onRead, onViewPdf }) {
  const accent = accentFor(row.section);
  const tone = toneOf(row.variance);
  const clocks = clocksFor(row);
  const refund = refundPosition(row);
  const amt = signed(row.variance);

  return (
    <Modal
      title={`${accent.label} u/s ${row.section} — A.Y. ${row.ay || "—"}`}
      titleStyle={{fontSize: 21}}
      sub={[titleCase(row.assessee) || row.pan, row.orderDate ? fmtDateLong(row.orderDate) : "date not stated", row.statusDesc].filter(Boolean).join("  ·  ")}
      onClose={onClose}
      width={820}
      footer={<button className="btn btn-secondary" onClick={onClose}>Close</button>}
    >
      <div className="col" style={{gap: 16}}>
        {/* What it did, and what we are doing about it — the two things a
            practitioner opens this card for. */}
        <div className="between" style={{alignItems: "center", flexWrap: "wrap", gap: 12, padding: "13px 15px", background: accent.tint, borderRadius: 12, borderLeft: `4px solid ${accent.bar}`}}>
          <div>
            <div style={{fontSize: 13, fontWeight: 700}}>{describeVariance(row.variance)}</div>
            {row.variance?.adjusted && (
              <div className="muted" style={{fontSize: 11.5, marginTop: 3}}>
                The refund was set off against an earlier year's demand u/s 245 — CPC allowed it, but none of it reaches the client.
              </div>
            )}
          </div>
          <div className="center" style={{gap: 16}}>
            <div style={{textAlign: "right"}}>
              <div className="muted" style={{fontSize: 9.5, fontWeight: 800, letterSpacing: ".05em", textTransform: "uppercase"}}>
                CPC determined{row.variance?.source === "document" ? " · per the order" : ""}
              </div>
              <CpcAmount variance={row.variance} size={19}/>
              {row.variance?.source === "document" && (
                <div className="muted" style={{fontSize: 10, marginTop: 2, maxWidth: 210}}>
                  The portal sent no amount — this was read off the order itself.
                </div>
              )}
            </div>
            <span style={{background: tone.bg, color: tone.fg, borderRadius: 9, padding: "6px 12px", fontWeight: 800, fontSize: 14, whiteSpace: "nowrap"}}>
              {amt || tone.word}
            </span>
          </div>
        </div>

        <div className="row" style={{gap: 10, flexWrap: "wrap"}}>
          <select
            value={row.decision}
            disabled={busy}
            onChange={(e) => onTrack({ decision: e.target.value })}
            style={{flex: "1 1 220px", padding: "8px 10px", borderRadius: 10, border: "1px solid var(--p-line)", fontSize: 13, fontWeight: 600}}
          >
            {DECISIONS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
          {row.storagePath && !row.locked ? (
            <>
              <button className="btn btn-secondary btn-sm" onClick={onViewPdf}><Icon name="doc" size={13}/>Open the PDF</button>
              <button className="btn btn-primary btn-sm" disabled={readingNow} onClick={onRead}>
                <Icon name="sparkle" size={13}/>{readingNow ? "Reading…" : row.reading ? "Re-read" : "Read the order"}
              </button>
            </>
          ) : (
            <span className="muted" style={{fontSize: 12, alignSelf: "center"}}>{row.lockReason === "request-only" ? "CPC only sends this year's order by e-mail" : "No readable PDF on file"}</span>
          )}
        </div>

        <div className="row" style={{gap: 18, alignItems: "flex-start", flexWrap: "wrap"}}>
          <div style={{flex: "1 1 300px", minWidth: 270}}>
            <Eyebrow>Remedies &amp; limitation</Eyebrow>
            <Clock label={`Appeal to CIT(A) — ${clocks.appeal.form || "Form 35"}`} clock={clocks.appeal}/>
            <Clock label="Rectification u/s 154" clock={clocks.rectification}/>
            {clocks.disposal && <Clock label="CPC to dispose of our application" clock={{...clocks.disposal, urgency: clocks.disposal.overdue ? "lapsed" : "open"}}/>}
            <div className="muted" style={{fontSize: 10.5, marginTop: 8, lineHeight: 1.5}}>
              Computed from the order date on the portal. Verify against the order and the Act before relying on them.
            </div>
          </div>

          <div style={{flex: "1 1 320px", minWidth: 280}}>
            <Eyebrow>Why CPC differed</Eyebrow>
            <ReadingPanel row={row} busy={busy} readingNow={readingNow} onRead={onRead} onTrack={onTrack}/>
          </div>
        </div>

        {row.reading?.outstandingDemands?.length > 0 && <ArrearsPanel reading={row.reading}/>}

        <div>
          <Eyebrow>Allocation</Eyebrow>
          <AllocationPanel row={row} busy={busy} roster={roster} onTrack={onTrack}/>
        </div>

        <div>
          <Eyebrow>Tracking</Eyebrow>
          <div className="row" style={{gap: 12, flexWrap: "wrap"}}>
            {(row.decision === "rectify" || row.tracking?.rectFiledOn) && (
              <>
                <Field label="Rectification filed on" style={{flex: "1 1 170px"}}>
                  <input type="date" value={row.tracking?.rectFiledOn || ""} disabled={busy} onChange={(e) => onTrack({ rectFiledOn: e.target.value })}/>
                </Field>
                <Field label="Request no." style={{flex: "1 1 170px"}}>
                  <input type="text" value={row.tracking?.rectRequestNo || ""} disabled={busy} placeholder="from the portal" onChange={(e) => onTrack({ rectRequestNo: e.target.value })}/>
                </Field>
              </>
            )}
            {refund.state !== "none" && refund.state !== "adjusted" && (
              <Field label={refund.state === "stale" ? "Refund received on (not chased — older than a year)" : "Refund received on"} style={{flex: "1 1 200px"}}>
                <input type="date" value={row.tracking?.refundReceivedOn || ""} disabled={busy} onChange={(e) => onTrack({ refundReceivedOn: e.target.value })}/>
              </Field>
            )}
            <Field label="Note" style={{flex: "2 1 260px"}}>
              <input type="text" value={row.tracking?.note || ""} disabled={busy} placeholder="for your own record" onChange={(e) => onTrack({ note: e.target.value })}/>
            </Field>
          </div>
          {refund.state === "adjusted" && (
            <div className="muted" style={{fontSize: 11.5, marginTop: 4}}>
              Refund of {fmtINR(refund.amount)} set off in full u/s 245 — nothing is due to the client, so it is not chased.
            </div>
          )}
          {/* The portal's own figures, exactly as sent, beside what we made of
              them. Here because this feature once reported a ₹1,83,744 demand on
              an order that raised none, and a practitioner should be able to
              check our arithmetic in five seconds rather than by opening a PDF. */}
          <details style={{marginTop: 10}}>
            <summary className="muted" style={{fontSize: 11, cursor: "pointer"}}>What the portal actually sent</summary>
            <div className="muted" style={{fontSize: 11, marginTop: 6, lineHeight: 1.7, fontFamily: "ui-monospace, monospace"}}>
              status {row.activityCd || "—"} · {row.statusDesc || "no description"}<br/>
              demand field {row.demand === "" || row.demand == null ? "—" : fmtINR(Number(row.demand))} ·
              refund field {row.refund === "" || row.refund == null ? "—" : fmtINR(Number(row.refund))}<br/>
              read as {row.variance?.cpcNet == null ? "not comparable" : `${row.variance.cpcNet < 0 ? "payable" : "refundable"} ${fmtINR(Math.abs(row.variance.cpcNet))}`} (engine {row.variance?.engine ?? "—"}{row.variance?.source ? `, ${SOURCE_LABEL[row.variance.source] || row.variance.source}` : ""})
              {row.returnPosition?.netPayable != null && <> · return closed at {row.returnPosition.netPayable < 0 ? "payable" : "refundable"} {fmtINR(Math.abs(row.returnPosition.netPayable))}</>}
            </div>
          </details>

          <div className="muted" style={{fontSize: 10.5, marginTop: 8}}>
            CPC ref. <span style={{fontFamily: "ui-monospace, monospace"}}>{row.commRefNo}</span>
            {row.emailedOn ? ` · e-mailed ${fmtDateLong(row.emailedOn)}` : ""}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* Who is doing this one, and have they finished.
 *
 * A TEXT BOX WITH SUGGESTIONS, NOT A DROP-DOWN. Staff is free text everywhere
 * else in ProHippo — on the assessee, the matter, the hearing — and a drop-down
 * here would be the only place in the app where a name has to exist before it
 * can be used. So the roster is offered through a datalist: every name already
 * in use is one click away, and a new one is simply typed. That is the whole of
 * "he can even add the staff if it's not in the list".
 *
 * Only assigned work can be marked done. Something nobody is holding cannot be
 * finished by anybody, and a tick with no name against it is a claim the page
 * cannot answer questions about a week later.
 *
 * The tick is deliberately NOT the same thing as the decision beside it. A
 * decision is what the PRACTICE has resolved to do about the order — rectify,
 * appeal, accept; "done" is whether the person given the job has carried it out.
 * A rectification can be decided on Monday and filed on Friday, and a page that
 * conflated the two would show the Monday state all week.
 */
function AllocationPanel({ row, busy, roster, onTrack }) {
  const listId = "intimation-staff-roster";
  const assigned = row.assignedTo || "";

  const assign = (name) => {
    const value = String(name || "").trim();
    if (value === assigned) return;
    onTrack(
      value
        ? { assignedTo: value, assignedAt: new Date().toISOString() }
        // Unassigning clears the tick with it, rather than leaving "done" hanging
        // against nobody.
        : { assignedTo: "", assignedAt: "", workDone: false, doneAt: "" }
    );
  };

  return (
    <div>
      <datalist id={listId}>
        {roster.map((name) => <option key={name} value={name}/>)}
      </datalist>
      <div className="row" style={{gap: 12, flexWrap: "wrap", alignItems: "flex-end"}}>
        <div style={{flex: "1 1 240px"}}>
          <div className="muted" style={{fontSize: 11, marginBottom: 3}}>Assigned to</div>
          <div className="center" style={{gap: 8, justifyContent: "flex-start"}}>
            {assigned && <Avatar name={assigned} color="mint" size="sm"/>}
            <input
              type="text"
              list={listId}
              defaultValue={assigned}
              key={assigned}
              disabled={busy}
              placeholder="Type a name, or pick from your staff"
              onBlur={(e) => assign(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
              style={{flex: 1, minWidth: 0, padding: "7px 9px", borderRadius: 9, border: "1px solid var(--p-line)", fontSize: 12.5}}
            />
            {assigned && (
              <button className="btn btn-ghost btn-xs" disabled={busy} title="Take this off them" onClick={() => assign("")}>
                <Icon name="x" size={12}/>
              </button>
            )}
          </div>
        </div>

        <div style={{flex: "1 1 200px"}}>
          <div className="muted" style={{fontSize: 11, marginBottom: 3}}>Progress</div>
          {assigned ? (
            <button
              className={`btn btn-sm ${row.workDone ? "btn-secondary" : "btn-primary"}`}
              disabled={busy}
              onClick={() => onTrack({ workDone: !row.workDone, doneAt: row.workDone ? "" : new Date().toISOString() })}
            >
              <Icon name="check" size={13}/>
              {row.workDone ? "Done — reopen" : "Mark the work done"}
            </button>
          ) : (
            <span className="muted" style={{fontSize: 11.5}}>Assign it to somebody first.</span>
          )}
        </div>
      </div>
      {row.workDone && row.tracking?.doneAt && (
        <div className="muted" style={{fontSize: 10.5, marginTop: 6}}>
          Marked done on {fmtDateLong(String(row.tracking.doneAt).slice(0, 10))}.
        </div>
      )}
    </div>
  );
}

const Eyebrow = ({ children }) => (
  <div className="pm-eyebrow" style={{fontSize: 11, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", marginBottom: 8}}>{children}</div>
);

function Field({ label, children, style }) {
  return (
    <label style={{display: "block", ...style}}>
      <div className="muted" style={{fontSize: 11, marginBottom: 3}}>{label}</div>
      {React.cloneElement(children, {
        style: {width: "100%", padding: "7px 9px", borderRadius: 9, border: "1px solid var(--p-line)", fontSize: 12.5},
      })}
    </label>
  );
}

function Clock({ label, clock }) {
  if (!clock?.deadline) {
    return (
      <div style={{marginBottom: 10}}>
        <div style={{fontSize: 12.5, fontWeight: 700}}>{label}</div>
        <div className="muted" style={{fontSize: 11.5}}>No date on the order, so this cannot be computed.</div>
      </div>
    );
  }
  const tone = clock.urgency === "lapsed" || clock.urgency === "urgent" ? "#B23B3B"
    : clock.urgency === "soon" ? "#B07512" : "var(--p-text-3)";
  // A window long closed is stated in grey: it is history, not a warning.
  const stale = clock.daysLeft != null && clock.daysLeft < -APPEAL_STALE_DAYS;
  const colour = stale ? "var(--p-text-3)" : tone;
  return (
    <div style={{marginBottom: 10}}>
      <div className="between" style={{gap: 8, alignItems: "baseline"}}>
        <span style={{fontSize: 12.5, fontWeight: 700}}>{label}</span>
        <span style={{fontSize: 12.5, fontWeight: 800, color: colour, whiteSpace: "nowrap"}}>{fmtDate(clock.deadline)}</span>
      </div>
      <div className="muted" style={{fontSize: 11}}>
        {clock.label}
        {clock.daysLeft != null && (
          <span style={{color: colour, fontWeight: stale ? 400 : 700}}>
            {" · "}{clock.daysLeft < 0 ? `closed ${Math.abs(clock.daysLeft)} days ago` : `${clock.daysLeft} days left`}
          </span>
        )}
      </div>
    </div>
  );
}

/* What the order's own comparison table says, once somebody has asked for it.
 *
 * THE TRUST BANNER IS NOT DECORATION. These figures were read by a model out of
 * a PDF, and what makes them safe to look at is that the order's own bottom line
 * was checked against the figure the portal separately recorded. Where they
 * agree the table is shown plainly; where they do not it is shown under a
 * warning. There is no middle setting — "probably right" would be read as
 * "right". */
function ReadingPanel({ row, busy, readingNow, onRead, onTrack }) {
  const reading = row.reading;

  if (!reading) {
    return (
      <div>
        <div className="muted" style={{fontSize: 11.5, lineHeight: 1.5, marginBottom: 8}}>
          The order prints the return's figures against CPC's, side by side. Reading it shows which line moved.
        </div>
        <button className="btn btn-secondary btn-xs" disabled={readingNow || !row.storagePath || row.locked} onClick={onRead}>
          <Icon name="sparkle" size={12}/>{readingNow ? "Reading…" : "Read the order"}
        </button>
        <CausePicker row={row} busy={busy} onTrack={onTrack}/>
      </div>
    );
  }

  const trust = readingTrust(reading);
  const moved = changedLines(reading);
  const suggestion = pendingCauseSuggestion(row);

  return (
    <div>
      {trust !== "ok" && (
        <div style={{
          background: trust === "broken" ? "#FDECEC" : "#FFF3D6",
          color: trust === "broken" ? "#B23B3B" : "#B07512",
          borderRadius: 9, padding: "8px 10px", fontSize: 11.5, lineHeight: 1.5, marginBottom: 8, fontWeight: 600,
        }}>
          <Icon name="alert" size={11}/>{" "}
          {trust === "broken" ? "This read does not reconcile. " : "This read could not be checked. "}
          {reading.reconcileNote}
        </div>
      )}

      {moved.length > 0 ? (
        <div style={{overflowX: "auto"}}>
          <table className="tbl" style={{fontSize: 12}}>
            <thead><tr><th>Head</th><th style={{textAlign: "right"}}>As returned</th><th style={{textAlign: "right"}}>As computed</th></tr></thead>
            <tbody>
              {moved.map((l, i) => (
                <tr key={`${l.head}-${i}`}>
                  <td>{l.head}{l.remark && <div className="muted" style={{fontSize: 10.5}}>{l.remark}</div>}</td>
                  <td style={{textAlign: "right", whiteSpace: "nowrap"}}>{fmtINR(l.asReturned)}</td>
                  <td style={{textAlign: "right", whiteSpace: "nowrap", color: l.asComputed < l.asReturned ? "#B23B3B" : "#13795C", fontWeight: 700}}>{fmtINR(l.asComputed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="muted" style={{fontSize: 11.5}}>
          The read found no line where the two columns differ — which is the right answer for an order CPC processed as filed.
        </div>
      )}

      {suggestion && (
        <div className="center" style={{gap: 8, marginTop: 10, padding: "8px 10px", background: "var(--p-card-tint)", borderRadius: 9, flexWrap: "wrap"}}>
          <span style={{fontSize: 11.5}}>Suggested cause: <b>{CAUSE_LABEL[suggestion]}</b></span>
          <button className="btn btn-primary btn-xs" style={{marginLeft: "auto"}} disabled={busy} onClick={() => onTrack({ cause: suggestion })}>
            <Icon name="check" size={11}/>Accept
          </button>
        </div>
      )}

      <CausePicker row={row} busy={busy} onTrack={onTrack}/>

      <div className="muted" style={{fontSize: 10.5, marginTop: 6, lineHeight: 1.5}}>
        Read on {fmtDateLong(String(reading.at || "").slice(0, 10))}. Verify against the order before acting on it.
      </div>
    </div>
  );
}

function CausePicker({ row, busy, onTrack }) {
  return (
    <div style={{marginTop: 10}}>
      <select
        value={row.cause}
        disabled={busy}
        onChange={(e) => onTrack({ cause: e.target.value })}
        style={{width: "100%", padding: "7px 9px", borderRadius: 9, border: "1px solid var(--p-line)", fontSize: 12.5}}
      >
        <option value="">Not yet tagged</option>
        {CAUSES.map((c) => <option key={c.id} value={c.id}>{c.label}{c.statute ? ` — s.${c.statute}` : ""}</option>)}
      </select>
      <div className="muted" style={{fontSize: 10.5, marginTop: 5, lineHeight: 1.5}}>
        Tagging pays off across the practice: <b>By cause</b> puts every client hit by the same adjustment in one list.
      </div>
    </div>
  );
}

/* The arrears of OTHER assessment years, from this order's own annexures.
 *
 * WHY THIS EARNS ITS SPACE. An order can agree with the return to the rupee,
 * determine a refund, and leave the client with nothing — because the refund
 * went against a demand from years nobody is looking at. "Agrees" is true and
 * incomplete. This is the other half, and it comes free: the annexure is in the
 * PDF the read already sends.
 *
 * Adjusted and still-owed are kept apart. Money already taken is a settled fact;
 * money still outstanding is a live problem, and often a wrong or long-paid CPC
 * demand that nobody has challenged. */
function ArrearsPanel({ reading }) {
  const rows = reading.outstandingDemands || [];
  const taken = rows.filter((d) => d.adjusted);
  const owed = rows.filter((d) => !d.adjusted);
  return (
    <div>
      <Eyebrow>Earlier years' demand, per this order</Eyebrow>
      <div className="row" style={{gap: 10, flexWrap: "wrap", marginBottom: 8}}>
        {reading.arrearsAdjusted > 0 && (
          <span className="pill" style={{background: "var(--p-line-2)", color: "var(--p-text-2)", fontWeight: 700}}>
            {fmtINR(reading.arrearsAdjusted)} taken from this refund
          </span>
        )}
        {reading.arrearsOutstanding > 0 && (
          <span className="pill" style={{background: "#FDECEC", color: "#B23B3B", fontWeight: 700}}>
            {fmtINR(reading.arrearsOutstanding)} still outstanding
          </span>
        )}
      </div>
      <div style={{overflowX: "auto"}}>
        <table className="tbl" style={{fontSize: 12}}>
          <thead><tr><th>A.Y.</th><th>Demand reference</th><th style={{textAlign: "right"}}>Amount</th><th></th></tr></thead>
          <tbody>
            {[...taken, ...owed].map((d, i) => (
              <tr key={`${d.demandReference}-${i}`}>
                <td>{d.ay || "—"}</td>
                <td style={{fontFamily: "ui-monospace, monospace", fontSize: 11}}>{d.demandReference || "—"}</td>
                <td style={{textAlign: "right", whiteSpace: "nowrap"}}>{fmtINR(d.amount)}</td>
                <td>
                  <span className="pill pill-muted" style={{fontSize: 10}}>{d.adjusted ? "adjusted" : "outstanding"}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="muted" style={{fontSize: 10.5, marginTop: 6, lineHeight: 1.5}}>
        Read from this order's annexures. These belong to <b>other</b> assessment years and never enter this order's
        own position — verify against the order before acting on them.
      </div>
    </div>
  );
}
