import React from 'react';
import Sidebar from './Sidebar';
import Dashboard from './Dashboard';
import { Assessees, AssesseeProfile } from './Assessees';
import Hearings from './Hearings';
import Notices, { ParsedNoticeReview } from './Notices';
import { Matters, Invoices, Communications, AiParser, Reports, SettingsPage } from './Other';
import { Icon } from './shared';

export default function App() {
  const [route, setRoute] = React.useState("dashboard");
  const [openAssessee, setOpenAssessee] = React.useState(null);
  const [showParsed, setShowParsed] = React.useState(false);
  const [toast, setToast] = React.useState(null);

  React.useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 3500);
      return () => clearTimeout(t);
    }
  }, [toast]);

  const handleNav = (id) => {
    setRoute(id);
    setOpenAssessee(null);
    setShowParsed(false);
  };

  const handleSaveAndCreate = () => {
    setShowParsed(false);
    setRoute("hearings");
    setToast({ msg: "Hearing created · Calendar synced · Client notified", icon: "check" });
  };

  let content;
  if (showParsed) {
    content = <ParsedNoticeReview onClose={() => setShowParsed(false)} onSaveAndCreate={handleSaveAndCreate}/>;
  } else if (openAssessee) {
    content = <AssesseeProfile assessee={openAssessee} onBack={() => setOpenAssessee(null)} onNav={handleNav}/>;
  } else {
    switch (route) {
      case "dashboard": content = <Dashboard onNav={handleNav} onOpenParsedNotice={() => setShowParsed(true)}/>; break;
      case "assessees": content = <Assessees onOpen={setOpenAssessee}/>; break;
      case "matters": content = <Matters/>; break;
      case "notices": content = <Notices onOpenParsed={() => setShowParsed(true)}/>; break;
      case "hearings": content = <Hearings/>; break;
      case "invoices": content = <Invoices/>; break;
      case "communications": content = <Communications/>; break;
      case "ai": content = <AiParser onOpenParsed={() => setShowParsed(true)}/>; break;
      case "reports": content = <Reports/>; break;
      case "settings": content = <SettingsPage/>; break;
      default: content = <Dashboard onNav={handleNav} onOpenParsedNotice={() => setShowParsed(true)}/>;
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
          <div style={{width: 22, height: 22, borderRadius: "50%", background: "var(--p-success)", display: "grid", placeItems: "center"}}>
            <Icon name={toast.icon} size={13} stroke={3}/>
          </div>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
