/* Admin console — the one screen you look at every morning. */
import React from "react";
import { orderBy, limit } from "firebase/firestore";
import { Icon, fmtDateLong, EmptyState } from "../shared";
import { useCollection } from "./useCollection";
import { adminOverview, syncVoiceKnownCallers, STATUS_PILL, STATUS_LABEL } from "./adminApi";
import { VOICE_HELPLINE } from "../voiceConfig";

/*
 * The voice help line can only recognise an inbound caller whose number is on
 * Sarvam's known-callers list, because the platform never passes a tool the
 * number that dialled. The list is rebuilt nightly, so this button is for the
 * one case the schedule handles badly: someone has just linked their mobile and
 * wants to ring the line now rather than tomorrow.
 *
 * It is deliberately not on the sign-up path. A failed upload must never be
 * able to fail a registration, and the nightly run picks up anyone this misses.
 */
function VoiceCallerList({ notify }) {
  const [busy, setBusy] = React.useState(false);
  const [last, setLast] = React.useState(null);

  const run = async () => {
    setBusy(true);
    try {
      const res = await syncVoiceKnownCallers();
      /* Say which of the three things happened. "Nothing to do" is a success
         and should read like one — the alternative is an admin pressing the
         button repeatedly wondering whether it worked. */
      const msg = res.uploaded
        ? `Caller list updated — ${res.callers} ${res.callers === 1 ? "caller" : "callers"}`
        : res.unchanged
          ? `Already up to date — ${res.callers} ${res.callers === 1 ? "caller" : "callers"}`
          : res.skipped === "empty-roster"
            ? "No accounts have a verified mobile yet"
            : res.skipped === "not-configured"
              ? "The voice agent isn't configured yet"
              : "Couldn't reach Sarvam — try again shortly";
      setLast(msg);
      notify?.(msg);
    } catch (e) {
      const msg = e.message || "Couldn't update the caller list.";
      setLast(msg);
      notify?.(msg, "alert");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="card-title">Voice help line</div>
          <div className="card-sub">Who can ring {VOICE_HELPLINE} and be recognised</div>
        </div>
        <button className="btn btn-secondary" disabled={busy} onClick={run}>
          {busy ? "Updating…" : "Update caller list"}
        </button>
      </div>
      <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
        Every account with a verified mobile is sent to Sarvam so the line knows
        who is calling. This runs by itself at 03:10 every night — press this
        only when someone has just linked their mobile and wants to call today.
        {last && <div style={{ marginTop: 8, color: "var(--p-ink-2)" }}>{last}</div>}
      </div>
    </div>
  );
}

function Stat({ label, value, sub, icon, tone = "primary" }) {
  return (
    <div className="stat">
      <div className="stat-icon" style={{ background: `var(--p-${tone === "primary" ? "lavender-2" : tone === "success" ? "mint" : tone === "warning" ? "amber" : "coral"})` }}>
        <Icon name={icon} size={17} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="stat-label">{label}</div>
        <div className="stat-value">{value}</div>
        {sub && <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>{sub}</div>}
      </div>
    </div>
  );
}

export default function AdminOverview({ onOpenAccount, notify }) {
  const [stats, setStats] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    adminOverview().then(setStats).catch((e) => setError(e.message || "Could not load the overview."));
  }, []);

  // Newest signups. `createdAt` is an ISO string, so a plain descending sort is
  // chronological — no index gymnastics needed.
  const { rows: recent } = useCollection("accounts", [orderBy("createdAt", "desc"), limit(8)], "recent");
  const { rows: history } = useCollection("growthDaily", [orderBy("date", "desc"), limit(14)], "growth");

  return (
    <div>
      <div className="topbar">
        <div>
          <div className="page-title">Overview</div>
          <div className="page-sub">How ProHippo is doing today</div>
        </div>
      </div>

      {error && (
        <div className="card mb-4" style={{ padding: 14, background: "var(--p-coral)", color: "#B8463A", fontSize: 13 }}>
          {error}
        </div>
      )}

      <div className="grid mb-5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
        <Stat label="Total accounts" value={stats ? stats.accounts.total : "—"} icon="users" />
        <Stat label="Paying" value={stats ? stats.accounts.active : "—"} sub={stats ? `${stats.conversionRate}% of all accounts` : ""} icon="wallet" tone="success" />
        <Stat
          label="On trial"
          value={stats ? stats.accounts.trial : "—"}
          // null while the composite index for this count is still building.
          sub={stats && stats.growth.expiredTrials !== null ? `${stats.growth.expiredTrials} expired, not converted` : ""}
          icon="clock"
          tone="warning"
        />
        <Stat label="Past due" value={stats ? stats.accounts.pastDue : "—"} icon="alert" tone="danger" />
      </div>

      <div className="grid mb-5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
        <Stat label="New this week" value={stats ? stats.growth.new7 : "—"} sub={stats ? `${stats.growth.new30} in the last 30 days` : ""} icon="trend-up" />
        <Stat label="Active this week" value={stats ? stats.growth.active7 : "—"} sub="Opened the app in 7 days" icon="sparkle" />
        <Stat label="Live referral codes" value={stats ? stats.referrals.activeCodes : "—"} icon="tag" />
        <Stat label="Attributed signups" value={stats ? stats.referrals.redemptions : "—"} icon="link" />
      </div>

      <div className="mb-5">
        <VoiceCallerList notify={notify} />
      </div>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))" }}>
        <div className="card">
          <div className="card-head">
            <div className="card-title">Newest accounts</div>
          </div>
          {recent.length === 0 ? (
            <EmptyState icon="users" title="No accounts yet" sub="Signups will appear here as they arrive." />
          ) : (
            <table className="tbl">
              <thead>
                <tr><th>Practice</th><th>Status</th><th>Joined</th></tr>
              </thead>
              <tbody>
                {recent.map((a) => (
                  <tr key={a.id} style={{ cursor: "pointer" }} onClick={() => onOpenAccount?.(a.id)}>
                    <td>
                      <div className="strong">{a.firmName || a.ownerName || "—"}</div>
                      <div className="muted">{a.email}</div>
                    </td>
                    <td><span className={`pill pill-${STATUS_PILL[a.status] || "muted"}`}><span className="pill-dot" style={{ background: "currentColor" }} />{STATUS_LABEL[a.status] || a.status}</span></td>
                    <td className="muted">{a.createdAt ? fmtDateLong(a.createdAt) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <div className="card-title">Daily snapshot</div>
            <div className="card-sub">Written by the nightly rollup</div>
          </div>
          {history.length === 0 ? (
            <EmptyState icon="chart" title="No history yet" sub="The first snapshot is written at 02:30 IST tonight." />
          ) : (
            <table className="tbl">
              <thead>
                <tr><th>Date</th><th>Total</th><th>Trial</th><th>Paying</th><th>Activated</th></tr>
              </thead>
              <tbody>
                {history.map((d) => (
                  <tr key={d.id}>
                    <td className="strong">{fmtDateLong(d.date)}</td>
                    <td>{d.total}</td>
                    <td>{d.trial}</td>
                    <td>{d.active}</td>
                    <td>{d.activatedToday || 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
