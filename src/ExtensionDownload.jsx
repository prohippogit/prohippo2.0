/* ProHippo — download + install the "ProHippo Sync" Chrome extension.
 *
 * WHY THIS EXISTS. Auto-login, the portal fetch and "Fetch master data" all run
 * through the extension, and until now the only way to get it was to clone the
 * repository. A practitioner opening ProHippo for the first time was told to
 * install something they had no way of installing, and every one of those
 * buttons simply did nothing for them.
 *
 * The zip is built from THIS build's extension/ folder (scripts/
 * build-extension-zip.mjs, run by npm run dev / build), so what they download
 * is always the version the app is expecting to talk to — there is no separate
 * release to remember to publish.
 *
 * Chrome's own install steps come with it: a zip on its own is not an install,
 * and "Load unpacked" is not a thing most people have ever done. The steps are
 * shown after the download starts rather than before, because a dialog between
 * a person and the file they asked for is a dialog they close.
 */
import React from 'react';
import { Icon, Modal, CopyField } from './shared';
import { EXTENSION_VERSION, EXTENSION_ZIP_URL, EXTENSION_FOLDER } from './extensionInfo';

const CHROME_EXTENSIONS_URL = "chrome://extensions";

function Step({ n, children }) {
  return (
    <div style={{display: "flex", gap: 11, alignItems: "flex-start"}}>
      <div style={{width: 22, height: 22, borderRadius: 999, background: "var(--p-primary)", color: "white", fontSize: 12, fontWeight: 800, display: "grid", placeItems: "center", flexShrink: 0}}>{n}</div>
      <div style={{fontSize: 13, lineHeight: 1.6, color: "var(--p-text-2)"}}>{children}</div>
    </div>
  );
}

/* The install steps. Also exported on its own so a page that has already
   downloaded the zip can show them again without re-downloading. */
export function ExtensionInstallSteps({ onRecheck }) {
  return (
    <div style={{display: "flex", flexDirection: "column", gap: 13}}>
      <Step n="1">
        <b>Unzip</b> the downloaded <b>{EXTENSION_FOLDER}.zip</b>. On Windows, right-click it → <b>Extract All</b>; on a Mac, double-click it.
        You'll get a folder called <b>{EXTENSION_FOLDER}</b>. Keep it somewhere permanent (Documents is fine) — Chrome reads it from that folder every time it starts, so deleting it uninstalls the extension.
      </Step>
      <Step n="2">
        Open a new Chrome tab and go to this address — Chrome won't let a page link to it, so copy it in:
        <CopyField text={CHROME_EXTENSIONS_URL}/>
      </Step>
      <Step n="3">Turn on <b>Developer mode</b> with the switch at the top-right of that page.</Step>
      <Step n="4">Click <b>Load unpacked</b> (top-left), select the <b>{EXTENSION_FOLDER}</b> folder you unzipped, and confirm. <b>ProHippo Sync</b> appears in the list.</Step>
      <Step n="5">Come back here and press <b>{onRecheck ? "I've installed it" : "I've installed it — recheck"}</b>. Portal login and sync work from then on.</Step>
    </div>
  );
}

/* Shown to someone who already has an older copy loaded. Chrome does not update
   an unpacked extension by itself, and a stale one fails in ways that look like
   a portal problem rather than a version problem. */
function UpdateNote() {
  return (
    <div style={{padding: "11px 13px", background: "var(--p-card-tint)", border: "1px solid var(--p-line-2)", borderRadius: 11, marginTop: 14, display: "flex", gap: 10, alignItems: "flex-start"}}>
      <Icon name="info" size={16}/>
      <div style={{fontSize: 12.5, lineHeight: 1.5, color: "var(--p-text-2)"}}>
        <b>Already have it?</b> Replace the contents of your existing {EXTENSION_FOLDER} folder with the new ones, then press the <b>refresh</b> arrow on the ProHippo Sync card at {CHROME_EXTENSIONS_URL}. Chrome never updates an unpacked extension on its own — check the version it shows reads <b>{EXTENSION_VERSION}</b>.
      </div>
    </div>
  );
}

export function ExtensionInstallModal({ onClose, onRecheck }) {
  return (
    <Modal
      title="Install the ProHippo Sync extension"
      sub={`Version ${EXTENSION_VERSION} · Google Chrome on a desktop or laptop`}
      onClose={onClose}
      width={580}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Close</button>
        <a className="btn btn-secondary" href={EXTENSION_ZIP_URL} download>
          <Icon name="download" size={14}/>Download again
        </a>
        {onRecheck && (
          <button className="btn btn-primary" onClick={() => { onRecheck(); onClose(); }}>
            <Icon name="check" size={14}/>I've installed it
          </button>
        )}
      </>}
    >
      <div style={{padding: "11px 13px", background: "var(--p-mint)", borderRadius: 11, marginBottom: 16, display: "flex", gap: 10, alignItems: "flex-start"}}>
        <Icon name="download" size={16}/>
        <div style={{fontSize: 12.5, lineHeight: 1.5}}>
          <b>{EXTENSION_FOLDER}.zip</b> is downloading — it's in your browser's Downloads. Follow the five steps below once; it stays installed after that.
        </div>
      </div>

      <ExtensionInstallSteps onRecheck={onRecheck}/>
      <UpdateNote/>

      <div className="muted" style={{fontSize: 11.5, marginTop: 14, lineHeight: 1.6}}>
        The extension only runs on incometax.gov.in and your ProHippo pages. Portal passwords pass through it in memory to fill the login form and are never stored by it.
        {" "}Syncing many PANs at once is faster with the <b>Sync Connector</b> desktop app, which needs no extension at all.
      </div>
    </Modal>
  );
}

/* The button itself. Downloads the zip and opens the steps in one press —
   `download` on the anchor is what saves the file rather than navigating to it,
   and the click handler runs either way.
 *
 * onRecheck (optional) is the caller's "check for the extension again" so the
 * user can finish the whole loop from inside the modal. */
export function ExtensionDownloadButton({ onRecheck, className = "btn btn-secondary btn-sm", label = "Get Chrome extension", title }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <a
        className={className}
        href={EXTENSION_ZIP_URL}
        download
        onClick={() => setOpen(true)}
        title={title || `Download ProHippo Sync ${EXTENSION_VERSION} and see how to load it into Chrome`}
        style={{textDecoration: "none"}}
      >
        <Icon name="download" size={13}/>{label}
      </a>
      {open && <ExtensionInstallModal onClose={() => setOpen(false)} onRecheck={onRecheck}/>}
    </>
  );
}
