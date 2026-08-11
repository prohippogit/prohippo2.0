/* Download page for the ProHippo Connector desktop app. Lives inside the
   authenticated Shell, so it only shows to signed-in users. Links point to the
   stable GitHub Release the build workflow publishes. OS-aware: shows the right
   first-run steps (Mac quarantine command / Windows "Run anyway"). */
import React from 'react';
import { Icon, CopyField } from './shared';

const REL = "https://github.com/prohippogit/prohippo2.0/releases/download/connector-latest";
const MAC_URL = `${REL}/ProHippo-Connector-mac.dmg`;
const WIN_URL = `${REL}/ProHippo-Connector-win.exe`;
const XATTR_CMD = 'xattr -cr "/Applications/ProHippo Connector.app"';

function detectOS() {
  const p = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || "").toLowerCase();
  if (/mac/.test(p)) return "mac";
  if (/win/.test(p)) return "win";
  return "mac";
}

function DownloadCard({ os, href, title, sub, primary }) {
  return (
    <a href={href} className="card" style={{
      display: "flex", alignItems: "center", gap: 16, textDecoration: "none",
      padding: "18px 20px", border: primary ? "2px solid var(--p-primary)" : "1px solid var(--p-line-2)",
      background: primary ? "var(--p-card-tint)" : "var(--p-card)",
    }}>
      <div style={{width: 46, height: 46, borderRadius: 13, background: "white", color: "var(--p-primary)", display: "grid", placeItems: "center", flexShrink: 0, boxShadow: "0 1px 3px rgba(20,16,45,.1)"}}>
        <Icon name={os === "mac" ? "apple" : "windows"} size={24}/>
      </div>
      <div style={{flex: 1, minWidth: 0}}>
        <div style={{fontWeight: 800, fontSize: 15, color: "var(--p-text)"}}>{title}</div>
        <div className="muted" style={{fontSize: 12.5, marginTop: 2}}>{sub}{primary ? " · detected as your system" : ""}</div>
      </div>
      <span className="btn btn-primary" style={{pointerEvents: "none"}}><Icon name="download" size={14}/>Download</span>
    </a>
  );
}

function Step({ n, children }) {
  return (
    <div style={{display: "flex", gap: 11, alignItems: "flex-start"}}>
      <div style={{width: 22, height: 22, borderRadius: 999, background: "var(--p-primary)", color: "white", fontSize: 12, fontWeight: 800, display: "grid", placeItems: "center", flexShrink: 0}}>{n}</div>
      <div style={{fontSize: 13, lineHeight: 1.6, color: "var(--p-text-2)"}}>{children}</div>
    </div>
  );
}

function MacSteps() {
  return (
    <div style={{display: "flex", flexDirection: "column", gap: 13}}>
      <Step n="1">Open the downloaded <b>ProHippo-Connector-mac.dmg</b>, then drag <b>ProHippo Connector</b> into your <b>Applications</b> folder.</Step>
      <Step n="2">
        The first time you open it, macOS may say <b>"ProHippo Connector is damaged and can't be opened."</b> This is normal for a new app that isn't yet signed by Apple — it's not actually damaged.
        <div style={{marginTop: 8}}>Open <b>Terminal</b> (press <b>Cmd + Space</b>, type <b>Terminal</b>, press Enter), then copy-paste this line and press Enter:</div>
        <CopyField text={XATTR_CMD}/>
      </Step>
      <Step n="3">Now open <b>ProHippo Connector</b> from your Applications folder. It opens normally from now on.</Step>
      <Step n="4">Click <b>Sign in with Google</b>, pick your PANs, and hit <b>Sync selected</b>.</Step>
    </div>
  );
}

function WinSteps() {
  return (
    <div style={{display: "flex", flexDirection: "column", gap: 13}}>
      <Step n="1">Open the downloaded <b>ProHippo-Connector-win.exe</b> to run the installer.</Step>
      <Step n="2">
        Windows may show a blue box: <b>"Windows protected your PC."</b> This is normal for a new app that isn't yet signed.
        <div style={{marginTop: 6}}>Click <b>More info</b> (the small link), then click the <b>Run anyway</b> button that appears.</div>
      </Step>
      <Step n="3">Finish the installer, then open <b>ProHippo Connector</b> from the Start menu or desktop shortcut.</Step>
      <Step n="4">Click <b>Sign in with Google</b>, pick your PANs, and hit <b>Sync selected</b>.</Step>
    </div>
  );
}

export default function ConnectorDownload() {
  const [os, setOS] = React.useState(detectOS());

  return (
    <div style={{maxWidth: 720, margin: "0 auto"}}>
      <div style={{marginBottom: 8}}>
        <h1 style={{fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em", margin: 0}}>Sync Connector App</h1>
        <p className="muted" style={{fontSize: 13.5, marginTop: 6, maxWidth: "62ch"}}>
          The Sync Connector syncs many PANs from the income-tax portal <b>in parallel</b>, straight from your
          own computer — much faster than one at a time, and safe for your IP. Install it once, sign in
          with this same ProHippo account, and the data flows into your Matters automatically.
        </p>
        <p className="muted" style={{fontSize: 13.5, marginTop: 8, maxWidth: "62ch"}}>
          It also <b>adds assessees</b>: enter a PAN and its e-filing password, and it signs in, pulls the
          name, address and Assessing Officer, and creates the record with its login stored. No Chrome
          extension needed for any of it — a good way to get your first PANs in.
        </p>
      </div>

      <div style={{display: "flex", flexDirection: "column", gap: 11, margin: "18px 0"}}>
        <DownloadCard os="mac" href={MAC_URL} primary={os === "mac"}
          title="Download for macOS" sub="Apple silicon & Intel · .dmg"/>
        <DownloadCard os="win" href={WIN_URL} primary={os === "win"}
          title="Download for Windows" sub="Windows 10 & 11 · .exe"/>
      </div>

      <div className="card" style={{padding: "18px 20px"}}>
        <div style={{display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap"}}>
          <div style={{fontWeight: 800, fontSize: 14}}>First-time install</div>
          <div style={{display: "flex", gap: 6, background: "var(--p-card-tint)", padding: 4, borderRadius: 10}}>
            <button className={`btn btn-sm ${os === "mac" ? "btn-primary" : "btn-ghost"}`} onClick={() => setOS("mac")}><Icon name="apple" size={13}/>Mac</button>
            <button className={`btn btn-sm ${os === "win" ? "btn-primary" : "btn-ghost"}`} onClick={() => setOS("win")}><Icon name="windows" size={13}/>Windows</button>
          </div>
        </div>

        <div style={{padding: "11px 13px", background: "var(--p-card-tint)", border: "1px solid var(--p-line-2)", borderRadius: 11, marginBottom: 14, display: "flex", gap: 10, alignItems: "flex-start"}}>
          <Icon name="info" size={16}/>
          <div style={{fontSize: 12.5, lineHeight: 1.5, color: "var(--p-text-2)"}}>
            <b>Google Chrome is required</b> — the Connector uses your Chrome to log in to the portal. Install it from
            {" "}<a href="https://www.google.com/chrome/" target="_blank" rel="noreferrer" style={{color: "var(--p-primary)"}}>google.com/chrome</a> if you don't already have it.
          </div>
        </div>

        {os === "mac" ? <MacSteps/> : <WinSteps/>}
      </div>

      <p className="muted" style={{fontSize: 11.5, marginTop: 14, textAlign: "center", lineHeight: 1.6}}>
        Your portal passwords stay encrypted and are used only in memory on your own computer — never stored on disk.
        <br/>The one-time warning appears only because the app isn't code-signed yet; it's safe to proceed.
      </p>
    </div>
  );
}
