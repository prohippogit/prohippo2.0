/* Download page for the ProHippo Connector desktop app. Lives inside the
   authenticated Shell, so it only shows to signed-in users. Links point to the
   stable GitHub Release the build workflow publishes. */
import React from 'react';
import { Icon } from './shared';

const REL = "https://github.com/prohippogit/prohippo2.0/releases/download/connector-latest";
const MAC_URL = `${REL}/ProHippo-Connector-mac.dmg`;
const WIN_URL = `${REL}/ProHippo-Connector-win.exe`;

function detectOS() {
  const p = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || "").toLowerCase();
  if (/mac/.test(p)) return "mac";
  if (/win/.test(p)) return "win";
  return "other";
}

function DownloadCard({ os, href, title, sub, primary }) {
  return (
    <a
      href={href}
      className="card"
      style={{
        display: "flex", alignItems: "center", gap: 16, textDecoration: "none",
        padding: "18px 20px", border: primary ? "2px solid var(--p-primary)" : "1px solid var(--p-line-2)",
        background: primary ? "var(--p-card-tint)" : "var(--p-card)",
      }}
    >
      <div style={{width: 46, height: 46, borderRadius: 13, background: "white", color: "var(--p-primary)", display: "grid", placeItems: "center", flexShrink: 0, boxShadow: "0 1px 3px rgba(20,16,45,.1)"}}>
        <Icon name={os === "mac" ? "apple" : "windows"} size={24}/>
      </div>
      <div style={{flex: 1, minWidth: 0}}>
        <div style={{fontWeight: 800, fontSize: 15, color: "var(--p-text)"}}>{title}</div>
        <div className="muted" style={{fontSize: 12.5, marginTop: 2}}>{sub}</div>
      </div>
      <span className="btn btn-primary" style={{pointerEvents: "none"}}><Icon name="download" size={14}/>Download</span>
    </a>
  );
}

function Step({ n, children }) {
  return (
    <div style={{display: "flex", gap: 11, alignItems: "flex-start"}}>
      <div style={{width: 22, height: 22, borderRadius: 999, background: "var(--p-primary)", color: "white", fontSize: 12, fontWeight: 800, display: "grid", placeItems: "center", flexShrink: 0}}>{n}</div>
      <div style={{fontSize: 13, lineHeight: 1.55, color: "var(--p-text-2)"}}>{children}</div>
    </div>
  );
}

export default function ConnectorDownload() {
  const os = detectOS();

  return (
    <div style={{maxWidth: 720, margin: "0 auto"}}>
      <div style={{marginBottom: 8}}>
        <h1 style={{fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em", margin: 0}}>Desktop Connector</h1>
        <p className="muted" style={{fontSize: 13.5, marginTop: 6, maxWidth: "62ch"}}>
          The Connector syncs many PANs from the income-tax portal <b>in parallel</b>, straight from your
          own computer — much faster than one tab at a time, and safe for your IP. Install it once, sign in
          with this same ProHippo account, and the data flows into your Matters automatically.
        </p>
      </div>

      <div style={{display: "flex", flexDirection: "column", gap: 11, margin: "18px 0"}}>
        <DownloadCard os="mac" href={MAC_URL} primary={os === "mac"}
          title="Download for macOS" sub="Apple silicon & Intel · .dmg installer"/>
        <DownloadCard os="win" href={WIN_URL} primary={os === "win"}
          title="Download for Windows" sub="Windows 10 & 11 · .exe installer"/>
      </div>

      <div className="card" style={{padding: "18px 20px"}}>
        <div style={{fontWeight: 800, fontSize: 14, marginBottom: 12}}>First-time install</div>
        <div style={{display: "flex", flexDirection: "column", gap: 12}}>
          <Step n="1"><b>Google Chrome is required</b> — the Connector drives your Chrome to log in to the portal. Install it from google.com/chrome if you don't have it.</Step>
          <Step n="2">Open the downloaded file and drag <b>ProHippo Connector</b> to your Applications (Mac), or run the installer (Windows).</Step>
          <Step n="3">
            The first time you open it, your computer may warn that it's from an unidentified developer — this is normal for a new app.
            <div className="muted" style={{fontSize: 12.5, marginTop: 5}}>
              <b>Mac:</b> right-click the app → <b>Open</b> → <b>Open</b>.&nbsp;&nbsp;
              <b>Windows:</b> <b>More info</b> → <b>Run anyway</b>.
            </div>
          </Step>
          <Step n="4">Sign in with Google (this same account), pick your PANs, and click <b>Sync selected</b>.</Step>
        </div>
      </div>

      <p className="muted" style={{fontSize: 11.5, marginTop: 14, textAlign: "center"}}>
        Your portal passwords stay encrypted and are used only in memory on your own computer — never stored on disk.
      </p>
    </div>
  );
}
