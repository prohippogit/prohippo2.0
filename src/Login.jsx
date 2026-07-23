/* ProHippo — sign-in screen (Email OTP now · SMS OTP when PRHIPO is live · Google) */
import React from "react";
import { Icon } from "./shared";
import { useAuth } from "./auth";
import { AUTH_METHODS } from "./authConfig";
import OtpInput from "./OtpInput";

function BrandMark({ height = 88 }) {
  return <img src="/prohippo-logo.png" alt="ProHippo" style={{ height, width: "auto" }} />;
}

const GoogleGlyph = () => (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#FFC107" d="M43.6 20.5h-1.9V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 4.1 29.6 2 24 2 11.8 2 2 11.8 2 24s9.8 22 22 22 22-9.8 22-22c0-1.5-.2-2.6-.4-3.5z" />
    <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 4.1 29.6 2 24 2 15.6 2 8.3 6.9 6.3 14.7z" />
    <path fill="#4CAF50" d="M24 46c5.5 0 10.5-2.1 14.3-5.5l-6.6-5.6C29.6 36.5 26.9 37.5 24 37.5c-5.2 0-9.6-3.3-11.2-7.9l-6.6 5.1C8.2 41 15.5 46 24 46z" />
    <path fill="#1976D2" d="M43.6 20.5H24v8h11.3c-.8 2.2-2.1 4.1-3.9 5.4l6.6 5.6C41.9 36.3 46 30.8 46 24c0-1.5-.2-2.6-.4-3.5z" />
  </svg>
);

const Divider = ({ label = "OR" }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "18px 0", color: "var(--p-text-3)", fontSize: 12 }}>
    <div style={{ flex: 1, height: 1, background: "var(--p-line)" }} />
    {label}
    <div style={{ flex: 1, height: 1, background: "var(--p-line)" }} />
  </div>
);

// Mask a target for the "code sent to …" line. Email stays readable; phone is masked.
function maskTarget(channel, target) {
  if (channel === "sms") {
    const d = String(target).replace(/\D/g, "");
    return d.length >= 4 ? `+91 ${d.slice(-10, -4).replace(/./g, "•")} ${d.slice(-4)}`.trim() : target;
  }
  return target;
}

export default function Login({ onBack }) {
  const { signInWithGoogle, requestOtp, verifyOtp, otpPending, resetOtp, error, clearError } = useAuth();

  const [email, setEmail] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false); // sending or verifying
  const [cooldown, setCooldown] = React.useState(0);

  // Resend countdown tick.
  React.useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const sendEmail = async () => {
    if (busy) return;
    setBusy(true);
    const res = await requestOtp("email", email);
    if (res) setCooldown(res.cooldownSeconds || 30);
    setBusy(false);
  };

  const sendSms = async () => {
    if (busy) return;
    const digits = phone.replace(/\D/g, "").slice(-10);
    if (digits.length !== 10) { clearError(); return; }
    setBusy(true);
    const res = await requestOtp("sms", "+91" + digits);
    if (res) setCooldown(res.cooldownSeconds || 30);
    setBusy(false);
  };

  const submitCode = async (value) => {
    if (busy) return;
    setBusy(true);
    const ok = await verifyOtp(value ?? code);
    if (!ok) setCode(""); // clear so the user can retype
    setBusy(false);
  };

  const resend = async () => {
    if (cooldown > 0 || busy) return;
    setBusy(true);
    const res = await requestOtp(otpPending.channel, otpPending.target);
    if (res) setCooldown(res.cooldownSeconds || 30);
    setBusy(false);
  };

  const backToMethods = () => { resetOtp(); clearError(); setCode(""); setCooldown(0); };

  // ---- Email OTP block (reused as hero or secondary). Plain render helpers,
  // NOT nested components, so the inputs don't remount (and lose focus) each keystroke.
  const emailBlock = (hero) => (
    <>
      <div className="field">
        <label>Email address</label>
        <input
          type="email"
          value={email}
          placeholder="you@example.com"
          onChange={(e) => { setEmail(e.target.value); if (error) clearError(); }}
          onKeyDown={(e) => { if (e.key === "Enter") sendEmail(); }}
        />
      </div>
      <button
        className={`btn ${hero ? "btn-primary" : "btn-secondary"}`}
        style={{ width: "100%", justifyContent: "center", height: 44, marginTop: 12, gap: 8, opacity: busy ? 0.7 : 1 }}
        disabled={busy}
        onClick={sendEmail}
      >
        <Icon name="mail" size={15} /> {busy ? "Sending…" : "Email me a code"}
      </button>
    </>
  );

  // ---- SMS OTP block (only rendered when the channel is enabled) ----
  const smsBlock = (hero) => (
    <>
      <div className="field">
        <label>Mobile number</label>
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ display: "grid", placeItems: "center", padding: "0 12px", height: 44, borderRadius: 10, border: "1px solid var(--p-line-2, #E3DEF0)", background: "var(--p-card-tint, #F7F6FB)", fontSize: 14, fontWeight: 600, color: "var(--p-text-2, #6B6480)", whiteSpace: "nowrap" }}>+91</div>
          <input
            type="tel"
            inputMode="numeric"
            value={phone}
            placeholder="98250 11234"
            style={{ flex: 1 }}
            onChange={(e) => { setPhone(e.target.value.replace(/[^\d\s]/g, "")); if (error) clearError(); }}
            onKeyDown={(e) => { if (e.key === "Enter") sendSms(); }}
          />
        </div>
      </div>
      <button
        className={`btn ${hero ? "btn-primary" : "btn-secondary"}`}
        style={{ width: "100%", justifyContent: "center", height: 44, marginTop: 12, gap: 8, opacity: busy ? 0.7 : 1 }}
        disabled={busy}
        onClick={sendSms}
      >
        <Icon name="phone" size={15} /> {busy ? "Sending…" : "Send OTP"}
      </button>
    </>
  );

  const smsPrimary = AUTH_METHODS.sms; // when live, SMS is the hero method

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 20, background: "radial-gradient(1200px 600px at 50% -10%, #EEE9FF 0%, #F7F6FB 45%, #F7F6FB 100%)" }}>
      <div style={{ width: "100%", maxWidth: 420 }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, marginBottom: 24 }}>
          <BrandMark />
          <div className="muted" style={{ fontSize: 13.5, textAlign: "center" }}>
            Income-tax litigation &amp; practice management
          </div>
        </div>

        <div className="card" style={{ padding: 26 }}>
          {otpPending ? (
            /* ---------- Step 2: enter the code ---------- */
            <div style={{ textAlign: "center", padding: "4px 0" }}>
              <div style={{ width: 52, height: 52, borderRadius: 16, background: "var(--p-mint)", color: "#1B8C5C", display: "grid", placeItems: "center", margin: "0 auto 14px" }}>
                <Icon name={otpPending.channel === "sms" ? "phone" : "mail"} size={24} />
              </div>
              <div style={{ fontWeight: 800, fontSize: 17, letterSpacing: "-0.01em" }}>Enter your code</div>
              <div className="muted" style={{ fontSize: 13, marginTop: 8, lineHeight: 1.5 }}>
                We sent a 6-digit code to<br />
                <b style={{ color: "var(--p-text)" }}>{maskTarget(otpPending.channel, otpPending.target)}</b>
              </div>

              <div style={{ margin: "20px 0 6px" }}>
                <OtpInput
                  value={code}
                  disabled={busy}
                  onChange={(v) => { setCode(v); if (error) clearError(); }}
                  onComplete={(v) => submitCode(v)}
                />
              </div>

              <button
                className="btn btn-primary"
                style={{ width: "100%", justifyContent: "center", height: 44, marginTop: 14, opacity: busy || code.length < 6 ? 0.7 : 1 }}
                disabled={busy || code.length < 6}
                onClick={() => submitCode()}
              >
                {busy ? "Verifying…" : "Verify & sign in"}
              </button>

              <div className="muted" style={{ fontSize: 12.5, marginTop: 16 }}>
                Didn't get it?{" "}
                {cooldown > 0 ? (
                  <span>Resend in {cooldown}s</span>
                ) : (
                  <button className="btn btn-ghost btn-sm" style={{ padding: "2px 6px" }} onClick={resend} disabled={busy}>
                    Resend code
                  </button>
                )}
              </div>

              <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={backToMethods}>
                Use a different method
              </button>
            </div>
          ) : (
            /* ---------- Step 1: choose a method ---------- */
            <>
              <div style={{ fontWeight: 800, fontSize: 18, letterSpacing: "-0.01em", marginBottom: 4 }}>Sign in</div>
              <div className="muted" style={{ fontSize: 13, marginBottom: 18 }}>Welcome back. Choose how you'd like to continue.</div>

              {smsPrimary ? (
                <>
                  {AUTH_METHODS.sms && smsBlock(true)}
                  {AUTH_METHODS.emailOtp && (<><Divider />{emailBlock(false)}</>)}
                  {AUTH_METHODS.google && (
                    <>
                      <Divider />
                      <button className="btn btn-secondary" style={{ width: "100%", justifyContent: "center", gap: 10, height: 44 }} onClick={signInWithGoogle}>
                        <GoogleGlyph /> Continue with Google
                      </button>
                    </>
                  )}
                </>
              ) : (
                <>
                  {AUTH_METHODS.emailOtp && emailBlock(true)}
                  {AUTH_METHODS.google && (
                    <>
                      <Divider />
                      <button className="btn btn-secondary" style={{ width: "100%", justifyContent: "center", gap: 10, height: 44 }} onClick={signInWithGoogle}>
                        <GoogleGlyph /> Continue with Google
                      </button>
                    </>
                  )}
                </>
              )}

              <div className="muted" style={{ fontSize: 11.5, marginTop: 14, textAlign: "center", lineHeight: 1.5 }}>
                No password needed — we'll {smsPrimary ? "text" : "email"} you a one-time code to sign in.
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
