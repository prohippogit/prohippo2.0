/*
 * ProHippo Sync — background service worker.
 *
 * Receives requests from the page bridge and drives the portal tab. For a
 * login request it opens the e-filing login page and stashes the credential
 * in session storage keyed by the new tab's id; the portal content script
 * then asks for it and fills the form. Credentials live only in memory
 * (chrome.storage.session) and are deleted as soon as they're handed over.
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
    chrome.tabs.create({ url: LOGIN_URL, active: true }, async (tab) => {
      if (!tab || tab.id == null) {
        sendResponse({ ok: false, error: "Could not open a portal tab." });
        return;
      }
      await chrome.storage.session.set({
        ["creds_" + tab.id]: {
          portalUserId: creds.portalUserId,
          portalPassword: creds.portalPassword,
          assesseeId: creds.assesseeId || null,
          createdAt: Date.now(),
        },
      });
      sendResponse({ ok: true, tabId: tab.id });
    });
    return true; // async response
  }

  // The portal content script asks for the credential stashed for its tab.
  if (type === "GET_PORTAL_CREDS") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) {
      sendResponse({ ok: false });
      return true;
    }
    const key = "creds_" + tabId;
    chrome.storage.session.get(key, (obj) => {
      const creds = obj[key];
      if (!creds) {
        sendResponse({ ok: false });
        return;
      }
      // Hand over once, then delete so it doesn't linger.
      chrome.storage.session.remove(key);
      sendResponse({ ok: true, creds });
    });
    return true;
  }

  return false;
});

// Clean up any stashed creds if a portal tab is closed before use.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove("creds_" + tabId);
});
