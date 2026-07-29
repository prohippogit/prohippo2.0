/*
 * Admin console — referral, partner and promo codes.
 *
 * The table is the funnel: clicked → signed up → activated → converted. That
 * middle column is the one that matters. Signups are easy to buy; a partner
 * whose signups never reach "activated" is sending you people who will never
 * pay, and you want to know that before the commission is due, not after.
 */
import React from "react";
import { orderBy, limit, where } from "firebase/firestore";
import { Icon, fmtDateLong, fmtDateTime, Modal, FormField, TextInput, SelectInput, Toggle, EmptyState } from "../shared";
import { useCollection } from "./useCollection";
import {
  adminCreateReferralCode,
  adminUpdateReferralCode,
  adminReverseRedemption,
  benefitLabel,
  fmtPaise,
} from "./adminApi";

const KINDS = [
  { value: "partner", label: "Partner — discount + commission" },
  { value: "promo", label: "Promo — campaign coupon" },
  { value: "member", label: "Member — customer word-of-mouth" },
];
const BENEFITS = [
  { value: "percent", label: "Percentage off" },
  { value: "flat", label: "Flat amount off" },
  { value: "free_days", label: "Free days" },
  { value: "plan_grant", label: "Free plan grant" },
];
const DURATIONS = [
  { value: "first_invoice", label: "First invoice only" },
  { value: "months", label: "For N months" },
  { value: "forever", label: "For as long as they stay" },
];
const PLAN_OPTIONS = ["solo", "practice", "firm"];

const STAGE_PILL = {
  clicked: "muted", signed_up: "info", activated: "primary",
  converted: "success", renewed: "success", churned: "danger",
};
const STAGE_LABEL = {
  clicked: "Clicked", signed_up: "Signed up", activated: "Activated",
  converted: "Paying", renewed: "Renewed", churned: "Churned",
};

const pct = (n, d) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "—");

/* ---------------- create / edit ---------------- */

function CodeForm({ code, onClose, notify }) {
  const editing = !!code;
  const [f, setF] = React.useState(() => ({
    code: code?.code || "",
    kind: code?.kind || "partner",
    benefitType: code?.benefit?.type || "percent",
    // Flat benefits are stored in paise; the form talks rupees.
    benefitValue: code?.benefit?.type === "flat" ? Math.round((code?.benefit?.value || 0) / 100) : (code?.benefit?.value ?? 20),
    duration: code?.duration || "first_invoice",
    durationMonths: code?.durationMonths || 3,
    ownerName: code?.owner?.name || "",
    ownerEmail: code?.owner?.email || "",
    ownerPhone: code?.owner?.phone || "",
    appliesToPlans: code?.appliesToPlans || [],
    newCustomersOnly: code?.newCustomersOnly ?? true,
    maxRedemptions: code?.maxRedemptions || 0,
    validFrom: (code?.validFrom || "").slice(0, 10),
    validTo: (code?.validTo || "").slice(0, 10),
    commissionPercent: code?.commission?.percent || 0,
    commissionMonths: code?.commission?.months || 12,
    status: code?.status || "active",
    notes: code?.notes || "",
  }));
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState(null);
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }));

  const togglePlan = (p) =>
    setF((s) => ({
      ...s,
      appliesToPlans: s.appliesToPlans.includes(p) ? s.appliesToPlans.filter((x) => x !== p) : [...s.appliesToPlans, p],
    }));

  const payload = () => ({
    kind: f.kind,
    benefit: {
      type: f.benefitType,
      value: f.benefitType === "flat" ? Math.round(Number(f.benefitValue) * 100) : Number(f.benefitValue),
    },
    duration: f.duration,
    durationMonths: Number(f.durationMonths),
    owner: { name: f.ownerName, email: f.ownerEmail, phone: f.ownerPhone },
    appliesToPlans: f.appliesToPlans,
    newCustomersOnly: f.newCustomersOnly,
    maxRedemptions: Number(f.maxRedemptions) || 0,
    validFrom: f.validFrom || null,
    validTo: f.validTo ? new Date(`${f.validTo}T23:59:59`).toISOString() : null,
    commission: { percent: Number(f.commissionPercent) || 0, months: Number(f.commissionMonths) || 0 },
    status: f.status,
    notes: f.notes,
  });

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      if (editing) {
        await adminUpdateReferralCode({ code: code.code, patch: payload() });
        notify(`${code.code} updated`);
      } else {
        const res = await adminCreateReferralCode({ code: f.code, ...payload() });
        notify(`Code ${res.code} created`);
      }
      onClose();
    } catch (e) {
      setErr(e.message || "Could not save the code.");
      setSaving(false);
    }
  };

  return (
    <Modal
      title={editing ? `Edit ${code.code}` : "New referral code"}
      sub={editing ? "Counters and funnel numbers are derived and can't be edited here." : "Leave the code blank to have one generated."}
      onClose={onClose}
      width={680}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? "Saving…" : editing ? "Save changes" : "Create code"}</button>
        </>
      }
    >
      {err && (
        <div className="mb-4" style={{ padding: "10px 12px", borderRadius: 10, background: "var(--p-coral)", color: "#B8463A", fontSize: 12.5 }}>{err}</div>
      )}

      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        {!editing && (
          <FormField label="Code">
            <TextInput value={f.code} onChange={(v) => set("code")(v.toUpperCase())} placeholder="AHMCA25 — or leave blank" mono />
          </FormField>
        )}
        <FormField label="Kind" required>
          <SelectInput value={f.kind} onChange={set("kind")} options={KINDS} />
        </FormField>

        <FormField label="Benefit" required>
          <SelectInput value={f.benefitType} onChange={set("benefitType")} options={BENEFITS} />
        </FormField>
        {f.benefitType !== "plan_grant" && (
          <FormField label={f.benefitType === "percent" ? "Percent off" : f.benefitType === "flat" ? "Rupees off" : "Days free"} required>
            <TextInput type="number" value={f.benefitValue} onChange={set("benefitValue")} />
          </FormField>
        )}

        <FormField label="Applies for">
          <SelectInput value={f.duration} onChange={set("duration")} options={DURATIONS} />
        </FormField>
        {f.duration === "months" && (
          <FormField label="Number of months">
            <TextInput type="number" value={f.durationMonths} onChange={set("durationMonths")} />
          </FormField>
        )}

        <FormField label="Plans it applies to" full>
          <div className="center" style={{ gap: 8, flexWrap: "wrap" }}>
            {PLAN_OPTIONS.map((p) => (
              <button
                key={p}
                type="button"
                className={`btn btn-sm ${f.appliesToPlans.includes(p) ? "btn-secondary" : "btn-ghost"}`}
                onClick={() => togglePlan(p)}
                style={{ textTransform: "capitalize" }}
              >
                {f.appliesToPlans.includes(p) && <Icon name="check" size={13} stroke={3} />} {p}
              </button>
            ))}
            <span className="muted" style={{ fontSize: 12 }}>
              {f.appliesToPlans.length === 0 ? "None selected — applies to every plan" : ""}
            </span>
          </div>
        </FormField>

        <FormField label="Max redemptions">
          <TextInput type="number" value={f.maxRedemptions} onChange={set("maxRedemptions")} placeholder="0 = unlimited" />
        </FormField>
        <FormField label="Status">
          <SelectInput value={f.status} onChange={set("status")} options={[{ value: "active", label: "Active" }, { value: "paused", label: "Paused" }]} />
        </FormField>

        <FormField label="Valid from">
          <input type="date" value={f.validFrom} onChange={(e) => set("validFrom")(e.target.value)} />
        </FormField>
        <FormField label="Valid to">
          <input type="date" value={f.validTo} onChange={(e) => set("validTo")(e.target.value)} />
        </FormField>

        <div className="center" style={{ gridColumn: "1 / -1", gap: 12, padding: "10px 12px", borderRadius: 12, border: "1px solid var(--p-line)" }}>
          <Toggle checked={f.newCustomersOnly} onChange={set("newCustomersOnly")} label="New customers only" />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>New customers only</div>
            <div className="muted" style={{ fontSize: 12 }}>Blocks an existing paying account from applying the code.</div>
          </div>
        </div>

        {f.kind === "partner" && (
          <>
            <FormField label="Partner name" full>
              <TextInput value={f.ownerName} onChange={set("ownerName")} placeholder="e.g. Ahmedabad CA Association" />
            </FormField>
            <FormField label="Partner email">
              <TextInput value={f.ownerEmail} onChange={set("ownerEmail")} type="email" />
            </FormField>
            <FormField label="Partner phone">
              <TextInput value={f.ownerPhone} onChange={set("ownerPhone")} />
            </FormField>
            <FormField label="Commission %">
              <TextInput type="number" value={f.commissionPercent} onChange={set("commissionPercent")} />
            </FormField>
            <FormField label="Commission months">
              <TextInput type="number" value={f.commissionMonths} onChange={set("commissionMonths")} placeholder="0 = forever" />
            </FormField>
          </>
        )}

        <FormField label="Internal notes" full>
          <textarea rows={2} value={f.notes} onChange={(e) => set("notes")(e.target.value)} placeholder="Where this code is being used, who agreed to what" />
        </FormField>
      </div>
    </Modal>
  );
}

/* ---------------- code detail ---------------- */

function CodeDetail({ code, onClose, onEdit, notify }) {
  const { rows } = useCollection("referralRedemptions", [where("code", "==", code.code), limit(200)], `red-${code.code}`);
  const sorted = [...rows].sort((a, b) => (b.attributedAt || "").localeCompare(a.attributedAt || ""));
  const funnel = code.funnel || {};
  const shareUrl = `${window.location.origin}/?ref=${code.code}`;

  const reverse = async (r) => {
    const reason = window.prompt(`Reverse ${r.firmName || r.uid}'s attribution to ${code.code}?\n\nThis frees the account to be attributed again and writes off any commission.\n\nReason:`);
    if (reason === null) return;
    try {
      await adminReverseRedemption({ redemptionId: r.id, reason });
      notify("Redemption reversed");
    } catch (e) {
      notify(e.message || "Could not reverse it", "alert");
    }
  };

  return (
    <Modal
      title={code.code}
      sub={`${code.kind} · ${benefitLabel(code.benefit)}${code.status !== "active" ? " · paused" : ""}`}
      onClose={onClose}
      width={760}
      titleStyle={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          <button className="btn btn-secondary" onClick={() => { navigator.clipboard?.writeText(shareUrl); notify("Share link copied"); }}>
            <Icon name="link" size={14} /> Copy share link
          </button>
          <button className="btn btn-primary" onClick={onEdit}><Icon name="edit" size={14} /> Edit</button>
        </>
      }
    >
      <div className="grid mb-5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 10 }}>
        {[
          ["Clicks", funnel.clicked || 0, null],
          ["Signed up", funnel.signed_up || 0, pct(funnel.signed_up || 0, funnel.clicked || 0)],
          ["Activated", funnel.activated || 0, pct(funnel.activated || 0, funnel.signed_up || 0)],
          ["Paying", funnel.converted || 0, pct(funnel.converted || 0, funnel.signed_up || 0)],
          ["Churned", funnel.churned || 0, null],
        ].map(([label, value, rate]) => (
          <div key={label} style={{ padding: "10px 12px", borderRadius: 12, background: "var(--p-card-tint)", border: "1px solid var(--p-line)" }}>
            <div className="muted" style={{ fontSize: 11 }}>{label}</div>
            <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.02em" }}>{value}</div>
            {rate && <div className="muted" style={{ fontSize: 11 }}>{rate} of previous</div>}
          </div>
        ))}
      </div>

      <div className="grid mb-5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, fontSize: 12.5 }}>
        <div><span className="muted">Revenue attributed</span><div className="strong">{fmtPaise(code.revenuePaise)}</div></div>
        <div><span className="muted">Commission owed</span><div className="strong">{fmtPaise(code.commissionPaise)}</div></div>
        <div><span className="muted">Redemptions</span><div className="strong">{code.redemptions || 0}{code.maxRedemptions ? ` / ${code.maxRedemptions}` : ""}</div></div>
        <div><span className="muted">Valid to</span><div className="strong">{code.validTo ? fmtDateLong(code.validTo) : "No end date"}</div></div>
      </div>

      {code.owner?.name && (
        <div className="mb-5" style={{ padding: "10px 12px", borderRadius: 12, background: "var(--p-lavender)", fontSize: 12.5 }}>
          <b>{code.owner.name}</b>
          {code.owner.email && <span className="muted"> · {code.owner.email}</span>}
          {code.commission?.percent > 0 && (
            <span className="muted"> · {code.commission.percent}% for {code.commission.months || "∞"} months</span>
          )}
        </div>
      )}

      <div className="card-title mb-2" style={{ fontSize: 13 }}>Accounts attributed to this code</div>
      {sorted.length === 0 ? (
        <EmptyState icon="link" title="No redemptions yet" sub="Share the link above to start attributing signups." />
      ) : (
        <table className="tbl">
          <thead>
            <tr><th>Account</th><th>Stage</th><th>Attributed</th><th>Revenue</th><th /></tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id} style={r.reversed ? { opacity: 0.5 } : undefined}>
                <td>
                  <div className="strong">{r.firmName || r.uid}</div>
                  <div className="muted">{r.accountEmail}</div>
                </td>
                <td>
                  {r.reversed ? (
                    <span className="pill pill-danger"><span className="pill-dot" style={{ background: "currentColor" }} />Reversed</span>
                  ) : (
                    <span className={`pill pill-${STAGE_PILL[r.stage] || "muted"}`}><span className="pill-dot" style={{ background: "currentColor" }} />{STAGE_LABEL[r.stage] || r.stage}</span>
                  )}
                </td>
                <td className="muted">{r.attributedAt ? fmtDateTime(r.attributedAt) : "—"}</td>
                <td>{fmtPaise(r.revenuePaise)}</td>
                <td style={{ textAlign: "right" }}>
                  {!r.reversed && (
                    <button className="btn btn-ghost btn-xs" onClick={() => reverse(r)}>Reverse</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

/* ---------------- list ---------------- */

export default function AdminReferrals({ notify }) {
  const { rows, loading, error } = useCollection("referralCodes", [orderBy("createdAt", "desc"), limit(500)], "codes");
  const [q, setQ] = React.useState("");
  const [kindFilter, setKindFilter] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [detailCode, setDetailCode] = React.useState(null);
  const [editCode, setEditCode] = React.useState(null);

  // "Expired" is compared against a clock read once, on mount. A code that
  // lapses while the tab is open is a refresh away from showing correctly, and
  // reading the wall clock mid-render would make the table impure.
  const [now] = React.useState(() => Date.now());

  const filtered = rows.filter((c) => {
    if (kindFilter && c.kind !== kindFilter) return false;
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return [c.code, c.owner?.name, c.owner?.email, c.notes].some((v) => (v || "").toLowerCase().includes(needle));
  });

  // The list is a live snapshot, so the open modals must re-read from `rows`
  // rather than hold a stale copy taken at click time.
  const detail = detailCode ? rows.find((c) => c.id === detailCode) : null;
  const edit = editCode ? rows.find((c) => c.id === editCode) : null;

  return (
    <div>
      <div className="topbar">
        <div>
          <div className="page-title">Referral codes</div>
          <div className="page-sub">{loading ? "Loading…" : `${filtered.length} of ${rows.length} codes`}</div>
        </div>
        <div className="topbar-actions">
          <div className="search">
            <Icon name="search" size={15} />
            <input value={q} placeholder="Code, partner or note…" onChange={(e) => setQ(e.target.value)} />
          </div>
          <select className="ph-select" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
            <option value="">All kinds</option>
            <option value="partner">Partner</option>
            <option value="promo">Promo</option>
            <option value="member">Member</option>
          </select>
          <button className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" size={15} /> New code</button>
        </div>
      </div>

      {error && (
        <div className="card mb-4" style={{ padding: 14, background: "var(--p-coral)", color: "#B8463A", fontSize: 13 }}>
          Could not read referral codes: {error.message}
        </div>
      )}

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {filtered.length === 0 && !loading ? (
          <EmptyState
            icon="tag"
            title={q ? "Nothing matched" : "No codes yet"}
            sub={q ? "Try a different search." : "Create a partner or promo code to start attributing signups."}
            action={!q && <button className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" size={15} /> New code</button>}
          />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Code</th><th>Kind</th><th>Benefit</th><th>Clicks</th><th>Signups</th><th>Activated</th><th>Paying</th><th>Owner</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const fn = c.funnel || {};
                const expired = !!now && c.validTo && Date.parse(c.validTo) < now;
                const exhausted = c.maxRedemptions > 0 && (c.redemptions || 0) >= c.maxRedemptions;
                const state = c.status !== "active" ? "Paused" : expired ? "Expired" : exhausted ? "Exhausted" : "Active";
                const tone = state === "Active" ? "success" : state === "Paused" ? "muted" : "warning";
                return (
                  <tr key={c.id} style={{ cursor: "pointer" }} onClick={() => setDetailCode(c.id)}>
                    <td className="strong" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{c.code}</td>
                    <td className="semi" style={{ textTransform: "capitalize" }}>{c.kind}</td>
                    <td>{benefitLabel(c.benefit)}</td>
                    <td>{fn.clicked || 0}</td>
                    <td>{fn.signed_up || 0}</td>
                    <td>{fn.activated || 0}</td>
                    <td className="strong">{fn.converted || 0}</td>
                    <td className="muted">{c.owner?.name || "—"}</td>
                    <td><span className={`pill pill-${tone}`}><span className="pill-dot" style={{ background: "currentColor" }} />{state}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {creating && <CodeForm onClose={() => setCreating(false)} notify={notify} />}
      {edit && <CodeForm code={edit} onClose={() => setEditCode(null)} notify={notify} />}
      {detail && !edit && (
        <CodeDetail
          code={detail}
          notify={notify}
          onClose={() => setDetailCode(null)}
          onEdit={() => setEditCode(detail.id)}
        />
      )}
    </div>
  );
}
