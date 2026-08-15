# Pitch deck

`ProHippo-Pitch-Deck.pdf` — 47 slides, 16:9, covering every feature and screen
in the app, the navigation path through each page, and the case for why a
practice needs this now. Illustrated throughout with **screenshots of the
running application** and the ProHippo mascot's explainer panels.

> **Outstanding:** seven further mascot explainer panels are specified and their
> slide layout is written and measured, but the art has not been generated.
> See `pending-explainers.md`.

## Rebuilding it

```bash
node pitch/build-pitch-pdf.mjs
```

The deck is written as ordinary HTML (`prohippo-pitch.html`) and printed by the
Chromium already on the machine — no new dependency, and no design tool in the
loop. Edit the HTML, re-run the command, and the PDF is regenerated from it.

Images are referenced as `__IMG:path__` tokens resolved against the repo root,
and the font and logos as `__FONT_WOFF2__` / `__LOGO_PNG__` / `__MARK_PNG__`.
The build inlines them into a temporary copy before printing, so the source
stays a file where a changed sentence reads as a changed sentence in the diff
rather than as a new megabyte of base64.

If Chromium is somewhere unusual, point at it:

```bash
CHROMIUM_BIN=/path/to/chrome node pitch/build-pitch-pdf.mjs
```

## Re-photographing the app

The screenshots are not mockups and not stored art — they are the real app,
driven by a browser and captured from its own components. To retake them after
a UI change:

```bash
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-save playwright
npx vite --config pitch/screens/vite.config.js    # terminal 1
node pitch/screens/capture.mjs                    # terminal 2
node pitch/screens/optimise.mjs
node pitch/build-pitch-pdf.mjs
```

`pitch/screens/` holds that harness:

| | |
|---|---|
| `vite.config.js` | the app's own config, with the five `firebase/*` entry points aliased to stubs |
| `stubs/` | stand-ins for the Firebase SDK — Firestore resolves reads against the seed, Auth reports a signed-in user, callables reject |
| `seed.js` | the practice the deck is photographed against: the app's own `buildSampleData()` plus orders, returns and groups so Appeals, Returns and Intimations have something to show |
| `capture.mjs` | drives the real app through every screen and writes `shots/*.png` |
| `optimise.mjs` | resizes those, and the mascot panels, into deck-sized JPEGs under `pitch/assets/` |

**Nothing under `src/` is stubbed, forked or conditionally compiled for this.**
Only the SDK underneath the app is replaced, so the screens in the deck are the
screens in the app — a harness that reimplemented them would photograph the
harness. Every name, PAN and figure in `seed.js` is invented.

`shots/` is git-ignored (13 MB of 2880px originals); the deck-sized copies in
`pitch/assets/` are committed.

## What is in it

| Slides | |
|---|---|
| 1–5 | The case: what faceless assessment changed, how matters are lost today, and the two limitation regimes running side by side from 1 April 2026 |
| 6–9 | The product: the notice → appeal journey in mascot panels, the four surfaces, the public page and the app on a phone |
| 10–35 | Navigation: every sidebar destination and every facility on it, each major page paired with a screenshot of itself |
| 36–42 | The machinery: portal sync, the Connector, WhatsApp, Calendar, ITAT mail, the voice line, Computation of Income, the AI boundary, security, the admin console |
| 43–47 | Why now, who it is for, what it replaces, and the roadmap |

## A note on the numbers

The deck deliberately contains **no market-size or adoption statistics**. Every
factual claim in it is either a statement about what the code does or a
statement of law that can be checked against the Act. If the pitch needs
market figures, add them to slides 3 and 43 from a source you can cite —
they were left out rather than estimated.
