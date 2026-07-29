/* ProHippo — client message templates.
 *
 * Pure functions: (request, assessee, profile) in, rendered strings out. The
 * composer renders here for the live preview and STORES the result on the
 * request; `sendClientMessage` then delivers exactly what was stored. That is
 * deliberate — it means the practitioner's preview is byte-for-byte what the
 * client receives, and there is no second copy of these templates on the
 * server to drift out of sync.
 */
import { titleCase, fmtDateLong } from './shared';

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

export const defaultTitle = (req) => {
  const tail = proceedingLine(req);
  return tail ? `Documents required — ${tail}` : "Documents required";
};

// Only items still outstanding are worth asking for again.
const askableItems = (req) => (req.items || []).filter((i) => i.status !== "received" && i.status !== "waived");

/* How the client should send things back.
 *
 * This is not a stylistic preference — the Income-tax portal accepts PDF only,
 * capped at 5 MB per file. A client who WhatsApps twelve photos has produced
 * nothing filable, and someone in the firm then spends an evening converting
 * them. Asking for the right format once, in the request itself, is the whole
 * saving. The phone-scan hint matters too: most clients own a scanner and don't
 * know it. */
const HOW_TO_SEND_TEXT =
  "Please send each document as a PDF file, under 5 MB. The Income-tax portal accepts PDFs only, so photos can't be filed as they are — if you only have photos, your phone can turn them into a PDF (the Scan option in Files, Notes or Google Drive).";

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

function renderText(req, assessee, profile, { forWhatsApp }) {
  const items = askableItems(req);
  const lines = [];
  lines.push(`Namaste ${titleCase(assessee?.name || req.assessee || "")},`.trim());
  lines.push("");

  const proc = proceedingLine(req);
  lines.push(
    proc
      ? `We have received a notice in your ${proc} matter${req.din ? ` (DIN ${req.din})` : ""}.`
      : `We have received a notice in your matter${req.din ? ` (DIN ${req.din})` : ""}.`
  );
  lines.push("");
  lines.push(
    items.length === 1
      ? "To prepare the reply we need the following document:"
      : `To prepare the reply we need the following ${items.length} documents:`
  );
  lines.push("");
  items.forEach((it, i) => {
    // WhatsApp renders *text* as bold; plain email text keeps it clean.
    const label = forWhatsApp ? `*${it.label}*` : it.label;
    lines.push(`${i + 1}. ${label}${it.required === false ? " (if available)" : ""}`);
    if (it.note) lines.push(`   ${it.note}`);
  });

  if (req.dueDate) {
    lines.push("");
    lines.push(`Please send these by ${fmtDateLong(req.dueDate)} so we have time to prepare and file the reply.`);
  }
  if (req.note) {
    lines.push("");
    lines.push(req.note);
  }

  lines.push("");
  lines.push(forWhatsApp ? `*How to send them*` : "How to send them");
  lines.push(HOW_TO_SEND_TEXT);
  lines.push("");
  lines.push(forWhatsApp ? "You can reply to this message with the PDFs attached." : "Just reply to this email with the PDFs attached.");
  const sig = signOff(profile);
  if (sig) {
    lines.push("");
    lines.push(sig);
  }
  return lines.join("\n");
}

/* ---------------- email HTML ---------------- */

function renderHtml(req, assessee, profile) {
  const items = askableItems(req);
  const proc = proceedingLine(req);
  const firm = (profile?.firmName || "").trim();

  const rows = items.map((it, i) => `
        <tr>
          <td style="padding:9px 0;vertical-align:top;width:26px;font-size:13px;font-weight:700;color:#6C5CE7;">${i + 1}.</td>
          <td style="padding:9px 0;vertical-align:top;font-size:14px;color:#2A1B4A;line-height:1.5;">
            ${esc(it.label)}${it.required === false ? ' <span style="color:#9A93AD;font-size:12px;">(if available)</span>' : ""}
            ${it.note ? `<div style="font-size:12.5px;color:#6B6480;margin-top:3px;">${esc(it.note)}</div>` : ""}
          </td>
        </tr>`).join("");

  return `<!doctype html><html><body style="margin:0;background:#F7F6FB;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F6FB;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #ECE9F5;border-radius:16px;padding:32px;">
        <tr><td style="font-weight:800;font-size:18px;color:#2A1B4A;letter-spacing:-0.02em;">${esc(firm || "ProHippo")}</td></tr>
        <tr><td style="padding-top:22px;font-size:15px;color:#2A1B4A;font-weight:700;">Namaste ${esc(titleCase(assessee?.name || req.assessee || ""))},</td></tr>
        <tr><td style="padding-top:12px;font-size:14px;color:#6B6480;line-height:1.6;">
          We have received a notice in your ${proc ? `<b style="color:#2A1B4A;">${esc(proc)}</b>` : ""} matter${req.din ? ` (DIN <span style="font-family:ui-monospace,Menlo,monospace;font-size:12.5px;">${esc(req.din)}</span>)` : ""}.
          To prepare the reply we need the following ${items.length === 1 ? "document" : `${items.length} documents`}:
        </td></tr>
        <tr><td style="padding-top:18px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F9F8FD;border:1px solid #ECE9F5;border-radius:12px;padding:8px 18px;">
            ${rows}
          </table>
        </td></tr>
        ${req.dueDate ? `<tr><td style="padding-top:20px;">
          <div style="background:#F3F0FB;border-radius:10px;padding:12px 14px;font-size:13.5px;color:#2A1B4A;">
            Please send these by <b>${esc(fmtDateLong(req.dueDate))}</b> so we have time to prepare and file the reply.
          </div>
        </td></tr>` : ""}
        ${req.note ? `<tr><td style="padding-top:18px;font-size:13.5px;color:#6B6480;line-height:1.6;">${esc(req.note).replace(/\n/g, "<br>")}</td></tr>` : ""}
        <tr><td style="padding-top:20px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F0FB;border-radius:10px;padding:14px 16px;">
            <tr><td style="font-size:13px;font-weight:800;color:#2A1B4A;padding-bottom:6px;">How to send them</td></tr>
            <tr><td style="font-size:13px;color:#6B6480;line-height:1.6;">
              Please send each document as a <b style="color:#2A1B4A;">PDF file, under 5&nbsp;MB</b>. The Income-tax portal accepts PDFs only, so photos can't be filed as they are — if you only have photos, your phone can turn them into a PDF (the <b style="color:#2A1B4A;">Scan</b> option in Files, Notes or Google&nbsp;Drive).
            </td></tr>
            <tr><td style="font-size:13px;color:#6B6480;line-height:1.6;padding-top:8px;">
              Just reply to this email with the PDFs attached.
            </td></tr>
          </table>
        </td></tr>
        ${signOff(profile) ? `<tr><td style="padding-top:22px;font-size:13.5px;color:#2A1B4A;line-height:1.6;">${esc(signOff(profile)).replace(/\n/g, "<br>")}</td></tr>` : ""}
        <tr><td style="padding-top:22px;border-top:1px solid #ECE9F5;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="font-size:11px;color:#9A93AD;line-height:1.5;padding-right:8px;vertical-align:middle;">Sent via</td>
            <td style="vertical-align:middle;">
              <a href="https://prohippo.in" style="text-decoration:none;">
                <img src="${LOGO_URL}" alt="ProHippo" width="73" height="36" style="display:block;border:0;outline:none;width:73px;height:36px;"/>
              </a>
            </td>
          </tr></table>
          <div style="padding-top:8px;font-size:11px;color:#9A93AD;line-height:1.5;">
            on behalf of ${esc(firm || "your tax practitioner")}. Reply to this email to reach them directly.
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

/* ---------------- the one entry point ---------------- */

export function renderDocRequest({ request, assessee, profile }) {
  const req = request || {};
  const subject = (req.title || "").trim() || defaultTitle(req);
  return {
    subject,
    emailHtml: renderHtml(req, assessee, profile),
    emailText: renderText(req, assessee, profile, { forWhatsApp: false }),
    whatsappText: renderText(req, assessee, profile, { forWhatsApp: true }),
  };
}

// wa.me deep link for a rendered request. Returns null when there's no mobile
// on file, so the caller can say so rather than opening a broken tab.
export function whatsappLink(assessee, text) {
  const digits = (assessee?.mobile || "").replace(/\D/g, "");
  if (!digits) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
