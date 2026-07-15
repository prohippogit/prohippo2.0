/*
 * ProHippo — client-side bridge to the "ProHippo Sync" browser extension.
 *
 * The extension injects a content script (bridge.js) into this page that
 * relays window.postMessage traffic to/from the extension. This module wraps
 * that in small promises: detect whether the extension is installed, and ask
 * it to open + auto-login the Income-tax portal for an assessee.
 */
const TAG = "__prohippo";

let extensionReady = false;
if (typeof window !== "undefined") {
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (d && d[TAG] === true && d.dir === "from-ext" && d.type === "READY") {
      extensionReady = true;
    }
  });
}

function request(type, payload, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") return reject(new Error("no window"));
    const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const onMsg = (event) => {
      if (event.source !== window) return;
      const d = event.data;
      if (!d || d[TAG] !== true || d.dir !== "from-ext" || d.id !== id) return;
      window.removeEventListener("message", onMsg);
      clearTimeout(timer);
      resolve(d.payload);
    };
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMsg);
      reject(new Error("The ProHippo Sync extension did not respond."));
    }, timeoutMs);
    window.addEventListener("message", onMsg);
    window.postMessage({ [TAG]: true, dir: "to-ext", id, type, payload }, window.location.origin);
  });
}

/** Resolves true if the extension is installed and responding. */
export async function detectExtension() {
  if (extensionReady) return true;
  try {
    const res = await request("PING", null, 1200);
    return Boolean(res && res.version);
  } catch {
    return false;
  }
}

/** Ask the extension to open the portal and auto-login. */
export async function openPortalLogin({ portalUserId, portalPassword, assesseeId }) {
  const res = await request("OPEN_PORTAL_LOGIN", { portalUserId, portalPassword, assesseeId }, 8000);
  if (!res || !res.ok) throw new Error(res?.error || "Could not open the portal.");
  return res;
}
