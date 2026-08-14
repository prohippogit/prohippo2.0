/*
 * Vite config for the deck's screenshot harness.
 *
 *   npx vite --config pitch/screens/vite.config.js
 *
 * Identical to the app's own config except that the five Firebase SDK entry
 * points resolve to the stubs in ./stubs. Nothing under src/ is aliased,
 * replaced or conditionally compiled — the screens in the deck are the screens
 * in the app.
 */
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const at = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: at("../.."),
  plugins: [react()],
  resolve: {
    alias: {
      "@": at("../../src"),
      "firebase/app": at("./stubs/app.js"),
      "firebase/auth": at("./stubs/auth.js"),
      "firebase/firestore": at("./stubs/firestore.js"),
      "firebase/functions": at("./stubs/functions.js"),
      "firebase/storage": at("./stubs/storage.js"),
    },
  },
  server: { port: 5178, strictPort: true },
});
