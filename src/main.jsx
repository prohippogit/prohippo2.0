import ReactDOM from 'react-dom/client';
import './app.css';
import './pwaInstall'; // capture beforeinstallprompt before React mounts
import App from './App';

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);

// PWA: register the service worker (production builds only, so dev stays uncached).
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("SW registration failed", e));
  });
}
