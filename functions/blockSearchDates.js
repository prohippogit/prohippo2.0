/*
 * Shaping what a language model read out of a search case's documents.
 *
 * Its own module, and CommonJS like everything else in functions/, so it can be
 * run by `node --test` without Firebase. That is the whole point: the network
 * call in index.js cannot be tested here, and this — the half where a bad read
 * turns into a bad block period — can.
 *
 * WHAT IS AT STAKE. s.158B(b) builds the block period out of two dates: when
 * the search was initiated, and when the last of the authorisations was
 * executed. One day either side of 31 March moves the whole block by a year and
 * changes which of Part C's two mutually exclusive tables applies. So this is
 * deliberately suspicious of what it is handed, and throws away more than it
 * keeps.
 */
"use strict";

/* Chapter XIV-B applies to searches initiated on or after 01-09-2024, so a
   "search date" before 2024 is a misread of something else on the page — an
   assessment year, a date of incorporation, a demand from an earlier year. The
   window is wider than the regime to leave room for a document that states a
   date oddly, and still narrow enough to catch the common misreads. */
const EARLIEST = "2024-01-01";
const LATEST = "2100-01-01";

/** YYYY-MM-DD, or "" for anything that is not a date in the window. */
function saneDate(v, normDate) {
  const d = normDate(v);
  if (!d) return "";
  return d >= EARLIEST && d <= LATEST ? d : "";
}

/**
 * @param raw       what the model returned
 * @param normDate  the caller's date normaliser (functions/index.js owns it)
 * @param now       ISO timestamp, injectable so a test can pin it
 */
function normaliseSearchDates(raw, normDate, now) {
  const r = raw && typeof raw === "object" ? raw : {};
  const initiationDate = saneDate(r.initiationDate, normDate);
  let lastAuthorisationDate = saneDate(r.lastAuthorisationDate, normDate);

  /* A search cannot conclude before it began. Where the read says otherwise the
     PAIR is untrustworthy, not just the later one — but the initiation date is
     the one the six preceding years hang off and is usually the better read of
     the two, so it survives and the conclusion is dropped. The block period
     then falls back to the same-day case, which is the shorter of the two
     shapes and never the one that invents a year of assessment. */
  if (lastAuthorisationDate && initiationDate && lastAuthorisationDate < initiationDate) lastAuthorisationDate = "";

  const panchnamaDates = [...new Set(
    (Array.isArray(r.panchnamaDates) ? r.panchnamaDates : []).map((v) => saneDate(v, normDate)).filter(Boolean)
  )].sort().slice(0, 20);

  const quotes = r.quotes && typeof r.quotes === "object" ? r.quotes : {};
  const quote = (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : "");

  return {
    initiationDate,
    lastAuthorisationDate,
    panchnamaDates,
    searchSection: ["132", "132A"].includes(String(r.searchSection || "").trim()) ? String(r.searchSection).trim() : "",
    /* Kept beside every date, because these two decide seven years of
       assessment and a date offered without the sentence it came from cannot be
       checked against the document. */
    quotes: {
      initiationDate: quote(quotes.initiationDate),
      lastAuthorisationDate: quote(quotes.lastAuthorisationDate),
    },
    at: now || new Date().toISOString(),
  };
}

module.exports = { normaliseSearchDates, EARLIEST, LATEST };
