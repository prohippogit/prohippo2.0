/* Where the ProHippo Sync extension comes from, and which version this build of
   the app expects. Kept out of ExtensionDownload.jsx so plain values can be
   imported without dragging a React component behind them.

   The version is read from the extension's own manifest at build time — there
   is deliberately no second copy of the number to forget to bump. */
import manifest from '../extension/manifest.json';

export const EXTENSION_VERSION = manifest.version;

// Built by scripts/build-extension-zip.mjs into public/ on every dev/build run,
// so it is served from our own origin: no release URL to go stale, and nothing
// for a corporate proxy or ad blocker to refuse.
export const EXTENSION_ZIP_URL = "/prohippo-sync-extension.zip";

// The folder someone is left holding after they unzip it — named in the install
// steps, because it is what they have to pick in Chrome's "Load unpacked".
export const EXTENSION_FOLDER = "prohippo-sync-extension";
