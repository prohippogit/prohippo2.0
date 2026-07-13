import React from 'react';
import { Icon } from './shared';
import { useData, awaitingNotices } from './store';
import { useAuth } from './auth';

const NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard" },
  { id: "assessees", label: "Assessees", icon: "users" },
  { id: "matters", label: "Matters", icon: "scale" },
  { id: "notices", label: "Notices", icon: "doc" },
  { id: "hearings", label: "Hearings", icon: "calendar" },
  { id: "invoices", label: "Invoices", icon: "invoice" },
  { id: "communications", label: "Communications", icon: "chat" },
  { id: "ai", label: "AI Parser", icon: "sparkle" },
  { id: "reports", label: "Reports", icon: "chart" },
];

const NAV_BOTTOM = [
  { id: "settings", label: "Settings", icon: "settings" },
];

export default function Sidebar({ active, onNav }) {
  const { data } = useData();
  const { user, signOutUser } = useAuth();
  const badges = {
    assessees: data.assessees.length || null,
    notices: awaitingNotices(data).length || null,
  };

  return (
    <aside className="sidebar">
      <div className="brand">
        <div style={{background: "white", borderRadius: 18, padding: "12px 16px", boxShadow: "0 6px 20px rgba(0,0,0,0.18)", display: "grid", placeItems: "center", width: "100%"}}>
          <img src="/prohippo-logo.png" alt="ProHippo" style={{width: "100%", maxWidth: 180, height: "auto"}}/>
        </div>
      </div>

      <div className="nav-section-label">Practice</div>
      <div className="nav">
        {NAV_ITEMS.map(item => (
          <div
            key={item.id}
            className={`nav-item ${active === item.id ? "active" : ""}`}
            onClick={() => onNav(item.id)}
          >
            <Icon name={item.icon} size={18} className="nav-icon"/>
            <span>{item.label}</span>
            {badges[item.id] && <span className="nav-badge">{badges[item.id]}</span>}
          </div>
        ))}
      </div>

      <div className="sidebar-bottom">
        <div className="nav" style={{marginBottom: 14}}>
          {NAV_BOTTOM.map(item => (
            <div
              key={item.id}
              className={`nav-item ${active === item.id ? "active" : ""}`}
              onClick={() => onNav(item.id)}
            >
              <Icon name={item.icon} size={18} className="nav-icon"/>
              <span>{item.label}</span>
            </div>
          ))}
        </div>
        <div className="firm-card">
          <div className="firm-avatar">{(data.profile.firmName || data.profile.ownerName || "You").split(" ").slice(0, 2).map(w => w[0]).join("").toUpperCase()}</div>
          <div style={{flex: 1, minWidth: 0}}>
            <div className="firm-name">{data.profile.firmName || data.profile.ownerName || "Your practice"}</div>
            <div className="firm-role" style={{overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>{user?.email || ""}</div>
          </div>
          <button
            className="icon-btn"
            style={{width: 30, height: 30, borderRadius: 9, flexShrink: 0}}
            title="Sign out"
            onClick={(e) => { e.stopPropagation(); if (window.confirm("Sign out of ProHippo?")) signOutUser(); }}
          >
            <Icon name="logout" size={14}/>
          </button>
        </div>
      </div>
    </aside>
  );
}
