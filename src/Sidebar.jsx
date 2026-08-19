import { Icon } from './shared';
import { useData } from './store';
import { useAuth } from './auth';
import { appealableOrders } from './appeals';
import { useAdminClaim } from './admin/useAdminClaim';
import { useItatMail } from './itatEmail';

const NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard" },
  { id: "assessees", label: "Assessees", icon: "users" },
  { id: "matters", label: "Matters", icon: "scale" },
  { id: "hearings", label: "Hearings", icon: "calendar" },
  { id: "appeals", label: "Appeals", icon: "gavel" },
  { id: "invoices", label: "Invoices", icon: "invoice" },
  { id: "communications", label: "Communications", icon: "chat" },
  /* No practice-wide Notices link. It listed the same records the dashboard's
     two notice queues surface and an assessee's own Notices tab holds in
     context; a fourth way in was one more place to keep in step. */
  { id: "intimations", label: "Intimations", icon: "chart" },
  { id: "reports", label: "Reports", icon: "list" },
  /* Tools sits at the end because it is the only link that is not a register of
     the practice's own records — it is where a calculation gets done. The Beta
     tag is not decoration: what is behind it produces working papers a
     practitioner will act on, and they are entitled to know it is new. */
  { id: "tools", label: "Tools", icon: "sparkle", beta: true },
];

const NAV_BOTTOM = [
  { id: "connector", label: "Sync Connector App", icon: "download" },
  { id: "settings", label: "Settings", icon: "settings" },
];

export default function Sidebar({ active, onNav, open }) {
  const { data } = useData();
  const { user, signOutUser } = useAuth();
  /* Read the claim off the cached token rather than forcing a refresh — this
     only decides whether one link is drawn. A claim granted in the last hour
     shows up on the next sign-in, and /admin re-checks properly on arrival. */
  const { isAdmin } = useAdminClaim({ force: false });
  /* The Tribunal's emails wait on the Hearings page, so the count that says
     "something arrived" belongs on that link. Without it the queue is only
     found by someone who already went looking, which defeats the point of
     receiving the mail at all. */
  const { pending: itatPending } = useItatMail();
  const badges = {
    assessees: data.assessees.length || null,
    appeals: appealableOrders(data).length || null,
    hearings: itatPending.length || null,
  };

  return (
    <aside className={`sidebar ${open ? "open" : ""}`}>
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
            {item.beta && <span className="nav-beta">Beta</span>}
            {badges[item.id] && <span className="nav-badge">{badges[item.id]}</span>}
          </div>
        ))}
      </div>

      <div className="sidebar-bottom">
        <div className="nav" style={{marginBottom: 14}}>
          {/* Only rendered for accounts carrying the admin claim, so a
              practitioner is never shown a door they can't open. It is a full
              page navigation, not an onNav route — /admin is a separate shell
              with its own lazily loaded bundle. */}
          {isAdmin && (
            <div className="nav-item" onClick={() => { window.location.href = "/admin"; }}>
              <Icon name="shield" size={18} className="nav-icon"/>
              <span>Admin console</span>
            </div>
          )}
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
