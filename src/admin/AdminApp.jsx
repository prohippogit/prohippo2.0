/*
 * ProHippo admin console — the /admin shell.
 *
 * Lives in the same React app and reuses the same design system, but it is a
 * different product with a different audience, so it gets its own shell rather
 * than a tab inside the practitioner's sidebar. It is lazily imported by
 * App.jsx, so none of this ships in the bundle a customer downloads.
 *
 * The claim check here decides what to RENDER, nothing more. Reads are gated by
 * firestore.rules and writes by requireAdmin() in the callables — the screen
 * below is a courtesy, not the lock.
 */
import React from "react";
import { Icon } from "../shared";
import { useAuth } from "../auth";
import { useAdminClaim } from "./useAdminClaim";
import AdminOverview from "./AdminOverview";
import AdminCustomers from "./AdminCustomers";
import AdminReferrals from "./AdminReferrals";
import AdminAudit from "./AdminAudit";

const NAV = [
  { id: "overview", label: "Overview", icon: "dashboard" },
  { id: "customers", label: "Customers", icon: "users" },
  { id: "referrals", label: "Referral codes", icon: "tag" },
  { id: "audit", label: "Audit log", icon: "shield" },
];

// /admin/customers → "customers"; /admin → "overview".
const routeFromPath = () => {
  const seg = window.location.pathname.replace(/^\/admin\/?/, "").split("/")[0];
  return NAV.some((n) => n.id === seg) ? seg : "overview";
};

function Centered({ children }) {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 20, background: "#F7F6FB" }}>
      <div className="card" style={{ padding: 32, maxWidth: 440, textAlign: "center" }}>{children}</div>
    </div>
  );
}

export default function AdminApp() {
  const { user, signOutUser } = useAuth();
  const { checking, isAdmin } = useAdminClaim();
  const [route, setRoute] = React.useState(routeFromPath);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [toast, setToast] = React.useState(null);
  const [openAccountId, setOpenAccountId] = React.useState(null);

  const notify = React.useCallback((msg, icon = "check") => setToast({ msg, icon }), []);

  React.useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  // Keep the URL in step so a screen can be linked to and Back works.
  React.useEffect(() => {
    const onPop = () => setRoute(routeFromPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const nav = (id) => {
    setRoute(id);
    setMenuOpen(false);
    window.history.pushState({}, "", id === "overview" ? "/admin" : `/admin/${id}`);
  };

  const openAccount = (uid) => { setOpenAccountId(uid); nav("customers"); };

  if (checking) {
    return <Centered><div className="muted">Checking your access…</div></Centered>;
  }

  if (!isAdmin) {
    return (
      <Centered>
        <div style={{ width: 52, height: 52, borderRadius: 16, background: "var(--p-coral)", color: "#B8463A", display: "grid", placeItems: "center", margin: "0 auto 14px" }}>
          <Icon name="shield" size={24} />
        </div>
        <div style={{ fontWeight: 800, fontSize: 16 }}>No admin access</div>
        <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
          {user?.email || "This account"} isn't an administrator. If that's wrong, ask an existing admin to grant access — or run <code>scripts/grant-admin.mjs</code> for the first one.
        </div>
        <div className="center" style={{ justifyContent: "center", gap: 8, marginTop: 18 }}>
          <button className="btn btn-secondary btn-sm" onClick={() => { window.location.href = "/"; }}>Back to ProHippo</button>
          <button className="btn btn-ghost btn-sm" onClick={signOutUser}>Sign out</button>
        </div>
      </Centered>
    );
  }

  let content;
  switch (route) {
    case "customers":
      content = <AdminCustomers notify={notify} openId={openAccountId} setOpenId={setOpenAccountId} />;
      break;
    case "referrals": content = <AdminReferrals notify={notify} />; break;
    case "audit": content = <AdminAudit />; break;
    default: content = <AdminOverview onOpenAccount={openAccount} />;
  }

  return (
    <div className="app">
      <div className="mobile-topbar">
        <div style={{ fontWeight: 800, letterSpacing: "-0.02em" }}>ProHippo Admin</div>
      </div>

      <aside className={`sidebar ${menuOpen ? "open" : ""}`}>
        <div className="brand">
          <div style={{ background: "white", borderRadius: 18, padding: "12px 16px", boxShadow: "0 6px 20px rgba(0,0,0,0.18)", width: "100%", textAlign: "center" }}>
            <img src="/prohippo-logo.png" alt="ProHippo" style={{ width: "100%", maxWidth: 160, height: "auto" }} />
            <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--p-primary-2)", marginTop: 6 }}>
              Admin console
            </div>
          </div>
        </div>

        <div className="nav-section-label">Business</div>
        <div className="nav">
          {NAV.map((item) => (
            <div key={item.id} className={`nav-item ${route === item.id ? "active" : ""}`} onClick={() => nav(item.id)}>
              <Icon name={item.icon} size={18} className="nav-icon" />
              <span>{item.label}</span>
            </div>
          ))}
        </div>

        <div className="sidebar-bottom">
          <div className="nav" style={{ marginBottom: 14 }}>
            <div className="nav-item" onClick={() => { window.location.href = "/"; }}>
              <Icon name="arrow-left" size={18} className="nav-icon" />
              <span>Back to the app</span>
            </div>
          </div>
          <div className="firm-card">
            <div className="firm-avatar">{(user?.email || "A").slice(0, 2).toUpperCase()}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="firm-name">Administrator</div>
              <div className="firm-role" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user?.email || ""}</div>
            </div>
            <button className="icon-btn" style={{ width: 30, height: 30, borderRadius: 9, flexShrink: 0 }} title="Sign out" onClick={signOutUser}>
              <Icon name="logout" size={14} />
            </button>
          </div>
        </div>
      </aside>

      {menuOpen && <div className="sidebar-backdrop" onClick={() => setMenuOpen(false)} />}
      <button className={`fab-menu ${menuOpen ? "open" : ""}`} aria-label={menuOpen ? "Close menu" : "Open menu"} onClick={() => setMenuOpen((o) => !o)}>
        <span /><span /><span />
      </button>

      <main className="main">{content}</main>

      {toast && (
        <div className="toast animate-in">
          <div style={{ width: 22, height: 22, borderRadius: "50%", background: toast.icon === "alert" ? "var(--p-danger)" : "var(--p-success)", display: "grid", placeItems: "center" }}>
            <Icon name={toast.icon} size={13} stroke={3} />
          </div>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
