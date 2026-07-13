/* ProHippo — first-run onboarding: create the user's practice profile */
import React from "react";
import { Icon } from "./shared";
import { useAuth } from "./auth";
import { useData } from "./store";

export default function Onboarding() {
  const { user, signOutUser } = useAuth();
  const { createProfile, loadSampleData } = useData();
  const [ownerName, setOwnerName] = React.useState(user?.displayName || "");
  const [firmName, setFirmName] = React.useState("");
  const [withSample, setWithSample] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(null);

  const valid = ownerName.trim().length > 1;

  const finish = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      await createProfile({ ownerName, firmName });
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
            <img src="/prohippo-mark.png" alt="ProHippo" style={{ width: 46, height: 46, objectFit: "contain" }} />
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
              <input value={firmName} placeholder="e.g. Jayesh Vyas & Co." onChange={(e) => setFirmName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") finish(); }} />
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
