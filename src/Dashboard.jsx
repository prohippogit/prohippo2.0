import React from 'react';
import { createPortal } from 'react-dom';
import { Icon, Avatar, titleCase, fmtINR, fmtLakhs, fmtDate, fmtDateLong, daysFromNow } from './shared';
import { openFromStorage } from './downloadFile';
import { InstallAppButton } from './InstallApp';
import { useData, upcomingHearings, awaitingNotices, totalOutstanding, overdueAmount, invoiceOutstanding, toISO, todayISO } from './store';
import { appealableOrders } from './appeals';
import { intimationVariances, varianceSummary, needsVarianceBackfill, DEFAULT_WINDOW_MONTHS } from './intimations';
import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';
import { AskDocsButton } from './askForDocuments';
import { noticeDocumentCount } from './noticeDocs';
import { KeepBoard } from './Tasks';

export default function Dashboard({ onNav, onOpenNotice, onSearch }) {
  const { data, loadSampleData, addTodo, notify } = useData();

  // Turn a hearing or an appeal deadline into a task card on the board.
  const addTaskFromHearing = (h) => {
    addTodo({ type: "note", text: `${titleCase(h.assessee)} — ${h.authority} hearing (${h.bench || "—"})`, due: h.date, assessee: h.assessee, label: "Hearing", color: "violet", done: false });
    notify("Added to tasks");
  };
  const addTaskFromAppeal = (o) => {
    addTodo({ type: "note", text: `File ${o.route} appeal — ${titleCase(o.notice.assessee || "")} (AY ${o.notice.ay || "—"})`, due: o.deadline || "", assessee: o.notice.assessee || "", label: "Appeal", color: o.urgency === "red" || o.urgency === "lapsed" ? "coral" : "amber", done: false });
    notify("Added to tasks");
  };
  const [query, setQuery] = React.useState("");
  const [showNotices, setShowNotices] = React.useState(false);

  const hearings = upcomingHearings(data);
  const awaiting = awaitingNotices(data);
  const appeals = appealableOrders(data);
  // Passed as { returns } rather than the whole store: the selector reads only
  // that collection, and depending on `data` would rebuild the list every time
  // an unrelated invoice or hearing changed.
  const variances = React.useMemo(() => intimationVariances({ returns: data.returns }), [data.returns]);
  useVarianceBackfill(data.returns);
  const activeMatters = data.matters.filter(m => !["Closed", "Decided"].includes(m.status));
  const weekAhead = hearings.filter(h => daysFromNow(h.date) <= 7);
  const next48h = hearings.filter(h => daysFromNow(h.date) <= 2);
  const outstanding = totalOutstanding(data);
  const overdue = overdueAmount(data);
  const monthStart = todayISO().slice(0, 7);
  const noticesThisMonth = data.notices.filter(n => (n.date || "").startsWith(monthStart));

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const firstName = (data.profile.ownerName || "").split(" ")[0];

  const isEmpty = data.assessees.length === 0 && data.hearings.length === 0 && data.notices.length === 0 && data.invoices.length === 0;

  return (
    <div className="animate-in">
      <div className="topbar">
        <div>
          <div className="page-title">{greeting}{firstName ? `, ${firstName}` : ""} 👋</div>
          <div className="page-sub">
            {isEmpty
              ? "Let's get your practice set up."
              : <>You have <b style={{color: "var(--p-primary-2)"}}>{weekAhead.length} hearing{weekAhead.length !== 1 ? "s" : ""} this week</b> and <b style={{color: "#C13388"}}>{awaiting.length} notice{awaiting.length !== 1 ? "s" : ""}</b> awaiting review.</>}
          </div>
        </div>
        <div className="topbar-actions">
          <div className="search">
            <Icon name="search" size={16}/>
            <input
              placeholder="Search PAN, assessee…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") onSearch(query); }}
            />
          </div>
          <InstallAppButton className="btn btn-secondary" label="Desktop app"/>
          <div className="user-chip">
            <Avatar name={data.profile.ownerName || "You"} color="violet"/>
            <div style={{lineHeight: 1.2}}>
              <div style={{fontSize: 12.5, fontWeight: 700}}>{data.profile.ownerName || "Welcome"}</div>
              <div style={{fontSize: 11, color: "var(--p-text-3)"}}>{data.profile.firmName || "Set up your firm"}</div>
            </div>
          </div>
        </div>
      </div>

      {isEmpty && (
        <div className="card" style={{padding: 0, overflow: "hidden", border: "none", background: "linear-gradient(120deg, #2B2270 0%, #5146C6 55%, #8E7CFF 100%)", color: "white", marginBottom: 18}}>
          <div style={{padding: "28px 30px"}}>
            <div style={{fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.3}}>
              Welcome to ProHippo.<br/>
              <span style={{opacity: 0.85}}>Add your first assessee, or explore with sample data.</span>
            </div>
            <div className="row" style={{marginTop: 18, gap: 10}}>
              <button className="btn" style={{background: "white", color: "var(--p-primary-2)"}} onClick={() => onNav("assessees")}>
                <Icon name="plus" size={14}/>Add assessee
              </button>
              <button className="btn btn-ghost" style={{color: "white"}} onClick={loadSampleData}>
                Load sample data
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="grid-stats" style={{marginBottom: 18}}>
        <Stat label="Active matters" value={activeMatters.length} delta={`${data.matters.length} total`} deltaKind="neutral" icon="scale" iconBg="var(--p-lavender-2)" iconColor="var(--p-primary-2)"
          glow="rgba(108, 92, 231, 0.24)" goLabel="Matters" onClick={() => onNav("matters")}/>
        <Stat label="Hearings this week" value={weekAhead.length} delta={next48h.length ? `${next48h.length} in next 48h` : "None in next 48h"} deltaKind="neutral" icon="calendar" iconBg="var(--p-pink)" iconColor="#C13388"
          glow="rgba(255, 140, 200, 0.30)" goLabel="Hearings" onClick={() => onNav("hearings")}/>
        <Stat label="Outstanding fees" value={fmtLakhs(outstanding)} delta={overdue ? `${fmtLakhs(overdue)} overdue` : "Nothing overdue"} deltaKind={overdue ? "down" : "up"} icon="wallet" iconBg="var(--p-amber)" iconColor="#B07512"
          glow="rgba(255, 193, 84, 0.32)" goLabel="Invoices" onClick={() => onNav("invoices")}/>
        <Stat label="Notices this month" value={noticesThisMonth.length} delta={awaiting.length ? `${awaiting.length} awaiting review` : "All reviewed"} deltaKind="neutral" icon="doc" iconBg="var(--p-mint)" iconColor="#1B8C5C"
          glow="rgba(74, 222, 164, 0.30)"/>
      </div>

      <div className="grid-main">
        <div className="col" style={{gap: 18}}>
          <AppealsReminderCard appeals={appeals} onNav={onNav} onAddTask={addTaskFromAppeal}/>

          <IntimationVarianceCard rows={variances} onOpen={() => onNav("intimations")}/>

          {awaiting.length > 0 && (
            <div
              className="card"
              style={{padding: 0, overflow: "hidden", border: "none", background: "linear-gradient(120deg, #2B2270 0%, #5146C6 55%, #8E7CFF 100%)", color: "white", position: "relative", cursor: "pointer"}}
              role="button"
              tabIndex={0}
              onClick={() => setShowNotices(true)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setShowNotices(true); } }}
              title="Open notices to review"
            >
              <div style={{position: "absolute", right: -40, top: -40, width: 200, height: 200, borderRadius: "50%", background: "rgba(255,180,220,0.25)", filter: "blur(20px)"}}/>
              <div style={{padding: "24px 26px", position: "relative"}}>
                <div className="center" style={{gap: 8}}>
                  <Icon name="sparkle" size={16}/>
                  <span style={{fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", opacity: 0.85}}>Notices · Awaiting review</span>
                </div>
                <div style={{fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em", marginTop: 8, lineHeight: 1.25}}>
                  {awaiting.length} notice{awaiting.length !== 1 ? "s" : ""} to review.<br/>
                  <span style={{opacity: 0.85}}>Recent, or with an upcoming hearing.</span>
                </div>
                <div className="row" style={{marginTop: 16, gap: 10, alignItems: "center"}}>
                  <span className="btn" style={{background: "white", color: "var(--p-primary-2)"}}>
                    Review &amp; mark as read <Icon name="arrow-right" size={14}/>
                  </span>
                </div>
              </div>
            </div>
          )}

          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Upcoming hearings</div>
                <div className="card-sub">{hearings.length ? `${hearings.length} scheduled · across all authorities` : "Nothing scheduled yet"}</div>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => onNav("hearings")}>View all <Icon name="arrow-right" size={14}/></button>
            </div>
            {hearings.length === 0 && (
              <div className="muted" style={{fontSize: 13, padding: "18px 0", textAlign: "center"}}>
                No upcoming hearings. Add one from the <b style={{cursor: "pointer", color: "var(--p-primary-2)"}} onClick={() => onNav("hearings")}>Hearings</b> page.
              </div>
            )}
            <div className="col" style={{gap: 10}}>
              {hearings.slice(0, 4).map(h => {
                const d = daysFromNow(h.date);
                return (
                  <div key={h.id} className="hearing-card">
                    <div className={`hearing-date ${d <= 1 ? "urgent" : d <= 4 ? "warning" : ""}`}>
                      <div className="d">{new Date(h.date).getDate()}</div>
                      <div className="m">{new Date(h.date).toLocaleString("en-IN",{month:"short"})}</div>
                    </div>
                    <div style={{flex: 1, minWidth: 0}}>
                      <div className="between">
                        <div style={{fontWeight: 700, fontSize: 14}}>{titleCase(h.assessee)}</div>
                        <div className="center" style={{gap: 6}}>
                          <span className="pill pill-primary">{h.authority}</span>
                          {h.mode === "Video Conference" && <span className="pill pill-info"><Icon name="video" size={11}/>VC</span>}
                        </div>
                      </div>
                      <div className="muted" style={{fontSize: 12, marginTop: 3}}>
                        {h.bench} · AY {h.ay} {h.section && `· u/s ${h.section}`} · <Icon name="clock" size={11}/> {h.time}
                      </div>
                    </div>
                    <button className="btn btn-ghost btn-xs" title="Add to tasks" onClick={() => addTaskFromHearing(h)}><Icon name="plus" size={12}/></button>
                    <Icon name="chevron-right" size={16} className="muted"/>
                  </div>
                );
              })}
            </div>
          </div>

          <ReceivablesCard data={data}/>
        </div>

        <div className="col" style={{gap: 18}}>
          <MiniCalendar hearings={data.hearings} onNav={onNav}/>
          <AuthorityMixCard matters={activeMatters}/>
        </div>
      </div>

      <div style={{marginTop: 18}}>
        <KeepBoard onOpenAssessee={onSearch}/>
      </div>

      {showNotices && (
        <AwaitingNoticesModal
          awaiting={awaiting}
          onClose={() => setShowNotices(false)}
          onOpenNotice={(n) => { setShowNotices(false); onOpenNotice(n); }}
        />
      )}

    </div>
  );
}

// App-open reminder: appealable orders with the filing clock running. The most
// urgent one leads; tap through to the Appeals page. Silent when nothing is due.
function AppealsReminderCard({ appeals, onNav, onAddTask }) {
  if (!appeals || appeals.length === 0) return null;
  const nearest = appeals[0];
  const soon = appeals.filter((o) => o.daysLeft != null && o.daysLeft >= 0 && o.daysLeft <= 15).length;
  const lapsed = appeals.filter((o) => o.daysLeft != null && o.daysLeft < 0).length;
  const urgent = nearest.daysLeft != null && (nearest.daysLeft < 0 || nearest.daysLeft <= 7);
  const bg = urgent
    ? "linear-gradient(120deg, #7A1E4B 0%, #B8324F 55%, #E0464A 100%)"
    : "linear-gradient(120deg, #2B2270 0%, #5146C6 55%, #8E7CFF 100%)";
  const lead = nearest.daysLeft == null ? "date to confirm"
    : nearest.daysLeft < 0 ? `${Math.abs(nearest.daysLeft)} days overdue`
      : `${nearest.daysLeft} day${nearest.daysLeft !== 1 ? "s" : ""} left`;

  return (
    <div
      className="card"
      style={{padding: 0, overflow: "hidden", border: "none", background: bg, color: "white", position: "relative", cursor: "pointer"}}
      role="button"
      tabIndex={0}
      onClick={() => onNav("appeals")}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onNav("appeals"); } }}
      title="Open the Appeals workspace"
    >
      <div style={{position: "absolute", right: -40, top: -40, width: 200, height: 200, borderRadius: "50%", background: "rgba(255,255,255,0.18)", filter: "blur(20px)"}}/>
      <div style={{padding: "24px 26px", position: "relative"}}>
        <div className="center" style={{gap: 8, justifyContent: "flex-start"}}>
          <Icon name="gavel" size={16}/>
          <span style={{fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", opacity: 0.85}}>Appeals · Filing deadlines</span>
        </div>
        <div style={{fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em", marginTop: 8, lineHeight: 1.25}}>
          {appeals.length} appeal{appeals.length !== 1 ? "s" : ""} to file.<br/>
          <span style={{opacity: 0.9}}>
            {titleCase(nearest.notice.assessee || "—")} — {nearest.route} · <b>{lead}</b>{nearest.deadline ? ` (by ${fmtDateLong(nearest.deadline)})` : ""}.
          </span>
        </div>
        <div className="row" style={{marginTop: 14, gap: 8, alignItems: "center", flexWrap: "wrap"}}>
          {soon > 0 && <span className="pill" style={{background: "rgba(255,255,255,0.2)", color: "white"}}>{soon} within 15 days</span>}
          {lapsed > 0 && <span className="pill" style={{background: "rgba(255,255,255,0.28)", color: "white"}}>{lapsed} lapsed</span>}
          <button className="btn" style={{background: "rgba(255,255,255,0.18)", color: "white", marginLeft: "auto"}} title="Add the nearest deadline to your tasks" onClick={(e) => { e.stopPropagation(); onAddTask && onAddTask(nearest); }}>
            <Icon name="plus" size={13}/>Add task
          </button>
          <span className="btn" style={{background: "white", color: "var(--p-primary-2)"}}>
            Prepare appeals <Icon name="arrow-right" size={14}/>
          </span>
        </div>
      </div>
    </div>
  );
}

/* ---------------- intimations u/s 143(1) and orders u/s 154 ---------------- */

/* Bring the whole history through the variance engine, once per page load.
 *
 * Every intimation a practice has ever synced already carries CPC's demand and
 * refund figures, and every filed return's JSON is already in Storage — so the
 * back history can be flagged without anybody re-syncing. It has to be a
 * deliberate trigger rather than a side effect of the next sync, because the
 * connector SKIPS an assessment year with no new order (portalReturns.js): a
 * quiet year would otherwise never pass through the ingest again and would stay
 * blank for ever.
 *
 * Module-level flag, not state: one attempt per page load whichever screen
 * mounts first, and no retry loop if the call fails. Silent either way — the
 * card fills in on its own when the write lands, and a practitioner who never
 * knew a backfill was due does not need to be told one failed. */
let varianceBackfillTried = false;
function useVarianceBackfill(returns) {
  React.useEffect(() => {
    if (varianceBackfillTried || !(returns || []).length) return;
    if (!needsVarianceBackfill({ returns })) return;
    varianceBackfillTried = true;
    httpsCallable(functions, "refreshReturnVariances")({}).catch((e) => {
      console.warn("variance backfill failed", e?.message || e);
    });
  }, [returns]);
}


/* What CPC did to the assessee's position, across the practice, over the last
 * six months.
 *
 * DELIBERATELY NOT A RED CARD. Six months of intimations will normally contain
 * movement in both directions, and a card that turns red whenever any client
 * gets a demand is a card that is red every week — which is a card nobody reads.
 * The surface stays one colour and the ROWS carry the red and the green, so the
 * colour still means something when it appears.
 *
 * The headline leads with additional demand when there is any, because that is
 * the one with a clock on it: a s.154 rectification and an appeal against an
 * intimation both run to a deadline, and an extra refund does not.
 */
function IntimationVarianceCard({ rows, onOpen }) {
  if (!rows || rows.length === 0) return null;
  const s = varianceSummary(rows);

  /* Nothing but agreement is not worth a card. Six months where CPC accepted
     every return is the normal, quiet case — saying so every day would train
     the practitioner to skip past the card on the days it matters. */
  if (!s.red && !s.green && !s.unknown) return null;

  const lead = s.red
    ? <>{fmtINR(s.additionalDemand)} more payable than the returns claimed{s.assessees > 1 ? `, across ${s.assessees} assessees` : ""}.</>
    : s.green
      ? <>{fmtINR(s.extraRefund)} more refund than claimed.</>
      : <>{s.unknown} could not be compared automatically.</>;

  return (
    <div
      className="card"
      style={{padding: 0, overflow: "hidden", border: "none", background: "linear-gradient(120deg, #10303E 0%, #175C66 55%, #2FA79C 100%)", color: "white", position: "relative", cursor: "pointer"}}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      title="Review the intimations and rectification orders CPC has issued"
    >
      <div style={{position: "absolute", right: -40, top: -40, width: 200, height: 200, borderRadius: "50%", background: "rgba(140,255,235,0.22)", filter: "blur(20px)"}}/>
      <div style={{padding: "24px 26px", position: "relative"}}>
        <div className="center" style={{gap: 8, justifyContent: "flex-start"}}>
          <Icon name="chart" size={16}/>
          <span style={{fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", opacity: 0.85}}>
            Intimations · Tax variance
          </span>
        </div>
        <div style={{fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em", marginTop: 8, lineHeight: 1.25}}>
          {rows.length} order{rows.length !== 1 ? "s" : ""} in the last {DEFAULT_WINDOW_MONTHS} months.<br/>
          <span style={{opacity: 0.9}}>{lead}</span>
        </div>
        <div className="row" style={{marginTop: 14, gap: 8, alignItems: "center", flexWrap: "wrap"}}>
          {s.red > 0 && <span className="pill" style={{background: "rgba(255,120,120,0.32)", color: "white"}}>{s.red} raising demand</span>}
          {s.green > 0 && <span className="pill" style={{background: "rgba(120,255,190,0.28)", color: "white"}}>{s.green} in the assessee's favour</span>}
          {s.adjusted > 0 && <span className="pill" style={{background: "rgba(255,255,255,0.2)", color: "white"}} title="CPC set the refund off against an earlier demand u/s 245">{s.adjusted} refund adjusted u/s 245</span>}
          {s.unknown > 0 && <span className="pill" style={{background: "rgba(255,255,255,0.2)", color: "white"}}>{s.unknown} not compared</span>}
          <span className="btn" style={{background: "white", color: "#12525C", marginLeft: "auto"}}>
            Review variances <Icon name="arrow-right" size={14}/>
          </span>
        </div>
      </div>
    </div>
  );
}

// A small square checkbox matching the checklist style.
function Check({ checked, onChange }) {
  return (
    <div
      onClick={(e) => { e.stopPropagation(); onChange(); }}
      role="checkbox"
      aria-checked={checked}
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onChange(); } }}
      style={{width: 18, height: 18, borderRadius: 6, border: "2px solid var(--p-line)", display: "grid", placeItems: "center", cursor: "pointer", background: checked ? "var(--p-primary)" : "white", borderColor: checked ? "var(--p-primary)" : "var(--p-line)", flexShrink: 0}}
    >
      {checked && <Icon name="check" size={12} stroke={3}/>}
    </div>
  );
}

// Popup opened from the dashboard's "Notices · Awaiting review" card — the
// notices worth acting on now (recent, or with an upcoming hearing). Each can
// be ticked read individually or in bulk.
//
// Every action here asks the practitioner to DECIDE something — is this read,
// does it need documents from the client — and none of those decisions can be
// taken off a one-line summary. So the notice itself is one click away in both
// the forms it exists in: the PDF the portal issued, opened for reading, and
// the record it was filed as. A list that only offers "mark as read" is asking
// someone to sign off on something they have not seen.
function AwaitingNoticesModal({ awaiting, onClose, onOpenNotice }) {
  const { updateNotice, notify } = useData();
  const [selected, setSelected] = React.useState(() => new Set());
  const [busy, setBusy] = React.useState(false);
  const today = todayISO();

  const rows = React.useMemo(
    () => [...awaiting].sort((a, b) => (b.date || "").localeCompare(a.date || "")),
    [awaiting]
  );

  const toggle = (id) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const allSelected = rows.length > 0 && rows.every((n) => selected.has(n.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((n) => n.id)));

  const markRead = async (ids) => {
    if (!ids.length || busy) return;
    setBusy(true);
    for (const id of ids) await updateNotice(id, { read: true });
    setBusy(false);
    setSelected(new Set());
    notify(ids.length > 1 ? `${ids.length} notices marked as read` : "Marked as read");
  };

  // The PDF the portal issued. Opened for reading, not saved — see
  // openFromStorage in downloadFile.js for why this one goes the other way.
  const viewPdf = async (n) => {
    try {
      await openFromStorage(n.storagePath);
    } catch {
      notify("That PDF could not be opened — try the notice record", "alert");
    }
  };

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{maxWidth: 700, padding: "22px 24px"}} onClick={(e) => e.stopPropagation()}>
        <div className="between" style={{alignItems: "flex-start", gap: 12, marginBottom: 12}}>
          <div>
            <div style={{fontSize: 17, fontWeight: 800}}>Notices · Awaiting review</div>
            <div className="card-sub" style={{marginTop: 2}}>{rows.length} recent or with an upcoming hearing · read the PDF or open the record, then tick as read</div>
          </div>
          <button className="icon-btn" style={{width: 32, height: 32, borderRadius: 10, flexShrink: 0}} title="Close" onClick={onClose}><Icon name="x" size={15}/></button>
        </div>

        <div className="between" style={{padding: "2px 2px 12px", gap: 10}}>
          <div className="center" style={{gap: 10, justifyContent: "flex-start"}}>
            <Check checked={allSelected} onChange={toggleAll}/>
            <span className="muted" style={{fontSize: 12}}>Select all</span>
          </div>
          {selected.size > 0 && (
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => markRead([...selected])}>
              <Icon name="check" size={14}/>Mark {selected.size} as read
            </button>
          )}
        </div>

        <div className="col" style={{gap: 8, maxHeight: "60vh", overflowY: "auto"}}>
          {rows.map((n) => {
            const due = n.responseDueDate || n.hearingDate || "";
            const hasFutureHearing = due && due >= today;
            const isSel = selected.has(n.id);
            /* A notice is often a SET of files — a s.148 arrives with its
               approval, set note and search print. This queue is for reading
               the notice, so it opens the notice; the count is here so nobody
               reads one file and assumes that was all of it. */
            const docCount = noticeDocumentCount(n);
            return (
              /* Wraps rather than squeezes: on a narrow window the buttons drop
                 to a second line instead of eating into the name. */
              <div key={n.id} className="center" style={{gap: 12, padding: "10px 12px", border: "1px solid var(--p-line-2)", borderRadius: 11, background: isSel ? "var(--p-lavender-2)" : "transparent", flexWrap: "wrap"}}>
                <Check checked={isSel} onChange={() => toggle(n.id)}/>
                {/* The assessee's name gets a line to itself.
                    It shared one with the section and hearing pills, which are
                    fixed-width and never shrink — so on a row carrying a
                    deadline pill and three buttons the name was the only thing
                    left that could give, and it gave until it read "Manis…".
                    The name is the one thing on this row nobody can act
                    without. The pills drop to the meta line, which has room. */}
                <div style={{flex: 1, minWidth: 190, cursor: "pointer"}} onClick={() => onOpenNotice(n)} title="Open the notice record">
                  <div style={{fontSize: 14.5, fontWeight: 800, color: "var(--p-primary-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
                    {n.assessee ? titleCase(n.assessee) : "—"}
                  </div>
                  <div className="center" style={{gap: 6, marginTop: 4, justifyContent: "flex-start", flexWrap: "wrap"}}>
                    {n.section && <span className="pill pill-muted">u/s {n.section}</span>}
                    {hasFutureHearing && <span className="pill pill-pink"><Icon name="calendar" size={10}/>{fmtDate(due)}</span>}
                    <span className="muted" style={{fontSize: 11.5}}>
                      AY {n.ay || "—"}{n.din ? ` · DIN …${String(n.din).slice(-6)}` : ""}{n.date ? ` · ${fmtDate(n.date)}` : ""}
                    </span>
                  </div>
                </div>
                {/* The notice itself. Where the portal PDF is on file it opens
                    for reading; where it isn't, the record is still one click
                    away — an absent button would read as a broken one. */}
                {n.storagePath ? (
                  <button className="btn btn-ghost btn-xs" title={docCount > 1 ? `Open the notice PDF — ${docCount} files came with this notice` : "Open the notice PDF in a new tab"} onClick={() => viewPdf(n)}>
                    <Icon name="doc" size={12}/>PDF{docCount > 1 ? ` ·${docCount}` : ""}
                  </button>
                ) : (
                  <button className="btn btn-ghost btn-xs" title="No PDF on file — open the notice record" onClick={() => onOpenNotice(n)}>
                    <Icon name="edit" size={12}/>Open
                  </button>
                )}
                {!n.isOrder && <AskDocsButton notice={n}/>}
                <button className="btn btn-ghost btn-xs" disabled={busy} title="Mark as read" onClick={() => markRead([n.id])}>
                  <Icon name="check" size={12}/>Read
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body
  );
}

function ReceivablesCard({ data }) {
  const byGroup = {};
  data.assessees.forEach(a => {
    const invs = data.invoices.filter(i => i.assessee === a.name);
    const out = invs.reduce((s, i) => s + invoiceOutstanding(i), 0);
    if (out <= 0) return;
    const g = a.group || "Others";
    byGroup[g] = byGroup[g] || { amount: 0, count: 0 };
    byGroup[g].amount += out;
    byGroup[g].count += 1;
  });
  // invoices for assessees not in the register still count
  const known = new Set(data.assessees.map(a => a.name));
  data.invoices.filter(i => !known.has(i.assessee)).forEach(i => {
    const out = invoiceOutstanding(i);
    if (out <= 0) return;
    byGroup["Others"] = byGroup["Others"] || { amount: 0, count: 0 };
    byGroup["Others"].amount += out;
  });
  const rows = Object.entries(byGroup).sort((a, b) => b[1].amount - a[1].amount).slice(0, 6);
  const max = rows.length ? rows[0][1].amount : 1;
  const palette = ["var(--p-primary)", "var(--p-primary-3)", "#FFB3D9", "#FFD17A", "#8EE7BC", "#B8A8FF"];

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">Receivables — Group-wise</div>
          <div className="card-sub">Outstanding professional fees</div>
        </div>
      </div>
      {rows.length === 0 && <div className="muted" style={{fontSize: 13, padding: "14px 0", textAlign: "center"}}>No outstanding receivables. 🎉</div>}
      <div className="col" style={{gap: 12}}>
        {rows.map(([name, g], i) => (
          <div key={name}>
            <div className="between" style={{marginBottom: 6}}>
              <div className="center" style={{gap: 8}}>
                <div style={{width: 8, height: 8, borderRadius: 3, background: palette[i % palette.length]}}/>
                <span style={{fontWeight: 600, fontSize: 13}}>{name}</span>
                {g.count > 0 && <span className="pill pill-muted" style={{fontSize: 10, padding: "1px 6px"}}>{g.count} assessee{g.count > 1 ? "s" : ""}</span>}
              </div>
              <div style={{fontWeight: 700, fontSize: 13}}>{fmtINR(g.amount)}</div>
            </div>
            <div style={{height: 8, borderRadius: 4, background: "var(--p-card-tint)", overflow: "hidden"}}>
              <div style={{height: "100%", width: `${Math.max(4, (g.amount / max) * 100)}%`, background: palette[i % palette.length], borderRadius: 4, transition: "width 0.6s ease"}}/>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, delta, deltaKind, icon, iconBg, iconColor, glow, goLabel, onClick }) {
  return (
    <div
      className={`stat ${onClick ? "clickable" : ""}`}
      style={glow ? { "--stat-glow": glow } : undefined}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
      title={onClick ? `Open ${goLabel || label}` : undefined}
    >
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
      {onClick && <span className="stat-go">{goLabel || "View"} <Icon name="arrow-right" size={11}/></span>}
    </div>
  );
}

function MiniCalendar({ hearings, onNav }) {
  const now = new Date();
  const [month, setMonth] = React.useState(new Date(now.getFullYear(), now.getMonth(), 1));

  const year = month.getFullYear();
  const m = month.getMonth();
  const daysInMonth = new Date(year, m + 1, 0).getDate();
  const mondayOffset = (new Date(year, m, 1).getDay() + 6) % 7;
  const monthPrefix = toISO(month).slice(0, 7);
  const eventDays = new Set(hearings.filter(h => (h.date || "").startsWith(monthPrefix)).map(h => new Date(h.date + "T00:00:00").getDate()));
  const isCurrentMonth = now.getFullYear() === year && now.getMonth() === m;
  const today = now.getDate();

  const cells = [];
  for (let i = 0; i < mondayOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  return (
    <div className="cal">
      <div className="cal-head">
        <div>
          <div style={{fontWeight: 800, fontSize: 17, letterSpacing: "-0.02em"}}>{month.toLocaleString("en-IN", { month: "long", year: "numeric" })}</div>
          <div className="card-sub">{eventDays.size ? `${eventDays.size} day${eventDays.size > 1 ? "s" : ""} with hearings` : "No hearings this month"}</div>
        </div>
        <div className="center" style={{gap: 4}}>
          <button className="icon-btn" style={{width: 30, height: 30, borderRadius: 9}} onClick={() => setMonth(new Date(year, m - 1, 1))}><Icon name="chevron-left" size={14}/></button>
          <button className="icon-btn" style={{width: 30, height: 30, borderRadius: 9}} onClick={() => setMonth(new Date(year, m + 1, 1))}><Icon name="chevron-right" size={14}/></button>
        </div>
      </div>
      <div className="cal-grid">
        {["M","T","W","T","F","S","S"].map((d, i) => <div key={i} className="cal-dow">{d}</div>)}
        {cells.map((d, i) => {
          if (d === null) return <div key={i} className="cal-cell muted"/>;
          const hasEvent = eventDays.has(d);
          return (
            <div
              key={i}
              className={`cal-cell ${isCurrentMonth && d === today ? "today" : ""} ${hasEvent ? "has-event" : ""}`}
              onClick={() => onNav("hearings")}
            >{d}</div>
          );
        })}
      </div>
      <div className="row" style={{marginTop: 14, gap: 10}}>
        <div className="center" style={{gap: 6, fontSize: 11, color: "var(--p-text-3)"}}>
          <div style={{width: 7, height: 7, borderRadius: "50%", background: "var(--p-primary)"}}/>Hearing
        </div>
        <button className="btn btn-ghost btn-xs" style={{marginLeft: "auto"}} onClick={() => onNav("hearings")}>Open calendar →</button>
      </div>
    </div>
  );
}

function AuthorityMixCard({ matters }) {
  const palette = { "Scrutiny": "#6C5CE7", "CIT(A)": "#8E7CFF", "ITAT": "#FFB3D9", "Penalty": "#FFD17A" };
  const byType = {};
  matters.forEach(mt => { byType[mt.type] = (byType[mt.type] || 0) + 1; });
  const data = Object.entries(byType).map(([label, value], i) => ({
    label, value,
    color: palette[label] || ["#8EE7BC", "#B8A8FF", "#FFC9A3"][i % 3],
  }));
  const total = data.reduce((s, d) => s + d.value, 0);
  const C = 2 * Math.PI * 36;
  let offset = 0;

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">Authority-wise matters</div>
          <div className="card-sub">{total} active</div>
        </div>
      </div>
      {total === 0 ? (
        <div className="muted" style={{fontSize: 13, padding: "14px 0", textAlign: "center"}}>No active matters yet.</div>
      ) : (
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
      )}
    </div>
  );
}

