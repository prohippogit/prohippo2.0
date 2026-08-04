/*
 * ProHippo — Intimations & rectification orders (CPC).
 *
 * Every s.143(1) intimation and s.154 order the portal sync has ever brought
 * in, as a place to WORK rather than a place to look.
 *
 * WHY THIS IS NOT THE RETURNS TAB AND NOT THE DASHBOARD CARD. The three answer
 * different questions and the difference is the whole design:
 *
 *   dashboard card    "what landed recently that I have not seen?" — an alert,
 *                     six months, dismissible, deliberately small
 *   Returns tab       "what does THIS client's file look like?" — one assessee,
 *                     by assessment year, alongside the ITR and the ITR-V
 *   this page         "what does my practice owe its clients?" — every client,
 *                     every year, each intimation carrying a decision
 *
 * GROUPED BY CLIENT by default, because that is how the work is actually done:
 * you ring one assessee about all their years, not one year about all your
 * clients. The by-cause grouping is the other half of it and earns its keep on
 * a different axis — fourteen clients hit by the same CPC adjustment is ONE
 * legal position to research and ONE template to write, not fourteen jobs.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 *   No client messaging. A sync can pull a dozen new PANs at once, and a screen
 *   that could fire messages off the back of that is a screen that will one day
 *   message a dozen clients nobody meant to contact. Communications stay where
 *   a human starts them one at a time.
 *
 *   No s.220(2) interest projection. It would be our arithmetic sitting next to
 *   figures the department actually stated, and on this screen those two must
 *   never be confusable.
 */
import React from "react";
import { Icon, EmptyState, titleCase, fmtINR, fmtDate, fmtDateLong } from "./shared";
import { useData } from "./store";
import { openFromStorage } from "./downloadFile";
import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase";
import {
  allIntimations, groupByAssessee, groupByCause, practiceSummary, matchesFilter,
  clocksFor, refundPosition, describeVariance, SECTION_LABEL,
  DECISIONS, CAUSES, CAUSE_LABEL, FILTERS, REFUND_CHASE_DAYS,
  changedLines, readingTrust, pendingCauseSuggestion,
} from "./intimations";

const FLAG_TONE = {
  red: { bg: "#FDECEC", fg: "#B23B3B" },
  green: { bg: "#E7F7F0", fg: "#13795C" },
  neutral: { bg: "var(--p-line-2)", fg: "var(--p-text-3)" },
  unknown: { bg: "#FFF3D6", fg: "#B07512" },
};

const URGENCY_TONE = { lapsed: "#B23B3B", urgent: "#B23B3B", soon: "#B07512", open: "var(--p-text-3)", none: "var(--p-text-3)" };

export default function Intimations({ onOpenAssessee }) {
  const { data, updateReturn, notify } = useData();
  const [filter, setFilter] = React.useState("All");
  const [grouping, setGrouping] = React.useState("client");
  const [open, setOpen] = React.useState(() => new Set());
  const [busy, setBusy] = React.useState(false);

  const rows = React.useMemo(() => allIntimations({ returns: data.returns }), [data.returns]);
  const visible = React.useMemo(() => rows.filter((r) => matchesFilter(r, filter)), [rows, filter]);
  const summary = React.useMemo(() => practiceSummary(rows), [rows]);

  const toggle = (key) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  /* One write per change, merged into the map on the return document.
   *
   * Recording a decision also ticks the order off the dashboard card: an
   * intimation somebody has decided about is not "awaiting review" any more,
   * and leaving it on the card would teach people to ignore the card. */
  const setTracking = async (row, patch) => {
    if (busy) return;
    setBusy(true);
    try {
      const ret = data.returns.find((r) => r.id === row.returnId) || {};
      const tracking = ret.intimationTracking || {};
      const write = {
        intimationTracking: {
          ...tracking,
          [row.commRefNo]: { ...(tracking[row.commRefNo] || {}), ...patch, updatedAt: new Date().toISOString() },
        },
      };
      if (patch.decision && patch.decision !== "pending") {
        write.varianceReviewed = { ...(ret.varianceReviewed || {}), [row.commRefNo]: true };
      }
      await updateReturn(row.returnId, write);
    } finally {
      setBusy(false);
    }
  };

  /* Read one order's comparison table. ON DEMAND ONLY — one button, one order,
     one paid call. There is deliberately no "read them all": a practice with
     200 clients would be a thousand reads nobody asked for, and the value of
     this is in the handful that are actually in dispute. */
  const [reading, setReading] = React.useState("");
  const readOrder = async (row) => {
    if (reading) return;
    setReading(row.key);
    try {
      await httpsCallable(functions, "readIntimationOrder", { timeout: 120000 })({
        returnId: row.returnId, commRefNo: row.commRefNo,
      });
      notify("Order read — check the breakdown against the PDF");
    } catch (e) {
      notify(e?.message?.slice(0, 140) || "Couldn't read that order", "alert");
    } finally {
      setReading("");
    }
  };

  const viewPdf = async (row) => {
    try {
      await openFromStorage(row.storagePath);
    } catch {
      notify("That order PDF could not be opened", "alert");
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

  const groups = grouping === "client" ? groupByAssessee(visible) : groupByCause(visible);

  return (
    <div className="animate-in">
      <Topbar summary={summary}/>

      <div className="grid-stats" style={{gap: 14, marginBottom: 18}}>
        <Stat label="Needs a decision" value={summary.pending} sub={`${summary.assessees} assessee${summary.assessees !== 1 ? "s" : ""} in all`} color="#B07512"/>
        <Stat label="More payable" value={fmtINR(summary.additionalDemand)} sub="than the returns claimed" color="#B23B3B"/>
        <Stat label="In the assessee's favour" value={fmtINR(summary.extraRefund)} sub="over the returns claimed" color="#13795C"/>
        <Stat
          label="Refund awaited"
          value={summary.refundAwaited + summary.refundOverdue}
          sub={summary.refundOverdue ? `${summary.refundOverdue} over ${REFUND_CHASE_DAYS} days` : "determined, not yet received"}
          color={summary.refundOverdue ? "#B23B3B" : "var(--p-text-2)"}
        />
      </div>

      {(summary.appealLapsing > 0 || summary.disposalOverdue > 0) && (
        <div className="card" style={{marginBottom: 18, borderLeft: "3px solid #B23B3B", padding: "14px 18px"}}>
          <div className="center" style={{gap: 8, justifyContent: "flex-start", flexWrap: "wrap"}}>
            <Icon name="alert" size={15}/>
            <span style={{fontWeight: 700, fontSize: 13.5}}>
              {summary.appealLapsing > 0 && `${summary.appealLapsing} appeal window${summary.appealLapsing > 1 ? "s" : ""} closing within 7 days`}
              {summary.appealLapsing > 0 && summary.disposalOverdue > 0 && " · "}
              {summary.disposalOverdue > 0 && `${summary.disposalOverdue} rectification${summary.disposalOverdue > 1 ? "s" : ""} past the s.154(8) six-month limit`}
            </span>
          </div>
          {/* Said plainly, because this is the trap: the 154 window stays open
              for four years and the appeal window does not, so it is the appeal
              that gets lost while everyone assumes rectification will do. */}
          <div className="muted" style={{fontSize: 12, marginTop: 6}}>
            Rectification u/s 154 stays open for four years; the appeal to CIT(A) does not. Letting it lapse should be a decision, not an oversight.
          </div>
        </div>
      )}

      <div className="between" style={{marginBottom: 12, gap: 10, flexWrap: "wrap"}}>
        <div className="row" style={{gap: 6, flexWrap: "wrap"}}>
          {FILTERS.map((f) => (
            <span key={f} className={`fchip ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>{f}</span>
          ))}
        </div>
        <div className="row" style={{gap: 6}}>
          <span className={`fchip ${grouping === "client" ? "active" : ""}`} onClick={() => setGrouping("client")}>By client</span>
          <span className={`fchip ${grouping === "cause" ? "active" : ""}`} onClick={() => setGrouping("cause")}
            title="Every client hit by the same CPC adjustment — one position to research, not one per client">
            By cause
          </span>
        </div>
      </div>

      {visible.length === 0 && (
        <div className="card"><EmptyState icon="check" title={`Nothing under “${filter}”`} sub="Try another filter, or All."/></div>
      )}

      <div className="col" style={{gap: 12}}>
        {groups.map((g) => {
          const key = grouping === "client" ? g.key : `cause:${g.cause}`;
          const isOpen = open.has(key) || groups.length === 1;
          return (
            <div key={key} className="card" style={{padding: 0, overflow: "hidden"}}>
              <div
                className="between"
                style={{padding: "14px 18px", cursor: "pointer", gap: 12, alignItems: "center", flexWrap: "wrap"}}
                role="button"
                tabIndex={0}
                onClick={() => toggle(key)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(key); } }}
              >
                <div style={{minWidth: 200}}>
                  <div style={{fontSize: 15, fontWeight: 800, letterSpacing: "-0.01em"}}>
                    {grouping === "client" ? (titleCase(g.assessee) || g.pan || "—") : g.label}
                  </div>
                  <div className="muted" style={{fontSize: 11.5, marginTop: 2}}>
                    {grouping === "client"
                      ? <>{g.pan || "PAN not on file"} · {g.count} order{g.count !== 1 ? "s" : ""} · A.Y. {g.years.join(", ") || "—"}</>
                      : <>{g.assessees} assessee{g.assessees !== 1 ? "s" : ""} · {g.count} order{g.count !== 1 ? "s" : ""}</>}
                  </div>
                </div>
                <div className="center" style={{gap: 8, flexWrap: "wrap"}}>
                  {g.pending > 0 && <span className="pill" style={{background: "#FFF3D6", color: "#B07512"}}>{g.pending} to decide</span>}
                  {g.atStake > 0 && <span className="pill" style={{background: "#FDECEC", color: "#B23B3B"}}>{fmtINR(g.atStake)} more payable</span>}
                  {grouping === "client" && g.assesseeId && (
                    <button className="btn btn-ghost btn-xs" title="Open this assessee" onClick={(e) => { e.stopPropagation(); onOpenAssessee(g.assesseeId); }}>
                      <Icon name="arrow-right" size={12}/>Open
                    </button>
                  )}
                  <Icon name={isOpen ? "chevron-up" : "chevron-down"} size={14}/>
                </div>
              </div>

              {isOpen && (
                <div style={{borderTop: "1px solid var(--p-line-2)"}}>
                  {g.rows.map((row) => (
                    <IntimationRow
                      key={row.key}
                      row={row}
                      showAssessee={grouping === "cause"}
                      busy={busy}
                      readingNow={reading === row.key}
                      onTrack={(patch) => setTracking(row, patch)}
                      onViewPdf={() => viewPdf(row)}
                      onRead={() => readOrder(row)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Topbar({ summary }) {
  return (
    <div className="topbar">
      <div>
        <div className="page-title">Intimations &amp; rectifications</div>
        <div className="page-sub">
          {summary.total
            ? <>{summary.total} order{summary.total !== 1 ? "s" : ""} from CPC across {summary.assessees} assessee{summary.assessees !== 1 ? "s" : ""}{summary.pending ? <> · <b style={{color: "#B07512"}}>{summary.pending} awaiting a decision</b></> : " · all decided"}</>
            : "Everything CPC has issued u/s 143(1) and u/s 154, compared against the return as filed"}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, color }) {
  return (
    <div className="card" style={{padding: "14px 16px"}}>
      <div className="muted" style={{fontSize: 11, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase"}}>{label}</div>
      <div style={{fontSize: 21, fontWeight: 800, marginTop: 3, color: color || "inherit", letterSpacing: "-0.02em"}}>{value}</div>
      <div className="muted" style={{fontSize: 11.5, marginTop: 2}}>{sub}</div>
    </div>
  );
}

/* One order: what it did, what is still open, and what we have decided.
 *
 * The variance and its baseline sit on the collapsed line because they are the
 * whole point; the clocks and the tracking fields open on demand, because a
 * list where every row is six lines tall is a list nobody scrolls. */
function IntimationRow({ row, showAssessee, busy, readingNow, onTrack, onViewPdf, onRead }) {
  const [open, setOpen] = React.useState(false);
  const v = row.variance;
  const tone = FLAG_TONE[v?.flag] || FLAG_TONE.unknown;
  const clocks = clocksFor(row);
  const refund = refundPosition(row);
  const signed = v && v.amount != null && v.flag !== "neutral" && v.flag !== "unknown"
    ? `${v.amount < 0 ? "−" : "+"}${fmtINR(Math.abs(v.amount))}`
    : null;

  // The appeal clock is only worth shouting about while the appeal is still a
  // live option: a red variance nobody has decided on yet.
  const appealLive = v?.flag === "red" && row.decision === "pending" && clocks.appeal.deadline;

  return (
    <div style={{padding: "12px 18px", borderTop: "1px solid var(--p-line-2)"}}>
      <div className="center" style={{gap: 12, flexWrap: "wrap"}}>
        <div style={{flex: 1, minWidth: 210}}>
          <div className="center" style={{gap: 7, justifyContent: "flex-start", flexWrap: "wrap"}}>
            {showAssessee && <span style={{fontWeight: 800, fontSize: 13.5, color: "var(--p-primary-2)"}}>{titleCase(row.assessee) || row.pan}</span>}
            <span className="pill pill-muted" title={SECTION_LABEL[row.section] || ""}>u/s {row.section}</span>
            <span style={{fontWeight: 700, fontSize: 13}}>A.Y. {row.ay || "—"}</span>
            <span className="muted" style={{fontSize: 11.5}}>
              {row.orderDate ? fmtDate(row.orderDate) : "date not stated"}
            </span>
            {v?.adjusted && (
              <span className="pill pill-muted" title="CPC set this refund off against an earlier demand u/s 245">adjusted u/s 245</span>
            )}
          </div>
          <div style={{fontSize: 12.5, marginTop: 4, color: v?.flag === "unknown" ? "var(--p-text-3)" : "var(--p-text-2)"}}>
            {describeVariance(v)}{row.statusDesc ? ` · ${row.statusDesc}` : ""}
          </div>
          {/* What the order itself says moved. Only shown once the read has been
              checked against the portal's own figure — an unreconciled headline
              is exactly the kind of confident sentence nobody should skim. */}
          {row.reading?.headline && readingTrust(row.reading) === "ok" && (
            <div className="center" style={{gap: 6, marginTop: 4, justifyContent: "flex-start"}}>
              <Icon name="sparkle" size={11}/>
              <span style={{fontSize: 12.5, fontWeight: 600, color: "var(--p-primary-2)"}}>{row.reading.headline}</span>
            </div>
          )}
          {(appealLive || refund.state === "overdue" || clocks.disposal?.overdue) && (
            <div className="center" style={{gap: 10, marginTop: 5, justifyContent: "flex-start", flexWrap: "wrap"}}>
              {appealLive && (
                <span style={{fontSize: 11.5, fontWeight: 700, color: URGENCY_TONE[clocks.appeal.urgency]}}>
                  {clocks.appeal.daysLeft < 0
                    ? `Appeal window closed ${Math.abs(clocks.appeal.daysLeft)} days ago`
                    : `Appeal to CIT(A) — ${clocks.appeal.daysLeft} day${clocks.appeal.daysLeft !== 1 ? "s" : ""} left`}
                </span>
              )}
              {refund.state === "overdue" && (
                <span style={{fontSize: 11.5, fontWeight: 700, color: "#B23B3B"}}>
                  Refund {fmtINR(refund.amount)} not received — {refund.days} days
                </span>
              )}
              {clocks.disposal?.overdue && (
                <span style={{fontSize: 11.5, fontWeight: 700, color: "#B23B3B"}}>
                  CPC past the s.154(8) limit ({fmtDate(clocks.disposal.deadline)})
                </span>
              )}
            </div>
          )}
        </div>

        <div style={{textAlign: "right", minWidth: 104}}>
          <span style={{display: "inline-block", background: tone.bg, color: tone.fg, borderRadius: 8, padding: "4px 9px", fontWeight: 800, fontSize: 13}}>
            {signed || (v?.flag === "neutral" ? "Agrees" : v?.flag === "unknown" || !v ? "Not compared" : "—")}
          </span>
        </div>

        <select
          value={row.decision}
          disabled={busy}
          title="What are we doing about this one?"
          onChange={(e) => onTrack({ decision: e.target.value })}
          style={{padding: "6px 8px", borderRadius: 9, border: "1px solid var(--p-line)", fontSize: 12.5, minWidth: 168}}
        >
          {DECISIONS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
        </select>

        {row.storagePath && !row.locked ? (
          <>
            <button className="btn btn-ghost btn-xs" title="Open the order PDF" onClick={onViewPdf}><Icon name="doc" size={12}/>PDF</button>
            {/* One order, one paid read, only when asked. A read already on file
                is re-runnable — CPC formats change and a bad read should not be
                permanent — but it never happens on its own. */}
            <button
              className="btn btn-ghost btn-xs"
              disabled={readingNow}
              title={row.reading
                ? "Read this order again — replaces the breakdown below"
                : "Read the order's comparison table and show which line moved"}
              onClick={onRead}
            >
              <Icon name="sparkle" size={12}/>{readingNow ? "Reading…" : row.reading ? "Re-read" : "Read order"}
            </button>
          </>
        ) : (
          <span className="muted" style={{fontSize: 11}} title={row.lockReason || "No readable PDF on file"}>No PDF</span>
        )}

        <button className="icon-btn" style={{width: 26, height: 26}} title={open ? "Hide detail" : "Deadlines, cause and tracking"} onClick={() => setOpen(!open)}>
          <Icon name={open ? "chevron-up" : "chevron-down"} size={13}/>
        </button>
      </div>

      {open && (
        <div className="row" style={{gap: 20, marginTop: 12, paddingLeft: 2, flexWrap: "wrap", alignItems: "flex-start"}}>
          <div style={{flex: "1 1 280px", minWidth: 250}}>
            <Eyebrow>Remedies &amp; limitation</Eyebrow>
            <Clock
              label={`Appeal to CIT(A) — ${clocks.appeal.form || "Form 35"}`}
              deadline={clocks.appeal.deadline}
              note={clocks.appeal.label}
              daysLeft={clocks.appeal.daysLeft}
              urgency={clocks.appeal.urgency}
            />
            <Clock
              label="Rectification u/s 154"
              deadline={clocks.rectification.deadline}
              note={clocks.rectification.label}
              daysLeft={clocks.rectification.daysLeft}
              urgency={clocks.rectification.urgency}
            />
            {clocks.disposal && (
              <Clock
                label="CPC to dispose of our application"
                deadline={clocks.disposal.deadline}
                note={clocks.disposal.label}
                daysLeft={clocks.disposal.daysLeft}
                urgency={clocks.disposal.overdue ? "lapsed" : "open"}
              />
            )}
            <div className="muted" style={{fontSize: 10.5, marginTop: 8, lineHeight: 1.5}}>
              Dates computed from the order date on the portal. Verify against the order and the Act before relying on them.
            </div>
          </div>

          <div style={{flex: "1 1 300px", minWidth: 260}}>
            <Eyebrow>Why CPC differed</Eyebrow>
            <ReadingPanel row={row} busy={busy} readingNow={readingNow} onRead={onRead} onTrack={onTrack}/>
            <select
              value={row.cause}
              disabled={busy}
              onChange={(e) => onTrack({ cause: e.target.value })}
              style={{width: "100%", padding: "7px 9px", borderRadius: 9, border: "1px solid var(--p-line)", fontSize: 12.5}}
            >
              <option value="">Not yet tagged</option>
              {CAUSES.map((c) => <option key={c.id} value={c.id}>{c.label}{c.statute ? ` — s.${c.statute}` : ""}</option>)}
            </select>
            <div className="muted" style={{fontSize: 11, marginTop: 6, lineHeight: 1.5}}>
              Tagging pays off across the practice: switch to <b>By cause</b> and every client hit by the same adjustment is one list, to be answered once.
            </div>
          </div>

          <div style={{flex: "1 1 240px", minWidth: 220}}>
            <Eyebrow>Tracking</Eyebrow>
            {(row.decision === "rectify" || row.tracking?.rectFiledOn) && (
              <>
                <FieldRow label="Rectification filed on">
                  <input type="date" value={row.tracking?.rectFiledOn || ""} disabled={busy}
                    onChange={(e) => onTrack({ rectFiledOn: e.target.value })}/>
                </FieldRow>
                <FieldRow label="Request no.">
                  <input type="text" value={row.tracking?.rectRequestNo || ""} disabled={busy} placeholder="from the portal"
                    onChange={(e) => onTrack({ rectRequestNo: e.target.value })}/>
                </FieldRow>
              </>
            )}
            {refund.state !== "none" && refund.state !== "adjusted" && (
              <FieldRow label="Refund received on">
                <input type="date" value={row.tracking?.refundReceivedOn || ""} disabled={busy}
                  onChange={(e) => onTrack({ refundReceivedOn: e.target.value })}/>
              </FieldRow>
            )}
            {refund.state === "adjusted" && (
              <div className="muted" style={{fontSize: 11.5, lineHeight: 1.5}}>
                Refund of {fmtINR(refund.amount)} set off in full against an earlier demand u/s 245 — nothing is due to the client.
              </div>
            )}
            <FieldRow label="Note">
              <input type="text" value={row.tracking?.note || ""} disabled={busy} placeholder="for your own record"
                onChange={(e) => onTrack({ note: e.target.value })}/>
            </FieldRow>
            <div className="muted" style={{fontSize: 10.5, marginTop: 6}}>
              CPC ref. <span style={{fontFamily: "ui-monospace, monospace"}}>{row.commRefNo}</span>
              {row.emailedOn ? ` · e-mailed ${fmtDateLong(row.emailedOn)}` : ""}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const Eyebrow = ({ children }) => (
  <div className="pm-eyebrow" style={{fontSize: 10.5, fontWeight: 800, letterSpacing: ".05em", textTransform: "uppercase", marginBottom: 8, color: "var(--p-text-3)"}}>
    {children}
  </div>
);

function FieldRow({ label, children }) {
  return (
    <label style={{display: "block", marginBottom: 8}}>
      <div className="muted" style={{fontSize: 11, marginBottom: 3}}>{label}</div>
      {React.cloneElement(children, {
        style: {width: "100%", padding: "6px 8px", borderRadius: 8, border: "1px solid var(--p-line)", fontSize: 12.5},
      })}
    </label>
  );
}

function Clock({ label, deadline, note, daysLeft, urgency }) {
  if (!deadline) {
    return (
      <div style={{marginBottom: 10}}>
        <div style={{fontSize: 12.5, fontWeight: 700}}>{label}</div>
        <div className="muted" style={{fontSize: 11.5}}>No date on the order, so this cannot be computed.</div>
      </div>
    );
  }
  const colour = URGENCY_TONE[urgency] || "var(--p-text-3)";
  return (
    <div style={{marginBottom: 10}}>
      <div className="between" style={{gap: 8, alignItems: "baseline"}}>
        <span style={{fontSize: 12.5, fontWeight: 700}}>{label}</span>
        <span style={{fontSize: 12.5, fontWeight: 800, color: colour, whiteSpace: "nowrap"}}>
          {fmtDate(deadline)}
        </span>
      </div>
      <div className="muted" style={{fontSize: 11}}>
        {note}
        {daysLeft != null && (
          <span style={{color: colour, fontWeight: 700}}>
            {" · "}{daysLeft < 0 ? `${Math.abs(daysLeft)} days past` : `${daysLeft} days left`}
          </span>
        )}
      </div>
    </div>
  );
}

/* What the order's own comparison table says, once somebody has asked for it.
 *
 * THE TRUST BANNER IS NOT DECORATION. The figures here were read by a model out
 * of a PDF, and the one thing that makes them safe to look at is that the
 * order's own bottom line was checked against the figure the portal separately
 * recorded. Where those agree the table is shown plainly; where they do not it
 * is shown under a warning, because a practitioner will otherwise advise a
 * client off a number nobody verified. There is no middle setting on purpose —
 * "probably right" would be read as "right". */
function ReadingPanel({ row, busy, readingNow, onRead, onTrack }) {
  const reading = row.reading;

  if (!reading) {
    return (
      <div style={{marginBottom: 10}}>
        <div className="muted" style={{fontSize: 11.5, lineHeight: 1.5, marginBottom: 7}}>
          The order prints the return's figures against CPC's, side by side. Reading it shows which line moved
          {row.storagePath && !row.locked ? "" : " — but there is no readable PDF for this one"}.
        </div>
        <button className="btn btn-secondary btn-xs" disabled={readingNow || !row.storagePath || row.locked} onClick={onRead}>
          <Icon name="sparkle" size={12}/>{readingNow ? "Reading…" : "Read the order"}
        </button>
      </div>
    );
  }

  const trust = readingTrust(reading);
  const moved = changedLines(reading);
  const suggestion = pendingCauseSuggestion(row);

  return (
    <div style={{marginBottom: 10}}>
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
            <thead>
              <tr>
                <th>Head</th>
                <th style={{textAlign: "right"}}>As returned</th>
                <th style={{textAlign: "right"}}>As computed</th>
              </tr>
            </thead>
            <tbody>
              {moved.map((l, i) => {
                const diff = l.asComputed - l.asReturned;
                return (
                  <tr key={`${l.head}-${i}`}>
                    <td>
                      {l.head}
                      {l.remark && <div className="muted" style={{fontSize: 10.5}}>{l.remark}</div>}
                    </td>
                    <td style={{textAlign: "right", whiteSpace: "nowrap"}}>{fmtINR(l.asReturned)}</td>
                    <td style={{textAlign: "right", whiteSpace: "nowrap", color: diff < 0 ? "#B23B3B" : "#13795C", fontWeight: 700}}>
                      {fmtINR(l.asComputed)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="muted" style={{fontSize: 11.5}}>
          The read found no line where the two columns differ. If the order plainly shows one, re-read it or open the PDF.
        </div>
      )}

      {/* A suggested tag is a suggestion until somebody says otherwise. It has
          to be accepted before it counts, because the by-cause grouping is what
          decides which clients get treated as sharing one legal position. */}
      {suggestion && (
        <div className="center" style={{gap: 8, marginTop: 10, padding: "8px 10px", background: "var(--p-card-tint)", borderRadius: 9, flexWrap: "wrap"}}>
          <span style={{fontSize: 11.5}}>
            Suggested cause: <b>{CAUSE_LABEL[suggestion]}</b>
          </span>
          <button className="btn btn-primary btn-xs" style={{marginLeft: "auto"}} disabled={busy} onClick={() => onTrack({ cause: suggestion })}>
            <Icon name="check" size={11}/>Accept
          </button>
        </div>
      )}

      <div className="muted" style={{fontSize: 10.5, marginTop: 8, lineHeight: 1.5}}>
        Read from the order PDF on {fmtDateLong(String(reading.at || "").slice(0, 10))}. Verify against the order before acting on it.
        {" "}
        <button className="btn btn-ghost btn-xs" disabled={readingNow} onClick={onRead} style={{padding: "2px 6px"}}>Re-read</button>
      </div>
    </div>
  );
}
