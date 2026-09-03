/* The layout of a downloaded proceeding.
 *
 * These are the rules a practitioner's case folder depends on: one folder per
 * notice, in the order the proceeding happened, with the reply filed against
 * that notice inside its folder — and nothing dropped without the index saying
 * so. Every one of them is a silent failure if it breaks: the zip downloads,
 * opens, and is quietly wrong. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planProceedingBundle, proceedingFileCount, bundleFolderName, noticeLabel, isoDay } from "../src/proceedingBundle.js";

const matter = {
  id: "m1", type: "Scrutiny", ay: "2024-25", pan: "AIQPC6674E", status: "Active",
  ref: "Assessment Proceeding u/s 143(3)", section: "143(3)", proceedingReqId: "p1",
};

const notices = [
  {
    id: "n2", date: "2024-11-30", isOrder: true, section: "143(3)", authority: "Scrutiny",
    subject: "Assessment order", storagePath: "u/1/order.pdf", fileName: "order us 143(3).pdf",
    contentType: "application/pdf",
  },
  {
    id: "n1", date: "2024-08-12", section: "142(1)", subject: "Notice u/s 142(1)",
    storagePath: "u/1/notice.pdf", fileName: "70000_2024_AST_AIQPC6674E_Notice us 142(1)_10879_12082024.pdf",
    contentType: "application/pdf", docsTotal: 3,
    attachments: [{ storagePath: "u/1/annex.pdf", filename: "70000_2024_AST_Annexure to notice_10880_12082024.pdf", contentType: "application/pdf" }],
    responses: [
      {
        responseId: "r1", respType: "Partial response", submittedOn: "2024-09-02T10:00:00Z",
        remarks: "Details furnished as called for.",
        attachments: [
          { storagePath: "u/1/resp1.pdf", filename: "reply.pdf", label: "Submission" },
          { filename: "bank statement.pdf", label: "Bank statement" },
        ],
      },
    ],
  },
];

const plan = () => planProceedingBundle({ matter, notices, assesseeName: "Shraddha Rahul Mehta", now: new Date("2026-09-03T00:00:00Z") });

test("the root folder carries the identity so the files inside need not", () => {
  assert.equal(bundleFolderName(matter, "Shraddha Rahul Mehta"), "Shraddha Rahul Mehta - AY 2024-25 - Assessment Proceeding u-s 143(3)");
  assert.equal(plan().fileName, "Shraddha Rahul Mehta - AY 2024-25 - Assessment Proceeding u-s 143(3).zip");
});

test("one folder per notice, oldest first and numbered so a file manager agrees", () => {
  const folders = [...new Set(plan().files.map((f) => f.path.split("/")[1]))];
  assert.deepEqual(folders, [
    "01 2024-08-12 Notice u-s 142(1)",
    "02 2024-11-30 Assessment order u-s 143(3)",
  ]);
});

test("the notice, its enclosure and the reply filed against it land together", () => {
  const paths = plan().files.map((f) => f.path.split("/").slice(1).join("/"));
  assert.deepEqual(paths, [
    "01 2024-08-12 Notice u-s 142(1)/Notice u-s 142(1).pdf",
    "01 2024-08-12 Notice u-s 142(1)/Annexure to notice.pdf",
    "01 2024-08-12 Notice u-s 142(1)/Reply - 2024-09-02/Submission.pdf",
    "02 2024-11-30 Assessment order u-s 143(3)/Assessment order u-s 143(3).pdf",
  ]);
});

test("remarks typed into the portal are written out — often they ARE the reply", () => {
  const remarks = plan().texts.find((t) => t.path.endsWith("Remarks.txt"));
  assert.ok(remarks, "no remarks file");
  assert.match(remarks.path, /01 2024-08-12 Notice u-s 142\(1\)\/Reply - 2024-09-02\/Remarks\.txt$/);
  assert.match(remarks.text, /Details furnished as called for\./);
  assert.match(remarks.text, /Partial response filed on 2024-09-02/);
});

test("a reply with only remarks still gets its folder", () => {
  const p = planProceedingBundle({
    matter,
    notices: [{ id: "n", date: "2024-08-12", section: "142(1)", storagePath: "u/1/n.pdf", fileName: "n.pdf",
      responses: [{ remarks: "Adjournment sought.", submittedOn: "2024-08-20" }] }],
    assesseeName: "A B",
  });
  assert.equal(p.texts.length, 1);
  assert.match(p.texts[0].path, /Reply - 2024-08-20\/Remarks\.txt$/);
});

test("an empty reply row is not a reply — the portal returns those", () => {
  const p = planProceedingBundle({
    matter,
    notices: [{ id: "n", date: "2024-08-12", section: "142(1)", storagePath: "u/1/n.pdf",
      responses: [{ remarks: "   ", attachments: [] }, { remarks: "", attachments: [] }] }],
    assesseeName: "A B",
  });
  assert.equal(p.texts.length, 0);
  assert.equal(p.summary.replies, 0);
});

test("several replies against one notice are numbered and kept in filed order", () => {
  const p = planProceedingBundle({
    matter,
    notices: [{ id: "n", date: "2024-08-12", section: "142(1)", storagePath: "u/1/n.pdf", fileName: "n.pdf",
      responses: [
        { submittedOn: "2024-09-20", attachments: [{ storagePath: "b", filename: "second.pdf", label: "Further reply" }] },
        { submittedOn: "2024-09-02", attachments: [{ storagePath: "a", filename: "first.pdf", label: "Reply" }] },
      ] }],
    assesseeName: "A B",
  });
  // Filed order, not the order the portal happened to hand them over in.
  assert.deepEqual(p.files.map((f) => f.path.split("/").slice(2).join("/")), [
    "Notice u-s 142(1).pdf",
    "Reply 1 - 2024-09-02/Reply.pdf",
    "Reply 2 - 2024-09-20/Further reply.pdf",
  ]);
});

test("two documents with the same label do not overwrite each other", () => {
  const p = planProceedingBundle({
    matter,
    notices: [{ id: "n", date: "2024-08-12", section: "148", storagePath: "u/1/n.pdf", fileName: "Notice us 148.pdf",
      attachments: [
        { storagePath: "a", filename: "70000_2024_AST_Approval_1_12082024.pdf" },
        { storagePath: "b", filename: "70000_2024_AST_Approval_2_12082024.pdf" },
      ] }],
    assesseeName: "A B",
  });
  const names = p.files.map((f) => f.path.split("/").pop());
  assert.deepEqual(names, ["Notice u-s 148.pdf", "Approval.pdf", "Approval (2).pdf"]);
  assert.equal(new Set(p.files.map((f) => f.path)).size, p.files.length);
});

test("a compressed folder the department called .pdf is named for what it is", () => {
  const p = planProceedingBundle({
    matter,
    notices: [{ id: "n", date: "2024-08-12", section: "148", storagePath: "u/1/n.pdf", fileName: "Notice us 148.pdf",
      attachments: [{ storagePath: "a", filename: "ATTACHMENT.pdf", contentType: "application/x-zip-compressed" }] }],
    assesseeName: "A B",
  });
  assert.equal(p.files[1].path.split("/").pop(), "ATTACHMENT.zip");
});

test("the Form 35 grounds ride on the appeal record and still get in", () => {
  const p = planProceedingBundle({
    matter: { ...matter, type: "CIT(A)", ref: "Appeal to CIT(A)" },
    notices: [{ id: "f35", isAppealForm: true, date: "2025-01-10", storagePath: "u/1/form35.pdf", fileName: "form35.pdf",
      appeal: { attachments: [
        { storagePath: "g", filename: "grounds.pdf", label: "Grounds of appeal" },
        { storagePath: "s", filename: "sof.pdf", label: "Statement of facts" },
      ] } }],
    assesseeName: "A B",
  });
  assert.deepEqual(p.files.map((f) => f.path.split("/").pop()), [
    "Form 35 - Appeal to CIT(A).pdf", "Grounds of appeal.pdf", "Statement of facts.pdf",
  ]);
});

test("what the portal listed but never gave us is counted and said out loud", () => {
  const p = plan();
  // 3 listed on the s.142(1) notice against 2 held, plus one reply attachment
  // that has no storagePath.
  assert.equal(p.summary.missing, 2);
  assert.match(p.indexText, /2 files the portal listed could not be included/);
  assert.match(p.indexText, /! 1 file the portal lists on this notice was not fetched/);
  assert.match(p.indexText, /! 1 attachment on this reply was listed by the portal but not fetched/);
});

test("a notice with nothing behind it gets a line in the index, not an empty folder", () => {
  const p = planProceedingBundle({
    matter,
    notices: [{ id: "n", date: "2024-08-12", section: "142(1)", docsTotal: 2 }],
    assesseeName: "A B",
  });
  assert.equal(p.files.length, 0);
  assert.match(p.indexText, /nothing held for this notice yet/);
  assert.equal(p.summary.missing, 2);
});

test("the index names the proceeding, the client and every file in it", () => {
  const text = plan().indexText;
  assert.match(text, /^PROCEEDING — Assessment Proceeding u\/s 143\(3\)/);
  assert.match(text, /Assessee\s+: Shraddha Rahul Mehta/);
  assert.match(text, /PAN\s+: AIQPC6674E/);
  assert.match(text, /A\.Y\.\s+: 2024-25/);
  assert.match(text, /Prepared\s+: 2026-09-03 — ProHippo/);
  assert.match(text, /2 notices\/orders {2}· {2}4 files {2}· {2}1 reply/);
  for (const f of plan().files) assert.ok(text.includes(f.path.split("/").pop()), `${f.path} missing from the index`);
});

test("a document with nothing said about it is still a PDF in the folder", () => {
  const p = planProceedingBundle({
    matter,
    notices: [{ id: "n", date: "2024-08-12", section: "142(1)", storagePath: "u/1/n.pdf",
      responses: [{ submittedOn: "2024-09-02", attachments: [{ storagePath: "a", label: "Submission" }] }] }],
    assesseeName: "A B",
  });
  assert.deepEqual(p.files.map((f) => f.path.split("/").pop()), ["Notice u-s 142(1).pdf", "Submission.pdf"]);
});

test("proceedingFileCount counts what would actually be zipped", () => {
  assert.equal(proceedingFileCount(notices), 4);
  assert.equal(proceedingFileCount([]), 0);
  assert.equal(proceedingFileCount([{ id: "manual" }]), 0);
});

test("a notice is labelled the way a practitioner says it out loud", () => {
  assert.equal(noticeLabel({ section: "142(1)" }), "Notice u-s 142(1)");
  assert.equal(noticeLabel({ isOrder: true, section: "143(3)", authority: "Scrutiny" }), "Assessment order u-s 143(3)");
  assert.equal(noticeLabel({ isAppealForm: true }), "Form 35 - Appeal to CIT(A)");
  assert.equal(noticeLabel({ subject: "Show cause notice" }), "Show cause notice");
  assert.equal(noticeLabel({}), "Notice");
});

/* The closure-order download hands over the order with its computation sheet
   and its notice of demand — all three with no section and a subject that is
   nothing but ITBA's concatenated ids. Those three strings were the folder
   names, which is unreadable in the one place somebody is looking for the
   order. */
test("a closure-order bundle is named for what each document is", () => {
  const order = (subject) => noticeLabel({ isOrder: true, subject, fileName: `${subject}.pdf` });
  assert.equal(order("70000000139740433_179050140_2025_AST_AIQPC6674E_Computation Sheet_1086"), "Computation sheet");
  assert.equal(order("70000000139740396_179131965_2025_AST_AIQPC6674E_Order us 143(3)_108641"), "Assessment order u-s 143(3)");
  assert.equal(order("70000000139740422_179131973_2025_AST_AIQPC6674E_Demand Notice us 156_1"), "Demand notice");
});

test("a section on the document's own name is used when the record has none", () => {
  // Read off the name, never inherited from the matter: a s.271AAC penalty
  // notice inside a scrutiny proceeding would inherit the wrong one.
  assert.equal(noticeLabel({ isOrder: true, subject: "Penalty Order us 270A", authority: "Penalty" }), "Penalty order u-s 270A");
  assert.equal(noticeLabel({ isOrder: true, subject: "Order", authority: "Scrutiny" }), "Assessment order");
});

test("a notice with no section keeps its subject, with ITBA's ids stripped out", () => {
  assert.equal(
    noticeLabel({ subject: "70000000145843545_186446841_2025_AST_AIQPC6674E_Notice us 148_1087936850(1)_26032026" }),
    "Notice us 148"
  );
});

test("the outline is the folder as data — what the summary sheet draws", () => {
  const [first, second] = plan().outline;
  assert.deepEqual(
    { no: first.no, label: first.label, date: first.date, kind: first.kind, empty: first.empty },
    { no: "01", label: "Notice u-s 142(1)", date: "2024-08-12", kind: "notice", empty: false }
  );
  assert.deepEqual(first.files.map((f) => f.name), ["Notice u-s 142(1).pdf", "Annexure to notice.pdf"]);
  assert.equal(first.files[0].kind, "pdf");
  assert.equal(first.replies.length, 1);
  assert.deepEqual(first.replies[0].files.map((f) => f.name), ["Remarks.txt", "Submission.pdf"]);
  assert.equal(first.replies[0].on, "2024-09-02");
  assert.equal(first.missing, 1);
  assert.equal(second.kind, "order");
});

test("the header carries what the summary sheet's masthead needs", () => {
  assert.deepEqual(plan().header, {
    title: "Assessment Proceeding u/s 143(3)",
    assessee: "Shraddha Rahul Mehta",
    pan: "AIQPC6674E",
    type: "Scrutiny",
    ay: "2024-25",
    section: "143(3)",
    status: "Active",
    bench: "",
    prepared: "2026-09-03",
    notices: 2,
    files: 4,
    replies: 1,
    missing: 2,
  });
});

test("every file in the plan is named in the text fallback", () => {
  // The two are built from one outline; this is what keeps them saying the
  // same thing when only one of them is edited.
  const p = plan();
  for (const f of p.files) assert.ok(p.indexText.includes(f.path.split("/").pop()), `${f.path} missing from the text index`);
});

test("a date is a date whether it arrives as ISO, a datetime or portal epoch ms", () => {
  assert.equal(isoDay("2024-08-12"), "2024-08-12");
  assert.equal(isoDay("2024-08-12T09:30:00Z"), "2024-08-12");
  assert.equal(isoDay(1723420800000), "2024-08-12");
  assert.equal(isoDay("1723420800000"), "2024-08-12");
  assert.equal(isoDay(""), "");
  assert.equal(isoDay("not a date"), "");
});
