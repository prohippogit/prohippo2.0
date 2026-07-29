/*
 * Admin console — audit log.
 *
 * Append-only: firestore.rules gives admins read and nobody write, so the only
 * path in is an Admin-SDK write from a callable that already checked the claim.
 * If a plan changed or a redemption was reversed and nobody remembers doing it,
 * this is where the answer is.
 */
import React from "react";
import { orderBy, limit } from "firebase/firestore";
import { Icon, fmtDateTime, EmptyState } from "../shared";
import { useCollection } from "./useCollection";

const ACTION_LABEL = {
  "account.update": "Account updated",
  "role.grant": "Admin access granted",
  "role.revoke": "Admin access revoked",
  "referral.create": "Referral code created",
  "referral.update": "Referral code updated",
  "referral.reverse": "Redemption reversed",
};
const ACTION_TONE = {
  "role.grant": "danger",
  "role.revoke": "warning",
  "referral.reverse": "warning",
};

export default function AdminAudit() {
  const { rows, loading, error } = useCollection("adminAudit", [orderBy("at", "desc"), limit(300)], "audit");
  const [q, setQ] = React.useState("");

  const filtered = rows.filter((e) => {
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return [e.action, e.target, e.actorEmail, JSON.stringify(e.details || {})]
      .some((v) => (v || "").toLowerCase().includes(needle));
  });

  return (
    <div>
      <div className="topbar">
        <div>
          <div className="page-title">Audit log</div>
          <div className="page-sub">{loading ? "Loading…" : `Last ${rows.length} admin actions`}</div>
        </div>
        <div className="topbar-actions">
          <div className="search">
            <Icon name="search" size={15} />
            <input value={q} placeholder="Action, target or admin…" onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
      </div>

      {error && (
        <div className="card mb-4" style={{ padding: 14, background: "var(--p-coral)", color: "#B8463A", fontSize: 13 }}>
          Could not read the audit log: {error.message}
        </div>
      )}

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {filtered.length === 0 && !loading ? (
          <EmptyState icon="shield" title="Nothing logged yet" sub="Every admin change lands here as it happens." />
        ) : (
          <table className="tbl">
            <thead>
              <tr><th>When</th><th>Action</th><th>Target</th><th>By</th><th>Details</th></tr>
            </thead>
            <tbody>
              {filtered.map((e) => (
                <tr key={e.id}>
                  <td className="muted" style={{ whiteSpace: "nowrap" }}>{fmtDateTime(e.at)}</td>
                  <td>
                    <span className={`pill pill-${ACTION_TONE[e.action] || "primary"}`}>
                      <span className="pill-dot" style={{ background: "currentColor" }} />
                      {ACTION_LABEL[e.action] || e.action}
                    </span>
                  </td>
                  <td className="muted" style={{ fontFamily: "ui-monospace, monospace", fontSize: 11.5 }}>{e.target || "—"}</td>
                  <td className="muted">{e.actorEmail || e.actorUid || "—"}</td>
                  <td className="muted" style={{ fontSize: 11.5, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {Object.keys(e.details || {}).length ? JSON.stringify(e.details) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
