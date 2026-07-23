// Google sign-in for the desktop app — system-browser + loopback (PKCE) flow.
//
// Google blocks OAuth inside embedded app windows ("disallowed_useragent"), so
// we do it the approved way for installed apps: open the user's REAL browser to
// Google's consent page, receive the auth code on a temporary localhost server,
// exchange it for a Google ID token, then hand that token to Firebase.
//
// Needs a Google OAuth "Desktop app" client (id + secret in google-oauth.json).
// The secret for an installed app is not a true secret (Google's own docs say
// so); PKCE is what actually protects the exchange.
"use strict";

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { URL, URLSearchParams } = require("url");
const { shell } = require("electron");
const { getGoogleOAuthConfig } = require("./config");

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CALLBACK_TIMEOUT_MS = 180000; // 3 min for the user to complete consent

const b64url = (buf) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Start a loopback server that resolves with the auth code from Google's
// redirect. Returns { server, port, done } where `done` is a Promise.
function startLoopback() {
  return new Promise((resolve, reject) => {
    let settle;
    const done = new Promise((res, rej) => { settle = { res, rej }; });
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url, "http://127.0.0.1");
        const code = u.searchParams.get("code");
        const err = u.searchParams.get("error");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<html><body style='font-family:-apple-system,sans-serif;text-align:center;padding:60px;color:#14132B'>" +
          "<h2>ProHippo Connector</h2><p>" +
          (code ? "Signed in — you can close this tab and return to the app." : "Sign-in was cancelled. You can close this tab.") +
          "</p></body></html>"
        );
        if (code) settle.res(code);
        else settle.rej(new Error(err || "Sign-in was cancelled."));
      } catch (e) {
        settle.rej(e);
      }
    });
    server.on("error", reject);
    // Port 0 → OS picks a free port; 127.0.0.1 only (never exposed off-machine).
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, done }));
  });
}

// Exchange the auth code for tokens; return the Google ID token.
function exchangeCode(cfg, code, verifier, redirectUri) {
  const body = new URLSearchParams({
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request(
      TOKEN_ENDPOINT,
      { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(data);
            if (j.id_token) resolve(j.id_token);
            else reject(new Error(j.error_description || j.error || "Token exchange failed."));
          } catch (e) { reject(e); }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Run the whole flow; resolves with a Google ID token for Firebase.
async function getGoogleIdToken() {
  const cfg = getGoogleOAuthConfig();
  if (!cfg) {
    throw new Error(
      "Google sign-in isn't set up yet. Add connector/google-oauth.json — see the README (Google sign-in setup)."
    );
  }

  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const { server, port, done } = await startLoopback();
  const redirectUri = `http://127.0.0.1:${port}`;

  const authUrl = new URL(AUTH_ENDPOINT);
  authUrl.searchParams.set("client_id", cfg.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("access_type", "online");
  authUrl.searchParams.set("prompt", "select_account");

  const timer = setTimeout(() => server.close(), CALLBACK_TIMEOUT_MS);
  try {
    await shell.openExternal(authUrl.toString());
    const code = await done;
    return await exchangeCode(cfg, code, verifier, redirectUri);
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

module.exports = { getGoogleIdToken };
