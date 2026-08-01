import ReactDOM from 'react-dom/client';
import './app.css';
import './pwaInstall'; // capture beforeinstallprompt before React mounts
import App from './App';
import { captureReferralFromUrl } from './referral';

// Read and store any ?ref=CODE before React renders and the router rewrites
// the URL — a partner's link only carries the code on the very first request.
captureReferralFromUrl();

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);

// PWA: register the service worker (production builds only, so dev stays uncached).
//
// AND pick up new releases without the user knowing what a service worker is.
//
// sw.js serves static assets stale-while-revalidate, so a returning user runs
// whatever JavaScript is already cached; a new build only takes effect on the
// reload AFTER the one that fetched it. That is invisible for a cosmetic change
// and actively misleading for a behavioural one — a fix ships, the practitioner
// reloads, nothing changes, and the only cure anyone knows is "clear your cache".
//
// The service worker already calls skipWaiting() and clients.claim(), so a new
// worker takes control as soon as it installs. `controllerchange` is that
// moment. Reloading once there swaps the page onto the new build.
//
// The guard matters: controllerchange also fires the first time a worker ever
// claims an uncontrolled page, and on some browsers more than once per update.
// Without it this is a reload loop.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("SW registration failed", e));
  });

  // Only reload for a worker replacing an existing one. A first-ever install has
  // no previous controller and its JavaScript is already the newest there is.
  if (navigator.serviceWorker.controller) {
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
  }
}
