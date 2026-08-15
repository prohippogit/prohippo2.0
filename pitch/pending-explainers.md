# Seven explainer panels — generated art still outstanding

Seven slides are meant to carry a mascot explainer panel of their own, in the
style of the eight journey panels on slide 7. **The slide layout for all seven
is written and measured; the pictures themselves do not exist yet.**

The layout lives in `pending-explainers.patch` rather than in
`prohippo-pitch.html`, because the moment those `__IMG:` tokens are in the deck
the build fails — `build-pitch-pdf.mjs` refuses to print a deck that references
a missing image, which is the right behaviour and not worth weakening for a
half-finished change. Applying the patch and generating the art are therefore
one job, not two.

## Why the art is missing

The images were to be generated with Higgsfield against
`src/assets/landing/features/03-whatsapp-alert.webp` as the character and style
reference. The session that was to do it could not reach Higgsfield: its egress
policy refused `upload.higgsfield.ai`, `higgsfield.ai` and
`d2ol7oe51mr4n9.cloudfront.net` (403 at CONNECT). That blocks both ends of the
job — the reference image cannot be uploaded, and finished renders cannot be
downloaded to be committed. The MCP tool channel itself worked; only the
container's own HTTPS egress was blocked.

A media record `959e9023-9e90-43a1-b21b-4a69e77a9388` was created on Higgsfield
before the failure. **It is empty** — the bytes never followed — so re-upload
from scratch rather than reusing that id.

## Finishing it

1. Upload the reference and confirm it:
   `media_upload` (filename `03-whatsapp-alert.webp`) → PUT the bytes of
   `src/assets/landing/features/03-whatsapp-alert.webp` to the presigned URL →
   `media_confirm` with type `image`. Keep the returned media id.
2. Generate the seven prompts below with `generate_image_batch`, one request per
   image, each with `aspect_ratio: "16:9"` and the reference passed as
   `medias: [{ role: "image", value: "<media id>" }]`.
   Model: **`nano_banana_pro`** — it takes a reference image, does 16:9, and
   holds a stylised 3D look. (`soul_2` also accepts a reference but is tuned for
   realistic portraiture, which is the wrong register for this set.) There is no
   unlimited-generation allowance on this account, so these are billed to
   credits.
3. Save each render into `pitch/assets/mascot/` under the filename in the table,
   as **JPEG, 640px wide, quality 0.82** — the same treatment
   `pitch/screens/optimise.mjs` gives the eight existing panels, and the size
   the slide actually uses.
4. `git apply pitch/pending-explainers.patch`, then delete this file and the
   patch.
5. `node pitch/build-pitch-pdf.mjs`, and check that no slide overflows (see
   *Checking overflow* below).

Note these seven have no `.webp` source under `src/assets/landing/features/`,
because they are deck illustrations rather than landing-page features.
`optimise.mjs` regenerates the first eight from that folder and will leave these
alone — which is correct, but means the 640px/0.82 conversion in step 3 is done
by hand.

## The seven

Every prompt is the shared style line plus its own subject. The slide numbers
are as the deck stands today.

**Shared style line** — prepend to each subject:

> 3D Pixar-style character illustration of a friendly hippopotamus in a navy
> business suit, matching the reference character exactly in face, build and
> costume. Lavender and violet monochrome palette, soft studio lighting,
> isometric props arranged on a pale lavender backdrop, glossy toy-like
> surfaces, clean and uncluttered. Absolutely no text, no lettering, no numerals
> and no signage anywhere in the image.

| # | Slide | File | Subject |
|---|---|---|---|
| a | 4 · *Five ways a matter is lost today* | `09-buried-in-folders.jpg` | The hippo as a tax professional at a desk, buried under hundreds of stacked client folders towering over and around him, only his head and shoulders showing above the pile, overwhelmed but game. |
| b | 5 · *From 1 April 2026, two limitation regimes* | `10-two-limitation-clocks.jpg` | The hippo standing between two large wall clocks of different designs, their hands set to visibly different positions, a distinct calendar block beneath each — the two clocks clearly disagreeing. |
| c | 35 · *The morning's notices, in before anyone sits down* | `11-overnight-sync.jpg` | A desktop computer glowing awake alone at night in an empty office, no one at the desk, documents flowing out of the screen and stacking themselves neatly into a document tray beside it. |
| d | 38 · *A colleague who knows the whole app, on the phone* | `12-voice-line.jpg` | The hippo wearing a telephone headset, one hand raised mid-explanation, answering a call at a tidy desk. |
| e | 39 · *A computation sheet, generated from the return as filed* | `13-computation-sheet.jpg` | The hippo holding up a crisp printed statement of computation towards the viewer, ruled rows and totals suggested as abstract lines and blocks only. |
| f | 40 · *Where AI is used — and where it deliberately is not* | `14-read-and-reckon.jpg` | The hippo holding a magnifying glass over an open document, a wooden abacus on the desk beside him — reading on one side, reckoning on the other. |
| g | 41 · *The security posture, stated plainly* | `15-vault.jpg` | The hippo standing guard in front of a closed bank vault door, arms folded, client file boxes secured behind it. |

Two things worth a decision before generating:

- **(a) is the only one whose brief says "a tax professional" rather than "the
  hippo".** It is written above as the hippo, so the set stays one character —
  the mascot already plays the practitioner in the eight journey panels. Render
  a human instead if the intent was to show the client-side pain.
- **(b) asks for two clocks "showing different dates", and the style line
  forbids lettering and numerals.** The prompt resolves this with clock hands
  and two distinct calendar blocks rather than legible dates. If the dates must
  actually read, relax the style line for this one image only.

## What the patch does

- Adds a `.slide.expl > .expl` rule: a 216px, 16:9, rounded panel pinned to the
  top-right of the slide, with a light-bordered variant for the dark slide, and
  a 890px cap on the headings of those slides.
- Adds `expl` to the seven `<section class="slide">` elements and a `<figure>`
  carrying the `__IMG:` token to each.

The panel is positioned rather than placed in the body on purpose. Every one of
these seven slides already sits within about 25px of its footer, so a picture in
the flow would push a sentence off the bottom — and slides are `overflow:
hidden`, so that loss is silent. Out of flow, the panels cost the layout
nothing: measured before and after, all seven keep the same ~25px of headroom,
and the deck stays at 0 overflowing slides. The heading cap exists because the
longest of the seven titles is 884px and the panel's left edge is at x=1004; at
a tighter cap three of them take a second line and slide 4 has nowhere to put
one.

## Checking overflow

The deck clips rather than complains, so "it looked fine" is not a check. Print
the deck and measure each slide's content against its footer — comparing the
bottom of the lowest element in `.body` against the top of `.foot`, per slide.

Two traps, both of which produce a **false pass**:

- The inlined webface is applied a beat after the parser reaches the end of the
  body. Measure eagerly and you measure the fallback font, whose boxes are
  *larger* — which reports overflow that is not there — while a run that
  happens to measure post-swap reports the truth. Gate the measurement on
  `document.fonts.check("800 34px 'Plus Jakarta Sans'")`, retried on a timer,
  and fail loudly if the face never arrives. Under Chromium's
  `--virtual-time-budget`, awaiting `document.fonts.ready` never settles, so a
  retry loop is the way, not `await`.
- Screenshotting a slide at `--window-size=1280,720` does **not** give you a
  720px viewport — headless insets make it shorter, and the bottom of the slide
  is cut off in the picture while the layout itself is perfectly fine. Shoot
  taller than the slide and read the footer to confirm you have the whole thing.

The cover slide reports a spill of ~140px and always will: its decorative orbs
are positioned outside the slide box deliberately and clipped by it. Exempt it
rather than chasing it.
