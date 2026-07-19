/*
 * ProHippo Sync — page bridge.
 *
 * Runs only on ProHippo's own pages. Relays messages between the web app
 * (via window.postMessage) and the extension background worker (via
 * chrome.runtime). This lets the app detect the extension and ask it to
 * open + auto-login the Income-tax portal, without the app needing to know
 * the extension's ID.
 *
 * Protocol (window.postMessage on the app's own origin):
 *   app  -> bridge : { __prohippo: true, dir: "to-ext",  id, type, payload }
 *   bridge -> app  : { __prohippo: true, dir: "from-ext", id, type, payload }
 */
(function () {
  const TAG = "__prohippo";
  const VERSION = "0.1.0";

  function toPage(msg) {
    window.postMessage({ [TAG]: true, dir: "from-ext", ...msg }, window.location.origin);
  }

  // Announce presence as soon as the page exists, and again on load / when the
  // page is shown (bfcache), so the app can detect the extension whichever
  // fires first — and re-detect after a navigation.
  const announce = () => { try { toPage({ type: "READY", version: VERSION }); } catch { /* noop */ } };
  announce();
  window.addEventListener("DOMContentLoaded", announce);
  window.addEventListener("pageshow", announce);

  // Pushes from the background worker (e.g. scraped sync data) → to the page.
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type) {
      toPage({ type: message.type, payload: message.payload });
    }
    return false;
  });

  window.addEventListener("message", (event) => {
    // Only accept messages from this same page directed to the extension.
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data[TAG] !== true || data.dir !== "to-ext") return;

    const { id, type, payload } = data;

    if (type === "PING") {
      toPage({ id, type: "PONG", version: VERSION });
      return;
    }

    // Forward everything else to the background worker and relay its reply.
    // If the extension was reloaded/updated while this page kept running an old
    // content script, chrome.runtime.sendMessage throws "Extension context
    // invalidated" — catch it and tell the app so it can prompt a refresh
    // instead of the app hanging until it times out.
    try {
      chrome.runtime.sendMessage({ type, payload }, (response) => {
        if (chrome.runtime.lastError) {
          toPage({ id, type: type + "_RESULT", payload: { ok: false, error: chrome.runtime.lastError.message || "Extension unavailable — reload ProHippo Sync and refresh this page." } });
          return;
        }
        toPage({ id, type: type + "_RESULT", payload: response });
      });
    } catch {
      toPage({ id, type: type + "_RESULT", payload: { ok: false, error: "ProHippo Sync was updated — please refresh this page and try again." } });
    }
  });
})();
