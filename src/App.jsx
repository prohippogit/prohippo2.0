import React from 'react';
import Sidebar from './Sidebar';
import Dashboard from './Dashboard';
import { Assessees, AssesseeProfile } from './Assessees';
import Hearings from './Hearings';
import Appeals from './Appeals';
import { NoticeReview } from './Notices';
import { Matters, Invoices, Communications, AiParser, Reports, SettingsPage } from './Other';
import { Icon } from './shared';
import { DataProvider, useData } from './store';
import { AuthProvider, useAuth } from './auth';
import Login from './Login';
import Landing from './Landing';
import Onboarding from './Onboarding';
import ConnectorDownload from './ConnectorDownload';
import { useCalendarReturn } from './googleCalendar';
import { CalendarDeadlineMirror } from './CalendarDeadlineMirror';

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
  const [menuOpen, setMenuOpen] = React.useState(false); // mobile drawer

  const handleNav = (id) => {
    setRoute(id);
    setOpenAssesseeId(null);
    setProfileFocus(null);
    setReviewNotice(null);
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
      case "dashboard": content = <Dashboard onNav={handleNav} onOpenNotice={openReview} onSearch={handleSearch}/>; break;
      case "assessees": content = <Assessees onOpen={(a) => { setProfileFocus(null); setOpenAssesseeId(a.id); }} initialSearch={assesseeQuery}/>; break;
      case "matters": content = <Matters onOpenMatter={openMatterInProfile}/>; break;
      case "hearings": content = <Hearings onOpenHearing={openHearingInProfile} onNav={handleNav}/>; break;
      case "appeals": content = <Appeals onOpenNotice={openReview}/>; break;
      case "invoices": content = <Invoices/>; break;
      case "communications": content = <Communications/>; break;
      case "ai": content = <AiParser onOpenNotice={openReview}/>; break;
      case "reports": content = <Reports/>; break;
      case "connector": content = <ConnectorDownload/>; break;
      case "settings": content = <SettingsPage/>; break;
      default: content = <Dashboard onNav={handleNav} onOpenNotice={openReview} onSearch={handleSearch}/>;
    }
  }

  return (
    <div className="app">
      <CalendarDeadlineMirror/>
      <div className="mobile-topbar">
        <img src="/prohippo-logo.png" alt="ProHippo" style={{height: 34, width: "auto"}}/>
      </div>
      <Sidebar active={route} onNav={handleNav} open={menuOpen}/>
      {menuOpen && <div className="sidebar-backdrop" onClick={() => setMenuOpen(false)}/>}
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

export default function App() {
  return (
    <AuthProvider>
      <AuthGate/>
    </AuthProvider>
  );
}
