import React from 'react';
import { Icon, Avatar, StatusPill, EmptyState, fmtINR, fmtDate, fmtDateLong, fmtLakhs, daysFromNow } from './shared';
import { useData, assesseeStats, upcomingHearings, invoiceStatus, invoiceOutstanding, fyOf, todayISO } from './store';
import { MatterModal } from './Other';
import { AssesseeModal } from './AssesseeModal';
import { httpsCallable } from 'firebase/functions';
import { ref as storageRef, uploadString, getDownloadURL } from 'firebase/storage';
import { functions, storage, auth } from './firebase';
import { detectExtension, openPortalLogin, onSyncData } from './portalSync';
import { ingestPortalSyncMessage } from './portalIngest';

// Open a Storage-hosted notice/order PDF in a new tab.
async function openStoragePdf(storagePath) {
  if (!storagePath) return;
  try {
    const url = await getDownloadURL(storageRef(storage, storagePath));
    window.open(url, "_blank", "noopener");
  } catch (e) {
    console.error("open pdf", e);
  }
}

export { AssesseeModal };

// The portal sends submittedOn as epoch millis; render it as a readable date.
function fmtSubmitted(v) {
  const n = Number(v);
  if (!v || Number.isNaN(n)) return String(v || "");
  try { return new Date(n).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }); }
  catch { return String(v); }
}

// Responses the assessee filed against a notice — remarks text + downloadable
// attachment PDFs. Shared by the Matters view and the per-assessee Notices tab
// so the two never drift apart.
function ResponsesBlock({ responses, plain }) {
  const list = responses || [];
  if (list.length === 0) return null;
  return (
    <div style={{marginTop: plain ? 0 : 8, borderTop: plain ? "none" : "1px dashed var(--p-line)", paddingTop: plain ? 0 : 8}}>
      <div className="muted" style={{fontSize: 10.5, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", marginBottom: 5}}>
        Response{list.length > 1 ? "s" : ""} filed
      </div>
      <div className="col" style={{gap: 8}}>
        {list.map((rsp, ri) => (
          <div key={ri} style={{padding: "8px 10px", background: "var(--p-mint)", borderRadius: 8, fontSize: 12}}>
            <div className="center" style={{gap: 6, justifyContent: "flex-start", marginBottom: rsp.remarks ? 4 : 0}}>
              <Icon name="check" size={11}/>
              <span className="strong">{rsp.respType || "Response"}</span>
              {rsp.submittedOn && <span className="muted">· {fmtSubmitted(rsp.submittedOn)}</span>}
            </div>
            {rsp.remarks && <div style={{whiteSpace: "pre-wrap"}}>{rsp.remarks}</div>}
            {(rsp.attachments || []).filter((at) => at.storagePath).length > 0 && (
              <div className="row" style={{gap: 6, flexWrap: "wrap", marginTop: 6}}>
                {rsp.attachments.filter((at) => at.storagePath).map((at, ci) => (
                  <button key={ci} className="btn btn-ghost btn-xs" title={at.label ? `${at.label} — ${at.filename}` : at.filename} onClick={(e) => { e.stopPropagation(); openStoragePdf(at.storagePath); }}>
                    <Icon name="doc" size={11}/>{(at.label || at.filename || "PDF").slice(0, 26)}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const PAGE_SIZE = 25;

// Small readout of how the last portal sync was fetched + how long it took.
// "api" = the fast portal JSON path (approach a); "scrape" = screen fallback.
function SyncTiming({ info }) {
  const fast = info.via === "api";
  const ms = typeof info.ms === "number" ? info.ms : null;
  const bg = fast ? "var(--p-mint)" : "var(--p-card-tint)";
  const fg = fast ? "#1B8C5C" : "var(--p-primary-2)";
  const label = info.calibrating
    ? `API reached${ms != null ? ` in ${ms} ms` : ""} · mapping calibration pending`
    : fast
      ? `Portal API${ms != null ? ` · ${ms} ms` : ""}${typeof info.count === "number" ? ` · ${info.count} proceedings` : ""}`
      : `Screen scrape${typeof info.count === "number" ? ` · ${info.count} proceedings` : ""}`;
  return (
    <div className="center" style={{gap: 6, justifyContent: "flex-start", padding: "6px 10px", background: bg, color: fg, borderRadius: 9, fontSize: 11.5, fontWeight: 700, alignSelf: "flex-start"}}
         title={info.endpoint || undefined}>
      <Icon name={fast ? "sparkle" : "doc"} size={12}/>
      <span>{label}</span>
    </div>
  );
}

export function Assessees({ onOpen, initialSearch = "" }) {
  const { data, notify } = useData();
  const [tab, setTab] = React.useState("All");
  const [search, setSearch] = React.useState(initialSearch);
  const [page, setPage] = React.useState(1);
  const [showAdd, setShowAdd] = React.useState(false);
  const [selected, setSelected] = React.useState(() => new Set());
  const [bulk, setBulk] = React.useState(null); // { done, total, current } while a bulk sync runs
  const doneResolver = React.useRef(null);
  const running = React.useRef(false); // true only while a bulk sync is in progress

  React.useEffect(() => { setSearch(initialSearch); }, [initialSearch]);
  React.useEffect(() => { setPage(1); }, [tab, search]);

  // While a bulk sync runs, ingest each streamed message and advance the queue
  // when an assessee signals it's done.
  React.useEffect(() => {
    const off = onSyncData(async (payload) => {
      if (!payload || !running.current) return; // only while a bulk sync runs
      if (payload.kind === "sync-done") { const r = doneResolver.current; if (r) r(payload.assesseeId); return; }
      try { await ingestPortalSyncMessage(payload); } catch (e) { console.error("bulk ingest", e); }
    });
    return off;
  }, []);

  const toggle = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const syncableOnPage = () => pageRows.filter((a) => a.portalCredSet).map((a) => a.id);
  const allPageSelected = () => { const ids = syncableOnPage(); return ids.length > 0 && ids.every((id) => selected.has(id)); };
  const toggleAllPage = () => setSelected((s) => {
    const ids = syncableOnPage(); const n = new Set(s);
    if (ids.every((id) => n.has(id))) ids.forEach((id) => n.delete(id)); else ids.forEach((id) => n.add(id));
    return n;
  });

  const runBulkSync = async () => {
    const targets = data.assessees.filter((a) => selected.has(a.id) && a.portalCredSet);
    if (!targets.length) { notify("Select assessees that have a saved portal login.", "alert"); return; }
    if (!(await detectExtension())) { notify("Install the ProHippo Sync extension to sync from the portal.", "alert"); return; }
    running.current = true;
    for (let i = 0; i < targets.length; i++) {
      const a = targets[i];
      setBulk({ done: i, total: targets.length, current: a.name });
      try {
        const { data: cred } = await httpsCallable(functions, "getPortalCredential")({ assesseeId: a.id });
        const known = new Set();
        (data.notices || []).forEach((n) => { if (n.pan === a.pan) { if (n.din) known.add(n.din); if (n.docKey) known.add(n.docKey); } });
        const knownDins = [...known];
        const done = new Promise((resolve) => { doneResolver.current = resolve; });
        await openPortalLogin({ portalUserId: cred.portalUserId, portalPassword: cred.portalPassword, assesseeId: a.id, mode: "sync", knownDins, background: true });
        await Promise.race([done, new Promise((r) => setTimeout(r, 120000))]); // done or 2-min safety
        doneResolver.current = null;
        await new Promise((r) => setTimeout(r, 1500)); // small gap between logins
      } catch (e) {
        console.error("bulk sync", a.name, e);
        notify(`Couldn't sync ${a.name}${e?.message ? " — " + e.message.slice(0, 80) : ""}`, "alert");
      }
    }
    running.current = false;
    setBulk(null);
    setSelected(new Set());
    notify(`Bulk sync complete — ${targets.length} assessee${targets.length > 1 ? "s" : ""}`);
  };

  const matchesTab = (a) => {
    if (tab === "All") return true;
    if (tab === "Firm/LLP") return a.status === "Firm" || a.status === "LLP";
    return a.status === tab;
  };
  const q = search.toLowerCase();
  const filtered = data.assessees.filter(a =>
    matchesTab(a) &&
    (!q || a.name.toLowerCase().includes(q) || a.pan.toLowerCase().includes(q) || (a.group || "").toLowerCase().includes(q) || (a.mobile || "").includes(q))
  );
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const thisMonth = todayISO().slice(0, 7);
  const addedThisMonth = data.assessees.filter(a => (a.createdAt || "").startsWith(thisMonth)).length;

  const tabCount = (t) => data.assessees.filter(a => (t === "All" ? true : t === "Firm/LLP" ? a.status === "Firm" || a.status === "LLP" : a.status === t)).length;

  return (
    <div className="animate-in">
      <div className="topbar">
        <div>
          <div className="page-title">Assessees</div>
          <div className="page-sub">{data.assessees.length} active{addedThisMonth ? ` · ${addedThisMonth} added this month` : ""}</div>
        </div>
        <div className="topbar-actions">
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}><Icon name="plus" size={14}/>Add assessee</button>
        </div>
      </div>

      <div className="row" style={{justifyContent: "space-between", marginBottom: 16, alignItems: "center", flexWrap: "wrap", gap: 12}}>
        <div className="tabs">
          {["All", "Individual", "Company", "Firm/LLP", "HUF", "Trust"].map(t => (
            <div key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
              {t}
              <span style={{marginLeft: 6, opacity: 0.65, fontSize: 11}}>{tabCount(t)}</span>
            </div>
          ))}
        </div>
        <div className="center" style={{gap: 8}}>
          <div className="search" style={{width: 260}}>
            <Icon name="search" size={15}/>
            <input placeholder="Name, PAN, group, mobile…" value={search} onChange={e => setSearch(e.target.value)}/>
          </div>
        </div>
      </div>

      {data.assessees.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="users"
            title="No assessees yet"
            sub="Add your first assessee to start tracking matters, hearings, notices and fees."
            action={<button className="btn btn-primary" onClick={() => setShowAdd(true)}><Icon name="plus" size={14}/>Add assessee</button>}
          />
        </div>
      ) : (
        <>
          {(selected.size > 0 || bulk) && (
            <div className="card" style={{marginBottom: 12, padding: "12px 16px", background: "var(--p-card-tint)", border: "1px solid var(--p-primary-3)"}}>
              <div className="between" style={{alignItems: "center", flexWrap: "wrap", gap: 10}}>
                <div className="center" style={{gap: 10}}>
                  <Icon name="sparkle" size={15}/>
                  <span className="strong" style={{fontSize: 13.5}}>
                    {bulk
                      ? `Syncing ${bulk.done + 1} of ${bulk.total}${bulk.current ? ` — ${bulk.current}` : ""}…`
                      : `${selected.size} selected`}
                  </span>
                  {bulk && <span className="muted" style={{fontSize: 11.5}}>· running in the background, keep working</span>}
                </div>
                <div className="center" style={{gap: 8}}>
                  {!bulk && <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>Clear</button>}
                  <button className="btn btn-primary btn-sm" disabled={Boolean(bulk)} onClick={runBulkSync}>
                    <Icon name="sparkle" size={13}/>{bulk ? "Syncing…" : `Sync ${selected.size} from portal`}
                  </button>
                </div>
              </div>
              {!bulk && <div className="muted" style={{fontSize: 11.5, marginTop: 6}}>Only assessees with a saved portal login can be synced. Each opens, syncs and closes in turn.</div>}
            </div>
          )}
          <div className="card" style={{padding: 0, overflow: "hidden"}}>
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{width: 34}}>
                    <input type="checkbox" checked={allPageSelected()} onChange={toggleAllPage} title="Select all on this page with a portal login"/>
                  </th>
                  <th>Assessee</th>
                  <th>PAN</th>
                  <th>Status</th>
                  <th>Group</th>
                  <th>Active matters</th>
                  <th>Outstanding</th>
                  <th>Next hearing</th>
                  <th>Staff</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map(a => {
                  const s = assesseeStats(data, a);
                  const nextHearing = s.hearings[0];
                  return (
                    <tr key={a.id} onClick={() => onOpen(a)} style={{cursor: "pointer"}}>
                      <td onClick={(e) => e.stopPropagation()} style={{textAlign: "center"}}>
                        {a.portalCredSet
                          ? <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggle(a.id)} title="Select for portal sync"/>
                          : <span className="muted" title="No portal login saved" style={{fontSize: 11}}>—</span>}
                      </td>
                      <td>
                        <div className="center" style={{gap: 10}}>
                          <Avatar name={a.name} color={a.color} size="sm"/>
                          <div>
                            <div className="strong">{a.name}</div>
                            <div className="muted">{a.mobile || a.email || "—"}</div>
                          </div>
                        </div>
                      </td>
                      <td className="strong" style={{fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12.5}}>{a.pan}</td>
                      <td><span className="pill pill-muted">{a.status}</span></td>
                      <td className="semi">{a.group || "—"}</td>
                      <td>
                        <div className="center" style={{gap: 6}}>
                          <span className="strong">{s.matters}</span>
                          {s.hearings.length > 0 && <span className="pill pill-pink" style={{fontSize: 10, padding: "2px 6px"}}>{s.hearings.length} hearing{s.hearings.length > 1 ? "s" : ""}</span>}
                        </div>
                      </td>
                      <td>
                        {s.outstanding === 0
                          ? <span className="pill pill-success">Clear</span>
                          : <span className="strong" style={{color: s.outstanding > 100000 ? "#B8463A" : "var(--p-text)"}}>{fmtINR(s.outstanding)}</span>}
                      </td>
                      <td>
                        {nextHearing
                          ? <div>
                              <div className="strong" style={{fontSize: 12.5}}>{fmtDate(nextHearing.date)}</div>
                              <div className="muted">{nextHearing.authority}</div>
                            </div>
                          : <span className="muted">—</span>}
                      </td>
                      <td>
                        {a.staff
                          ? <div className="center" style={{gap: 6}}>
                              <Avatar name={a.staff} color="mint" size="sm"/>
                              <span style={{fontSize: 12}}>{a.staff.split(" ")[0]}</span>
                            </div>
                          : <span className="muted">—</span>}
                      </td>
                      <td><Icon name="chevron-right" size={16} className="muted"/></td>
                    </tr>
                  );
                })}
                {pageRows.length === 0 && (
                  <tr><td colSpan="10" style={{textAlign: "center", padding: 40, color: "var(--p-text-3)"}}>No assessees match this filter.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="between" style={{marginTop: 14}}>
            <div className="muted" style={{fontSize: 12.5}}>
              Showing {filtered.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length}
            </div>
            {pages > 1 && (
              <div className="center" style={{gap: 4}}>
                <button className="btn btn-secondary btn-sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}><Icon name="chevron-left" size={14}/></button>
                {Array.from({ length: pages }, (_, i) => i + 1).map(p => (
                  <button key={p} className={`btn ${p === page ? "btn-primary" : "btn-secondary"} btn-sm`} style={{minWidth: 32, justifyContent: "center"}} onClick={() => setPage(p)}>{p}</button>
                ))}
                <button className="btn btn-secondary btn-sm" disabled={page === pages} onClick={() => setPage(p => p + 1)}><Icon name="chevron-right" size={14}/></button>
              </div>
            )}
          </div>
        </>
      )}

      {showAdd && <AssesseeModal onClose={() => setShowAdd(false)}/>}
    </div>
  );
}

export function AssesseeProfile({ assessee, onBack, onNav }) {
  const { data, removeAssessee, updateAssessee, notify } = useData();
  const [tab, setTab] = React.useState("Overview");
  const [showEdit, setShowEdit] = React.useState(false);
  const [showMatter, setShowMatter] = React.useState(false);
  const [closedProceedings, setClosedProceedings] = React.useState([]); // popup after a sync
  const [focusReqId, setFocusReqId] = React.useState(null); // proceeding to expand in Matters
  const a = assessee;
  const s = assesseeStats(data, a);
  const hearings = upcomingHearings(data).filter(h => h.pan === a.pan);
  const allHearings = data.hearings.filter(h => h.pan === a.pan).sort((x, y) => y.date.localeCompare(x.date));
  const notices = data.notices.filter(n => n.pan === a.pan);
  const matters = data.matters.filter(m => m.pan === a.pan);
  const invoices = data.invoices.filter(i => i.assessee === a.name);
  const comms = data.communications.filter(c => c.to === a.name || c.to === a.email || c.to === a.mobile);

  const fy = fyOf(todayISO());
  const billedFY = invoices.filter(i => fyOf(i.date) === fy).reduce((sum, i) => sum + i.amount, 0);
  const receivedFY = invoices.filter(i => fyOf(i.date) === fy).reduce((sum, i) => sum + (i.received || 0), 0);

  const waLink = a.mobile ? `https://wa.me/${a.mobile.replace(/\D/g, "")}` : null;

  const doDelete = async () => {
    if (!window.confirm(`Delete ${a.name}? Their matters, hearings, notices, invoices and messages will also be removed. This cannot be undone.`)) return;
    onBack();
    const removed = await removeAssessee(a);
    if (removed !== null) {
      notify(removed > 0
        ? `${a.name} deleted along with ${removed} linked record${removed > 1 ? "s" : ""}`
        : `${a.name} deleted`);
    }
  };

  return (
    <div className="animate-in">
      <div className="center" style={{gap: 8, marginBottom: 16, fontSize: 13}}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}><Icon name="arrow-left" size={14}/>Back</button>
        <span className="muted">Assessees / </span>
        <span style={{fontWeight: 600}}>{a.name}</span>
      </div>

      <div className="card" style={{background: "linear-gradient(120deg, #F8F6FF 0%, #FFEDF5 100%)", border: "1px solid var(--p-line)"}}>
        <div className="between" style={{alignItems: "flex-start"}}>
          <div className="center" style={{gap: 16}}>
            <Avatar name={a.name} color={a.color} size="lg"/>
            <div>
              <div className="center" style={{gap: 8}}>
                <div style={{fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em"}}>{a.name}</div>
                <span className="pill pill-muted">{a.status}</span>
                {a.group && <span className="pill pill-primary">{a.group}</span>}
              </div>
              <div className="row" style={{gap: 18, marginTop: 8, fontSize: 13, color: "var(--p-text-2)"}}>
                <span><b style={{fontFamily: "ui-monospace, monospace"}}>{a.pan}</b></span>
                {a.mobile && <span><Icon name="phone" size={12}/> {a.mobile}</span>}
                {a.email && <span><Icon name="mail" size={12}/> {a.email}</span>}
              </div>
            </div>
          </div>
          <div className="center" style={{gap: 8}}>
            {waLink && <a className="btn btn-secondary btn-sm" href={waLink} target="_blank" rel="noreferrer"><Icon name="whatsapp" size={14}/>WhatsApp</a>}
            {a.email && <a className="btn btn-secondary btn-sm" href={`mailto:${a.email}`}><Icon name="mail" size={14}/>Email</a>}
            <button className="btn btn-primary btn-sm" onClick={() => setShowMatter(true)}><Icon name="plus" size={14}/>New matter</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setShowEdit(true)}><Icon name="edit" size={14}/>Edit</button>
            <button className="icon-btn" style={{width: 36, height: 36}} onClick={doDelete} title="Delete assessee"><Icon name="trash" size={15}/></button>
          </div>
        </div>
        <div className="grid-stats" style={{gap: 12, marginTop: 20}}>
          <MiniStat label="Active matters" value={s.matters} icon="scale"/>
          <MiniStat label="Upcoming hearings" value={hearings.length} icon="calendar" accent="pink"/>
          <MiniStat label="Outstanding" value={s.outstanding ? fmtINR(s.outstanding) : "—"} icon="wallet" accent={s.outstanding > 100000 ? "warn" : "default"}/>
          <MiniStat label="Notices on file" value={notices.length} icon="doc"/>
        </div>
      </div>

      <div className="utabs" style={{marginTop: 22}}>
        {["Overview","Matters","Hearings","Notices","Invoices","Communications","Notes"].map(t => (
          <div key={t} className={`utab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{t}</div>
        ))}
      </div>

      {tab === "Overview" && (
        <div className="grid-main">
          <div className="col" style={{gap: 18}}>
            <div className="card">
              <div className="card-head">
                <div className="card-title">Recent activity</div>
              </div>
              <Timeline data={data} assessee={a}/>
            </div>
            <div className="card">
              <div className="card-head">
                <div className="card-title">Upcoming hearings</div>
                <button className="btn btn-ghost btn-sm" onClick={() => onNav("hearings")}>View all</button>
              </div>
              <div className="col" style={{gap: 10}}>
                {hearings.length === 0 && <div className="muted" style={{fontSize: 13, padding: 8}}>No upcoming hearings.</div>}
                {hearings.map(h => {
                  const d = daysFromNow(h.date);
                  return (
                    <div key={h.id} className="hearing-card">
                      <div className={`hearing-date ${d <= 1 ? "urgent" : d <= 4 ? "warning" : ""}`}>
                        <div className="d">{new Date(h.date).getDate()}</div>
                        <div className="m">{new Date(h.date).toLocaleString("en-IN",{month:"short"})}</div>
                      </div>
                      <div style={{flex: 1}}>
                        <div className="between">
                          <div style={{fontWeight: 700}}>{h.authority} — {h.bench}</div>
                          <span className="pill pill-primary">AY {h.ay}</span>
                        </div>
                        <div className="muted" style={{fontSize: 12, marginTop: 3}}>
                          {h.ita || (h.section ? `u/s ${h.section}` : "")} · {h.mode} · <Icon name="clock" size={11}/>{h.time}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="col" style={{gap: 18}}>
            <PortalCard a={a} onAddLogin={() => setShowEdit(true)} onClosedProceedings={(list) => setClosedProceedings(list)}/>
            <div className="card">
              <div className="card-title mb-3">Particulars</div>
              <KV label="PAN" value={a.pan} mono/>
              <KV label="Status" value={a.status}/>
              <KV label="Group" value={a.group || "—"}/>
              <KV label="Mobile" value={a.mobile || "—"}/>
              <KV label="Email" value={a.email || "—"}/>
              <KV label="Address" value={a.address || "—"}/>
              <KV label="Assigned staff" value={a.staff || "—"}/>
            </div>
            <div className="card">
              <div className="card-title mb-3">Ledger snapshot · FY {fy}</div>
              <div className="row" style={{gap: 16}}>
                <MiniStat label="Billed" value={billedFY ? fmtLakhs(billedFY) : "—"} icon="invoice"/>
                <MiniStat label="Received" value={receivedFY ? fmtLakhs(receivedFY) : "—"} icon="wallet" accent="success"/>
              </div>
              <div className="mt-4" style={{borderTop: "1px dashed var(--p-line)", paddingTop: 14}}>
                <div className="between">
                  <div className="muted" style={{fontSize: 12}}>Outstanding</div>
                  <div style={{fontWeight: 800, fontSize: 18, color: s.outstanding ? "#C13388" : "var(--p-success)"}}>{s.outstanding ? fmtINR(s.outstanding) : "₹0"}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === "Matters" && (
        <MattersView matters={matters} notices={notices} hearings={allHearings} assesseeName={a.name} notify={notify} focusReqId={focusReqId}/>
      )}

      {tab === "Hearings" && (
        <div className="card" style={{padding: 0}}>
          <table className="tbl">
            <thead><tr><th>Date / Time</th><th>Authority</th><th>Bench</th><th>AY</th><th>Mode</th><th>Status</th></tr></thead>
            <tbody>
              {allHearings.map(h => (
                <tr key={h.id}>
                  <td><div className="strong">{fmtDateLong(h.date)}</div><div className="muted">{h.time}</div></td>
                  <td><span className="pill pill-primary">{h.authority}</span></td>
                  <td className="semi">{h.bench}</td>
                  <td>{h.ay}</td>
                  <td>{h.mode}</td>
                  <td><StatusPill status={h.date < todayISO() ? "Completed" : h.status}/></td>
                </tr>
              ))}
              {allHearings.length === 0 && <tr><td colSpan="6" style={{textAlign: "center", padding: 40, color: "var(--p-text-3)"}}>No hearings for {a.name} yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === "Notices" && (
        <div className="card" style={{padding: 0}}>
          <table className="tbl">
            <thead><tr><th>DIN</th><th>AY</th><th>Section</th><th>Authority</th><th>Date</th><th>Status</th></tr></thead>
            <tbody>
              {notices.map(n => (
                <React.Fragment key={n.id}>
                  <tr style={(n.responses || []).length > 0 ? {borderBottom: "none"} : undefined}>
                    <td className="muted" style={{fontFamily: "ui-monospace, monospace", fontSize: 11.5}}>
                      <div className="center" style={{gap: 6, justifyContent: "flex-start"}}>
                        <span>{n.din || "—"}</span>
                        {n.storagePath && (
                          <button className="btn btn-ghost btn-xs" title="Open notice / order PDF" onClick={() => openStoragePdf(n.storagePath)}>
                            <Icon name="doc" size={11}/>PDF
                          </button>
                        )}
                      </div>
                    </td>
                    <td>{n.ay}</td>
                    <td>{n.section ? <span className="pill pill-muted">u/s {n.section}</span> : "—"}</td>
                    <td>{n.authority}</td>
                    <td className="muted">{n.date ? fmtDateLong(n.date) : "—"}</td>
                    <td><StatusPill status={n.status}/></td>
                  </tr>
                  {(n.responses || []).length > 0 && (
                    <tr>
                      <td></td>
                      <td colSpan="5" style={{paddingTop: 0}}><ResponsesBlock responses={n.responses} plain/></td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
              {notices.length === 0 && <tr><td colSpan="6" style={{textAlign: "center", padding: 40, color: "var(--p-text-3)"}}>No notices for {a.name} yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === "Invoices" && (
        <div className="card" style={{padding: 0}}>
          <table className="tbl">
            <thead><tr><th>Invoice #</th><th>Date</th><th>Service</th><th>AY</th><th>Amount</th><th>Balance</th><th>Status</th></tr></thead>
            <tbody>
              {invoices.map(inv => (
                <tr key={inv.id}>
                  <td className="strong" style={{fontFamily: "ui-monospace, monospace", fontSize: 12.5}}>{inv.number}</td>
                  <td className="muted">{fmtDateLong(inv.date)}</td>
                  <td>{inv.service}</td>
                  <td>{inv.ay}</td>
                  <td className="strong">{fmtINR(inv.amount)}</td>
                  <td>{invoiceOutstanding(inv) ? fmtINR(invoiceOutstanding(inv)) : "—"}</td>
                  <td><StatusPill status={invoiceStatus(inv)}/></td>
                </tr>
              ))}
              {invoices.length === 0 && <tr><td colSpan="7" style={{textAlign: "center", padding: 40, color: "var(--p-text-3)"}}>No invoices yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === "Communications" && (
        <div className="card" style={{padding: 0}}>
          {comms.length === 0 && <EmptyState icon="chat" title="No messages logged" sub={`Messages sent to ${a.name} will appear here.`}/>}
          <div className="col">
            {comms.map(c => (
              <div key={c.id} className="row" style={{padding: "14px 18px", borderBottom: "1px solid var(--p-line-2)", gap: 12}}>
                <Icon name={c.channel === "WhatsApp" ? "whatsapp" : "mail"} size={16}/>
                <div style={{flex: 1}}>
                  <div className="strong" style={{fontSize: 13}}>{c.subject}</div>
                  <div className="muted" style={{fontSize: 11.5, marginTop: 2}}>{c.channel} · {new Date(c.time).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "Notes" && <NotesCard assessee={a} onSave={(notes) => { updateAssessee(a.id, { notes }); notify("Notes saved"); }}/>}

      {showEdit && <AssesseeModal initial={a} onClose={() => setShowEdit(false)}/>}
      {showMatter && <MatterModal initial={{ assessee: a.name, pan: a.pan, staff: a.staff }} onClose={() => setShowMatter(false)}/>}
      {closedProceedings.length > 0 && (
        <ClosedProceedingsModal
          items={closedProceedings}
          onClose={() => setClosedProceedings([])}
          onOpen={(reqId) => { setClosedProceedings([]); setTab("Matters"); setFocusReqId(reqId); }}
        />
      )}
    </div>
  );
}

/* Popup shown when a sync moves one or more proceedings to Closed. */
function ClosedProceedingsModal({ items, onClose, onOpen }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{maxWidth: 460, padding: "22px 26px"}} onClick={(e) => e.stopPropagation()}>
        <div className="center" style={{gap: 12, alignItems: "flex-start", marginBottom: 6}}>
          <div style={{width: 40, height: 40, borderRadius: 12, background: "var(--p-mint)", color: "#1B8C5C", display: "grid", placeItems: "center", flexShrink: 0}}>
            <Icon name="check" size={20}/>
          </div>
          <div>
            <div style={{fontSize: 17, fontWeight: 800}}>{items.length === 1 ? "A proceeding is now closed" : `${items.length} proceedings are now closed`}</div>
            <div className="card-sub" style={{marginTop: 2}}>Moved from “For your Action” to completed. An order may be available.</div>
          </div>
        </div>
        <div className="col" style={{gap: 8, marginTop: 12, maxHeight: 300, overflowY: "auto"}}>
          {items.map((it) => (
            <div key={it.proceedingReqId} className="between" style={{padding: "10px 12px", background: "var(--p-card-tint)", borderRadius: 10, alignItems: "center"}}>
              <div style={{minWidth: 0}}>
                <div className="strong" style={{fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{it.proceedingName || "Proceeding"}</div>
                <div className="muted" style={{fontSize: 11.5}}>{[it.type, it.ay ? `AY ${it.ay}` : ""].filter(Boolean).join(" · ")}</div>
              </div>
              <button className="btn btn-primary btn-sm" onClick={() => onOpen(it.proceedingReqId)}><Icon name="arrow-right" size={13}/>View order</button>
            </div>
          ))}
        </div>
        <div className="row" style={{marginTop: 16, justifyContent: "flex-end"}}>
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

/* Income-tax portal card — open e-Proceedings already logged in (Phase 1). */
function PortalCard({ a, onAddLogin, onClosedProceedings }) {
  const { data: appData, notify } = useData();
  const [hasExt, setHasExt] = React.useState(null); // null = checking
  const [busy, setBusy] = React.useState(false);
  // Last sync's method + timing (approach "a" readout). null until a sync runs.
  const [syncInfo, setSyncInfo] = React.useState(null);
  // Counters for the streamed notice documents (used to surface failures).
  const noticeStats = React.useRef({ ok: 0, fail: 0, lastNotify: 0 });

  const check = React.useCallback(() => {
    setHasExt(null);
    detectExtension().then(setHasExt);
  }, []);
  React.useEffect(() => {
    let alive = true;
    detectExtension().then((v) => { if (alive) setHasExt(v); });
    return () => { alive = false; };
  }, []);

  const launch = async (mode) => {
    if (busy) return;
    setBusy(true);
    try {
      const { data } = await httpsCallable(functions, "getPortalCredential")({ assesseeId: a.id });
      // Incremental sync: tell the extension which notice DINs we already have so
      // it skips re-downloading their PDFs (only NEW documents are fetched).
      const known = new Set();
      if (mode === "sync") (appData.notices || []).forEach((n) => { if (n.pan === a.pan) { if (n.din) known.add(n.din); if (n.docKey) known.add(n.docKey); } });
      const knownDins = [...known];
      await openPortalLogin({ portalUserId: data.portalUserId, portalPassword: data.portalPassword, assesseeId: a.id, mode, knownDins });
      notify(mode === "sync" ? "Syncing from the portal — watch the new tab…" : "Opening the portal — logging you in…");
    } catch (e) {
      console.error(e);
      notify(e?.message?.slice(0, 120) || "Couldn't open the portal.", "alert");
    } finally {
      setBusy(false);
    }
  };

  // Receive the e-Proceedings list the extension fetches and save it, and
  // record how it was fetched (portal JSON API vs screen scrape) + how long.
  React.useEffect(() => {
    const off = onSyncData(async (payload) => {
      if (!payload || payload.assesseeId !== a.id) return;

      // A notice/order document streamed from the portal. Upload its PDF (if
      // present) to Storage under the user's own path, then record the metadata.
      if (payload.kind === "notice") {
        const n = payload.notice || {};
        try {
          let storagePath = null;
          if (n.contentBase64) {
            const uid = auth.currentUser?.uid;
            const safeId = (n.din || `${n.proceedingReqId}-${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, "");
            storagePath = `users/${uid}/assessees/${a.id}/notices/${safeId}.pdf`;
            await uploadString(storageRef(storage, storagePath), n.contentBase64, "base64", { contentType: n.contentType || "application/pdf" });
          }
          const meta = { ...n };
          delete meta.contentBase64;
          await httpsCallable(functions, "ingestPortalNotice")({ assesseeId: a.id, notice: meta, storagePath, filename: n.filename });
          noticeStats.current.ok++;
        } catch (e) {
          console.error("Notice ingest failed", e);
          noticeStats.current.fail++;
          // Surface the real error (e.g. function not deployed, permission) —
          // throttled so 39 failures don't spam 39 toasts.
          const now = Date.now();
          if (now - noticeStats.current.lastNotify > 1500) {
            noticeStats.current.lastNotify = now;
            notify("Couldn't save a portal notice — " + (e?.code || e?.message || "error") + " (check Storage/functions are deployed)", "alert");
          }
        }
        return;
      }

      // A response filed against a notice (remarks + attachment PDFs).
      if (payload.kind === "response") {
        try { await ingestPortalSyncMessage(payload); }
        catch (e) { console.error("response ingest failed", e); }
        return;
      }

      // Approach (a) probe: the API was reached fast but its JSON shape still
      // needs a one-time mapping calibration. No data to save — just show the
      // timing so the speed is visible while scraping fills in the data.
      if (payload.kind === "api-probe") {
        setSyncInfo({ via: "api", ms: payload.ms, endpoint: payload.endpoint, calibrating: true, at: Date.now() });
        return;
      }

      if (payload.kind !== "proceedings") return;
      setSyncInfo({
        via: payload.via || "scrape",
        ms: typeof payload.ms === "number" ? payload.ms : null,
        endpoint: payload.endpoint || null,
        count: (payload.proceedings || []).length,
        calibrating: false,
        at: Date.now(),
      });
      try {
        const { data } = await httpsCallable(functions, "ingestPortalProceedings")({
          assesseeId: a.id,
          proceedings: payload.proceedings || [],
        });
        notify(`Synced ${data.total} proceedings (${data.added} new)`);
        if (Array.isArray(data.closed) && data.closed.length && onClosedProceedings) onClosedProceedings(data.closed);
      } catch (e) {
        console.error(e);
        notify("Sync received but couldn't be saved.", "alert");
      }
    });
    return off;
  }, [a.id, notify, onClosedProceedings]);

  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">Income-tax portal</div>
        {a.portalCredSet
          ? <span className="pill pill-success"><Icon name="check" size={11}/> Login saved</span>
          : <span className="pill pill-muted">No login</span>}
      </div>

      {!a.portalCredSet ? (
        <div className="col" style={{gap: 10}}>
          <div className="muted" style={{fontSize: 12.5}}>Add this assessee's e-filing login to open the portal in one click.</div>
          <button className="btn btn-secondary btn-sm" style={{alignSelf: "flex-start"}} onClick={onAddLogin}><Icon name="plus" size={13}/>Add portal login</button>
        </div>
      ) : hasExt === false ? (
        <div className="col" style={{gap: 8}}>
          <div className="center" style={{gap: 8, padding: "10px 12px", background: "var(--p-amber)", borderRadius: 10, fontSize: 12.5}}>
            <Icon name="info" size={13}/>
            <span>Install the <b>ProHippo Sync</b> Chrome extension to open the portal automatically.</span>
          </div>
          <button className="btn btn-ghost btn-sm" style={{alignSelf: "flex-start"}} onClick={check}><Icon name="arrow-right" size={12}/>I've installed it — recheck</button>
        </div>
      ) : (
        <div className="col" style={{gap: 10}}>
          <div className="row" style={{gap: 8, flexWrap: "wrap"}}>
            <button className="btn btn-primary btn-sm" disabled={busy || hasExt === null} onClick={() => launch("sync")}>
              <Icon name="sparkle" size={13}/>{busy ? "Working…" : "Update status (sync)"}
            </button>
            <button className="btn btn-secondary btn-sm" disabled={busy || hasExt === null} onClick={() => launch("open")}>
              <Icon name="link" size={13}/>Open portal
            </button>
          </div>
          <div className="muted" style={{fontSize: 11.5}}>
            Last synced: {a.portalLastSyncedAt ? fmtDateLong(a.portalLastSyncedAt) : "never"}
            {typeof a.portalProceedingCount === "number" ? ` · ${a.portalProceedingCount} proceedings` : ""}
            {typeof a.portalNoticeCount === "number" ? ` · ${a.portalNoticeCount} notices` : ""}
          </div>
          {syncInfo && <SyncTiming info={syncInfo}/>}
        </div>
      )}
    </div>
  );
}

/* Consolidated, proceeding-wise view: each matter (proceeding) expands to its
   notices/orders (recent first) and hearings. Manual matters (no proceeding)
   still show as a simple non-expanding row. */
function MattersView({ matters, notices, hearings, assesseeName, notify, focusReqId }) {
  const [openId, setOpenId] = React.useState(null);
  const [parsingId, setParsingId] = React.useState("");

  // When asked to focus a proceeding (e.g. from the "closed" popup), open it.
  React.useEffect(() => {
    if (!focusReqId) return;
    const m = matters.find((mm) => mm.proceedingReqId === focusReqId);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (m) setOpenId(m.id);
  }, [focusReqId, matters]);

  const byDateDesc = (arr) => [...arr].sort((x, y) => (y.date || "").localeCompare(x.date || ""));
  const noticesFor = (m) => byDateDesc(notices.filter((n) => m.proceedingReqId && n.proceedingReqId === m.proceedingReqId));
  const hearingsFor = (m) => byDateDesc(hearings.filter((h) => m.proceedingReqId && h.proceedingReqId === m.proceedingReqId));
  // Newest-first: order by the latest notice/order or hearing date in the
  // proceeding (NOT the sync timestamp — that's the same for every matter and
  // would flatten the order). Fall back to createdAt only when it has no dates.
  const lastActivity = (m) => {
    const ns = noticesFor(m); const hs = hearingsFor(m);
    const dated = [ns[0]?.date, hs[0]?.date].filter(Boolean).sort();
    return dated.length ? dated[dated.length - 1] : ("0000-" + (m.createdAt || m.portalSyncedAt || ""));
  };
  const ordered = [...matters].sort((x, y) => lastActivity(y).localeCompare(lastActivity(x)));

  const parse = async (n) => {
    setParsingId(n.id);
    try {
      await httpsCallable(functions, "summarizePortalNotice")({ noticeId: n.id });
      // The summary lands on the notice doc → appears via the store's live data.
    } catch (e) {
      console.error("summarize failed", e);
      notify && notify("AI parse failed — " + (e?.message?.slice(0, 100) || "error"), "alert");
    } finally {
      setParsingId("");
    }
  };
  const isOrderDoc = (n) => Boolean(n.isOrder) || /\border\b/i.test(n.subject || "");

  if (matters.length === 0) {
    return (
      <div className="card" style={{padding: 0}}>
        <EmptyState icon="scale" title={`No proceedings for ${assesseeName} yet`} sub="Run a portal sync from the Overview tab to pull the assessee's e-Proceedings, or add a matter manually."/>
      </div>
    );
  }

  // chevron | type | proceeding (natural width) | AY | section (no-wrap) | status | right spacer
  const GRID = "18px 92px minmax(190px, max-content) 78px 132px 92px 1fr";
  return (
    <div className="col" style={{gap: 10}}>
      <div style={{display: "grid", gridTemplateColumns: GRID, gap: 14, alignItems: "center", padding: "0 18px", fontSize: 10.5, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--p-text-3)"}}>
        <span/><span>Type</span><span>Proceeding</span><span>AY</span><span>Section</span><span>Status</span>
      </div>
      {ordered.map((m) => {
        const ns = noticesFor(m);
        const hs = hearingsFor(m);
        const isPortal = Boolean(m.proceedingReqId);
        const open = openId === m.id;
        const docCount = ns.length;
        const section = m.section || ns.map((n) => n.section).find(Boolean) || "";
        return (
          <div key={m.id} className="card" style={{padding: 0, overflow: "hidden"}}>
            <div
              style={{display: "grid", gridTemplateColumns: GRID, gap: 14, alignItems: "center", padding: "13px 18px", cursor: isPortal ? "pointer" : "default"}}
              onClick={isPortal ? () => setOpenId(open ? null : m.id) : undefined}
            >
              <span>{isPortal ? <Icon name={open ? "chevron-down" : "chevron-right"} size={16}/> : null}</span>
              <span><span className="pill pill-primary">{m.type || "Matter"}</span></span>
              <span style={{minWidth: 0}}>
                <span className="strong" style={{fontSize: 13, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{m.ref || m.proceedingName || "Matter"}</span>
                {isPortal && <span className="muted" style={{fontSize: 11}}>{docCount} notice{docCount === 1 ? "" : "s"}/orders{hs.length ? ` · ${hs.length} hearing${hs.length === 1 ? "" : "s"}` : ""}</span>}
              </span>
              <span>{m.ay || "—"}</span>
              <span style={{whiteSpace: "nowrap"}}>{section ? <span className="pill pill-muted">u/s {section}</span> : <span className="muted">—</span>}</span>
              <span><StatusPill status={m.status}/></span>
            </div>

            {open && isPortal && (
              <div style={{borderTop: "1px solid var(--p-line-2)", background: "var(--p-card-tint)", padding: "12px 18px"}}>
                {hs.length > 0 && (
                  <div style={{marginBottom: ns.length ? 14 : 0}}>
                    <div className="muted" style={{fontSize: 11, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", marginBottom: 6}}>Hearings</div>
                    <div className="col" style={{gap: 6}}>
                      {hs.map((h) => (
                        <div key={h.id} className="center" style={{gap: 10, fontSize: 12.5}}>
                          <Icon name="calendar" size={13}/>
                          <span className="strong">{fmtDateLong(h.date)}</span>
                          <span className="muted">{h.time} · {h.mode}</span>
                          <StatusPill status={h.date < todayISO() ? "Completed" : h.status}/>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div className="muted" style={{fontSize: 11, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", marginBottom: 6}}>Notices &amp; orders</div>
                {ns.length === 0
                  ? <div className="muted" style={{fontSize: 12.5, padding: "4px 0"}}>No notices/orders synced for this proceeding.</div>
                  : (
                    <div className="col" style={{gap: 8}}>
                      {ns.map((n) => {
                        const order = isOrderDoc(n);
                        return (
                          <div key={n.id} style={{padding: "9px 11px", background: "white", borderRadius: 10, border: "1px solid var(--p-line-2)"}}>
                            <div className="center" style={{gap: 10, alignItems: "flex-start"}}>
                              <div style={{width: 30, height: 38, borderRadius: 5, background: order ? "var(--p-amber)" : "var(--p-pink)", display: "grid", placeItems: "center", color: order ? "#B07512" : "#C13388", fontSize: 8, fontWeight: 800, flexShrink: 0}}>PDF</div>
                              <div style={{flex: 1, minWidth: 0}}>
                                <div className="center" style={{gap: 6, justifyContent: "flex-start"}}>
                                  <span className={`pill ${order ? "pill-warning" : "pill-muted"}`} style={{fontSize: 10}}>{order ? "Order" : "Notice"}</span>
                                  <span className="strong" style={{fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{n.subject || n.din || "Notice"}</span>
                                </div>
                                <div className="muted" style={{fontSize: 11, marginTop: 2}}>
                                  {[n.date ? fmtDateLong(n.date) : "", n.section ? `u/s ${n.section}` : "", n.din ? `DIN ${n.din}` : ""].filter(Boolean).join(" · ")}
                                </div>
                              </div>
                              {n.storagePath && (
                                <button className="btn btn-ghost btn-xs" title="Summarise this PDF with AI" disabled={parsingId === n.id} onClick={(e) => { e.stopPropagation(); parse(n); }}>
                                  <Icon name="sparkle" size={12}/>{parsingId === n.id ? "Parsing…" : (n.aiSummary ? "Re-parse" : "Parse with AI")}
                                </button>
                              )}
                              {n.storagePath && (
                                <button className="btn btn-ghost btn-xs" title="Open the portal PDF" onClick={(e) => { e.stopPropagation(); openStoragePdf(n.storagePath); }}>
                                  <Icon name="doc" size={12}/>PDF
                                </button>
                              )}
                            </div>
                            {n.aiSummary && (n.aiSummary.summary || (n.aiSummary.items || []).length > 0) && (
                              <div style={{marginTop: 8, padding: "8px 10px", background: "var(--p-card-tint)", borderRadius: 8, fontSize: 12}}>
                                <div className="center" style={{gap: 6, justifyContent: "flex-start", marginBottom: (n.aiSummary.items || []).length ? 5 : 0}}>
                                  <Icon name="sparkle" size={11}/><span className="strong">{n.aiSummary.summary}</span>
                                </div>
                                {(n.aiSummary.items || []).length > 0 && (
                                  <ul style={{margin: 0, paddingLeft: 18}}>
                                    {n.aiSummary.items.map((it, i) => <li key={i} style={{marginTop: 2}}>{it}</li>)}
                                  </ul>
                                )}
                              </div>
                            )}
                            <ResponsesBlock responses={n.responses}/>
                          </div>
                        );
                      })}
                    </div>
                  )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function NotesCard({ assessee, onSave }) {
  const [text, setText] = React.useState(assessee.notes || "");
  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">Notes</div>
        <button className="btn btn-primary btn-sm" onClick={() => onSave(text)}><Icon name="check" size={13}/>Save notes</button>
      </div>
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder={`Internal notes about ${assessee.name}…`}
        style={{width: "100%", minHeight: 180, border: "1px solid var(--p-line)", borderRadius: 12, padding: "12px 14px", fontSize: 13.5, fontFamily: "inherit", resize: "vertical", outline: "none"}}
      />
    </div>
  );
}

function MiniStat({ label, value, icon, accent = "default" }) {
  const colors = {
    default: { bg: "var(--p-lavender-2)", fg: "var(--p-primary-2)" },
    pink:    { bg: "var(--p-pink)", fg: "#C13388" },
    warn:    { bg: "var(--p-amber)", fg: "#B07512" },
    success: { bg: "var(--p-mint)", fg: "#1B8C5C" },
  }[accent];
  return (
    <div style={{display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", background: "white", borderRadius: 14, border: "1px solid var(--p-line-2)", flex: 1}}>
      <div style={{width: 34, height: 34, borderRadius: 10, background: colors.bg, color: colors.fg, display: "grid", placeItems: "center"}}>
        <Icon name={icon} size={16}/>
      </div>
      <div style={{minWidth: 0}}>
        <div style={{fontSize: 11, color: "var(--p-text-3)", fontWeight: 600}}>{label}</div>
        <div style={{fontWeight: 800, fontSize: 16, letterSpacing: "-0.02em"}}>{value}</div>
      </div>
    </div>
  );
}

function KV({ label, value, mono }) {
  return (
    <div className="between" style={{padding: "8px 0", borderBottom: "1px dashed var(--p-line-2)", fontSize: 13, alignItems: "flex-start"}}>
      <div className="muted" style={{fontSize: 12, minWidth: 130}}>{label}</div>
      <div style={{fontWeight: 600, textAlign: "right", maxWidth: "60%", fontFamily: mono ? "ui-monospace, monospace" : "inherit"}}>{value}</div>
    </div>
  );
}

function Timeline({ data, assessee }) {
  const items = [];
  data.notices.filter(n => n.pan === assessee.pan).forEach(n => items.push({
    when: n.date || n.createdAt?.slice(0, 10) || "", icon: "doc", color: "primary",
    title: `Notice ${n.section ? `u/s ${n.section}` : ""} received — ${n.authority}`,
    desc: n.din ? `DIN ${n.din}` : (n.subject || ""),
  }));
  data.hearings.filter(h => h.pan === assessee.pan).forEach(h => items.push({
    when: h.date, icon: "calendar", color: "pink",
    title: `${h.authority} hearing ${h.date < todayISO() ? "held" : "scheduled"}`,
    desc: `${h.bench} · AY ${h.ay} · ${h.time}`,
  }));
  data.invoices.filter(i => i.assessee === assessee.name).forEach(i => items.push({
    when: i.date, icon: "invoice", color: "info",
    title: `Invoice ${i.number} raised`,
    desc: `${fmtINR(i.amount)} · ${i.service}${i.due ? ` · Due ${fmtDate(i.due)}` : ""}`,
  }));
  data.communications.filter(c => c.to === assessee.name).forEach(c => items.push({
    when: (c.time || "").slice(0, 10), icon: c.channel === "WhatsApp" ? "whatsapp" : "mail", color: "success",
    title: `${c.channel} sent — ${c.template || "message"}`,
    desc: c.subject,
  }));
  items.sort((x, y) => (y.when || "").localeCompare(x.when || ""));
  const shown = items.slice(0, 6);
  const colorMap = { primary: "var(--p-primary)", success: "var(--p-success)", info: "var(--p-info)", pink: "#C13388" };

  if (shown.length === 0) return <div className="muted" style={{fontSize: 13, padding: 8}}>No activity recorded yet.</div>;

  return (
    <div style={{position: "relative", paddingLeft: 8}}>
      <div style={{position: "absolute", left: 17, top: 8, bottom: 8, width: 2, background: "var(--p-lavender-2)"}}/>
      <div className="col" style={{gap: 14}}>
        {shown.map((it, i) => (
          <div key={i} className="center" style={{gap: 14, alignItems: "flex-start", position: "relative"}}>
            <div style={{width: 28, height: 28, borderRadius: 9, background: "white", border: `2px solid ${colorMap[it.color]}`, color: colorMap[it.color], display: "grid", placeItems: "center", flexShrink: 0, zIndex: 1}}>
              <Icon name={it.icon} size={13}/>
            </div>
            <div style={{flex: 1}}>
              <div className="between">
                <div style={{fontWeight: 700, fontSize: 13.5}}>{it.title}</div>
                <div className="muted" style={{fontSize: 11.5}}>{it.when ? fmtDate(it.when) : ""}</div>
              </div>
              <div className="muted" style={{fontSize: 12.5, marginTop: 2}}>{it.desc}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
