# Pitch deck

`ProHippo-Pitch-Deck.pdf` — 39 slides, 16:9, covering every feature and screen in
the app, the navigation path through each page, and the case for why a practice
needs this now.

## Rebuilding it

```bash
node pitch/build-pitch-pdf.mjs
```

The deck is written as ordinary HTML (`prohippo-pitch.html`) and printed by the
Chromium already on the machine — no new dependency, and no design tool in the
loop. Edit the HTML, re-run the command, and the PDF is regenerated from it.

`prohippo-pitch.html` carries three placeholder tokens — `__FONT_WOFF2__`,
`__LOGO_PNG__`, `__MARK_PNG__` — rather than megabytes of inlined base64, so a
change to a sentence shows up in a diff as a change to that sentence. The build
script substitutes the real assets into a temporary copy before printing.

If Chromium is somewhere unusual, point at it:

```bash
CHROMIUM_BIN=/path/to/chrome node pitch/build-pitch-pdf.mjs
```

## What is in it

| Slides | |
|---|---|
| 1–5 | The case: what faceless assessment changed, how matters are lost today, and the two limitation regimes running side by side from 1 April 2026 |
| 6–8 | The product: the notice → appeal journey, and the four surfaces it runs on |
| 9–25 | Navigation: every sidebar destination, the eight assessee-profile tabs, and every facility on each page |
| 26–34 | The machinery: portal sync, the Connector, WhatsApp, Calendar, ITAT mail, the voice line, Computation of Income, the AI boundary, security, the admin console |
| 35–39 | Why now, who it is for, what it replaces, and the roadmap |

## A note on the numbers

The deck deliberately contains **no market-size or adoption statistics**. Every
factual claim in it is either a statement about what the code does or a
statement of law that can be checked against the Act. If the pitch needs
market figures, add them to slides 3 and 36 from a source you can cite —
they were left out rather than estimated.
