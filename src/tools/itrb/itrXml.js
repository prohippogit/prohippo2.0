/*
 * The ITR as XML — every year up to A.Y. 2020-21.
 *
 * WHY THIS EXISTS. The portal served returns as XML until the JSON schema came
 * in, so a block period reaching back seven years reaches back into the XML era
 * for its earliest rows. `declared.js` reads a JSON, the practitioner has an
 * XML, and the year that could not be filled was the oldest one in the block —
 * on a screen whose whole purpose is seven years at once.
 *
 * WHAT IT DOES, AND WHAT IT DOES NOT. It turns the XML into the same object the
 * JSON reader already takes, and stops. The tag names inside are ITD's own and
 * they are the SAME NAMES as the JSON keys — <ITRForm:TotalIncome> is
 * `TotalIncome`, <ITRForm:Salaries> is `Salaries` — because both are generated
 * from one schema. So there is no mapping table here to drift out of date: strip
 * the namespace, keep the shape, and every rule in declared.js, partA.js and
 * the rest applies unchanged to a 2020 return.
 *
 * NO AI, AND NOTHING GUESSED. This is the return itself, parsed. A figure that
 * comes out of here is the figure the assessee filed, to the rupee — which is
 * the whole reason to prefer it to reading an intimation about the return.
 *
 * WHY THE PARSER IS HERE RATHER THAN DOMParser. Two reasons, and the second is
 * the real one: `node --test` has no DOM, and a parser that cannot be tested
 * against a real return's shape is a parser nobody can trust with seven years of
 * somebody's assessment. The document is machine-generated, attribute-light and
 * well-formed, so what is needed is small.
 */

/** The five predefined entities, plus numeric character references. */
function decode(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Ampersand last, or "&amp;lt;" would decode twice.
    .replace(/&amp;/g, "&");
}

/** "ITRForm:TotalIncome" → "TotalIncome". The prefix is which schema declared
    the element; the name is the same one the JSON uses. */
const bare = (tag) => String(tag).split(":").pop();

/* Sibling elements of the same name become an array — schedules repeat rows,
   and a reader that kept only the last one would silently drop every capital
   gain but the final entry. A name seen once stays a plain value, because that
   is what the JSON does and every path in declared.js is written for it. */
function put(obj, key, value) {
  if (!(key in obj)) { obj[key] = value; return; }
  if (Array.isArray(obj[key])) { obj[key].push(value); return; }
  obj[key] = [obj[key], value];
}

/**
 * Parse an ITD return XML into the object shape the JSON reader takes.
 *
 * @param   text  the file's contents
 * @returns { ITR: { ITR2: {...} } } — or null if this is not an ITR XML
 *
 * Elements carrying only text become strings; `num()` in declared.js coerces
 * them, so "382060" and 382060 are the same answer. Elements with children
 * become objects. Attributes are dropped: ITD carries no return data in them,
 * only schema locations.
 */
export function parseItrXml(text) {
  const src = String(text || "");
  if (!/<[\w:]*ITR[\s>:]/.test(src)) return null;

  const stack = [];
  let root = null;
  let rootName = "";
  let i = 0;

  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) break;

    // Text between tags belongs to whatever element is open.
    if (lt > i && stack.length) {
      const chunk = src.slice(i, lt);
      if (chunk.trim()) stack[stack.length - 1].text += chunk;
    }

    if (src.startsWith("<!--", lt)) { i = src.indexOf("-->", lt); i = i < 0 ? src.length : i + 3; continue; }
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt);
      const body = src.slice(lt + 9, end < 0 ? src.length : end);
      if (stack.length) stack[stack.length - 1].text += body;
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    // <?xml ... ?> and <!DOCTYPE ...>
    if (src.startsWith("<?", lt) || src.startsWith("<!", lt)) {
      const end = src.indexOf(">", lt);
      i = end < 0 ? src.length : end + 1;
      continue;
    }

    const gt = src.indexOf(">", lt);
    if (gt < 0) break;
    const raw = src.slice(lt + 1, gt).trim();

    if (raw.startsWith("/")) {                                   // closing tag
      const done = stack.pop();
      if (!done) { i = gt + 1; continue; }
      const value = Object.keys(done.children).length ? done.children : decode(done.text).trim();
      if (stack.length) put(stack[stack.length - 1].children, done.name, value);
      else { root = value; rootName = done.name; }
      i = gt + 1;
      continue;
    }

    const selfClosing = raw.endsWith("/");
    const name = bare(raw.replace(/\/$/, "").split(/[\s/]/)[0]);
    if (selfClosing) {
      if (stack.length) put(stack[stack.length - 1].children, name, "");
      i = gt + 1;
      continue;
    }
    stack.push({ name, text: "", children: {} });
    i = gt + 1;
  }

  if (!rootName || !root || typeof root !== "object") return null;
  return { [rootName]: root };
}

/** Does this file look like an ITR XML rather than any other XML? */
export const looksLikeItrXml = (text) =>
  /^\s*<\?xml/i.test(String(text || "")) && /incometaxindiaefiling\.gov\.in|<[\w:]*ITR[\s>:]/.test(String(text || ""));
