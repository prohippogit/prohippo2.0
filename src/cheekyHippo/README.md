# CheekyHippoProgress 🦛

A mascot-driven progress card for the Income-tax portal fetch. Purely
presentational — the parent owns the fetch; this component just narrates it
with cheeky, tax-flavoured copy and honest progress.

## Files
| File | Purpose |
| --- | --- |
| `CheekyHippoProgress.jsx` | The component (default export). |
| `hippoLines.js` | All mascot copy + the line-selection helpers. Edit copy here. |
| `pickRandom.js` | `pickNoRepeat()` — no-repeat random picker (pure, testable). |
| `pickRandom.test.mjs` | Zero-dep tests: `node src/cheekyHippo/pickRandom.test.mjs`. |
| `cheekyHippo.css` | Styles, reusing the app's `--p-*` tokens. |
| `CheekyHippoProgress.demo.jsx` | Simulates the full lifecycle for preview. |

## Two honest phases
- **Phase A** (`authenticating` / `fetchingList` / `processing`): indeterminate
  slider bar + rotating lines, `aria-busy`, **no fake %**.
- **Phase B** (`downloading`, once `totalPdfs` is known): real determinate bar
  from `downloadedCount / totalPdfs`, with a count-up "X of N".

Then a brief `done` state, plus `empty` and `error` (error always shows Retry).

## Usage
```jsx
import CheekyHippoProgress from "./cheekyHippo/CheekyHippoProgress.jsx";

<CheekyHippoProgress
  phase={phase}                 // FetchPhase
  totalPdfs={totalPdfs}         // known once the notice list returns
  downloadedCount={downloaded}  // increments during 'downloading'
  noticeCounts={{ penalty: 3, reassessment: 2 }}  // optional, smarter copy
  currentFileName={currentFile} // optional
  errorMessage={err}            // optional
  onRetry={() => launch("sync")}
/>
```

## Preview
Temporarily render the demo from `App.jsx`:
```jsx
import CheekyHippoDemo from "./cheekyHippo/CheekyHippoProgress.demo.jsx";
// ...render <CheekyHippoDemo /> anywhere.
```

## Wiring to the real fetch
See the block comment at the top of `CheekyHippoProgress.jsx` — it maps the
extension's streamed messages (`portalSync.js` / `portalIngest.js`) to each
prop (proceedings → `totalPdfs`, each `notice` → `downloadedCount++`, etc.).

Accessibility: `role="progressbar"` with `aria-valuenow/min/max` in Phase B,
`aria-busy` in Phase A, a debounced `aria-live="polite"` status line, and full
`prefers-reduced-motion` support.
