/* ProHippo — client message templates.
 *
 * Pure functions: (request, assessee, profile) in, rendered strings out. The
 * composer renders here for the live preview and STORES the result on the
 * request; `sendClientMessage` then delivers exactly what was stored. That is
 * deliberate — it means the practitioner's preview is byte-for-byte what the
 * client receives, and there is no second copy of these templates on the
 * server to drift out of sync.
 *
 * THE SENTENCES ARE DATA, BECAUSE THEY GET TRANSLATED.
 *
 * Every fixed sentence lives in PHRASES below with SLOTS in it — "Namaste
 * {name}," — and the renderers fill the slots. A translated message is the same
 * renderers over a different phrase bundle, so the HTML skeleton, the ordering
 * and the escaping are identical in every language and a model never touches
 * markup. See functions/messageTranslation.js for what is never sent to it.
 */
// The pure formatters, NOT shared.jsx: this module must stay importable without
// a bundler so its output can be tested directly.
import { titleCase, fmtDateLong } from './formatters.js';

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/* One line describing the proceeding the request arises from, e.g.
   "Scrutiny assessment u/s 143(2) · AY 2021-22". Every part is optional —
   whatever is on file gets used, nothing is invented. */
export const proceedingLine = (req) =>
  [
    req.authority ? `${req.authority}${req.section ? ` u/s ${req.section}` : ""}` : (req.section ? `u/s ${req.section}` : ""),
    req.ay ? `AY ${req.ay}` : "",
  ].filter(Boolean).join(" · ");

/* Every fixed sentence of a document request, with its slots.
 *
 * WHAT IS A SLOT AND WHAT IS NOT. A slot holds something a translator must
 * never see, let alone rewrite: the client's name, the proceeding
 * ("Scrutiny u/s 142(1) · AY 2020-21"), the DIN, a date, the firm. The words
 * around them are ordinary prose and get translated. Word order moves between
 * languages — English puts the proceeding before the noun, Gujarati after it —
 * so the model places the slot and the app fills it.
 *
 * Keys are the contract with functions/messageTranslation.js; a phrase added
 * here is translated automatically, and one renamed silently stops being.
 */
export const PHRASES = {
  subject: "Documents required — {proceeding}",
  subjectPlain: "Documents required",
  greeting: "Namaste {name},",
  intro: "We have received a notice in your {proceeding} matter{din}.",
  introPlain: "We have received a notice in your matter{din}.",
  needOne: "To prepare the reply we need the following document:",
  needMany: "To prepare the reply we need the following {count} documents:",
  ifAvailable: "(if available)",
  dueBy: "Please send these by {date} so we have time to prepare and file the reply.",
  howToTitle: "How to send them",
  /* How the client should send things back.
   *
   * This is not a stylistic preference — the Income-tax portal accepts PDF only,
   * capped at 5 MB per file. A client who WhatsApps twelve photos has produced
   * nothing filable, and someone in the firm then spends an evening converting
   * them. Asking for the right format once, in the request itself, is the whole
   * saving. The phone-scan hint matters too: most clients own a scanner and
   * don't know it.
   *
   * PDF, Scan, Files, Notes and Google Drive stay in English in every language:
   * the client has to find those on their own phone, where they are in English. */
  howToBody:
    "Please send each document as a PDF file, under 5 MB. The Income-tax portal accepts PDFs only, so photos can't be filed as they are — if you only have photos, your phone can turn them into a PDF (the Scan option in Files, Notes or Google Drive).",
  replyEmail: "Just reply to this email with the PDFs attached.",
  replyWhatsApp: "You can reply to this message with the PDFs attached.",
  sentVia: "Sent via",
  onBehalfOf: "on behalf of {firm}. Reply to this email to reach them directly.",
};

/* Fill the slots. Values are inserted verbatim — they are the parts that must
   not change — and a slot with nothing for it collapses to empty rather than
   printing its own name at a client. */
const fill = (phrase, values = {}) =>
  String(phrase || "").replace(/\{([a-zA-Z]+)\}/g, (_, k) => (values[k] === undefined || values[k] === null ? "" : String(values[k])));

/* The bundle a render uses: the translation's phrases where there is one, the
   English above where there is not. A translation missing a key falls back to
   English for that key alone rather than failing the whole letter. */
const bundleFor = (translation) =>
  translation && translation.phrases ? { ...PHRASES, ...translation.phrases } : PHRASES;

export const defaultTitle = (req) => {
  const tail = proceedingLine(req);
  return tail ? fill(PHRASES.subject, { proceeding: tail }) : PHRASES.subjectPlain;
};

// Only items still outstanding are worth asking for again.
const askableItems = (req) => (req.items || []).filter((i) => i.status !== "received" && i.status !== "waived");

/* The document names to print: the translated ones when they line up with the
   list, the practitioner's own otherwise. Length is the guard — an item added
   after translating must never be silently dropped or mismatched, and the
   composer's stale warning is what tells them to translate again. */
function labelsFor(items, translation) {
  const t = translation && Array.isArray(translation.items) ? translation.items : null;
  if (!t || t.length !== items.length) return items.map((i) => i.label);
  return t;
}

const noteFor = (req, translation) =>
  (translation && translation.note) ? translation.note : (req.note || "");

/* Brand mark shown at the foot of the email.
 *
 * Served from prohippo.in — the address the product actually goes by, and the
 * one a recipient checking the sender will recognise. Firebase's default
 * domains stay live behind it, so prohippo2.web.app remains a working fallback
 * if the custom domain is ever detached from Hosting. */
const LOGO_URL = "https://prohippo.in/prohippo-logo.png";

const signOff = (profile) => {
  const who = (profile?.ownerName || "").trim();
  const firm = (profile?.firmName || "").trim();
  if (who && firm) return `${who}\n${firm}`;
  return who || firm || "";
};

/* ---------------- plain text (WhatsApp, and the email's text part) ---------------- */

function renderText(req, assessee, profile, { forWhatsApp, translation }) {
  const t = bundleFor(translation);
  const items = askableItems(req);
  const labels = labelsFor(items, translation);
  const note = noteFor(req, translation);
  const lines = [];

  const name = titleCase(assessee?.name || req.assessee || "");
  lines.push(fill(t.greeting, { name }).trim());
  lines.push("");

  const proc = proceedingLine(req);
  const din = req.din ? ` (DIN ${req.din})` : "";
  lines.push(proc ? fill(t.intro, { proceeding: proc, din }) : fill(t.introPlain, { din }));
  lines.push("");
  lines.push(items.length === 1 ? t.needOne : fill(t.needMany, { count: items.length }));
  lines.push("");
  items.forEach((it, i) => {
    // WhatsApp renders *text* as bold; plain email text keeps it clean.
    const label = forWhatsApp ? `*${labels[i]}*` : labels[i];
    lines.push(`${i + 1}. ${label}${it.required === false ? ` ${t.ifAvailable}` : ""}`);
    if (it.note) lines.push(`   ${it.note}`);
  });

  if (req.dueDate) {
    lines.push("");
    lines.push(fill(t.dueBy, { date: fmtDateLong(req.dueDate) }));
  }
  if (note) {
    lines.push("");
    lines.push(note);
  }

  lines.push("");
  lines.push(forWhatsApp ? `*${t.howToTitle}*` : t.howToTitle);
  lines.push(t.howToBody);
  lines.push("");
  lines.push(forWhatsApp ? t.replyWhatsApp : t.replyEmail);
  const sig = signOff(profile);
  if (sig) {
    lines.push("");
    lines.push(sig);
  }
  return lines.join("\n");
}

/* ---------------- email HTML ---------------- */

function renderHtml(req, assessee, profile, { translation } = {}) {
  const t = bundleFor(translation);
  const items = askableItems(req);
  const labels = labelsFor(items, translation);
  const note = noteFor(req, translation);
  const proc = proceedingLine(req);
  const firm = (profile?.firmName || "").trim();
  // Monospaced, because a DIN is read back character by character.
  const dinHtml = req.din
    ? ` (DIN <span style="font-family:ui-monospace,Menlo,monospace;font-size:12.5px;">${esc(req.din)}</span>)`
    : "";

  /* The English "how to send" paragraph carries inline emphasis on the two
     things clients get wrong — the format and the size. A translated sentence
     is one string with no way to say where the bold went, so it renders plain
     inside the same box. Keeping the English path byte-identical matters more
     than matching it: nothing changes for the clients already receiving it. */
  const howToHtml = translation
    ? esc(t.howToBody)
    : `Please send each document as a <b style="color:#2A1B4A;">PDF file, under 5&nbsp;MB</b>. The Income-tax portal accepts PDFs only, so photos can't be filed as they are — if you only have photos, your phone can turn them into a PDF (the <b style="color:#2A1B4A;">Scan</b> option in Files, Notes or Google&nbsp;Drive).`;

  const rows = items.map((it, i) => `
        <tr>
          <td style="padding:9px 0;vertical-align:top;width:26px;font-size:13px;font-weight:700;color:#6C5CE7;">${i + 1}.</td>
          <td style="padding:9px 0;vertical-align:top;font-size:14px;color:#2A1B4A;line-height:1.5;">
            ${esc(labels[i])}${it.required === false ? ` <span style="color:#9A93AD;font-size:12px;">${esc(t.ifAvailable)}</span>` : ""}
            ${it.note ? `<div style="font-size:12.5px;color:#6B6480;margin-top:3px;">${esc(it.note)}</div>` : ""}
          </td>
        </tr>`).join("");

  return `<!doctype html><html><body style="margin:0;background:#F7F6FB;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F6FB;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #ECE9F5;border-radius:16px;padding:32px;">
        <tr><td style="font-weight:800;font-size:18px;color:#2A1B4A;letter-spacing:-0.02em;">${esc(firm || "ProHippo")}</td></tr>
        <tr><td style="padding-top:22px;font-size:15px;color:#2A1B4A;font-weight:700;">${esc(fill(t.greeting, { name: titleCase(assessee?.name || req.assessee || "") }))}</td></tr>
        <tr><td style="padding-top:12px;font-size:14px;color:#6B6480;line-height:1.6;">
          ${proc
            ? fill(esc(t.intro), { proceeding: `<b style="color:#2A1B4A;">${esc(proc)}</b>`, din: dinHtml })
            : fill(esc(t.introPlain), { din: dinHtml })}
          ${esc(items.length === 1 ? t.needOne : fill(t.needMany, { count: items.length }))}
        </td></tr>
        <tr><td style="padding-top:18px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F9F8FD;border:1px solid #ECE9F5;border-radius:12px;padding:8px 18px;">
            ${rows}
          </table>
        </td></tr>
        ${req.dueDate ? `<tr><td style="padding-top:20px;">
          <div style="background:#F3F0FB;border-radius:10px;padding:12px 14px;font-size:13.5px;color:#2A1B4A;">
            ${fill(esc(t.dueBy), { date: `<b>${esc(fmtDateLong(req.dueDate))}</b>` })}
          </div>
        </td></tr>` : ""}
        ${note ? `<tr><td style="padding-top:18px;font-size:13.5px;color:#6B6480;line-height:1.6;">${esc(note).replace(/\n/g, "<br>")}</td></tr>` : ""}
        <tr><td style="padding-top:20px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F0FB;border-radius:10px;padding:14px 16px;">
            <tr><td style="font-size:13px;font-weight:800;color:#2A1B4A;padding-bottom:6px;">${esc(t.howToTitle)}</td></tr>
            <tr><td style="font-size:13px;color:#6B6480;line-height:1.6;">
              ${howToHtml}
            </td></tr>
            <tr><td style="font-size:13px;color:#6B6480;line-height:1.6;padding-top:8px;">
              ${esc(t.replyEmail)}
            </td></tr>
          </table>
        </td></tr>
        ${signOff(profile) ? `<tr><td style="padding-top:22px;font-size:13.5px;color:#2A1B4A;line-height:1.6;">${esc(signOff(profile)).replace(/\n/g, "<br>")}</td></tr>` : ""}
        <tr><td style="padding-top:22px;border-top:1px solid #ECE9F5;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="font-size:11px;color:#9A93AD;line-height:1.5;padding-right:8px;vertical-align:middle;">${esc(t.sentVia)}</td>
            <td style="vertical-align:middle;">
              <a href="https://prohippo.in" style="text-decoration:none;">
                <img src="${LOGO_URL}" alt="ProHippo" width="73" height="36" style="display:block;border:0;outline:none;width:73px;height:36px;"/>
              </a>
            </td>
          </tr></table>
          <div style="padding-top:8px;font-size:11px;color:#9A93AD;line-height:1.5;">
            ${fill(esc(t.onBehalfOf), { firm: esc(firm || "your tax practitioner") })}
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

/* ---------------- the one entry point ---------------- */

/**
 * The one entry point.
 *
 * @param translation  a stored translation (functions/messageTranslation.js), or
 *                     null for English. Passing one swaps the phrase bundle and
 *                     the document names; NOTHING else about the render changes,
 *                     which is what keeps every language's letter identical in
 *                     structure and escaping.
 */
export function renderDocRequest({ request, assessee, profile, translation = null }) {
  const req = request || {};
  const t = bundleFor(translation);
  /* A practitioner who typed their own subject keeps it — it is their words, in
     whatever language they chose to write them, and overwriting it with a
     translation of the default would lose them. */
  const proc = proceedingLine(req);
  const subject = (req.title || "").trim()
    || (proc ? fill(t.subject, { proceeding: proc }) : t.subjectPlain);
  return {
    subject,
    emailHtml: renderHtml(req, assessee, profile, { translation }),
    emailText: renderText(req, assessee, profile, { forWhatsApp: false, translation }),
    whatsappText: renderText(req, assessee, profile, { forWhatsApp: true, translation }),
    language: translation?.language || "en",
  };
}

// wa.me deep link for a rendered request. Returns null when there's no mobile
// on file, so the caller can say so rather than opening a broken tab.
export function whatsappLink(assessee, text) {
  const digits = (assessee?.mobile || "").replace(/\D/g, "");
  if (!digits) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
