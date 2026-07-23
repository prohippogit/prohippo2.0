// Loads the static Form 35 pdfweb template (f35-template.js) for use in Node.
//
// f35-template.js is the extension's content-script file: a single statement
// `window.__PH_F35 = { shape, list, childData }`. We run it with a tiny window
// shim and return the object — no browser needed. It's our own file (captured
// from a real request, assessee-independent), so executing it is safe.
"use strict";

const fs = require("fs");
const path = require("path");

let cached = null;

function loadF35Template() {
  if (cached) return cached;
  const src = fs.readFileSync(path.join(__dirname, "f35-template.js"), "utf8");
  const window = {};
  // eslint-disable-next-line no-new-func
  new Function("window", src)(window); // assigns window.__PH_F35
  cached = window.__PH_F35 || null;
  return cached;
}

module.exports = { loadF35Template };
