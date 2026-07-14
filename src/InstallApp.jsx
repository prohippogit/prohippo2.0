/* "Download app" button — triggers the native PWA install prompt where the
   browser supports it, otherwise shows add-to-home-screen instructions.
   Renders nothing when the app is already running installed. */
import React from 'react';
import { Icon, Modal } from './shared';
import { canInstall, isStandalone, onInstallChange, promptInstall } from './pwaInstall';

function HelpRow({ icon, title, steps }) {
  return (
    <div className="center" style={{gap: 12, alignItems: "flex-start", padding: "12px 14px", background: "var(--p-card-tint)", borderRadius: 12, border: "1px solid var(--p-line-2)"}}>
      <div style={{width: 34, height: 34, borderRadius: 10, background: "white", color: "var(--p-primary)", display: "grid", placeItems: "center", flexShrink: 0}}>
        <Icon name={icon} size={16}/>
      </div>
      <div>
        <div style={{fontWeight: 700, fontSize: 13.5}}>{title}</div>
        <div className="muted" style={{fontSize: 12.5, marginTop: 3, lineHeight: 1.5}}>{steps}</div>
      </div>
    </div>
  );
}

export function InstallAppButton({ className = "btn btn-secondary", label = "Download app" }) {
  const [available, setAvailable] = React.useState(canInstall());
  const [showHelp, setShowHelp] = React.useState(false);
  React.useEffect(() => onInstallChange(setAvailable), []);

  if (isStandalone()) return null; // already installed and running as an app

  const click = async () => {
    if (available) {
      const accepted = await promptInstall();
      if (!accepted) setShowHelp(false);
    } else {
      setShowHelp(true);
    }
  };

  return (
    <>
      <button className={className} onClick={click}><Icon name="download" size={14}/>{label}</button>
      {showHelp && (
        <Modal
          title="Install ProHippo"
          sub="Add ProHippo to your home screen — it opens full-screen like a native app and loads instantly."
          width={480}
          onClose={() => setShowHelp(false)}
          footer={<button className="btn btn-primary" onClick={() => setShowHelp(false)}>Got it</button>}
        >
          <div className="col" style={{gap: 10}}>
            <HelpRow icon="phone" title="iPhone / iPad (Safari)"
              steps={<>Tap the <b>Share</b> button, then choose <b>Add to Home Screen</b>.</>}/>
            <HelpRow icon="menu" title="Android (Chrome)"
              steps={<>Open the browser menu (⋮), then tap <b>Install app</b> or <b>Add to Home screen</b>.</>}/>
            <HelpRow icon="download" title="Desktop (Chrome / Edge)"
              steps={<>Click the <b>install icon</b> at the right end of the address bar, then <b>Install</b>.</>}/>
          </div>
        </Modal>
      )}
    </>
  );
}
