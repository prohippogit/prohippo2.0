/*
 * ProHippo — reading the Income Tax Appellate Tribunal's two emails.
 *
 * The Tribunal's e-filing portal sends exactly two templated messages from
 * no-reply@itat.nic.in, and between them they carry the whole life of a second
 * appeal:
 *
 *   • a Registration & Scrutiny Summary when an appeal is registered — the
 *     appeal number it was registered as, the PAN, the assessment year and the
 *     date of filing;
 *   • a Notice of Hearing when it is fixed — the appeal number, PAN, year, the
 *     hearing bench, the date, the time and the venue.
 *
 * Everything here is PURE: no Firestore, no network, no firebase-functions
 * import. That is what lets test/itatEmail.test.mjs run it against the real
 * messages from the repository's own test command, without a functions install
 * — and a parser that can only be exercised by posting mail at a live webhook
 * does not get tested. The plumbing that receives the mail and writes the matter
 * lives next door in itatEmail.js.
 *
 * These are machine-generated templates, so this is deterministic string work
 * and not a model read. That is the same line functions/index.js already draws:
 * the portal's own structured data wins, and Gemini is asked only about things a
 * PDF is the sole source of. It also fails closed — an email in a shape it does
 * not recognise comes back as `unrecognised` with empty fields, to be shown to a
 * practitioner, rather than as a half-filled guess. NIC templates do change.
 */
"use strict";

const crypto = require("node:crypto");

/* The mail domain the practice addresses live on.
 *
 * A DOMAIN OF ITS OWN, not a subdomain of prohippo.in. The MX record here points
 * at the inbound provider, and every address under it is a firehose pointed at a
 * public webhook — so it must not share a zone with the mail the product depends
 * on. prohippo.in carries the login emails Resend sends; a fat-fingered MX record
 * there would lock every practitioner out of the app, and that risk is not worth
 * running to save the price of a domain. Isolation by separate registration is
 * absolute in a way isolation by subdomain is not. */
const MAIL_DOMAIN = "prohippo.info";

/* Who we accept mail from. Anything else is dropped before it is written
   anywhere, which is what makes the promise on the client setup page true: if
   somebody points an over-broad forwarding rule at us, their personal mail is
   discarded rather than stored. Extending this to the department's own
   donotreply@incometax.gov.in is how CIT(A) mail joins the same pipeline. */
const ALLOWED_SENDERS = [/(^|[.@])itat\.nic\.in$/i];

/* Gmail's forwarding-verification mail. Not from the Tribunal, and it never
   becomes a matter — but it carries the code the practitioner (or their client)
   has to type back into Gmail, and that code is sent HERE rather than to them.
   Capturing it is what turns a phone call into a self-service setup. */
const GMAIL_CONFIRM_SENDERS = [/(^|[.@])google\.com$/i, /(^|[.@])gmail\.com$/i];

const MAX_BODY_CHARS = 200000;

/* ---------------------------------------------------------------------------
 * Pure helpers. No Firestore, no network — everything below this line is
 * exported as `helpers` and unit-tested against the real emails in
 * test/itatEmail.test.mjs. Keep it that way: a parser that can only be exercised
 * by sending mail through a live webhook does not get tested.
 * ------------------------------------------------------------------------- */

const clean = (v) => (typeof v === "string" ? v.trim() : "");

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const pad2 = (n) => String(n).padStart(2, "0");

/* "15-Sep-2026" and "2026-Sep-15" both mean the same day. The Tribunal uses the
   first in the body of a notice and the second in its subject line, so both
   have to resolve to the ISO date the rest of the app stores. */
function toISODate(value) {
  const s = clean(value);
  let m = /^(\d{1,2})[-/\s]([A-Za-z]{3,})[-/\s](\d{4})$/.exec(s);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    return mo ? `${m[3]}-${pad2(mo)}-${pad2(+m[1])}` : "";
  }
  m = /^(\d{4})[-/\s]([A-Za-z]{3,})[-/\s](\d{1,2})$/.exec(s);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    return mo ? `${m[1]}-${pad2(mo)}-${pad2(+m[3])}` : "";
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return "";
}

/* "10.30 a.m" → "10:30". The Tribunal writes the hour with a full stop and the
   meridiem with spaced full stops, so this is deliberately loose about both. */
function toISOTime(hour, minute, meridiem) {
  let h = Number(hour);
  const mm = Number(minute);
  if (!Number.isInteger(h) || !Number.isInteger(mm) || h > 23 || mm > 59) return "";
  const mer = clean(meridiem).replace(/[.\s]/g, "").toLowerCase();
  if (mer === "pm" && h < 12) h += 12;
  if (mer === "am" && h === 12) h = 0;
  return `${pad2(h)}:${pad2(mm)}`;
}

// "2014-2015" and "2014 - 15" are the same year the app stores as "2014-15".
function normaliseAy(value) {
  const m = /((?:19|20)\d{2})\s*[-–—]\s*(\d{2,4})/.exec(clean(value));
  if (!m) return "";
  const start = m[1];
  const end = m[2].length === 4 ? m[2].slice(2) : m[2].padStart(2, "0");
  return `${start}-${end}`;
}

/* Every way the Tribunal, the app and a practitioner write the same appeal
   number reduced to one string: "ITA No. 2635/Ahd/2026" and "ITA 2635/AHD/2026"
   are one appeal, and the derived document IDs depend on that being true —
   otherwise a re-sent email creates a second matter. */
const APPEAL_RE = /\b(ITA|C\.?O\.?|SA|MA|WTA|ITSSA)\s*(?:Nos?\.?\s*)?(\d{1,6})\s*\/\s*([A-Za-z]{2,5})\s*\/\s*(\d{4})\b/i;

function findAppealNo(text) {
  const m = APPEAL_RE.exec(clean(text));
  if (!m) return "";
  const type = m[1].replace(/\./g, "").toUpperCase();
  return `${type} ${Number(m[2])}/${m[3].toUpperCase()}/${m[4]}`;
}

// The same normalisation applied to whatever is already stored on a matter, so
// a hand-typed "ITA No. 1244/Ahd/2024" still matches an email about it.
const canonicalAppealNo = (value) => findAppealNo(value);

/* The bench code inside an appeal number names the city it sits at. Unknown
   codes fall through to the code itself rather than to nothing — a bench shown
   as "SMR" is still more use to a practitioner than a blank field. */
const BENCH_CITY = {
  AHD: "Ahmedabad", MUM: "Mumbai", DEL: "Delhi", KOL: "Kolkata", CHNY: "Chennai",
  CHE: "Chennai", MDS: "Chennai", BANG: "Bangalore", BLR: "Bangalore", HYD: "Hyderabad",
  PUN: "Pune", PN: "Pune", JP: "Jaipur", JPR: "Jaipur", LKW: "Lucknow", CHD: "Chandigarh",
  IND: "Indore", NAG: "Nagpur", PAT: "Patna", RJT: "Rajkot", SRT: "Surat", AGR: "Agra",
  ALLD: "Allahabad", ALL: "Allahabad", ASR: "Amritsar", AMR: "Amritsar", CTK: "Cuttack",
  GAU: "Guwahati", JAB: "Jabalpur", JODH: "Jodhpur", JOD: "Jodhpur", PNJ: "Panaji",
  RNC: "Ranchi", VIZ: "Visakhapatnam", VNS: "Varanasi", RPR: "Raipur", DDN: "Dehradun",
  SHI: "Shimla", BIL: "Bilaspur", CBE: "Coimbatore",
};

const benchCodeOf = (appealNo) => {
  const m = /\/([A-Z]{2,5})\//.exec(clean(appealNo).toUpperCase());
  return m ? m[1] : "";
};

/* How the app writes a bench on a hearing: "Ahmedabad 'D' Bench". The letter
   comes off the notice (Hearing Bench: D) and the city off the appeal number,
   because no single field carries both. */
function benchName(appealNo, benchLetter) {
  const code = benchCodeOf(appealNo);
  const city = BENCH_CITY[code] || code;
  const letter = clean(benchLetter).toUpperCase();
  if (!city) return letter ? `'${letter}' Bench` : "";
  return letter ? `${city} '${letter}' Bench` : `${city} Bench`;
}

/* The hearing notice arrives as an HTML table and Gmail forwards carry both
   parts, so the text half may be missing or may be the poorer of the two. This
   is not a general HTML parser — it turns a table into lines, because what the
   patterns below need is that "Hearing Bench: D" does not run into the address
   that follows it in the next cell. */
function plainTextOf(html) {
  return clean(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
    .replace(/<\/(td|th)>/gi, "   ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/* The body to run the patterns over: BOTH parts, not the better-looking one.
 *
 * A forward arrives as two alternatives — the Tribunal's HTML, and a plain-text
 * rendition the forwarding client generated from it. Preferring the text part
 * (which this did, whenever it ran past forty characters) throws the HTML away,
 * and Gmail's rendition of the notice's table is lossy in exactly the places
 * that matter: the assessment year, the bench letter and the case type sit in a
 * cell that can come through as nothing at all. The result is a card reporting
 * fields as missing that arrived perfectly well in the other part.
 *
 * Text first, so a message where both parts carry a field reads the same as it
 * always did; the HTML is appended as the place to look when the rendition lost
 * something. Capped, because a forwarded thread can be enormous and nothing we
 * look for is a hundred kilobytes in.
 */
function bodyTextOf({ text, html }) {
  const t = clean(text);
  const h = plainTextOf(html);
  const body = t && h && t !== h ? `${t}\n${h}` : t || h;
  return body.slice(0, MAX_BODY_CHARS);
}

const PAN_RE = /\b([A-Z]{5}\d{4}[A-Z])\b/;
const findPan = (text) => {
  const m = PAN_RE.exec(clean(text).toUpperCase());
  return m ? m[1] : "";
};

const findAy = (text) => {
  const m = /Assessment\s*Year\s*[:\s]\s*((?:19|20)\d{2}\s*[-–—]\s*\d{2,4})/i.exec(clean(text));
  return m ? normaliseAy(m[1]) : "";
};

/* Is this message from an address we accept anything from at all? Checked
   against the address inside a display-name form ("ITAT Online <no-reply@…>")
   as well as a bare one. */
function senderDomain(from) {
  const s = clean(from).toLowerCase();
  const m = /<([^>]+)>/.exec(s);
  const addr = m ? m[1] : s;
  const at = addr.lastIndexOf("@");
  return at === -1 ? "" : addr.slice(at + 1).trim();
}

const matchesAny = (domain, patterns) => Boolean(domain) && patterns.some((re) => re.test(domain));
const isTribunalSender = (from) => matchesAny(senderDomain(from), ALLOWED_SENDERS);
const isGmailConfirmSender = (from) => matchesAny(senderDomain(from), GMAIL_CONFIRM_SENDERS);

/* Gmail's forwarding confirmation, and the account that asked for it.
   The subject reads "(#123456789) Gmail Forwarding Confirmation - Receive Mail
   from someone@gmail.com", and the body repeats both. Reading the requesting
   address out is what lets the code be shown to the right person when several
   clients are setting up on the same day. */
function gmailConfirmation({ from, subject, text, html }) {
  if (!isGmailConfirmSender(from)) return null;
  const subj = clean(subject);
  const body = bodyTextOf({ text, html });
  if (!/forwarding\s+confirmation/i.test(subj) && !/confirmation\s+code/i.test(body)) return null;
  const code = (/\(#(\d{6,12})\)/.exec(subj) || /confirmation\s+code\s*[:\s]\s*(\d{6,12})/i.exec(body) || [])[1] || "";
  const requester = (/receive\s+mail\s+from\s+([^\s<>]+@[^\s<>,]+)/i.exec(`${subj}\n${body}`) || [])[1] || "";

  /* The same email also carries a one-click confirmation link, and it is the
     better of the two routes: where the code has to be found in Gmail's
     settings — which hides the box it goes in until the right word is clicked —
     the link completes the handshake on its own.

     Taken from the RAW parts rather than the flattened body, because the link
     lives in an href and flattening strips attributes along with the tags. */
  const raw = `${clean(text)} ${clean(html)}`.replace(/&amp;/gi, "&");
  const confirmUrl = (/https:\/\/mail[\w.-]*\.google\.com\/mail\/vf-[^\s"'<>)\]]+/i.exec(raw) || [])[0] || "";

  if (!code && !confirmUrl) return null;
  return { code, confirmUrl, requester: requester.toLowerCase().replace(/[.,;]$/, "") };
}

/* Which of the Tribunal's two messages this is. Decided from the subject first
   because both subjects are templated and unambiguous, then from the body, so a
   forward that mangles the subject line still classifies. */
function classify({ subject, body }) {
  const s = clean(subject);
  if (/registration\s*&?(amp;)?\s*scrutiny\s*summary/i.test(s) || /has\s+been\s+registered\s+as/i.test(body)) {
    return "registration";
  }
  if (/notice\s+of\s+hearing/i.test(s) || /fixed\s+for\s+hearing/i.test(body)) return "hearing";
  return "unrecognised";
}

function parseRegistration({ subject, body, html }) {
  const all = `${subject}\n${body}`;
  const appealNo = findAppealNo(all);
  // "filed by you in AAWPM8125C on 23-Jul-2026 for the Assessment Year 2014-15"
  const filedOn = toISODate((/\bon\s+(\d{1,2}-[A-Za-z]{3}-\d{4})\b/i.exec(body) || [])[1] || "");
  return {
    appealNo,
    pan: findPan(all),
    ay: findAy(all),
    filedOn,
    bench: benchName(appealNo, ""),
    /* Today's summary email opens "Dear Assessee" and names nobody, so this
       finds nothing and adds nothing. It is asked anyway because the two
       templates are maintained together: the day a party block appears here,
       the client's file opens from it without another release. */
    ...partiesOf(html),
  };
}

/* ---------------- who the parties are ----------------
 *
 * The notice lays the parties out in a two-column table: appellant on the left,
 * respondent on the right, with the words "Appellant" and "Respondent" as the
 * last row under them. Flattened into a line of text that interleaves beyond
 * recovery, which is why an earlier version of this file did not attempt it at
 * all and left the practitioner to pick the client from a list.
 *
 * Read as a TABLE it is perfectly tractable: find the row that labels the
 * columns, then look up the same column in the rows above it. That is the whole
 * trick, and it is worth doing because the name and address are what let a
 * client's file be opened from the email rather than typed.
 */
function tableRows(html) {
  const rows = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr;
  while ((tr = trRe.exec(clean(html))) !== null) {
    const cells = [];
    const cellRe = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let cell;
    while ((cell = cellRe.exec(tr[1])) !== null) cells.push(plainTextOf(cell[2]));
    if (cells.length) rows.push(cells);
  }
  return rows;
}

// The cells above the label carry the appeal's own particulars when the party
// block is short, and those are not somebody's name.
const NOT_A_PARTY = /Appeal\s*No|Assessment\s*Year|Permanent\s*Account|Hearing\s*Bench|Case\s*Type|आयकर|अपील/i;

function partiesOf(html) {
  const rows = tableRows(html);
  const labelAt = rows.findIndex((cells) => cells.some((c) => /^appellant$/i.test(clean(c))));
  if (labelAt < 1) return {};
  const col = rows[labelAt].findIndex((c) => /^appellant$/i.test(clean(c)));

  /* Two rows above at most: the Tribunal writes the name in one and the address
     in the next, or both in one cell separated by a line break. Either way the
     first line is the name and the rest is where they live. */
  const lines = [];
  for (let i = Math.max(0, labelAt - 2); i < labelAt; i++) {
    const cell = clean(rows[i][col] ?? rows[i][0] ?? "");
    if (!cell || NOT_A_PARTY.test(cell)) continue;
    lines.push(...cell.split("\n").map(clean).filter(Boolean));
  }
  if (!lines.length) return {};

  return {
    appellant: lines[0].slice(0, 120),
    appellantAddress: lines.slice(1).join(", ").slice(0, 300),
  };
}

/* What kind of person or body a PAN belongs to, from its fourth character.
   A rule of the Act rather than a guess — P for an individual, C for a company,
   and so on — so an assessee opened from an email starts out correctly typed
   instead of defaulting to Individual and being quietly wrong for a trust.

   The same table, and the same blank for a letter it does not cover, as
   entityFromPan() in src/AssesseeModal.jsx: a record opened from an email and
   one typed in by hand have to agree about what a PAN says, and the honest
   answer to G or J or L is nothing rather than a plausible wrong one. */
const PAN_HOLDER = {
  P: "Individual", C: "Company", H: "HUF", F: "Firm",
  A: "AOP/BOI", B: "AOP/BOI", T: "Trust",
};
const statusFromPan = (pan) => {
  const p = clean(pan).toUpperCase();
  if (!/^[A-Z]{4}/.test(p)) return "";
  return PAN_HOLDER[p.charAt(3)] || "";
};

function parseHearing({ subject, body, html }) {
  const all = `${subject}\n${body}`;
  const appealNo = findAppealNo(all);
  /* Both sit in bold in the notice, and a plain-text rendition leaves the
     emphasis behind as asterisks or underscores — "Hearing Bench: *D*". Skipped
     rather than treated as part of the value, which is why an otherwise perfect
     notice used to come through as a bench with no letter. */
  const benchLetter = (/Hearing\s*Bench\s*[:\s]\s*[*_]*([A-Z0-9]{1,4})\b/i.exec(body) || [])[1] || "";
  const caseType = (/Case\s*Type\s*[:\s]\s*[*_]*([A-Z]{2,8})\b/i.exec(body) || [])[1] || "";

  /* The date appears twice, in two formats: "Date of Hearing: 2026-Sep-15" in
     the subject and "on 15-Sep-2026 (Tue)" in the body. The body is preferred —
     it sits in the operative sentence — and the subject is the fallback for a
     forward that dropped the HTML part. */
  const bodyDate = (/\bon\s+(\d{1,2}-[A-Za-z]{3}-\d{4})\s*\(/i.exec(body)
    || /\bat\s+[\d.:]+\s*[ap]\.?\s?m\.?\s+on\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/i.exec(body) || [])[1] || "";
  const subjDate = (/Date\s+of\s+Hearing\s*[:\s]\s*(\d{4}-[A-Za-z]{3}-\d{1,2})/i.exec(subject) || [])[1] || "";
  const date = toISODate(bodyDate) || toISODate(subjDate);

  /* The time, and only the Tribunal's own.
   *
   * A forward puts its own header above the notice — "Date: Mon, 10 Aug 2026 at
   * 5:24 PM" — and a bare search for "at H:MM pm" finds that first and writes
   * the moment the email was sent into somebody's diary as the hearing time.
   * So the pattern is anchored to what the notice says around it: the time is
   * the one followed by "on <date>", or failing that the one inside the
   * "fixed for hearing" sentence. An unanchored match is not taken at all —
   * blank is a visible gap, a wrong time is not. */
  const t = /\bat\s*(\d{1,2})[.:](\d{2})\s*([ap]\.?\s?m)\.?\s+on\s+\d{1,2}-[A-Za-z]{3}-\d{4}/i.exec(body)
    || /fixed\s+for\s+hearing[\s\S]{0,400}?\bat\s*(\d{1,2})[.:](\d{2})\s*([ap]\.?\s?m)/i.exec(body);
  const time = t ? toISOTime(t[1], t[2], t[3]) : "";

  /* Where it will be heard. The sentence is "…fixed for hearing at <address> at
     10.30 a.m on 15-Sep-2026", so the venue is what sits between the two. */
  const venue = clean(
    (/fixed\s+for\s+hearing\s+at\s+([\s\S]{5,300}?)\s+at\s+\d{1,2}[.:]\d{2}\s*[ap]\.?\s?m/i.exec(body) || [])[1] || ""
  ).replace(/\s+/g, " ");

  const lastFixedOn = toISODate(
    (/Last\s+fixed\s+for\s+hearing\s+on\s*[:\s]\s*(\d{1,2}-[A-Za-z]{3}-\d{4})/i.exec(body) || [])[1] || ""
  );

  return {
    appealNo,
    pan: findPan(all),
    ay: findAy(all),
    date,
    time,
    bench: benchName(appealNo, benchLetter),
    benchLetter: clean(benchLetter).toUpperCase(),
    caseType: clean(caseType).toUpperCase(),
    venue,
    lastFixedOn,
    ...partiesOf(html),
  };
}

/* The one entry point: an inbound message in, a kind and its fields out.
 *
 * `kind` is one of registration | hearing | gmail-confirmation | unrecognised,
 * and the caller decides what to do with each. Nothing here throws on a message
 * it cannot read — an unrecognised email is a fact to record, not an error, and
 * the templates behind this WILL change one day. */
function parseItatEmail(msg) {
  const subject = clean(msg.subject);
  const body = bodyTextOf(msg);

  const confirm = gmailConfirmation(msg);
  if (confirm) return { kind: "gmail-confirmation", fields: confirm };

  if (!isTribunalSender(msg.from) && !isTribunalSender(msg.originalFrom)) {
    return { kind: "unrecognised", fields: {}, reason: "sender-not-allowed" };
  }

  const kind = classify({ subject, body });
  if (kind === "registration") return { kind, fields: parseRegistration({ subject, body, html: msg.html }) };
  if (kind === "hearing") return { kind, fields: parseHearing({ subject, body, html: msg.html }) };
  return { kind: "unrecognised", fields: {}, reason: "no-template-match" };
}

/* A forwarded message keeps the Tribunal's own From: when the forward was made
   by a rule, but an inline "forward" from a phone rewrites it to the person
   pressing the button. In that case the original sender is still quoted in the
   body, so find it there rather than rejecting mail a client kindly sent on. */
function originalSenderOf({ from, text, html }) {
  if (isTribunalSender(from)) return clean(from);
  const body = bodyTextOf({ text, html });
  const m = /From\s*:\s*[^\n<]*<?\s*([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+)\s*>?/i.exec(body.slice(0, 4000));
  return m && isTribunalSender(m[1]) ? m[1] : "";
}

// Which mailbox a rule-based forward travelled through. Gmail stamps this, and
// it is how a practice learns whose inbox is feeding it without being told.
function forwardedByOf(headers) {
  const h = clean(headers);
  const m = /^X-Forwarded-(?:For|To)\s*:\s*(.+)$/im.exec(h);
  if (!m) return "";
  const first = m[1].trim().split(/\s+/)[0] || "";
  return /@/.test(first) ? first.toLowerCase() : "";
}

const sha = (s, n = 24) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, n);

// Derived, not stored: a provider retry or a message forwarded by both the
// practitioner and their client resolves to the same document rather than to a
// second copy of the same hearing.
const messageKey = (msg) => sha(clean(msg.messageId) || `${clean(msg.from)}|${clean(msg.subject)}|${clean(msg.date)}`);
const matterIdFor = (appealNo) => `itat_${sha(canonicalAppealNo(appealNo), 20)}`;
const hearingIdFor = (appealNo, date) => `itath_${sha(`${canonicalAppealNo(appealNo)}|${date}`, 20)}`;

/* ---------------- the address a practice receives on ----------------
 *
 * ProHippo can mint one — <token>@MAIL_DOMAIN — but it cannot insist on it.
 * Whether a practice can have an address on its own domain at all is a decision
 * its mail provider makes: CloudMailin's free tier, for one, hands out an
 * address on cloudmailin.net and puts custom domains behind a paid plan. Paying
 * a monthly fee to change the words after the @ would be a poor trade for a
 * mailbox that receives a few dozen messages a month.
 *
 * So an address is whatever the practice tells us to expect, and the lookup is
 * keyed by the ADDRESS rather than by a token parsed out of one. That also
 * makes the feature provider-agnostic by construction — a Mailgun route or a
 * Postmark inbound address needs no code change to work.
 */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const normaliseAddress = (v) => clean(v).toLowerCase();

// The document id an address is registered under. Hashed rather than used raw:
// an address is a personal identifier, and a top-level collection keyed by
// plain addresses would leak the set of them to anyone who could guess an id.
const addressKey = (v) => sha(normaliseAddress(v), 32);

const isEmailAddress = (v) => /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(clean(v));

/* Every address in a recipients blob, de-duplicated, in the order found.
 *
 * The blob is deliberately everything a provider offered — envelope, To, Cc,
 * Delivered-To — because which of those carries the practice's address depends
 * on how the mail was forwarded, and a Gmail filter forward leaves To: pointing
 * somewhere else entirely. Most of what comes back belongs to nobody we know;
 * that is fine, they simply do not resolve. */
function emailAddressesIn(text) {
  const found = String(text || "").toLowerCase().match(EMAIL_RE) || [];
  return [...new Set(found)];
}

/* Matching an assessee by NAME is deliberately absent. Neither email carries
   the appellant's name in a field a pattern can trust — the hearing notice lays
   the parties out in a two-column table whose cells interleave once flattened,
   and the registration email carries the name only in its PDF attachment. Both
   messages do carry the PAN, every time, which is exact. A name match guessed
   out of interleaved table cells could quietly file an appeal against the wrong
   client, and that is worse than asking. It returns in phase 2 with the PDF,
   where the name sits in a labelled cell. */

/* ---------------------------------------------------------------------------
 * Normalising what the inbound provider posts.
 *
 * Providers disagree about the shape: Postmark posts JSON, SendGrid and Mailgun
 * post form fields, and a Cloudflare Email Worker posts whatever we make it
 * post. Rather than marry one of them, all three are flattened into the same
 * object, and the parser above never learns which is in front of it.
 * ------------------------------------------------------------------------- */

/* Every address the message might have been delivered to, as one string.
 *
 * This is the field the practice's alias is found in, and getting it from the
 * To: header alone would break the main case outright: when Gmail forwards by a
 * FILTER it leaves the original To: intact — still the practitioner's own
 * address — and puts ours only in the envelope. So the envelope recipient comes
 * first and everything else is kept beside it, because the alias only has to
 * appear SOMEWHERE in here to be found. */
const recipientsOf = (...values) => values.flat().filter(Boolean).map(String).join(" ");

/* CloudMailin's JSON: an `envelope`, a `headers` OBJECT, and the body split into
   `plain` and `html`. Nothing like Postmark's shape, so it gets its own reader.
   Header names are matched case- and punctuation-insensitively because
   CloudMailin offers two JSON formats — one keeps the header's original casing,
   the other lower-cases it and turns Message-ID into message_id — and which one
   an account is set to is not worth making the practice care about. */
function fromCloudMailin(b) {
  const h = b.headers || {};
  const flat = (v) => (Array.isArray(v) ? v.join(" ") : clean(v));
  const keys = Object.keys(h);
  const headerOf = (name) => {
    const want = name.toLowerCase().replace(/[-_]/g, "");
    const key = keys.find((k) => k.toLowerCase().replace(/[-_]/g, "") === want);
    return key ? flat(h[key]) : "";
  };
  const env = b.envelope || {};
  return {
    from: clean(env.from) || headerOf("From"),
    to: recipientsOf(env.to, env.recipients, headerOf("To"), headerOf("Cc"), headerOf("Delivered-To")),
    subject: headerOf("Subject"),
    text: clean(b.plain),
    html: clean(b.html),
    headers: keys.map((k) => `${k}: ${flat(h[k])}`).join("\n"),
    messageId: headerOf("Message-ID"),
    date: headerOf("Date"),
  };
}

/* Postmark-style JSON, the CloudMailin shape, and the plain object our own
   smoke test and a Cloudflare Worker would post. Told apart by structure rather
   than by a configured provider name: there is nothing to get out of step, and
   changing provider needs no redeploy. */
function fromJson(b) {
  if (b && b.envelope && (b.plain !== undefined || b.html !== undefined)) return fromCloudMailin(b);
  const headerList = Array.isArray(b.Headers) ? b.Headers : [];
  const headerText = headerList.map((h) => `${h.Name}: ${h.Value}`).join("\n");
  const headerOf = (name) => (headerList.find((h) => String(h.Name).toLowerCase() === name) || {}).Value || "";
  return {
    from: clean(b.from || b.From || b.FromFull?.Email),
    to: recipientsOf(b.OriginalRecipient, b.to, b.To, b.Cc, b.Bcc, headerOf("delivered-to")),
    subject: clean(b.subject || b.Subject),
    text: clean(b.text || b.TextBody),
    html: clean(b.html || b.HtmlBody),
    headers: clean(b.headers) || headerText,
    messageId: clean(b.messageId || b.MessageID || headerOf("message-id")),
    date: clean(b.date || b.Date || b.ReceivedAt || headerOf("date")),
  };
}

// SendGrid Inbound Parse / Mailgun field names, whether they arrive as
// multipart or urlencoded.
function fromForm(f) {
  const envelope = (() => {
    try { return JSON.parse(f.envelope || "{}"); } catch { return {}; }
  })();
  /* Mailgun posts `message-headers` as a JSON array of [name, value] pairs;
     SendGrid posts a raw header block. Flatten either into "Name: value" lines
     so one lookup serves both.

     This is not cosmetic. Without it the Message-ID is never found on a Mailgun
     delivery, and the dedupe key falls back to sender-plus-subject-plus-date —
     which still catches a provider retry, but is a weaker promise than the
     header the sender stamped precisely to identify the message. */
  const raw = clean(f.headers || f["message-headers"]);
  const headers = (() => {
    if (!raw.startsWith("[")) return raw;
    try {
      const pairs = JSON.parse(raw);
      return Array.isArray(pairs) ? pairs.map((p) => `${p[0]}: ${p[1]}`).join("\n") : raw;
    } catch { return raw; }
  })();
  const headerOf = (name) => (new RegExp(`^${name}\\s*:\\s*(.+)$`, "im").exec(headers) || [])[1] || "";
  return {
    from: clean(f.from || f.sender || envelope.from),
    to: recipientsOf(envelope.to, f.recipient, f.to, f.cc, headerOf("Delivered-To")),
    subject: clean(f.subject || f.Subject),
    text: clean(f.text || f["body-plain"] || f["stripped-text"]),
    html: clean(f.html || f["body-html"]),
    headers,
    messageId: clean(f["Message-Id"] || f["message-id"] || headerOf("Message-Id")),
    date: clean(f.date || headerOf("Date")),
  };
}

module.exports = {
  toISODate, toISOTime, normaliseAy, findAppealNo, canonicalAppealNo, benchName, benchCodeOf,
  plainTextOf, bodyTextOf, findPan, findAy, senderDomain, isTribunalSender, gmailConfirmation,
  classify, parseRegistration, parseHearing, parseItatEmail, originalSenderOf, forwardedByOf,
  messageKey, matterIdFor, hearingIdFor, MAIL_DOMAIN, recipientsOf, fromJson, fromForm,
  tableRows, partiesOf, statusFromPan,
  normaliseAddress, addressKey, isEmailAddress, emailAddressesIn,
};
