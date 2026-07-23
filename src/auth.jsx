/* ProHippo — authentication context (Google + passwordless email magic link) */
import React from "react";
import {
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  signInWithCustomToken,
  onAuthStateChanged,
  signOut,
} from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { auth, functions } from "./firebase";

const EMAIL_KEY = "prohippo-email-for-signin";

const AuthCtx = React.createContext(null);
export const useAuth = () => React.useContext(AuthCtx);

const friendly = (code) => {
  const map = {
    "auth/popup-closed-by-user": "Sign-in window closed before finishing.",
    "auth/popup-blocked": "Your browser blocked the sign-in popup — redirecting instead.",
    "auth/invalid-email": "That doesn't look like a valid email address.",
    "auth/invalid-action-code": "This sign-in link has expired or was already used. Please request a new one.",
    "auth/unauthorized-domain": "This site's domain isn't authorized. Add prohippo2.web.app in Firebase console → Authentication → Settings → Authorized domains.",
    "auth/unauthorized-continue-uri": "This site's domain isn't authorized for email links. Add prohippo2.web.app in Firebase console → Authentication → Settings → Authorized domains.",
    "auth/invalid-continue-uri": "The sign-in link's return address is invalid. Please contact support.",
    "auth/missing-continue-uri": "The sign-in link is missing a return address. Please contact support.",
    "auth/operation-not-allowed": "Email-link sign-in isn't switched on. In Firebase console → Authentication → Sign-in method → Email/Password, enable the second toggle 'Email link (passwordless sign-in)' and Save.",
    "auth/admin-restricted-operation": "Email-link sign-in isn't switched on. In Firebase console → Authentication → Sign-in method → Email/Password, enable the second toggle 'Email link (passwordless sign-in)' and Save.",
    "auth/too-many-requests": "Too many attempts. Please wait a minute and try again.",
    "auth/network-request-failed": "Network problem — check your connection and try again.",
  };
  return map[code] || null;
};

export function AuthProvider({ children }) {
  const [user, setUser] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [pendingEmail, setPendingEmail] = React.useState(null); // email a link was just sent to
  const [otpPending, setOtpPending] = React.useState(null); // { channel, target } a code was sent to
  const [error, setError] = React.useState(null);
  const [completingLink, setCompletingLink] = React.useState(false);

  // Complete an email magic-link sign-in if the user arrived via one.
  React.useEffect(() => {
    if (!isSignInWithEmailLink(auth, window.location.href)) return;
    setCompletingLink(true);
    let email = window.localStorage.getItem(EMAIL_KEY);
    if (!email) {
      email = window.prompt("Please confirm the email address you used to sign in:") || "";
    }
    signInWithEmailLink(auth, email, window.location.href)
      .then(() => {
        window.localStorage.removeItem(EMAIL_KEY);
        // Remove the sign-in parameters from the URL bar.
        window.history.replaceState({}, document.title, window.location.pathname);
      })
      .catch((e) => { console.error("email-link sign-in:", e); setError(friendly(e.code) || `Could not complete sign-in (${e.code || "unknown"}). Please request a new link.`); })
      .finally(() => setCompletingLink(false));
  }, []);

  React.useEffect(() => {
    return onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
      if (u) { setPendingEmail(null); setOtpPending(null); }
    });
  }, []);

  const api = React.useMemo(() => ({
    signInWithGoogle: async () => {
      setError(null);
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      try {
        await signInWithPopup(auth, provider);
      } catch (e) {
        if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-environment") {
          try {
            await signInWithRedirect(auth, provider);
            return;
          } catch (e2) {
            console.error("google redirect sign-in:", e2);
            setError(friendly(e2.code) || `Google sign-in failed (${e2.code || "unknown"}). Please try again.`);
            return;
          }
        }
        if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
          console.error("google popup sign-in:", e);
          setError(friendly(e.code) || `Google sign-in failed (${e.code || "unknown"}). Please try again.`);
        }
      }
    },
    sendMagicLink: async (email) => {
      setError(null);
      const clean = (email || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
        setError("Please enter a valid email address.");
        return false;
      }
      try {
        await sendSignInLinkToEmail(auth, clean, {
          url: window.location.origin + window.location.pathname,
          handleCodeInApp: true,
        });
        window.localStorage.setItem(EMAIL_KEY, clean);
        setPendingEmail(clean);
        return true;
      } catch (e) {
        console.error("sendSignInLinkToEmail:", e);
        setError(friendly(e.code) || `Could not send the sign-in link (${e.code || "unknown"}). Please try again.`);
        return false;
      }
    },
    // Passwordless OTP login. `channel` is "email" (live) or "sms" (later).
    // On success a code is sent and { channel, target } is remembered so the
    // UI can switch to the code-entry step.
    requestOtp: async (channel, target) => {
      setError(null);
      const clean = (target || "").trim();
      if (channel === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
        setError("Please enter a valid email address.");
        return null;
      }
      try {
        const call = httpsCallable(functions, "requestOtp");
        const res = await call({ channel, target: channel === "email" ? clean.toLowerCase() : clean });
        setOtpPending({ channel, target: channel === "email" ? clean.toLowerCase() : clean });
        return res.data || { ok: true };
      } catch (e) {
        console.error("requestOtp:", e);
        setError(e?.message || "Could not send the code. Please try again.");
        return null;
      }
    },
    // Verify a code for the pending challenge and sign the user in.
    verifyOtp: async (code) => {
      setError(null);
      if (!otpPending) { setError("Request a code first."); return false; }
      try {
        const call = httpsCallable(functions, "verifyOtp");
        const res = await call({ channel: otpPending.channel, target: otpPending.target, code: String(code || "") });
        const token = res.data?.token;
        if (!token) { setError("Could not verify the code. Please try again."); return false; }
        await signInWithCustomToken(auth, token);
        return true;
      } catch (e) {
        console.error("verifyOtp:", e);
        setError(e?.message || "That code didn't work. Please try again.");
        return false;
      }
    },
    resetOtp: () => setOtpPending(null),
    resetPendingEmail: () => setPendingEmail(null),
    clearError: () => setError(null),
    signOutUser: () => signOut(auth),
  }), [otpPending]);

  const value = React.useMemo(
    () => ({ user, loading: loading || completingLink, pendingEmail, otpPending, error, ...api }),
    [user, loading, completingLink, pendingEmail, otpPending, error, api]
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}
