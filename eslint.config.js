import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
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
    // preload bridge on `window.connector`.
    files: ['connector/src/renderer/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.browser,
      sourceType: 'script',
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
