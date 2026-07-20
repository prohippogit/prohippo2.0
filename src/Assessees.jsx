import React from 'react';
import { Icon, Avatar, StatusPill, EmptyState, Modal, fmtINR, fmtDate, fmtDateLong, fmtLakhs, daysFromNow } from './shared';
import { useData, assesseeStats, upcomingHearings, invoiceStatus, invoiceOutstanding, fyOf, todayISO } from './store';
import { MatterModal } from './Other';
import { AssesseeModal } from './AssesseeModal';
import { httpsCallable } from 'firebase/functions';
import { ref as storageRef, uploadString, getDownloadURL } from 'firebase/storage';
import { functions, storage, auth } from './firebase';
import { detectExtension, openPortalLogin, onSyncData } from './portalSync';
import { ingestPortalSyncMessage } from './portalIngest';
import CheekyHippoProgress from './cheekyHippo/CheekyHippoProgress.jsx';

// Rough bucket for a streamed notice so the hippo can drop smarter copy
// ("2 reassessment notices…"). Best-effort string matching on the portal's
// section/description — not authoritative, just flavour for the mascot.
function classifyNoticeSection(notice) {
  const hay = `${notice?.section || ''} ${notice?.description || ''} ${notice?.proceedingName || ''}`.toLowerCase();
  if (/\b148a?\b|reassess|reopen/.test(hay)) return 'reassessment';
  if (/\b27[01]\b|penalty|penal/.test(hay)) return 'penalty';
  if (/appeal|\b250\b|form\s*35|cit\s*\(a\)/.test(hay)) return 'appeal';
  if (/\b14[34]\b|assessment|order/.test(hay) || notice?.isOrder) return 'assessment';
  return null;
}

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

// Column layout for the Assessees list (checkbox · name · PAN · entity ·
// contact · proceedings · assigned · status · actions).
const ASS_GRID = "30px minmax(220px, 2fr) 130px 120px 110px 150px 110px 80px";

// Colour for an entity-type pill.
function entityPill(status) {
  const map = {
    Individual: { bg: "var(--p-lavender-2)", c: "var(--p-primary-2)" },
    Company: { bg: "#E3ECFF", c: "#2B5FD0" },
    Firm: { bg: "var(--p-mint)", c: "#1B8C5C" },
    LLP: { bg: "#EDE4FF", c: "#7A4FD0" },
    HUF: { bg: "var(--p-amber)", c: "#B07512" },
    Trust: { bg: "var(--p-pink)", c: "#C13388" },
    "AOP/BOI": { bg: "#FFE7D6", c: "#B5651D" },
  };
  return map[status] || { bg: "var(--p-card-tint)", c: "var(--p-text-2)" };
}

export function Assessees({ onOpen, initialSearch = "" }) {
  const { data, notify } = useData();
  const [tab, setTab] = React.useState("All");
  const [search, setSearch] = React.useState(initialSearch);
  const [sortBy, setSortBy] = React.useState("recent");
  const [statusFilter, setStatusFilter] = React.useState("all");
  const [page, setPage] = React.useState(1);
  const [showAdd, setShowAdd] = React.useState(false);
  const [editAssessee, setEditAssessee] = React.useState(null);
  const [selected, setSelected] = React.useState(() => new Set());
  const [bulk, setBulk] = React.useState(null); // { done, total, current } while a bulk sync runs
  const doneResolver = React.useRef(null);
  const running = React.useRef(false); // true only while a bulk sync is in progress

  React.useEffect(() => { setSearch(initialSearch); }, [initialSearch]);
  React.useEffect(() => { setPage(1); }, [tab, search, sortBy, statusFilter]);

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

  // Active = has an open matter. Computed up-front so the KPI tiles and the
  // Status filter share one definition.
  const activeMattersAll = data.matters.filter(m => !["Closed", "Decided"].includes(m.status));
  const activePans = new Set(activeMattersAll.map(m => (m.pan || "").toUpperCase()).filter(Boolean));
  const isActive = (a) => activePans.has((a.pan || "").toUpperCase());

  const matchesTab = (a) => {
    if (tab === "All") return true;
    if (tab === "Firm/LLP") return a.status === "Firm" || a.status === "LLP";
    return a.status === tab;
  };
  const q = search.toLowerCase();
  const filtered = data.assessees.filter(a =>
    matchesTab(a) &&
    (statusFilter === "all" || (statusFilter === "active" ? isActive(a) : !isActive(a))) &&
    (!q || a.name.toLowerCase().includes(q) || a.pan.toLowerCase().includes(q) || (a.group || "").toLowerCase().includes(q) || (a.mobile || "").includes(q))
  );
  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "name") return (a.name || "").localeCompare(b.name || "");
    if (sortBy === "pan") return (a.pan || "").localeCompare(b.pan || "");
    if (sortBy === "proceedings") return assesseeStats(data, b).matters - assesseeStats(data, a).matters;
    return (b.createdAt || "").localeCompare(a.createdAt || ""); // recent (default)
  });
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageRows = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const tabCount = (t) => data.assessees.filter(a => (t === "All" ? true : t === "Firm/LLP" ? a.status === "Firm" || a.status === "LLP" : a.status === t)).length;

  return (
    <div className="animate-in">
      <div className="topbar">
        <div>
          <div className="page-title">Assessees</div>
          <div className="page-sub">Manage assessee records and related proceedings</div>
        </div>
        <div className="topbar-actions">
          <div className="search" style={{width: 300}}>
            <Icon name="search" size={15}/>
            <input placeholder="Search by name, PAN, email or mobile…" value={search} onChange={e => setSearch(e.target.value)}/>
          </div>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}><Icon name="plus" size={14}/>Add Assessee</button>
        </div>
      </div>

      {data.assessees.length > 0 && (
        <div className="tabs" style={{marginBottom: 14}}>
          {["All", "Individual", "Company", "Firm/LLP", "HUF", "Trust"].map(t => (
            <div key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
              {t}
              <span style={{marginLeft: 6, opacity: 0.65, fontSize: 11}}>{tabCount(t)}</span>
            </div>
          ))}
        </div>
      )}

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
          <div className="between" style={{marginBottom: 12, flexWrap: "wrap", gap: 10, alignItems: "center"}}>
            <div className="muted" style={{fontSize: 12.5}}>{sorted.length} assessee{sorted.length === 1 ? "" : "s"}{statusFilter !== "all" ? ` · ${statusFilter}` : ""}</div>
            <div className="center" style={{gap: 10, flexWrap: "wrap"}}>
              <label className="center" style={{gap: 6, fontSize: 12.5}}>
                <span className="muted center" style={{gap: 5}}><Icon name="filter" size={13}/>Status</span>
                <select className="ph-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                  <option value="all">All</option>
                  <option value="active">Active</option>
                  <option value="pending">Pending</option>
                </select>
              </label>
              <label className="center" style={{gap: 6, fontSize: 12.5}}>
                <span className="muted">Sort by</span>
                <select className="ph-select" value={sortBy} onChange={e => setSortBy(e.target.value)}>
                  <option value="recent">Recently added</option>
                  <option value="name">Name (A–Z)</option>
                  <option value="proceedings">Most proceedings</option>
                  <option value="pan">PAN</option>
                </select>
              </label>
            </div>
          </div>
          <div className="card" style={{padding: 0, overflow: "hidden"}}>
            <div style={{overflowX: "auto"}}>
              <div style={{minWidth: 820}}>
                <div style={{display: "grid", gridTemplateColumns: ASS_GRID, gap: 12, alignItems: "center", padding: "12px 18px", borderBottom: "1px solid var(--p-line-2)", fontSize: 10.5, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--p-text-3)"}}>
                  <span><input type="checkbox" checked={allPageSelected()} onChange={toggleAllPage} title="Select all on this page with a portal login"/></span>
                  <span>Assessee</span>
                  <span>PAN</span>
                  <span>Entity type</span>
                  <span>Proceedings</span>
                  <span>Assigned to</span>
                  <span>Status</span>
                  <span style={{textAlign: "right"}}>Actions</span>
                </div>
                {pageRows.map(a => {
                  const s = assesseeStats(data, a);
                  const ep = entityPill(a.status);
                  const active = isActive(a);
                  return (
                    <div key={a.id} className="ass-row" onClick={() => onOpen(a)}
                      style={{display: "grid", gridTemplateColumns: ASS_GRID, gap: 12, alignItems: "center", padding: "12px 18px", borderBottom: "1px solid var(--p-line-2)", cursor: "pointer"}}>
                      <span onClick={(e) => e.stopPropagation()}>
                        {a.portalCredSet
                          ? <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggle(a.id)} title="Select for portal sync"/>
                          : <span className="muted" title="No portal login saved" style={{fontSize: 11}}>—</span>}
                      </span>
                      <div className="center" style={{gap: 10, minWidth: 0, justifyContent: "flex-start"}}>
                        <Avatar name={a.name} color={a.color} round soft/>
                        <div style={{minWidth: 0}}>
                          <div className="strong" style={{fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{a.name}</div>
                          <div className="muted" style={{fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{a.group || a.email || "—"}</div>
                        </div>
                      </div>
                      <span className="strong" style={{fontFamily: "ui-monospace, monospace", fontSize: 12}}>{a.pan}</span>
                      <span><span className="pill" style={{background: ep.bg, color: ep.c, fontWeight: 700}}>{a.status}</span></span>
                      <span>
                        <span className="pill pill-muted" style={{fontSize: 11}} title={`${s.matters} active matter${s.matters === 1 ? "" : "s"}`}>{s.matters}</span>
                      </span>
                      <span>
                        {a.staff
                          ? <span className="center" style={{gap: 6, justifyContent: "flex-start"}}><Avatar name={a.staff} color="mint" size="sm"/><span style={{fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{a.staff.split(" ")[0]}</span></span>
                          : <span className="muted">—</span>}
                      </span>
                      <span>
                        <span className="center" style={{gap: 6, justifyContent: "flex-start"}}>
                          <span style={{width: 7, height: 7, borderRadius: "50%", background: active ? "var(--p-success)" : "#E0A43B", flexShrink: 0}}/>
                          <span style={{fontSize: 12}}>{active ? "Active" : "Pending"}</span>
                        </span>
                      </span>
                      <span onClick={(e) => e.stopPropagation()} className="center" style={{gap: 2, justifyContent: "flex-end"}}>
                        <button className="icon-btn" style={{width: 30, height: 30, borderRadius: 8}} title="Edit" onClick={() => setEditAssessee(a)}><Icon name="edit" size={15}/></button>
                      </span>
                    </div>
                  );
                })}
                {pageRows.length === 0 && (
                  <div style={{textAlign: "center", padding: 40, color: "var(--p-text-3)"}}>No assessees match this filter.</div>
                )}
              </div>
            </div>
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
      {editAssessee && <AssesseeModal initial={editAssessee} onClose={() => setEditAssessee(null)}/>}
    </div>
  );
}

export function AssesseeProfile({ assessee, onBack, onNav, initialTab, initialMatterId }) {
  const { data, removeAssessee, updateAssessee, notify } = useData();
  const [tab, setTab] = React.useState(initialTab || "Overview");
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

      <div className="card" style={{background: "#FCE7B8", border: "1px solid #EFCE86", boxShadow: "0 10px 30px -12px rgba(176, 117, 18, 0.26), 0 2px 8px rgba(176, 117, 18, 0.07)"}}>
        <div className="between" style={{alignItems: "flex-start"}}>
          <div className="center" style={{gap: 16}}>
            <Avatar name={a.name} color={a.color} size="lg" round soft/>
            <div>
              <div className="center" style={{gap: 8}}>
                <div style={{fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em"}}>{a.name}</div>
                <span className="pill" style={{background: "#FFFFFF", color: "#A96D10", fontWeight: 700}}>{a.status}</span>
                {a.group && <span className="pill pill-primary">{a.group}</span>}
              </div>
              <div className="row" style={{gap: 18, marginTop: 8, fontSize: 13, color: "#7A5B22"}}>
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
              {a.jurisdiction && (a.jurisdiction.ward || a.jurisdiction.aoEmail || a.jurisdiction.building) && (() => {
                const j = a.jurisdiction;
                const aoAddr = [j.building, j.area].filter(Boolean).join(", ");
                return (
                  <>
                    <div className="muted" style={{fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", marginTop: 14, marginBottom: 2}}>Jurisdictional AO</div>
                    {j.ward && <KV label="AO / Ward" value={j.ward}/>}
                    {j.aoEmail && <KV label="AO email" value={<a href={`mailto:${j.aoEmail}`} style={{color: "var(--p-primary)", wordBreak: "break-all"}}>{j.aoEmail}</a>}/>}
                    {aoAddr && <KV label="AO address" value={aoAddr}/>}
                  </>
                );
              })()}
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
        <MattersView matters={matters} notices={notices} hearings={allHearings} assesseeName={a.name} notify={notify} focusReqId={focusReqId} openMatterId={initialMatterId}/>
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

  // ── Cheeky Hippo fetch progress ──────────────────────────────────────────
  // The extension streams the sync in the background (login → proceedings list
  // → one "notice" message per PDF → "sync-done"). We turn that stream into the
  // presentational props CheekyHippoProgress wants. `fetchPhase === null` means
  // idle (hippo hidden). Everything else mirrors the live stream.
  const [fetchState, setFetchState] = React.useState(null); // { phase, totalPdfs, downloadedCount, currentFileName, noticeCounts, errorMessage } | null
  const downloadedRef = React.useRef(0);          // live count for the sync-done branch
  const noticeCountsRef = React.useRef({});        // live section tally
  const watchdogRef = React.useRef(null);          // "no activity" timeout
  const doneTimerRef = React.useRef(null);         // processing→done beat
  const hideTimerRef = React.useRef(null);         // auto-hide after a terminal state

  // Auto-dismiss the hippo a few seconds after a terminal (done/empty) state so
  // the card quietly returns to its normal buttons. Errors stay until Retry.
  const scheduleHide = React.useCallback(() => {
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setFetchState(null), 6000);
  }, []);

  // Restart the no-activity watchdog: if the stream goes silent mid-fetch we
  // flip to the error state (with Retry) instead of spinning forever.
  const armWatchdog = React.useCallback(() => {
    clearTimeout(watchdogRef.current);
    watchdogRef.current = setTimeout(() => {
      setFetchState((f) => (f && (f.phase === 'authenticating' || f.phase === 'fetchingList' || f.phase === 'downloading' || f.phase === 'processing')
        ? { ...f, phase: 'error', errorMessage: 'The portal went quiet — the sync may have stalled. Try again.' }
        : f));
    }, 150000);
  }, []);

  React.useEffect(() => () => { clearTimeout(watchdogRef.current); clearTimeout(doneTimerRef.current); clearTimeout(hideTimerRef.current); }, []);

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
    // A fresh sync resets the hippo to Phase A; "open" mode doesn't fetch, so it
    // never shows the progress card.
    if (mode === "sync") {
      clearTimeout(doneTimerRef.current);
      clearTimeout(hideTimerRef.current);
      downloadedRef.current = 0;
      noticeCountsRef.current = {};
      setFetchState({ phase: 'authenticating', totalPdfs: 0, downloadedCount: 0, currentFileName: '', noticeCounts: null, errorMessage: '' });
      armWatchdog();
    }
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
      // The fetch never got off the ground — show the hippo's error + Retry.
      if (mode === "sync") {
        clearTimeout(watchdogRef.current);
        setFetchState((f) => ({ ...(f || {}), phase: 'error', errorMessage: e?.message?.slice(0, 140) || "Couldn't reach the portal." }));
      }
    } finally {
      setBusy(false);
    }
  };

  // Receive the e-Proceedings list the extension fetches and save it, and
  // record how it was fetched (portal JSON API vs screen scrape) + how long.
  React.useEffect(() => {
    const off = onSyncData(async (payload) => {
      if (!payload || payload.assesseeId !== a.id) return;

      // Sync finished (extension sends this from beginSync's .finally). Decide
      // the hippo's terminal state: nothing new → calm "empty"; otherwise a
      // brief "processing" beat then "done".
      if (payload.kind === "sync-done") {
        clearTimeout(watchdogRef.current);
        setFetchState((f) => {
          if (!f || f.phase === 'error') return f;
          if (downloadedRef.current === 0) {
            scheduleHide();
            return { ...f, phase: 'empty' };
          }
          clearTimeout(doneTimerRef.current);
          doneTimerRef.current = setTimeout(() => {
            setFetchState((g) => (g ? { ...g, phase: 'done', downloadedCount: downloadedRef.current, totalPdfs: downloadedRef.current } : g));
            scheduleHide();
          }, 1200);
          return { ...f, phase: 'processing', currentFileName: '' };
        });
        return;
      }

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
        // Drive the hippo's determinate phase: one more PDF in hand. This fires
        // whether or not the ingest above succeeded — a downloaded doc counts.
        downloadedRef.current += 1;
        const bucket = classifyNoticeSection(n);
        if (bucket) noticeCountsRef.current[bucket] = (noticeCountsRef.current[bucket] || 0) + 1;
        armWatchdog();
        setFetchState((f) => f && ({
          ...f,
          phase: 'downloading',
          downloadedCount: downloadedRef.current,
          // If we have a real estimate, keep the count from ever exceeding it
          // (closure-order docs can overshoot). If we have NO estimate (0), keep
          // it 0 so the hippo shows an honest indeterminate bar + plain count
          // rather than a fake "3 of 0".
          totalPdfs: f.totalPdfs > 0 ? Math.max(f.totalPdfs, downloadedRef.current) : 0,
          currentFileName: n.filename || '',
          noticeCounts: { ...noticeCountsRef.current },
        }));
        return;
      }

      // A response filed against a notice (remarks + attachment PDFs).
      if (payload.kind === "response") {
        try { await ingestPortalSyncMessage(payload); }
        catch (e) { console.error("response ingest failed", e); }
        return;
      }

      // A CIT(A) appeal filed as Form 35 (metadata + PDFs).
      if (payload.kind === "appealForm") {
        try { await ingestPortalSyncMessage(payload); }
        catch (e) { console.error("appeal ingest failed", e); }
        return;
      }

      // Approach (a) probe: the API was reached fast but its JSON shape still
      // needs a one-time mapping calibration. No data to save — just show the
      // timing so the speed is visible while scraping fills in the data.
      if (payload.kind === "api-probe") {
        setSyncInfo({ via: "api", ms: payload.ms, endpoint: payload.endpoint, calibrating: true, at: Date.now() });
        armWatchdog();
        setFetchState((f) => (f && f.phase === 'authenticating' ? { ...f, phase: 'fetchingList' } : f));
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
      // The notice list is in: switch the hippo from indeterminate Phase A to a
      // known target. totalPdfs is an ESTIMATE (sum of the portal's per-
      // proceeding notice counts); the download branch clamps the live count to
      // it, and sync-done snaps it to the real number actually fetched.
      {
        const rows = payload.proceedings || [];
        const estTotal = rows.reduce((s, r) => s + (Number(r.viewNoticeCount ?? r.noticeCount) || 0), 0);
        armWatchdog();
        setFetchState((f) => (f ? {
          ...f,
          phase: f.phase === 'downloading' ? 'downloading' : 'fetchingList',
          totalPdfs: Math.max(f.totalPdfs || 0, estTotal, downloadedRef.current),
        } : f));
      }
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
  }, [a.id, notify, onClosedProceedings, armWatchdog, scheduleHide]);

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
          {/* The hippo narrates a live sync (Phase A → B → done/empty/error). */}
          {fetchState && (
            <CheekyHippoProgress
              phase={fetchState.phase}
              totalPdfs={fetchState.totalPdfs}
              downloadedCount={fetchState.downloadedCount}
              noticeCounts={fetchState.noticeCounts}
              currentFileName={fetchState.currentFileName}
              errorMessage={fetchState.errorMessage}
              onRetry={() => launch("sync")}
            />
          )}
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

// Accent colour per proceeding type — used for the row's left stripe and the
// modal header so scrutiny / appeal / penalty proceedings read apart at a glance.
const TYPE_ACCENT = {
  Scrutiny: { bar: "#F39C12", tint: "var(--p-amber)", fg: "#B07512" },
  "CIT(A)": { bar: "#C13388", tint: "var(--p-pink)", fg: "#C13388" },
  ITAT: { bar: "var(--p-primary)", tint: "var(--p-lavender-2)", fg: "var(--p-primary-2)" },
  Penalty: { bar: "#EE5A5A", tint: "var(--p-coral)", fg: "#B8463A" },
};
const accentFor = (t) => TYPE_ACCENT[t] || { bar: "var(--p-primary-3)", tint: "var(--p-lavender-2)", fg: "var(--p-primary-2)" };
const isOrderDoc = (n) => Boolean(n.isOrder) || /\border\b/i.test(n.subject || "");

/* Consolidated, proceeding-wise view: each matter (proceeding) is a distinct,
   clearly-separated card. Clicking one opens a full, scrollable pop-up card
   (ProceedingModal) with its hearings and notices/orders. Manual matters (no
   proceeding) open the same card — it simply has nothing synced to show yet. */
function MattersView({ matters, notices, hearings, assesseeName, notify, focusReqId, openMatterId }) {
  const [openId, setOpenId] = React.useState(null);
  const [parsingId, setParsingId] = React.useState("");

  const byDateDesc = (arr) => [...arr].sort((x, y) => (y.date || "").localeCompare(x.date || ""));
  const noticesFor = (m) => byDateDesc(notices.filter((n) => m.proceedingReqId && n.proceedingReqId === m.proceedingReqId));
  const hearingsFor = (m) => byDateDesc(hearings.filter((h) => m.proceedingReqId && h.proceedingReqId === m.proceedingReqId));

  // When asked to focus a proceeding — from the "closed" popup (by reqId) or a
  // click on the global Matters / Hearings page (by matter id) — open its card.
  React.useEffect(() => {
    let id = null;
    if (openMatterId && matters.some((m) => m.id === openMatterId)) id = openMatterId;
    else if (focusReqId) id = matters.find((mm) => mm.proceedingReqId === focusReqId)?.id || null;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (id) setOpenId(id);
  }, [focusReqId, openMatterId, matters]);

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

  if (matters.length === 0) {
    return (
      <div className="card" style={{padding: 0}}>
        <EmptyState icon="scale" title={`No proceedings for ${assesseeName} yet`} sub="Run a portal sync from the Overview tab to pull the assessee's e-Proceedings, or add a matter manually."/>
      </div>
    );
  }

  const selected = ordered.find((m) => m.id === openId) || null;

  // type | proceeding (flex) | AY | section (no-wrap) | status | view chip
  const GRID = "96px minmax(170px, 1fr) 70px 128px 96px 104px";
  return (
    <>
      <div style={{overflowX: "auto"}}>
        <div className="col" style={{gap: 10, minWidth: 640}}>
          <div style={{display: "grid", gridTemplateColumns: GRID, gap: 14, alignItems: "center", padding: "0 18px", fontSize: 10.5, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--p-text-3)"}}>
            <span>Type</span><span>Proceeding</span><span>AY</span><span>Section</span><span>Status</span><span/>
          </div>
          {ordered.map((m) => {
            const ns = noticesFor(m);
            const hs = hearingsFor(m);
            const isPortal = Boolean(m.proceedingReqId);
            const docCount = ns.length;
            const section = m.section || ns.map((n) => n.section).find(Boolean) || "";
            const accent = accentFor(m.type);
            return (
              <div
                key={m.id}
                className="card matter-row"
                onClick={() => setOpenId(m.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenId(m.id); } }}
                style={{display: "grid", gridTemplateColumns: GRID, gap: 14, alignItems: "center", padding: "14px 18px", cursor: "pointer", borderLeft: `4px solid ${accent.bar}`}}
              >
                <span><span className="pill" style={{background: accent.tint, color: accent.fg, fontWeight: 700}}>{m.type || "Matter"}</span></span>
                <span style={{minWidth: 0}}>
                  <span className="strong" style={{fontSize: 13, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{m.ref || m.proceedingName || "Matter"}</span>
                  <span className="muted" style={{fontSize: 11}}>
                    {isPortal
                      ? `${docCount} notice${docCount === 1 ? "" : "s"}/orders${hs.length ? ` · ${hs.length} hearing${hs.length === 1 ? "" : "s"}` : ""}`
                      : "Manual matter"}
                  </span>
                </span>
                <span>{m.ay || "—"}</span>
                <span style={{whiteSpace: "nowrap"}}>{section ? <span className="pill pill-muted">u/s {section}</span> : <span className="muted">—</span>}</span>
                <span><StatusPill status={m.status}/></span>
                <span className="matter-view center" style={{gap: 5, justifySelf: "end", padding: "6px 11px", borderRadius: 999, background: "var(--p-lavender-2)", color: "var(--p-primary-2)", fontSize: 11.5, fontWeight: 700, whiteSpace: "nowrap"}}>
                  View <Icon name="arrow-right" size={13}/>
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {selected && (
        <ProceedingModal
          matter={selected}
          notices={noticesFor(selected)}
          hearings={hearingsFor(selected)}
          parsingId={parsingId}
          onParse={parse}
          onClose={() => setOpenId(null)}
        />
      )}
    </>
  );
}

/* Full, scrollable pop-up card for a single proceeding — its hearings and every
   notice / order / appeal filed against it, with the assessee's responses. */
function ProceedingModal({ matter: m, notices: ns, hearings: hs, parsingId, onParse, onClose }) {
  const accent = accentFor(m.type);
  const section = m.section || ns.map((n) => n.section).find(Boolean) || "";
  const docCount = ns.length;
  return (
    <Modal
      title={m.ref || m.proceedingName || "Proceeding"}
      sub={[m.type || "Matter", m.ay ? `AY ${m.ay}` : "", section ? `u/s ${section}` : ""].filter(Boolean).join("  ·  ")}
      onClose={onClose}
      width={780}
      footer={<button className="btn btn-secondary" onClick={onClose}>Close</button>}
    >
      <div className="col" style={{gap: 16}}>
        {/* Summary strip — tinted by the proceeding type so it reads apart. */}
        <div className="between" style={{alignItems: "center", flexWrap: "wrap", gap: 10, padding: "12px 14px", background: accent.tint, borderRadius: 12, borderLeft: `4px solid ${accent.bar}`}}>
          <div className="center" style={{gap: 8, flexWrap: "wrap", justifyContent: "flex-start"}}>
            <span className="pill" style={{background: "white", color: accent.fg, fontWeight: 800}}>{m.type || "Matter"}</span>
            <StatusPill status={m.status}/>
            {m.bench && <span className="muted" style={{fontSize: 12}}>{m.bench}</span>}
          </div>
          <div className="muted" style={{fontSize: 12, fontWeight: 700}}>
            {docCount} notice{docCount === 1 ? "" : "s"}/orders{hs.length ? ` · ${hs.length} hearing${hs.length === 1 ? "" : "s"}` : ""}
          </div>
        </div>

        {hs.length > 0 && (
          <div>
            <div className="muted" style={{fontSize: 11, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", marginBottom: 8}}>Hearings</div>
            <div className="col" style={{gap: 8}}>
              {hs.map((h) => (
                <div key={h.id} className="center" style={{gap: 10, fontSize: 12.5, justifyContent: "flex-start", padding: "9px 11px", background: "var(--p-card-tint)", borderRadius: 10, border: "1px solid var(--p-line-2)", flexWrap: "wrap"}}>
                  <Icon name="calendar" size={13}/>
                  <span className="strong">{fmtDateLong(h.date)}</span>
                  <span className="muted">{h.time} · {h.mode}</span>
                  <StatusPill status={h.date < todayISO() ? "Completed" : h.status}/>
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <div className="muted" style={{fontSize: 11, fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", marginBottom: 8}}>Notices &amp; orders</div>
          {ns.length === 0
            ? <div className="muted" style={{fontSize: 12.5, padding: "10px 12px", background: "var(--p-card-tint)", borderRadius: 10, border: "1px dashed var(--p-line)"}}>No notices/orders synced for this proceeding yet.</div>
            : (
              <div className="col" style={{gap: 10}}>
                {ns.map((n) => {
                  const order = isOrderDoc(n);
                  const appeal = Boolean(n.isAppealForm);
                  const ap = n.appeal || {};
                  const apAtts = appeal ? (ap.attachments || []).filter((x) => x.storagePath) : [];
                  return (
                    <div key={n.id} style={{padding: "11px 13px", background: "var(--p-card-tint)", borderRadius: 12, border: "1px solid var(--p-line)"}}>
                      <div className="center" style={{gap: 10, alignItems: "flex-start"}}>
                        <div style={{width: 30, height: 38, borderRadius: 5, background: appeal ? "var(--p-lavender-2)" : order ? "var(--p-amber)" : "var(--p-pink)", display: "grid", placeItems: "center", color: appeal ? "var(--p-primary-2)" : order ? "#B07512" : "#C13388", fontSize: 8, fontWeight: 800, flexShrink: 0}}>PDF</div>
                        <div style={{flex: 1, minWidth: 0}}>
                          <div className="center" style={{gap: 6, justifyContent: "flex-start"}}>
                            <span className={`pill ${appeal ? "pill-primary" : order ? "pill-warning" : "pill-muted"}`} style={{fontSize: 10}}>{appeal ? "Appeal · Form 35" : order ? "Order" : "Notice"}</span>
                            <span className="strong" style={{fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{n.subject || n.din || "Notice"}</span>
                          </div>
                          <div className="muted" style={{fontSize: 11, marginTop: 2}}>
                            {appeal
                              ? [ap.dateFiling ? `Filed ${fmtDateLong(ap.dateFiling)}` : "", ap.ackNum ? `Ack ${ap.ackNum}` : "", ap.dateOrder ? `vs order ${fmtDateLong(ap.dateOrder)}` : "", ap.orderSection ? `u/s ${ap.orderSection}` : "", ap.appealSection ? `appeal u/s ${ap.appealSection}` : ""].filter(Boolean).join(" · ")
                              : [n.date ? fmtDateLong(n.date) : "", n.section ? `u/s ${n.section}` : "", n.din ? `DIN ${n.din}` : ""].filter(Boolean).join(" · ")}
                          </div>
                          {appeal && (ap.amountAssessed || ap.disputedDemand) ? (
                            <div className="muted" style={{fontSize: 11, marginTop: 2}}>
                              {[ap.amountAssessed ? `Assessed ${fmtINR(ap.amountAssessed)}` : "", ap.disputedDemand ? `Disputed ${fmtINR(ap.disputedDemand)}` : ""].filter(Boolean).join(" · ")}
                            </div>
                          ) : null}
                        </div>
                        {!appeal && n.storagePath && (
                          <button className="btn btn-ghost btn-xs" title="Summarise this PDF with AI" disabled={parsingId === n.id} onClick={(e) => { e.stopPropagation(); onParse(n); }}>
                            <Icon name="sparkle" size={12}/>{parsingId === n.id ? "Parsing…" : (n.aiSummary ? "Re-parse" : "Parse with AI")}
                          </button>
                        )}
                        {!appeal && n.storagePath && (
                          <button className="btn btn-ghost btn-xs" title="Open the portal PDF" onClick={(e) => { e.stopPropagation(); openStoragePdf(n.storagePath); }}>
                            <Icon name="doc" size={12}/>PDF
                          </button>
                        )}
                      </div>
                      {appeal && apAtts.length > 0 && (
                        <div className="row" style={{gap: 6, flexWrap: "wrap", marginTop: 8}}>
                          {apAtts.map((at, ai) => (
                            <button key={ai} className="btn btn-ghost btn-xs" title={at.label ? `${at.label} — ${at.filename}` : at.filename} onClick={(e) => { e.stopPropagation(); openStoragePdf(at.storagePath); }}>
                              <Icon name="doc" size={11}/>{(at.label || at.filename || "PDF").slice(0, 28)}
                            </button>
                          ))}
                        </div>
                      )}
                      {appeal && ap.formPdfError && !apAtts.some((at) => /form 35/i.test(at.label || at.filename || "")) && (
                        <div className="muted" style={{marginTop: 6, fontSize: 10.5, color: "var(--p-danger)"}}>Form 35 PDF couldn't be fetched — {ap.formPdfError}</div>
                      )}
                      {!appeal && n.aiSummary && (n.aiSummary.summary || (n.aiSummary.items || []).length > 0) && (
                        <div style={{marginTop: 8, padding: "8px 10px", background: "white", borderRadius: 8, border: "1px solid var(--p-line-2)", fontSize: 12}}>
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
      </div>
    </Modal>
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
