import React from 'react';
import Sidebar from './Sidebar';
import Dashboard from './Dashboard';
import { Assessees, AssesseeProfile } from './Assessees';
import Hearings from './Hearings';
import Notices, { NoticeReview } from './Notices';
import { Matters, Invoices, Communications, AiParser, Reports, SettingsPage } from './Other';
import { Icon } from './shared';
import { DataProvider, useData } from './store';
import { AuthProvider, useAuth } from './auth';
import Login from './Login';
import Landing from './Landing';
import Onboarding from './Onboarding';

function Splash({ label = "Loading your practice…" }) {
  return (
    <div style={{minHeight: "100vh", display: "grid", placeItems: "center", background: "#F7F6FB"}}>
      <div style={{display: "flex", flexDirection: "column", alignItems: "center", gap: 16}}>
        <img src="/prohippo-mark.png" alt="ProHippo" style={{width: 56, height: 56, objectFit: "contain", animation: "pulse 1.2s ease-in-out infinite"}}/>
        <div className="muted" style={{fontSize: 13}}>{label}</div>
        <style>{`@keyframes pulse { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(0.92); opacity: 0.75; } }`}</style>
      </div>
    </div>
  );
}

function Shell() {
  const { data, toast } = useData();
  const [route, setRoute] = React.useState("dashboard");
  const [openAssesseeId, setOpenAssesseeId] = React.useState(null);
  const [reviewNotice, setReviewNotice] = React.useState(null); // notice record, or {} for a new one
  const [assesseeQuery, setAssesseeQuery] = React.useState("");

  const handleNav = (id) => {
    setRoute(id);
    setOpenAssesseeId(null);
    setReviewNotice(null);
  };

  const openReview = (notice) => setReviewNotice(notice || {});

  const handleSearch = (q) => {
    setAssesseeQuery(q);
    handleNav("assessees");
  };

  const openAssessee = openAssesseeId ? data.assessees.find((a) => a.id === openAssesseeId) : null;

  let content;
  if (reviewNotice) {
    content = (
      <NoticeReview
        notice={reviewNotice}
        onClose={() => setReviewNotice(null)}
        onSaved={(dest) => { setReviewNotice(null); if (dest) setRoute(dest); }}
      />
    );
  } else if (openAssessee) {
    content = <AssesseeProfile assessee={openAssessee} onBack={() => setOpenAssesseeId(null)} onNav={handleNav}/>;
  } else {
    switch (route) {
      case "dashboard": content = <Dashboard onNav={handleNav} onOpenNotice={openReview} onSearch={handleSearch}/>; break;
      case "assessees": content = <Assessees onOpen={(a) => setOpenAssesseeId(a.id)} initialSearch={assesseeQuery}/>; break;
      case "matters": content = <Matters/>; break;
      case "notices": content = <Notices onOpenNotice={openReview}/>; break;
      case "hearings": content = <Hearings/>; break;
      case "invoices": content = <Invoices/>; break;
      case "communications": content = <Communications/>; break;
      case "ai": content = <AiParser onOpenNotice={openReview}/>; break;
      case "reports": content = <Reports/>; break;
      case "settings": content = <SettingsPage/>; break;
      default: content = <Dashboard onNav={handleNav} onOpenNotice={openReview} onSearch={handleSearch}/>;
    }
  }

  return (
    <div className="app">
      <Sidebar active={route} onNav={handleNav}/>
      <main className="main">
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
