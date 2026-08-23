/*
 * The embedded typefaces, on the CLIENT side — spec §14.
 *
 * WHY THE CLIENT CARRIES THEM AT ALL. The render function has its own copies
 * and fills the template's font slot with them, which is the tidier
 * arrangement and the one this shipped with. It has a failure mode with no
 * error in it: the browser and the functions deploy separately, and a document
 * built by a client the deployed function has never heard of comes back set in
 * whatever headless Chromium falls back to — which is nothing, because the
 * render container has no system fonts. Two curvy computations went out in
 * Liberation Sans that way, and nothing anywhere said why.
 *
 * A document that carries its own faces cannot be broken by a function that is
 * a version behind. The client fills the slot before it posts the HTML; the
 * server's `.replace(FONT_SLOT, …)` then finds nothing to replace and leaves
 * the document alone. The server's copies stay, for a client old enough to
 * leave the slot empty.
 *
 * WHY DYNAMIC IMPORT. Each family is ~40 KB of base64 and most sessions never
 * generate a computation. `import()` puts each in its own chunk, so a
 * practitioner downloads the one their theme is set in, once, at the moment
 * they press the button — and never the other one.
 */

/* Named one by one rather than built from the id, because a bundler cannot
   split what it cannot see: `import('./' + family + '.js')` makes Vite emit
   every file in the directory as a possible chunk and defeats the point. */
const LOADERS = {
  poppins: () => import("./poppins.js"),
  montserrat: () => import("./montserrat.js"),
};

/**
 * The @font-face block for one family, or "" if we do not embed it.
 *
 * Returning "" rather than throwing is deliberate: an unknown family means a
 * theme naming a face nobody generated, and the slot left empty is then filled
 * by the server exactly as it always was. A computation that fails to build
 * over a typeface would be the worse outcome by a distance.
 */
export async function loadFontFaceCss(family) {
  const load = LOADERS[String(family || "").trim().toLowerCase()];
  if (!load) return "";
  try {
    return (await load()).FONT_FACE_CSS;
  } catch {
    // A chunk that would not load. The page is still worth generating.
    return "";
  }
}

/** Which families this side can supply — used by the tests, not by the app. */
export const FONT_FAMILIES = Object.keys(LOADERS);
