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
        <div className="brand-mark">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M6 4c3 0 3 4 6 4s3-4 6-4v16c-3 0-3-4-6-4s-3 4-6 4V4z" fill="url(#g1)"/>
            <defs>
              <linearGradient id="g1" x1="0" y1="0" x2="24" y2="24">
                <stop offset="0" stopColor="#6C5CE7"/>
                <stop offset="1" stopColor="#C13388"/>
              </linearGradient>
            </defs>
          </svg>
        </div>
        <div className="brand-name">Pro<span className="tld">Hippo</span></div>
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
