/* ProHippo — sign-in screen (Google + passwordless email link) */
import React from "react";
import { Icon } from "./shared";
import { useAuth } from "./auth";

function BrandMark({ size = 52 }) {
  return <img src="/prohippo-mark.png" alt="ProHippo" style={{ width: size, height: size, objectFit: "contain" }} />;
}

const GoogleGlyph = () => (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#FFC107" d="M43.6 20.5h-1.9V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 4.1 29.6 2 24 2 11.8 2 2 11.8 2 24s9.8 22 22 22 22-9.8 22-22c0-1.5-.2-2.6-.4-3.5z" />
    <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 4.1 29.6 2 24 2 15.6 2 8.3 6.9 6.3 14.7z" />
    <path fill="#4CAF50" d="M24 46c5.5 0 10.5-2.1 14.3-5.5l-6.6-5.6C29.6 36.5 26.9 37.5 24 37.5c-5.2 0-9.6-3.3-11.2-7.9l-6.6 5.1C8.2 41 15.5 46 24 46z" />
    <path fill="#1976D2" d="M43.6 20.5H24v8h11.3c-.8 2.2-2.1 4.1-3.9 5.4l6.6 5.6C41.9 36.3 46 30.8 46 24c0-1.5-.2-2.6-.4-3.5z" />
  </svg>
);

export default function Login({ onBack }) {
  const { signInWithGoogle, sendMagicLink, pendingEmail, resetPendingEmail, error, clearError } = useAuth();
  const [email, setEmail] = React.useState("");
  const [sending, setSending] = React.useState(false);

  const submitEmail = async () => {
    if (sending) return;
    setSending(true);
    await sendMagicLink(email);
    setSending(false);
  };

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 20, background: "radial-gradient(1200px 600px at 50% -10%, #EEE9FF 0%, #F7F6FB 45%, #F7F6FB 100%)" }}>
      <div style={{ width: "100%", maxWidth: 420 }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, marginBottom: 24 }}>
          <BrandMark />
          <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.02em" }}>
            Pro<span style={{ color: "var(--p-primary-2)" }}>Hippo</span>
          </div>
          <div className="muted" style={{ fontSize: 13.5, textAlign: "center" }}>
            Income-tax litigation & practice management
          </div>
        </div>

        <div className="card" style={{ padding: 26 }}>
          {pendingEmail ? (
            <div style={{ textAlign: "center", padding: "8px 0" }}>
              <div style={{ width: 52, height: 52, borderRadius: 16, background: "var(--p-mint)", color: "#1B8C5C", display: "grid", placeItems: "center", margin: "0 auto 14px" }}>
                <Icon name="mail" size={24} />
              </div>
              <div style={{ fontWeight: 800, fontSize: 17, letterSpacing: "-0.01em" }}>Check your inbox</div>
              <div className="muted" style={{ fontSize: 13, marginTop: 8, lineHeight: 1.5 }}>
                We sent a secure sign-in link to<br />
                <b style={{ color: "var(--p-text)" }}>{pendingEmail}</b>.<br />
                Open it on this device to finish signing in.
              </div>
              <button className="btn btn-secondary" style={{ marginTop: 18, width: "100%", justifyContent: "center" }} onClick={() => { resetPendingEmail(); clearError(); }}>
                Use a different method
              </button>
            </div>
          ) : (
            <>
              <div style={{ fontWeight: 800, fontSize: 18, letterSpacing: "-0.01em", marginBottom: 4 }}>Sign in</div>
              <div className="muted" style={{ fontSize: 13, marginBottom: 18 }}>Welcome back. Choose how you'd like to continue.</div>

              <button className="btn btn-secondary" style={{ width: "100%", justifyContent: "center", gap: 10, height: 44 }} onClick={signInWithGoogle}>
                <GoogleGlyph /> Continue with Google
              </button>

              <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "18px 0", color: "var(--p-text-3)", fontSize: 12 }}>
                <div style={{ flex: 1, height: 1, background: "var(--p-line)" }} />
                OR
                <div style={{ flex: 1, height: 1, background: "var(--p-line)" }} />
              </div>

              <div className="field">
                <label>Email address</label>
                <input
                  type="email"
                  value={email}
                  placeholder="you@example.com"
                  onChange={(e) => { setEmail(e.target.value); if (error) clearError(); }}
                  onKeyDown={(e) => { if (e.key === "Enter") submitEmail(); }}
                />
              </div>
              <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center", height: 44, marginTop: 12, opacity: sending ? 0.7 : 1 }} disabled={sending} onClick={submitEmail}>
                {sending ? "Sending…" : <><Icon name="mail" size={15} /> Email me a sign-in link</>}
              </button>

              <div className="muted" style={{ fontSize: 11.5, marginTop: 14, textAlign: "center", lineHeight: 1.5 }}>
                No password needed — we'll email you a secure one-time link to sign in.
              </div>
            </>
          )}

          {error && (
            <div style={{ marginTop: 16, padding: "10px 12px", borderRadius: 10, background: "var(--p-coral)", color: "#B8463A", fontSize: 12.5, display: "flex", gap: 8, alignItems: "flex-start" }}>
              <Icon name="alert" size={14} /> <span>{error}</span>
            </div>
          )}
        </div>

        <div className="muted" style={{ fontSize: 11, textAlign: "center", marginTop: 18 }}>
          Your practice data is private to your account.
        </div>

        {onBack && (
          <div style={{ textAlign: "center", marginTop: 14 }}>
            <button className="btn btn-ghost btn-sm" onClick={onBack}>
              <Icon name="arrow-left" size={14} /> Back to overview
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
