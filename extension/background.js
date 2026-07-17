/*
 * ProHippo Sync — background service worker.
 *
 * Opens the portal tab for login, and (Phase 2) relays scraped e-Proceedings
 * data from the portal tab back to the ProHippo app tab that started the sync,
 * where the authenticated app saves it via a Cloud Function.
 *
 * Credentials live only in chrome.storage.session and are deleted as soon as
 * the portal tab picks them up.
 */
const LOGIN_URL = "https://eportal.incometax.gov.in/iec/foservices/#/login";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message || {};

  if (type === "OPEN_PORTAL_LOGIN") {
    const creds = payload || {};
    if (!creds.portalUserId || !creds.portalPassword) {
      sendResponse({ ok: false, error: "Missing portal credentials." });
      return true;
    }
    const appTabId = sender.tab && sender.tab.id; // the ProHippo app tab
    // Bulk sync opens the portal tab in the background (active:false) so it
    // doesn't steal focus; a single manual sync opens it in front.
    chrome.tabs.create({ url: LOGIN_URL, active: !creds.background }, async (tab) => {
      if (!tab || tab.id == null) {
        sendResponse({ ok: false, error: "Could not open a portal tab." });
        return;
      }
      await chrome.storage.session.set({
        ["creds_" + tab.id]: {
          portalUserId: creds.portalUserId,
          portalPassword: creds.portalPassword,
          assesseeId: creds.assesseeId || null,
          mode: creds.mode || "open", // "open" | "sync"
          knownDins: Array.isArray(creds.knownDins) ? creds.knownDins : [],
          appTabId: appTabId != null ? appTabId : null,
          createdAt: Date.now(),
        },
      });
      sendResponse({ ok: true, tabId: tab.id });
    });
    return true;
  }

  // Portal content script asks for the credential stashed for its tab.
  if (type === "GET_PORTAL_CREDS") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) { sendResponse({ ok: false }); return true; }
    const key = "creds_" + tabId;
    chrome.storage.session.get(key, (obj) => {
      const creds = obj[key];
      if (!creds) { sendResponse({ ok: false }); return; }
      // Keep the entry (mode/appTabId needed for the sync return path); the
      // content script uses the password immediately and doesn't re-request.
      sendResponse({ ok: true, creds });
    });
    return true;
  }

  // Portal content script pushes scraped data → relay to the app tab.
  if (type === "SYNC_DATA") {
    const tabId = sender.tab && sender.tab.id;
    const key = "creds_" + tabId;
    chrome.storage.session.get(key, (obj) => {
      const appTabId = obj[key] && obj[key].appTabId;
      if (appTabId == null) { sendResponse({ ok: false, error: "No app tab to receive data." }); return; }
      chrome.tabs.sendMessage(appTabId, { type: "SYNC_DATA", payload }, () => {
        // Ignore lastError; the app may not have a listener yet.
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  // Portal content script asks to close its own tab after a sync completes.
  if (type === "CLOSE_TAB") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null) setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 600);
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove("creds_" + tabId);
});
