import React from 'react';
import { Icon, EmptyState, fmtDateTime } from './shared';
import { useData } from './store';
import { draftSummary } from './tools/itrb/draft';

/* The ITR-B builder is the one page in the app that carries jsPDF and its font
   subset into the bundle for a feature most practices will use in a handful of
   matters a year. It is loaded when somebody opens the tool, not before. */
const ItrB = React.lazy(() => import('./tools/ItrB'));

/* The catalogue. One entry today; the shape is here because a tools page with
   one hard-coded card is a tools page that grows a second one by copy-paste. */
const TOOLS = [
  {
    id: "itrb",
    name: "ITR-B — block assessment return",
    blurb: "Build the return for a search case: the block period from the date of search, the income already declared read straight out of each year's filed ITR, the undisclosed income head by head, and the tax under s.113.",
    icon: "doc",
    color: "primary",
    beta: true,
    tags: ["Chapter XIV-B", "s.158BC", "Rule 12AE"],
  },
];

const COLORS = {
  primary: ["var(--p-lavender-2)", "var(--p-primary-2)"],
  pink: ["var(--p-pink)", "#C13388"],
  success: ["var(--p-mint)", "#1B8C5C"],
};

export default function Tools({ seed, onSeedUsed }) {
  const { data } = useData();
  // A seeded arrival opens its tool immediately: somebody who clicked "Build
  // the ITR-B" on a notice has already chosen, and a catalogue page in between
  // is a click that asks them to choose again.
  const [open, setOpen] = React.useState(seed?.tool || null);
  const [openDraftId, setOpenDraftId] = React.useState(null);
  /* Adjusted during render rather than in an effect, because the seed can
     arrive while this page is ALREADY the one on screen — a practitioner who
     came to Tools first, went back for the notice, and clicked through from
     there. Initialising from the prop alone would leave them looking at the
     catalogue wondering what the button did. */
  const [seedUsed, setSeedUsed] = React.useState(seed || null);
  if (seed && seed !== seedUsed) {
    setSeedUsed(seed);
    setOpen(seed.tool);
    setOpenDraftId(null);
  }

  const drafts = [...(data.itrbDrafts || [])].sort((a, b) =>
    String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));

  const enter = (toolId, draftId = null) => { setOpen(toolId); setOpenDraftId(draftId); };

  if (open === "itrb") {
    return (
      <React.Suspense fallback={<div className="card animate-in" style={{display: "grid", placeItems: "center", minHeight: 220}}><span className="muted">Opening ITR-B…</span></div>}>
        <ItrB
          draftId={openDraftId}
          seedNotice={seedUsed?.notice || null}
          onBack={() => { setOpen(null); setOpenDraftId(null); onSeedUsed?.(); }}
        />
      </React.Suspense>
    );
  }

  return (
    <div className="animate-in">
      <div className="topbar">
        <div>
          <div className="page-title" style={{display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap"}}>
            Tools
            <span className="pill pill-warning" style={{fontSize: 11, letterSpacing: "0.05em"}}>BETA</span>
          </div>
          <div className="page-sub">Working papers built from what the practice already holds. Everything here produces a draft to check — nothing is filed.</div>
        </div>
      </div>

      <div className="grid-cards">
        {TOOLS.map((t) => {
          const colors = COLORS[t.color] || COLORS.primary;
          return (
            <div key={t.id} className="card" style={{display: "flex", flexDirection: "column"}}>
              <div className="center" style={{gap: 12, marginBottom: 14}}>
                <div style={{width: 40, height: 40, borderRadius: 12, background: colors[0], color: colors[1], display: "grid", placeItems: "center", flexShrink: 0}}>
                  <Icon name={t.icon} size={18}/>
                </div>
                <div style={{flex: 1, minWidth: 0}}>
                  <div style={{fontWeight: 700, fontSize: 14}}>{t.name}</div>
                </div>
                {t.beta && <span className="pill pill-warning" style={{fontSize: 10}}>BETA</span>}
              </div>
              <div className="card-sub mb-4" style={{flex: 1}}>{t.blurb}</div>
              <div style={{display: "flex", gap: 6, flexWrap: "wrap", margin: "12px 0 14px"}}>
                {t.tags.map((tag) => <span key={tag} className="pill pill-muted" style={{fontSize: 10.5}}>{tag}</span>)}
              </div>
              <button className="btn btn-primary btn-sm" style={{width: "100%", justifyContent: "center"}} onClick={() => enter(t.id)}>
                <Icon name="plus" size={12}/>Start a new ITR-B
              </button>
            </div>
          );
        })}
      </div>

      <div className="card" style={{marginTop: 18}}>
        <div className="card-head">
          <div>
            <div className="card-title">Saved drafts</div>
            <div className="card-sub">A block return is built over days. Every draft is saved against your practice and picks up where it was left.</div>
          </div>
        </div>
        {drafts.length === 0 ? (
          <EmptyState
            icon="folder"
            title="No ITR-B drafts yet"
            sub="Start one from the card above — pick the assessee, enter the date of the search, and the block period follows from it."
          />
        ) : (
          <div style={{display: "flex", flexDirection: "column", gap: 8}}>
            {drafts.map((d) => (
              <div
                key={d.id}
                className="row-link"
                onClick={() => enter("itrb", d.id)}
                style={{display: "flex", alignItems: "center", gap: 12, padding: "11px 13px", borderRadius: 12, border: "1px solid var(--p-line)", cursor: "pointer", background: "white"}}
              >
                <div style={{width: 32, height: 32, borderRadius: 10, background: "var(--p-lavender-2)", color: "var(--p-primary-2)", display: "grid", placeItems: "center", flexShrink: 0}}>
                  <Icon name="doc" size={15}/>
                </div>
                <div style={{flex: 1, minWidth: 0}}>
                  <div style={{fontWeight: 600, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{d.name || d.assessee || "Untitled ITR-B"}</div>
                  <div className="muted" style={{fontSize: 11.5}}>{draftSummary(d)}</div>
                </div>
                <div className="muted" style={{fontSize: 11.5, flexShrink: 0}}>
                  {d.updatedAt ? `Saved ${fmtDateTime(d.updatedAt)}` : ""}
                </div>
                <Icon name="chevron-right" size={15}/>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
