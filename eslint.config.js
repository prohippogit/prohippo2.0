import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // `functions/shared` is src/ copied in by scripts/build-functions-shared.mjs
  // at deploy time. Linting it reports every finding in those files twice, and
  // under the wrong rules besides — it is ESM inside a CommonJS directory. The
  // originals in src/ are linted normally, which is where a fix would go anyway.
  globalIgnores(['dist', 'functions/shared']),
  {
    // Cloud Functions run on Node (CommonJS), not in the browser.
    files: ['functions/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
      sourceType: 'commonjs',
    },
  },
  {
    // The connector's Electron MAIN process is Node (CommonJS) — without this
    // block every require/module in it was reported as an undefined global,
    // which drowned out real findings and made `npm run lint` unusable there.
    //
    // Browser globals are in scope too, and legitimately: several of these
    // modules define functions that Playwright serialises and runs INSIDE the
    // page (portalLogin's tickInPage, portalApi's fetch helpers), so `document`
    // and `window` are real there even though the file itself runs in Node.
    files: ['connector/src/main/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      sourceType: 'commonjs',
    },
  },
  {
    // The connector's renderer is an ordinary browser script talking to the
    // preload bridge on `window.connector`. The window loads two scripts, so
    // `SyncStatus` — the list's grouping and stall rules, defined in
    // syncStatus.js — is a real global by the time renderer.js runs.
    files: ['connector/src/renderer/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { ...globals.browser, SyncStatus: 'readonly' },
      sourceType: 'script',
    },
  },
  {
    // ...and syncStatus.js itself is loaded BOTH ways: as that plain <script>,
    // and as a CommonJS module by test/connectorSyncStatus.test.mjs, which is
    // the whole reason those rules live in a file of their own rather than
    // inside the renderer where they cannot be tested.
    files: ['connector/src/renderer/syncStatus.js'],
    languageOptions: {
      // 'off' because this is the file that DEFINES SyncStatus — declaring the
      // same name the other renderer files borrow would be a redeclaration.
      globals: { ...globals.browser, module: 'readonly', SyncStatus: 'off' },
    },
  },
  {
    // Browser-extension scripts run in the extension/content-script world:
    // browser globals plus the WebExtension `chrome.*` API.
    files: ['extension/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { ...globals.browser, ...globals.webextensions },
    },
  },
  {
    files: ['**/*.{js,jsx}'],
    ignores: ['functions/**', 'extension/**', 'connector/**'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
])
