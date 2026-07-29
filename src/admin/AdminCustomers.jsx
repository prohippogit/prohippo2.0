/*
 * Admin console — customers.
 *
 * The list is a live snapshot of `accounts`, which carries identity, plan and
 * usage COUNTS. It does not carry, and this screen cannot reach, anything under
 * users/{uid} — the practitioner's clients' PANs and notices. "12 assessees" is
 * as much as support ever needs to know, and is all the rules permit.
 */
import React from "react";
import { orderBy, limit, where } from "firebase/firestore";
import { Icon, fmtDateLong, fmtDateTime, Modal, FormField, TextInput, SelectInput, EmptyState, Avatar } from "../shared";
import { useCollection } from "./useCollection";
import { adminUpdateAccount, adminSetRole, adminLookupUser, STATUS_PILL, STATUS_LABEL } from "./adminApi";

const STATUSES = ["trial", "active", "past_due", "cancelled", "suspended"];
const PLANS = ["", "solo", "practice", "firm"];

const StatusPill = ({ status }) => (
  <span className={`pill pill-${STATUS_PILL[status] || "muted"}`}>
    <span className="pill-dot" style={{ background: "currentColor" }} />
    {STATUS_LABEL[status] || status || "—"}
  </span>
);

const daysLeft = (iso) => (iso ? Math.ceil((Date.parse(iso) - Date.now()) / 86400000) : null);

/* ---------------- detail ---------------- */

function AccountDetail({ account, onClose, notify }) {
  const [form, setForm] = React.useState({
    plan: account.plan || "",
    status: account.status || "trial",
    trialEndsAt: (account.trialEndsAt || "").slice(0, 10),
    seats: account.seats || 1,
    notes: account.notes || "",
  });
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState(null);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  // Equality-only query: no composite index needed, so this works on a fresh
  // project without a console trip.
  const { rows: trail } = useCollection("adminAudit", [where("target", "==", account.id), limit(50)], `audit-${account.id}`);
  const sortedTrail = [...trail].sort((a, b) => (b.at || "").localeCompare(a.at || ""));

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      await adminUpdateAccount({
        uid: account.id,
        patch: {
          plan: form.plan || null,
          status: form.status,
          trialEndsAt: form.trialEndsAt ? new Date(`${form.trialEndsAt}T23:59:59`).toISOString() : null,
          seats: Number(form.seats) || 1,
          notes: form.notes,
        },
      });
      notify("Account updated");
      onClose();
    } catch (e) {
      setErr(e.message || "Could not save.");
      setSaving(false);
    }
  };

  const toggleAdmin = async () => {
    const next = !account.isAdmin;
    if (!window.confirm(next
      ? `Give ${account.email} full admin access to this console?`
      : `Remove admin access from ${account.email}? They will be signed out.`)) return;
    try {
      await adminSetRole({ uid: account.id, admin: next });
      notify(next ? "Admin access granted" : "Admin access removed");
    } catch (e) {
      setErr(e.message || "Could not change the role.");
    }
  };

  const counters = account.counters || {};
  const trial = daysLeft(account.trialEndsAt);

  return (
    <Modal
      title={account.firmName || account.ownerName || "Account"}
      sub={account.email || account.phone || account.id}
      onClose={onClose}
      width={720}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving} onClick={save}>
            {saving ? "Saving…" : "Save changes"}
          </button>
        </>
      }
    >
      {err && (
        <div className="mb-4" style={{ padding: "10px 12px", borderRadius: 10, background: "var(--p-coral)", color: "#B8463A", fontSize: 12.5 }}>
          {err}
        </div>
      )}

      <div className="grid mb-5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10 }}>
        {["assessees", "matters", "hearings", "notices", "communications", "invoices"].map((k) => (
          <div key={k} style={{ padding: "10px 12px", borderRadius: 12, background: "var(--p-card-tint)", border: "1px solid var(--p-line)" }}>
            <div className="muted" style={{ fontSize: 11, textTransform: "capitalize" }}>{k}</div>
            <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: "-0.02em" }}>{counters[k] ?? "—"}</div>
          </div>
        ))}
      </div>
      <div className="muted mb-5" style={{ fontSize: 11.5 }}>
        Counts only — this console has no access to the practice's client records.
        {account.countersAt && ` Last counted ${fmtDateTime(account.countersAt)}.`}
      </div>

      {account.referral?.code && (
        <div className="mb-5" style={{ padding: "12px 14px", borderRadius: 12, background: "var(--p-lavender)", border: "1px solid var(--p-primary-3)" }}>
          <div className="center" style={{ gap: 8 }}>
            <Icon name="tag" size={15} />
            <div style={{ fontSize: 13 }}>
              Referred by <b style={{ fontFamily: "ui-monospace, monospace" }}>{account.referral.code}</b>
              {" — "}{account.referral.label}
              <span className="muted"> · attributed {fmtDateLong(account.referral.attributedAt)}</span>
            </div>
          </div>
        </div>
      )}

      <div className="grid mb-4" style={{ gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <FormField label="Plan">
          <SelectInput value={form.plan} onChange={set("plan")} options={PLANS.map((p) => ({ value: p, label: p ? p[0].toUpperCase() + p.slice(1) : "No plan" }))} />
        </FormField>
        <FormField label="Status">
          <SelectInput value={form.status} onChange={set("status")} options={STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))} />
        </FormField>
        <FormField label={`Trial ends${trial !== null ? ` (${trial >= 0 ? `${trial} days left` : `${-trial} days ago`})` : ""}`}>
          <input type="date" value={form.trialEndsAt} onChange={(e) => set("trialEndsAt")(e.target.value)} />
        </FormField>
        <FormField label="Seats">
          <TextInput type="number" value={form.seats} onChange={set("seats")} />
        </FormField>
        <FormField label="Internal notes" full>
          <textarea rows={3} value={form.notes} onChange={(e) => set("notes")(e.target.value)} placeholder="Context for whoever picks up the next support ticket" />
        </FormField>
      </div>

      <div className="between mb-5" style={{ padding: "12px 14px", borderRadius: 12, border: "1px solid var(--p-line)", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 13 }}>Admin console access</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {account.isAdmin ? "This account can see everything in here." : "No access to this console."}
          </div>
        </div>
        <button className={`btn btn-sm ${account.isAdmin ? "btn-ghost" : "btn-secondary"}`} onClick={toggleAdmin}>
          {account.isAdmin ? "Revoke admin" : "Make admin"}
        </button>
      </div>

      <div className="card-title mb-2" style={{ fontSize: 13 }}>Admin actions on this account</div>
      {sortedTrail.length === 0 ? (
        <div className="muted" style={{ fontSize: 12.5 }}>Nothing yet.</div>
      ) : (
        <table className="tbl">
          <tbody>
            {sortedTrail.map((e) => (
              <tr key={e.id}>
                <td style={{ width: 150 }} className="muted">{fmtDateTime(e.at)}</td>
                <td className="strong">{e.action}</td>
                <td className="muted">{e.actorEmail || e.actorUid}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

/* ---------------- list ---------------- */

/* `openId` lives in the shell, not here: the Overview page links straight to an
   account, and threading it down as a prop beats syncing two copies. */
export default function AdminCustomers({ notify, openId, setOpenId }) {
  const [q, setQ] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("");
  const [lookup, setLookup] = React.useState(null);

  // 500 newest accounts. Search below is client-side over these; anything older
  // is found by exact email/phone through adminLookupUser, which goes to
  // Firebase Auth rather than paging the whole collection into the browser.
  const { rows, loading, error } = useCollection("accounts", [orderBy("createdAt", "desc"), limit(500)], "accounts");

  const filtered = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((a) => {
      if (statusFilter && a.status !== statusFilter) return false;
      if (!needle) return true;
      return [a.firmName, a.ownerName, a.email, a.phone, a.referral?.code, a.id]
        .some((v) => (v || "").toLowerCase().includes(needle));
    });
  }, [rows, q, statusFilter]);

  const runLookup = async () => {
    const term = q.trim();
    if (!term) return;
    setLookup({ searching: true });
    try {
      const res = await adminLookupUser({ query: term });
      setLookup(res.found ? res : { notFound: true });
      if (res.found && res.account) setOpenId(res.uid);
    } catch (e) {
      setLookup({ error: e.message || "Lookup failed." });
    }
  };

  const open = rows.find((a) => a.id === openId);

  return (
    <div>
      <div className="topbar">
        <div>
          <div className="page-title">Customers</div>
          <div className="page-sub">{loading ? "Loading…" : `${filtered.length} of ${rows.length} accounts`}</div>
        </div>
        <div className="topbar-actions">
          <div className="search">
            <Icon name="search" size={15} />
            <input
              value={q}
              placeholder="Firm, name, email, phone or code…"
              onChange={(e) => { setQ(e.target.value); setLookup(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") runLookup(); }}
            />
          </div>
          <select className="ph-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </div>
      </div>

      {error && (
        <div className="card mb-4" style={{ padding: 14, background: "var(--p-coral)", color: "#B8463A", fontSize: 13 }}>
          Could not read accounts: {error.message}
        </div>
      )}

      {lookup?.notFound && (
        <div className="card mb-4" style={{ padding: 14, fontSize: 13 }}>
          No Firebase user with that exact email or phone number.
        </div>
      )}

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {filtered.length === 0 && !loading ? (
          <EmptyState
            icon="users"
            title={q ? "Nothing matched" : "No accounts yet"}
            sub={q ? "Press Enter to look the exact email or phone up in Firebase Auth." : "Signups will appear here as they arrive."}
          />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Practice</th><th>Status</th><th>Plan</th><th>Assessees</th><th>Referral</th><th>Joined</th><th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => (
                <tr key={a.id} style={{ cursor: "pointer" }} onClick={() => setOpenId(a.id)}>
                  <td>
                    <div className="center" style={{ gap: 10 }}>
                      <Avatar name={a.firmName || a.ownerName || a.email || "?"} size="sm" soft />
                      <div style={{ minWidth: 0 }}>
                        <div className="strong">{a.firmName || a.ownerName || "—"}</div>
                        <div className="muted">{a.email || a.phone || a.id}</div>
                      </div>
                    </div>
                  </td>
                  <td><StatusPill status={a.status} /></td>
                  <td className="semi" style={{ textTransform: "capitalize" }}>{a.plan || "—"}</td>
                  <td>{a.counters?.assessees ?? "—"}</td>
                  <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{a.referral?.code || <span className="muted">—</span>}</td>
                  <td className="muted">{a.createdAt ? fmtDateLong(a.createdAt) : "—"}</td>
                  <td className="muted">{a.lastSeenAt ? fmtDateLong(a.lastSeenAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {open && <AccountDetail account={open} onClose={() => setOpenId(null)} notify={notify} />}
    </div>
  );
}
