import React from 'react';

export const Icon = ({ name, size = 18, stroke = 1.6, className = "" }) => {
  const s = size;
  const sw = stroke;
  const common = {
    width: s, height: s, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: sw, strokeLinecap: "round", strokeLinejoin: "round",
    className,
  };
  switch (name) {
    case "dashboard": return <svg {...common}><rect x="3" y="3" width="7" height="9" rx="2"/><rect x="14" y="3" width="7" height="5" rx="2"/><rect x="14" y="12" width="7" height="9" rx="2"/><rect x="3" y="16" width="7" height="5" rx="2"/></svg>;
    case "users": return <svg {...common}><circle cx="9" cy="8" r="3.5"/><path d="M3 21c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.5"/><path d="M15 21c0-2.5 1.6-4.5 4-5"/></svg>;
    case "user": return <svg {...common}><circle cx="12" cy="8" r="4"/><path d="M5 21c0-3.9 3.1-7 7-7s7 3.1 7 7"/></svg>;
    case "group": return <svg {...common}><path d="M16 4l4 4-4 4"/><path d="M8 20l-4-4 4-4"/><path d="M4 16h16M20 8H4"/></svg>;
    case "folder": return <svg {...common}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>;
    case "scale": return <svg {...common}><path d="M12 3v18M5 8l-2 6c0 1.7 1.3 3 3 3s3-1.3 3-3l-2-6M19 8l-2 6c0 1.7 1.3 3 3 3s3-1.3 3-3l-2-6"/><path d="M5 8h14"/></svg>;
    case "bell": return <svg {...common}><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21a2 2 0 0 0 4 0"/></svg>;
    case "calendar": return <svg {...common}><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>;
    case "list": return <svg {...common}><path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg>;
    case "invoice": return <svg {...common}><path d="M14 3H6a2 2 0 0 0-2 2v15l3-2 3 2 3-2 3 2V8z"/><path d="M14 3l6 6h-6V3z"/><path d="M8 12h6M8 16h4"/></svg>;
    case "wallet": return <svg {...common}><path d="M3 7v12a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1V10a1 1 0 0 0-1-1H5a2 2 0 0 1-2-2zm0 0a2 2 0 0 1 2-2h12v4"/><circle cx="17" cy="15" r="1.3"/></svg>;
    case "chart": return <svg {...common}><path d="M3 21h18"/><rect x="6" y="13" width="3" height="6" rx="0.5"/><rect x="11" y="9" width="3" height="10" rx="0.5"/><rect x="16" y="5" width="3" height="14" rx="0.5"/></svg>;
    case "doc": return <svg {...common}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M8 13h8M8 17h5"/></svg>;
    case "chat": return <svg {...common}><path d="M21 12c0 4.4-4 8-9 8-1.5 0-2.9-.3-4.1-.9L3 21l1.9-4.9C4.3 15 4 13.5 4 12c0-4.4 4-8 9-8s8 3.6 8 8z"/></svg>;
    case "sparkle": return <svg {...common}><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"/><path d="M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z"/></svg>;
    case "settings": return <svg {...common}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .4 1.9l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.4 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.4l-.1.1a2 2 0 0 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .4-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.4-1.9l-.1-.1a2 2 0 0 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.4h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.4l.1-.1a2 2 0 0 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.4 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>;
    case "search": return <svg {...common}><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>;
    case "plus": return <svg {...common}><path d="M12 5v14M5 12h14"/></svg>;
    case "filter": return <svg {...common}><path d="M3 6h18M6 12h12M10 18h4"/></svg>;
    case "arrow-right": return <svg {...common}><path d="M5 12h14M13 5l7 7-7 7"/></svg>;
    case "arrow-left": return <svg {...common}><path d="M19 12H5M11 5l-7 7 7 7"/></svg>;
    case "arrow-up": return <svg {...common}><path d="M12 19V5M5 12l7-7 7 7"/></svg>;
    case "chevron-down": return <svg {...common}><path d="M6 9l6 6 6-6"/></svg>;
    case "chevron-right": return <svg {...common}><path d="M9 6l6 6-6 6"/></svg>;
    case "chevron-left": return <svg {...common}><path d="M15 6l-6 6 6 6"/></svg>;
    case "more": return <svg {...common}><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>;
    case "check": return <svg {...common}><path d="M4 12l5 5L20 6"/></svg>;
    case "x": return <svg {...common}><path d="M18 6L6 18M6 6l12 12"/></svg>;
    case "upload": return <svg {...common}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>;
    case "download": return <svg {...common}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>;
    case "alert": return <svg {...common}><path d="M12 9v4M12 17h0M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>;
    case "info": return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="M12 8h0M11 12h1v5h1"/></svg>;
    case "clock": return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>;
    case "video": return <svg {...common}><rect x="2" y="6" width="14" height="12" rx="2"/><path d="M22 8l-6 4 6 4z"/></svg>;
    case "mail": return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 7 9-7"/></svg>;
    case "phone": return <svg {...common}><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.1-8.7A2 2 0 0 1 4 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.5 2.1L7.9 9.6a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5c.8.3 1.7.5 2.6.6A2 2 0 0 1 22 16.9z"/></svg>;
    case "whatsapp": return <svg {...common}><path d="M21 12a9 9 0 0 1-13.5 7.8L3 21l1.3-4.4A9 9 0 1 1 21 12z"/><path d="M8.5 9c0 4 3.5 7 6.5 7l1.5-1.5-2-1.5-1 1c-1-.3-2-1-2.5-2l1-1L10.5 8 9 8.5C8.7 8.5 8.5 8.7 8.5 9z" fill="currentColor" stroke="none"/></svg>;
    case "link": return <svg {...common}><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 1 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 1 0 7 7l1-1"/></svg>;
    case "tag": return <svg {...common}><path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>;
    case "shield": return <svg {...common}><path d="M12 2l9 4v6c0 5-3.8 9.4-9 10-5.2-.6-9-5-9-10V6l9-4z"/><path d="M9 12l2 2 4-4"/></svg>;
    case "trend-up": return <svg {...common}><path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/></svg>;
    case "menu": return <svg {...common}><path d="M3 6h18M3 12h18M3 18h18"/></svg>;
    case "edit": return <svg {...common}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>;
    case "trash": return <svg {...common}><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"/></svg>;
    case "pdf": return <svg {...common}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><text x="7" y="17" fontSize="6" fontWeight="700" fill="currentColor" stroke="none">PDF</text></svg>;
    case "logout": return <svg {...common}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>;
    default: return null;
  }
};

export const fmtINR = (n) => "₹" + new Intl.NumberFormat("en-IN").format(n);
export const fmtLakhs = (n) => {
  if (n >= 10000000) return "₹" + (n / 10000000).toFixed(2).replace(/\.?0+$/, "") + "Cr";
  if (n >= 100000) return "₹" + (n / 100000).toFixed(2).replace(/\.?0+$/, "") + "L";
  return fmtINR(n);
};
export const fmtDate = (iso) => {
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
};
export const fmtDateLong = (iso) => {
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};
export const daysFromNow = (iso) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const ms = new Date(iso + "T00:00:00") - today;
  return Math.round(ms / (1000 * 60 * 60 * 24));
};

export const StatusPill = ({ status }) => {
  const map = {
    "Upcoming": "primary",
    "Completed": "muted",
    "Submitted": "success",
    "Awaiting review": "pink",
    "Reply drafted": "info",
    "Paid": "success",
    "Outstanding": "warning",
    "Overdue": "danger",
    "Partial": "info",
    "Adjourned": "muted",
    "Active": "primary",
    "Decided": "success",
    "Pending": "warning",
    "Closed": "muted",
    "Sent": "success",
    "Draft": "muted",
  };
  return <span className={`pill pill-${map[status] || "muted"}`}><span className="pill-dot" style={{background: "currentColor"}}/>{status}</span>;
};

export const Avatar = ({ name, color = "violet", size = "" }) => {
  const initials = name.split(" ").filter(p => p[0] && /[A-Z]/i.test(p[0])).slice(0, 2).map(p => p[0]).join("").toUpperCase() || "?";
  const grads = {
    violet: "linear-gradient(135deg, #8E7CFF, #4F46BE)",
    pink: "linear-gradient(135deg, #FFB3D9, #C13388)",
    amber: "linear-gradient(135deg, #FFD17A, #F39C12)",
    mint: "linear-gradient(135deg, #8EE7BC, #20B978)",
  };
  return <div className={`avatar ${size}`} style={{background: grads[color] || grads.violet}}>{initials}</div>;
};

export function Modal({ title, sub, onClose, children, footer, width = 560 }) {
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal animate-in" style={{maxWidth: width}}>
        <div className="modal-head">
          <div>
            <div style={{fontSize: 17, fontWeight: 800, letterSpacing: "-0.02em"}}>{title}</div>
            {sub && <div className="muted" style={{fontSize: 12.5, marginTop: 3}}>{sub}</div>}
          </div>
          <button className="icon-btn" style={{width: 32, height: 32}} onClick={onClose}><Icon name="x" size={15}/></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function FormField({ label, required, children, full }) {
  return (
    <div className="field" style={{gridColumn: full ? "1 / -1" : "auto"}}>
      <label>{label}{required && <span style={{color: "var(--p-danger)"}}> *</span>}</label>
      {children}
    </div>
  );
}

export function TextInput({ value, onChange, placeholder, type = "text", mono, required }) {
  return (
    <input
      type={type}
      value={value}
      required={required}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={mono ? {fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"} : undefined}
    />
  );
}

export function SelectInput({ value, onChange, options, placeholder }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {placeholder && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={typeof o === "string" ? o : o.value} value={typeof o === "string" ? o : o.value}>
          {typeof o === "string" ? o : o.label}
        </option>
      ))}
    </select>
  );
}

export function EmptyState({ icon = "folder", title, sub, action }) {
  return (
    <div style={{textAlign: "center", padding: "48px 20px"}}>
      <div style={{width: 52, height: 52, borderRadius: 16, background: "var(--p-lavender-2)", color: "var(--p-primary-2)", display: "grid", placeItems: "center", margin: "0 auto 14px"}}>
        <Icon name={icon} size={24}/>
      </div>
      <div style={{fontWeight: 800, fontSize: 15, letterSpacing: "-0.01em"}}>{title}</div>
      {sub && <div className="muted" style={{fontSize: 13, marginTop: 5, maxWidth: 380, marginLeft: "auto", marginRight: "auto"}}>{sub}</div>}
      {action && <div style={{marginTop: 16, display: "flex", justifyContent: "center", gap: 8}}>{action}</div>}
    </div>
  );
}
