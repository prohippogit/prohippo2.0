/* ProHippo — first-run onboarding: create the user's practice profile */
import React from "react";
import { Icon } from "./shared";
import { useAuth } from "./auth";
import { useData } from "./store";
import { pendingReferral, validateReferralCode, redeemReferralCode, normaliseCode } from "./referral";

export default function Onboarding() {
  const { user, signOutUser } = useAuth();
  const { createProfile, loadSampleData } = useData();
  const [ownerName, setOwnerName] = React.useState(user?.displayName || "");
  const [firmName, setFirmName] = React.useState("");
  const [phone, setPhone] = React.useState(user?.phoneNumber || "");
  const [withSample, setWithSample] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(null);

  // A code carried in from ?ref= is pre-filled and checked straight away, so
  // someone arriving on a partner's link never has to type anything.
  const [referral, setReferral] = React.useState(() => pendingReferral()?.code || "");
  // The code the server has been asked about — set on blur, on Enter, and once
  // at mount for a code that arrived in the URL.
  const [checking, setChecking] = React.useState(() => normaliseCode(pendingReferral()?.code || ""));
  const [refState, setRefState] = React.useState(null); // { ok, label } | { ok:false, message }

  React.useEffect(() => {
    if (checking.length < 4) return undefined;
    let cancelled = false;
    validateReferralCode(checking)
      .then((res) => { if (!cancelled) setRefState(res); })
      .catch((e) => { if (!cancelled) setRefState({ ok: false, message: e.message || "Could not check that code." }); });
    return () => { cancelled = true; };
  }, [checking]);

  const checkReferral = (raw) => {
    const code = normaliseCode(raw);
    setChecking(code);
    if (code.length < 4) setRefState(null);
  };
  const refChecking = checking.length >= 4 && !refState;

  const valid = ownerName.trim().length > 1;

  const finish = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      await createProfile({ ownerName, firmName, phone });
      // Attribution is best-effort and never blocks the signup: a code that has
      // just been paused shouldn't leave someone stuck on this screen.
      const code = normaliseCode(referral);
      if (code.length >= 4) {
        try {
          await redeemReferralCode(code);
        } catch (e) {
          console.warn("referral not applied:", e.message || e);
        }
      }
      if (withSample) await loadSampleData();
      // DataProvider's profile listener flips the app into the dashboard.
    } catch (e) {
      console.error(e);
      setError("Could not save your profile. Please check your connection and try again.");
      setSaving(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 20, background: "radial-gradient(1200px 600px at 50% -10%, #EEE9FF 0%, #F7F6FB 45%, #F7F6FB 100%)" }}>
      <div style={{ width: "100%", maxWidth: 460 }}>
        <div className="card" style={{ padding: 28 }}>
          <div className="center" style={{ gap: 12, marginBottom: 6 }}>
            <img src="/prohippo-logo.png" alt="ProHippo" style={{ height: 50, width: "auto" }} />
            <div>
              <div style={{ fontWeight: 800, fontSize: 19, letterSpacing: "-0.02em" }}>Welcome to ProHippo 👋</div>
              <div className="muted" style={{ fontSize: 12.5 }}>Signed in as <b>{user?.email}</b></div>
            </div>
          </div>

          <div className="muted" style={{ fontSize: 13, margin: "12px 0 20px", lineHeight: 1.55 }}>
            Let's set up your practice. This takes 30 seconds — you can change everything later in Settings.
          </div>

          <div className="col" style={{ gap: 14 }}>
            <div className="field">
              <label>Your name <span style={{ color: "var(--p-danger)" }}>*</span></label>
              <input value={ownerName} placeholder="e.g. Jayesh Vyas" onChange={(e) => setOwnerName(e.target.value)} />
            </div>
            <div className="field">
              <label>Firm name</label>
              <input value={firmName} placeholder="e.g. Jayesh Vyas & Co." onChange={(e) => setFirmName(e.target.value)} />
            </div>
            <div className="field">
              <label>Mobile number <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label>
              <input value={phone} type="tel" inputMode="numeric" placeholder="e.g. +91 98250 11234" onChange={(e) => setPhone(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") finish(); }} />
            </div>

            <div className="field">
              <label>Referral or promo code <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label>
              <input
                value={referral}
                placeholder="e.g. AHMCA25"
                style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", textTransform: "uppercase" }}
                onChange={(e) => { setReferral(e.target.value.toUpperCase()); setChecking(""); setRefState(null); }}
                onBlur={(e) => checkReferral(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") checkReferral(e.target.value); }}
              />
              {refChecking && <div className="muted" style={{ fontSize: 12 }}>Checking…</div>}
              {!refChecking && refState?.ok && (
                <div className="center" style={{ gap: 6, fontSize: 12, color: "var(--p-success)", fontWeight: 600 }}>
                  <Icon name="check" size={13} stroke={3} />
                  {refState.label} applied
                  {refState.ownerName ? ` — thanks to ${refState.ownerName}` : ""}
                </div>
              )}
              {!refChecking && refState && !refState.ok && (
                <div style={{ fontSize: 12, color: "var(--p-danger)" }}>{refState.message}</div>
              )}
            </div>

            <div
              onClick={() => setWithSample(!withSample)}
              className="center"
              style={{ gap: 12, padding: "12px 14px", borderRadius: 13, background: withSample ? "var(--p-card-tint)" : "white", border: `1px solid ${withSample ? "var(--p-primary-3)" : "var(--p-line-2)"}`, cursor: "pointer" }}
            >
              <div style={{ width: 18, height: 18, borderRadius: 6, border: "2px solid var(--p-line)", display: "grid", placeItems: "center", background: withSample ? "var(--p-primary)" : "white", borderColor: withSample ? "var(--p-primary)" : "var(--p-line)", flexShrink: 0 }}>
                {withSample && <Icon name="check" size={12} stroke={3} />}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 13.5 }}>Start with sample data</div>
                <div className="muted" style={{ fontSize: 12 }}>Explore with example assessees and hearings — you can clear it anytime from Settings.</div>
              </div>
            </div>
          </div>

          {error && (
            <div style={{ marginTop: 14, padding: "10px 12px", borderRadius: 10, background: "var(--p-coral)", color: "#B8463A", fontSize: 12.5 }}>
              {error}
            </div>
          )}

          <button
            className="btn btn-primary"
            style={{ width: "100%", justifyContent: "center", height: 44, marginTop: 20, opacity: valid && !saving ? 1 : 0.6 }}
            disabled={!valid || saving}
            onClick={finish}
          >
            {saving ? "Setting up…" : <>Create my practice <Icon name="arrow-right" size={15} /></>}
          </button>

          <button className="btn btn-ghost btn-sm" style={{ width: "100%", justifyContent: "center", marginTop: 10 }} onClick={signOutUser}>
            Sign in with a different account
          </button>
        </div>
      </div>
    </div>
  );
}
