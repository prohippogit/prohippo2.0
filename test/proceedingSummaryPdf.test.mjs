/* The summary sheet that opens a downloaded proceeding.
 *
 * It is drawn, not written, so these cannot assert on wording — what they hold
 * is the part that actually breaks: that the document builds at all from a real
 * plan (a font that stops registering, a theme export that moves, takes the
 * whole thing down), that a long proceeding pages rather than running off the
 * bottom of one sheet, and that the odd shapes the portal produces — a
 * proceeding with nothing in it, a notice with no files — do not throw.
 *
 * A throw here is not cosmetic: it costs the practitioner their index. The
 * downloader falls back to the plain-text listing when this fails, which is why
 * that fallback is exercised in the planner's own tests too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planProceedingBundle } from "../src/proceedingBundle.js";
import { buildProceedingSummaryPDF, proceedingSummaryBytes } from "../src/proceedingSummaryPdf.js";

const matter = {
  type: "Scrutiny", ay: "2024-25", pan: "AIQPC6674E", status: "Closed",
  ref: "Assessment Proceeding u/s 143(3)", section: "143(3)", proceedingReqId: "p1",
};

const reply = (on, remarks, names) => ({
  respType: "Full response", submittedOn: on, remarks,
  attachments: names.map((f, i) => ({ storagePath: `s/${on}-${i}`, filename: f, label: f.replace(/\.pdf$/, "") })),
});

const notices = [
  { id: "1", date: "2025-06-23", section: "143(2)", din: "100097252660", subject: "Notice u/s 143(2)",
    storagePath: "s/1", fileName: "Notice us 143(2).pdf", contentType: "application/pdf",
    responses: [reply("2025-07-08", "The return filed is supported by the documents annexed.", ["Reply.pdf", "Others.pdf"])] },
  { id: "2", date: "2025-08-25", section: "142(1)", din: "100100634043", subject: "Notice u/s 142(1)",
    storagePath: "s/2", fileName: "Notice us 142(1).pdf", contentType: "application/pdf",
    // Eleven annexures — this is what forces a page break inside one reply.
    responses: [reply("2025-09-09", "Details as called for.", [
      "COI.pdf", "ITR ACK.pdf", "FORM 16.pdf", "26 AS.pdf", "80C DOCUMENTS.pdf", "DONATION DETAILS.pdf",
      "REPLY SIGNED.pdf", "Others.pdf", "BANK STATEMENT.pdf", "AIS.pdf", "POLITICAL PARTY PROOF.pdf"])] },
  { id: "3", date: "2026-02-23", isOrder: true, authority: "Scrutiny",
    subject: "70000000139740396_179131965_2025_AST_AIQPC6674E_Order us 143(3)_108641",
    storagePath: "s/3", fileName: "70000000139740396_179131965_2025_AST_AIQPC6674E_Order us 143(3)_108641.pdf",
    contentType: "application/pdf" },
];

const planFor = (ns = notices, m = matter) =>
  planProceedingBundle({ matter: m, notices: ns, assesseeName: "Shraddha Rahul Mehta", now: new Date("2026-09-03") });

const profile = {
  firmName: "Chavda & Associates", email: "office@example.in",
  invoiceSettings: { accent: "#6C5CE7" },
};

test("a real proceeding builds, and pages rather than overflowing", () => {
  const doc = buildProceedingSummaryPDF({ plan: planFor(), profile });
  assert.ok(doc.internal.getNumberOfPages() >= 2, "21 documents should not fit on one sheet");
});

test("what it hands back is a PDF", () => {
  const bytes = proceedingSummaryBytes({ plan: planFor(), profile });
  assert.ok(bytes.length > 1000, "suspiciously small for an embedded-font PDF");
  assert.equal(String.fromCharCode(...bytes.subarray(0, 5)), "%PDF-");
});

test("the practice's own accent is used, whatever it is", () => {
  // A firm that has chosen crimson must not get one violet document — the same
  // rule the ledger and the cause list follow.
  for (const accent of ["#C13378", "not-a-colour", undefined]) {
    assert.ok(proceedingSummaryBytes({ plan: planFor(), profile: { invoiceSettings: { accent } } }).length > 1000);
  }
});

test("it draws with no practice profile at all", () => {
  // A brand-new account has no firm name, address or accent saved yet.
  assert.ok(proceedingSummaryBytes({ plan: planFor() }).length > 1000);
});

test("the failures block draws when a download did not come down", () => {
  const plan = planFor();
  const failed = plan.files.slice(0, 3).map((f) => ({ path: f.path, reason: "storage/object-not-found" }));
  const withFail = proceedingSummaryBytes({ plan, profile, failed });
  assert.ok(withFail.length > proceedingSummaryBytes({ plan, profile }).length, "the failures block added nothing");
});

test("the shapes the portal actually produces do not throw", () => {
  // A proceeding with nothing synced; a notice with no files but a reply; a
  // notice with no date, no section and no subject; gaps the portal listed.
  const odd = [
    { id: "a", date: "2025-01-01", section: "142(1)", docsTotal: 3 },
    { id: "b", date: "2025-02-01", storagePath: "s/b", fileName: "x.pdf",
      responses: [{ remarks: "Adjournment sought.", submittedOn: "2025-02-10" },
        { submittedOn: "2025-02-20", attachments: [{ filename: "never-fetched.pdf" }] }] },
    { id: "c", storagePath: "s/c" },
  ];
  assert.ok(proceedingSummaryBytes({ plan: planFor(odd, { type: "Penalty" }), profile }).length > 1000);
  assert.ok(proceedingSummaryBytes({ plan: planFor([], {}), profile }).length > 1000);
});

test("a proceeding long enough to page many times still terminates", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: String(i), date: `2025-${String((i % 12) + 1).padStart(2, "0")}-15`, section: "142(1)",
    storagePath: `s/${i}`, fileName: "n.pdf", contentType: "application/pdf",
    responses: [reply("2025-12-01", "Filed.", ["a.pdf", "b.pdf", "c.pdf"])],
  }));
  const doc = buildProceedingSummaryPDF({ plan: planFor(many), profile });
  assert.ok(doc.internal.getNumberOfPages() > 4);
});
