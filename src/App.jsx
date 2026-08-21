import React from 'react';
import Sidebar from './Sidebar';
import Dashboard from './Dashboard';
import { Assessees, AssesseeProfile } from './Assessees';
import Hearings from './Hearings';
import Appeals from './Appeals';
import { NoticeReview } from './Notices';
import Intimations from './Intimations';
import { Matters, Invoices, Communications, Reports, SettingsPage } from './Other';
import Tools from './Tools';
import { Icon } from './shared';
import { DataProvider, useData } from './store';
import { AuthProvider, useAuth } from './auth';
import Login from './Login';
import Landing from './Landing';
import Onboarding from './Onboarding';
import ConnectorDownload from './ConnectorDownload';
import { useCalendarReturn } from './googleCalendar';
import { CalendarDeadlineMirror } from './CalendarDeadlineMirror';
import { tap, success, error as hapticError, setHapticsEnabled } from './haptics';
import { MobileAppBar, MobileTabBar, useOverdueCount } from './MobileNav';
import { useItatMail } from './itatEmail';

function Splash({ label = "Loading your practice…" }) {
  return (
    <div style={{minHeight: "100vh", display: "grid", placeItems: "center", background: "#F7F6FB"}}>
      <div style={{display: "flex", flexDirection: "column", alignItems: "center", gap: 16}}>
        <img src="/prohippo-logo.png" alt="ProHippo" style={{height: 76, width: "auto", animation: "pulse 1.2s ease-in-out infinite"}}/>
        <div className="muted" style={{fontSize: 13}}>{label}</div>
        <style>{`@keyframes pulse { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(0.92); opacity: 0.75; } }`}</style>
      </div>
    </div>
  );
}

function Shell() {
  const { data, toast, notify } = useData();
  const { user } = useAuth();
  const [route, setRoute] = React.useState("dashboard");
  const [linkDismissed, setLinkDismissed] = React.useState(false);
  const [openAssesseeId, setOpenAssesseeId] = React.useState(null);
  const [profileFocus, setProfileFocus] = React.useState(null); // { tab, matterId } when opened via a matter/hearing click
  const [reviewNotice, setReviewNotice] = React.useState(null); // notice record, or {} for a new one
  const [assesseeQuery, setAssesseeQuery] = React.useState("");
  // A record handed to the Tools page to start a tool from — today, the s.158BC
  // notice an ITR-B is being built against.
  const [toolsSeed, setToolsSeed] = React.useState(null);
  const [menuOpen, setMenuOpen] = React.useState(false); // mobile drawer
  /* Counted once, here, for everything that shows them: the sidebar's Hearings
     badge, the phone's tab bar, the bell on the app bar. Each of these used to
     work its own out — a second live listener on the Tribunal's mail and a
     second walk of every order in the practice, on every session. */
  const { pending: itatPending } = useItatMail();
  const overdue = useOverdueCount();

  /* TOUCH FEEDBACK, WIRED ONCE.
   *
   * One delegated listener rather than an onTouchStart on several hundred
   * buttons. Every control in the app is covered by construction, including
   * ones not written yet, and no component has to know that haptics exist.
   *
   * `pointerdown`, not click: the buzz has to land when the finger lands, not
   * after whatever the button does. Touch only — a mouse is not asking for
   * this, and the API is a no-op on a desktop anyway. */
  React.useEffect(() => {
    const onDown = (e) => {
      if (e.pointerType !== "touch") return;
      const el = e.target?.closest?.("button, a[href], .fchip, .utab, .tab, .matter-row, .row-link, [role='button'], input[type='checkbox'], select");
      if (!el || el.disabled || el.getAttribute("aria-disabled") === "true") return;
      tap();
    };
    document.addEventListener("pointerdown", onDown, { passive: true });
    return () => document.removeEventListener("pointerdown", onDown);
  }, []);

  // The practice can switch it off; anyone who has asked the OS for reduced
  // motion has it off already (see src/haptics.js).
  React.useEffect(() => { setHapticsEnabled(data.profile?.haptics); }, [data.profile?.haptics]);

  /* A toast is the app answering back, so it answers in the same channel:
     two light ticks for a success, one firmer one for a failure. */
  React.useEffect(() => {
    if (!toast) return;
    if (toast.icon === "alert") hapticError(); else success();
  }, [toast]);

  const handleNav = (id) => {
    setRoute(id);
    setOpenAssesseeId(null);
    setProfileFocus(null);
    setReviewNotice(null);
    setToolsSeed(null);
    setMenuOpen(false);
  };

  /* Open the ITR-B builder against a notice under s.158BC.
   *
   * The block return is furnished through the e-Proceeding for this very
   * notice, and the notice already carries the four things the return's Part A
   * asks for — the DIN, the date, the date of service and the period the AO has
   * allowed. Carrying the record across means none of them is typed twice. */
  const openItrbForNotice = (notice) => {
    setReviewNotice(null);
    setOpenAssesseeId(null);
    setProfileFocus(null);
    setToolsSeed({ tool: "itrb", notice });
    setRoute("tools");
    setMenuOpen(false);
  };

  const openReview = (notice) => setReviewNotice(notice || {});

  /* Google sends the user back to the app root after consent. Report how it
     went, and put them on Settings — that's where the switches they just
     unlocked live, and where a failure has to be fixed. */
  useCalendarReturn(React.useCallback((result) => {
    notify(result.message, result.icon);
    if (result.outcome !== "cancelled") setRoute("settings");
  }, [notify]));

  const handleSearch = (q) => {
    setAssesseeQuery(q);
    handleNav("assessees");
  };

  // Resolve the assessee a matter/hearing belongs to (by PAN, then name).
  const assesseeForRecord = (rec) => {
    const pan = (rec.pan || "").toUpperCase();
    return data.assessees.find((a) => pan && (a.pan || "").toUpperCase() === pan)
      || data.assessees.find((a) => a.name && a.name === rec.assessee);
  };

  // Open the assessee's profile straight to the clicked proceeding's pop-up card.
  const openMatterInProfile = (matter) => {
    const a = assesseeForRecord(matter);
    if (!a) return;
    setReviewNotice(null);
    setOpenAssesseeId(a.id);
    setProfileFocus({ tab: "Matters", matterId: matter.id });
    setMenuOpen(false);
  };

  /* Open the proceeding a NOTICE belongs to — the assessee's profile, Matters
     tab, with that proceeding's card expanded.
   *
   * This is where a notice is read in context: the card carries the whole
   * proceeding — every notice and order in it, the replies filed, the hearings
   * — which is what somebody clicking a notice on the dashboard is actually
   * looking for. The review screen shows the one document and none of that.
   *
   * A notice with no proceeding behind it (keyed in by hand, or parsed from a
   * PDF, so it never came through the portal sync) has no card to open; those
   * fall back to the review screen, which at least shows that exact notice. */
  const openNoticeInProfile = (notice) => {
    const a = assesseeForRecord(notice);
    const match = a && notice.proceedingReqId
      ? data.matters.find((m) => m.proceedingReqId === notice.proceedingReqId
        && (m.pan || "").toUpperCase() === (notice.pan || "").toUpperCase())
      : null;
    if (!match) { openReview(notice); return; }
    setReviewNotice(null);
    setOpenAssesseeId(a.id);
    setProfileFocus({ tab: "Matters", matterId: match.id });
    setMenuOpen(false);
  };

  // Open the proceeding a hearing belongs to; fall back to the Hearings tab when
  // no matching matter exists for it.
  const openHearingInProfile = (hearing) => {
    const a = assesseeForRecord(hearing);
    if (!a) return;
    const match = data.matters.find((m) => (m.pan || "").toUpperCase() === (hearing.pan || "").toUpperCase()
      && ((hearing.proceedingReqId && m.proceedingReqId === hearing.proceedingReqId) || m.ay === hearing.ay));
    setReviewNotice(null);
    setOpenAssesseeId(a.id);
    setProfileFocus(match ? { tab: "Matters", matterId: match.id } : { tab: "Hearings" });
    setMenuOpen(false);
  };

  const backFromProfile = () => { setOpenAssesseeId(null); setProfileFocus(null); };

  const openAssessee = openAssesseeId ? data.assessees.find((a) => a.id === openAssesseeId) : null;

  let content;
  if (reviewNotice) {
    content = (
      <NoticeReview
        key={reviewNotice.id || "new"}
        notice={reviewNotice}
        onClose={() => setReviewNotice(null)}
        onSaved={(dest) => { setReviewNotice(null); if (dest) setRoute(dest); }}
        onOpenNotice={openReview}
        onBuildItrB={openItrbForNotice}
      />
    );
  } else if (openAssessee) {
    content = (
      <AssesseeProfile
        key={openAssessee.id}
        assessee={openAssessee}
        onBack={backFromProfile}
        onNav={handleNav}
        initialTab={profileFocus?.tab}
        initialMatterId={profileFocus?.matterId}
      />
    );
  } else {
    switch (route) {
      case "dashboard": content = <Dashboard onNav={handleNav} onOpenNotice={openReview} onOpenProceeding={openNoticeInProfile} onSearch={handleSearch}/>; break;
      case "assessees": content = <Assessees onOpen={(a) => { setProfileFocus(null); setOpenAssesseeId(a.id); }} initialSearch={assesseeQuery}/>; break;
      case "matters": content = <Matters onOpenMatter={openMatterInProfile}/>; break;
      case "hearings": content = <Hearings onOpenHearing={openHearingInProfile} onNav={handleNav}/>; break;
      case "appeals": content = <Appeals onOpenNotice={openReview}/>; break;
      case "invoices": content = <Invoices/>; break;
      case "communications": content = <Communications/>; break;
      case "intimations": content = <Intimations/>; break;
      case "reports": content = <Reports/>; break;
      case "tools": content = <Tools seed={toolsSeed} onSeedUsed={() => setToolsSeed(null)}/>; break;
      case "connector": content = <ConnectorDownload/>; break;
      case "settings": content = <SettingsPage/>; break;
      default: content = <Dashboard onNav={handleNav} onOpenNotice={openReview} onOpenProceeding={openNoticeInProfile} onSearch={handleSearch}/>;
    }
  }

  return (
    <div className="app">
      <CalendarDeadlineMirror/>
      <MobileAppBar
        /* The bell leads to the dashboard because that is where both of the
           queues it counts are already listed and worked — it is a way of
           noticing them from another page, not a page of its own. */
        onBell={() => handleNav("dashboard")}
        overdue={overdue}
      />
      <Sidebar active={route} onNav={handleNav} open={menuOpen} itatCount={itatPending.length}/>
      {menuOpen && <div className="sidebar-backdrop" onClick={() => setMenuOpen(false)}/>}
      {/* The whole drawer, one thumb-reach from the corner. The tab bar under
          it carries the four registers; this is everything else. */}
      <button
        className={`fab-menu ${menuOpen ? "open" : ""}`}
        aria-label={menuOpen ? "Close menu" : "Open menu"}
        onClick={() => setMenuOpen(o => !o)}
      >
        <span/><span/><span/>
      </button>
      <main className="main">
        {data.profile && !data.profile.phoneVerified && !(user && user.phoneNumber) && route !== "settings" && !linkDismissed && (
          <div className="animate-in" style={{ margin: "0 0 14px", padding: "10px 14px", borderRadius: 12, background: "var(--p-lavender-2, #EEE9FF)", border: "1px solid var(--p-primary-3, #C9BEF5)", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <Icon name="phone" size={16}/>
            <div style={{ flex: 1, minWidth: 180, fontSize: 13 }}>Add your mobile number to sign in by SMS — and keep phone &amp; email on one account.</div>
            <button className="btn btn-primary btn-sm" onClick={() => handleNav("settings")}>Add mobile</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setLinkDismissed(true)}>Later</button>
          </div>
        )}
        {content}
      </main>
      <MobileTabBar
        active={route}
        menuOpen={menuOpen}
        onNav={handleNav}
        onMore={() => setMenuOpen(o => !o)}
        overdue={overdue}
        itatCount={itatPending.length}
      />
      {toast && (
        <div className="toast animate-in">
          <div style={{width: 22, height: 22, borderRadius: "50%", background: toast.icon === "alert" ? "var(--p-danger)" : "var(--p-success)", display: "grid", placeItems: "center"}}>
            <Icon name={toast.icon} size={13} stroke={3}/>
          </div>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function ProfileGate() {
  const { profile, profileLoading } = useData();
  if (profileLoading) return <Splash/>;
  if (!profile) return <Onboarding/>;
  return <Shell/>;
}

function AuthGate() {
  const { user, loading } = useAuth();
  const [showLogin, setShowLogin] = React.useState(false);
  if (loading) return <Splash label="Signing you in…"/>;
  if (!user) {
    if (!showLogin) return <Landing onSignIn={() => setShowLogin(true)}/>;
    return <Login onBack={() => setShowLogin(false)}/>;
  }
  return (
    <DataProvider>
      <ProfileGate/>
    </DataProvider>
  );
}

/* The admin console. Lazily imported so it never lands in the bundle a
   practitioner downloads — and it deliberately does NOT mount DataProvider:
   the console has no business subscribing to anyone's practice data, including
   the signed-in admin's own. */
const AdminApp = React.lazy(() => import('./admin/AdminApp'));

function AdminGate() {
  const { user, loading } = useAuth();
  if (loading) return <Splash label="Signing you in…"/>;
  // Same sign-in screen as the app; a non-admin who gets through it lands on
  // AdminApp's "no admin access" wall.
  if (!user) return <Login onBack={() => { window.location.href = "/"; }}/>;
  return (
    <React.Suspense fallback={<Splash label="Opening the admin console…"/>}>
      <AdminApp/>
    </React.Suspense>
  );
}

export default function App() {
  // Hosting rewrites every path to index.html (firebase.json), so routing is
  // ours to do. One split is all the app needs: the console, or the product.
  const path = typeof window === "undefined" ? "" : window.location.pathname;
  const isAdmin = path === "/admin" || path.startsWith("/admin/");

  return (
    <AuthProvider>
      {isAdmin ? <AdminGate/> : <AuthGate/>}
    </AuthProvider>
  );
}
