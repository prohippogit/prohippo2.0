/*
 * Finding the block assessment proceeding the practice already holds.
 *
 * A search case does not arrive in this app as an ITR-B draft. It arrives as a
 * proceeding under Matters, with the s.158BC notice in it, its attachments
 * beside it, and — once the portal sync has run — the DIN, the notice date, the
 * date it was served and the period the Assessing Officer allowed all recorded
 * against it. Every one of those is a Part A field, and every one of them was
 * being typed a second time.
 *
 * WHAT THIS MODULE DOES AND DOES NOT DO. It searches, matches and reports. It
 * reads nothing out of a PDF: the two dates that actually fix the block period
 * — when the search was initiated and when the last authorisation was executed
 * — are in the prose of the notice and nowhere in any record, so they are the
 * business of readBlockSearchDates (functions/index.js) and of nothing here.
 * The split matters: what this file returns is as reliable as the portal sync
 * that produced it, and what comes back from the reader is as reliable as a
 * language model reading a scan. Those two things should not arrive looking
 * alike.
 *
 * CONFLICTS ARE REPORTED, NEVER RESOLVED. Where two notices in the same
 * proceeding disagree about a DIN or a date, this says so and fills nothing.
 * A block return runs on a sixty-day clock off the date of service; quietly
 * picking one of two dates is how that clock ends up wrong with nobody looking.
 */

/** s.158BC, or s.158BC read with s.158BD. Tolerant of the spacing the portal uses. */
export const isBlockSection = (s) => /158\s*B\s*[CD]/i.test(String(s || ""));

/** Does this record belong to a block assessment at all? */
const looksBlock = (r) =>
  isBlockSection(r?.section)
  || isBlockSection(r?.subject)
  || /block\s+assessment|search\s+assessment/i.test(String(r?.type || ""))
  || /chapter\s*xiv-?b/i.test(`${r?.subject || ""} ${r?.type || ""}`);

const samePan = (r, pan) => pan && String(r?.pan || "").toUpperCase() === pan;

/**
 * Everything the practice holds for this assessee's block assessment.
 *
 * @param data  the app's store — { matters, notices }
 * @param pan   the assessee's PAN
 * @returns { matters, notices, attachments, proceedingIds }
 *
 * Notices are matched on the PAN AND on belonging to a block proceeding, rather
 * than on the proceeding alone: a s.158BC notice keyed in by hand never got a
 * proceedingReqId, and those are exactly the cases where nothing else in the
 * app has the details either.
 */
export function findBlockProceedings(data, pan) {
  const PAN = String(pan || "").toUpperCase();
  const allMatters = (data?.matters || []).filter((m) => samePan(m, PAN));
  const allNotices = (data?.notices || []).filter((n) => samePan(n, PAN));

  /* A PROCEEDING IS A BLOCK PROCEEDING IF ANYTHING IN IT IS UNDER s.158BC.
   *
   * This used to work only from the MATTER's own type and section, which is how
   * a real proceeding came back holding one notice out of four. The department
   * runs a block assessment inside a proceeding the portal has typed "Scrutiny",
   * with the s.158BC notice sitting alongside three notices u/s 142(1) calling
   * for the material — and it is one of THOSE that carries the ZIP with the
   * panchnama in it. Typing the container is the portal's business and it does
   * it loosely; what the notices are under is a fact.
   *
   * So the proceeding is identified from the notices as well as the matters,
   * and then everything sharing that proceeding is in scope whatever section it
   * is under. */
  const proceedingIds = [...new Set([
    ...allMatters.filter(looksBlock).map((m) => m.proceedingReqId),
    ...allNotices.filter(looksBlock).map((n) => n.proceedingReqId),
  ].filter(Boolean))];

  const inScope = (r) => looksBlock(r) || (r.proceedingReqId && proceedingIds.includes(r.proceedingReqId));
  const matters = allMatters.filter(inScope);
  const notices = allNotices.filter(inScope);

  // Every file hanging off those notices — the notice PDF itself plus whatever
  // the department sent with it. This is what the reader will be given.
  const attachments = notices.flatMap((n) => [
    ...(n.storagePath ? [{ noticeId: n.id, storagePath: n.storagePath, filename: n.fileName || "Notice", primary: true }] : []),
    ...((n.attachments || []).filter((a) => a && a.storagePath).map((a) => ({
      noticeId: n.id, storagePath: a.storagePath, filename: a.filename || a.label || "Attachment", primary: false,
    }))),
  ]);

  const replies = searchDocsInReplies(notices);

  return { matters, notices, attachments, replies, proceedingIds };
}

/* Search documents inside the replies the practice has already filed.
 *
 * THE PANCHNAMA IS OFTEN NOT WHAT THE DEPARTMENT SENT — IT IS WHAT WE SENT
 * BACK. It is handed over at the conclusion of the search, scanned, and then
 * uploaded to the portal as an annexure to the reply to a s.142(1) notice. On a
 * real proceeding it sat there, under a filed response, while the reader was
 * being told there was nothing to read.
 *
 * MATCHED BY NAME, NOT READ WHOLESALE. A reply carries the client's ledgers,
 * bank statements and confirmations — dozens of files, none of which can state
 * when a search was authorised. Sending all of them would cost a great deal to
 * learn nothing, so only the ones NAMED as search documents are read, and the
 * rest are counted in the manifest so a miss is visible rather than silent. */
/* Kept in step with functions/blockSearchDates.js, which is the authority — it
   decides what is actually sent to the reader; this only counts it on screen.
   A test asserts the two classify the same names the same way. */
export const isSearchDocName = (name) => /panch|warrant|authoris|authoriz|\b132\b|search\s*(&|and)?\s*seiz/i.test(String(name || ""));

export function searchDocsInReplies(notices) {
  const picked = [];
  let considered = 0;
  for (const n of notices || []) {
    for (const r of n.responses || []) {
      for (const a of r.attachments || []) {
        if (!a || !a.storagePath) continue;
        considered++;
        const name = `${a.label || ""} ${a.filename || ""}`;
        if (!isSearchDocName(name)) continue;
        picked.push({
          noticeId: n.id,
          storagePath: a.storagePath,
          filename: a.label || a.filename || "Reply attachment",
          filedOn: r.submittedOn || "",
        });
      }
    }
  }
  return { picked, considered, passedOver: considered - picked.length };
}

/* Which notice starts the block return.
 *
 * The one under s.158BC, earliest first — an assessee can receive several in a
 * block proceeding (a reminder, a further notice), and it is the first that
 * fixes the sixty days. A notice under s.158BD is taken only when there is no
 * s.158BC one, because 158BD is the limb, not the notice. */
export function primaryNotice(notices) {
  const dated = (notices || []).slice().sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  return dated.find((n) => /158\s*BC/i.test(String(n.section || n.subject || "")))
    || dated.find((n) => isBlockSection(n.section) || isBlockSection(n.subject))
    || null;
}

/* One field, gathered from every notice that states it.
 *
 * Returns { value, conflict, seen } — `seen` being the distinct values found,
 * so a disagreement can be shown rather than described. */
function gather(notices, read) {
  const seen = [...new Set((notices || []).map(read).filter((v) => v !== "" && v !== null && v !== undefined))];
  return { value: seen.length === 1 ? seen[0] : "", conflict: seen.length > 1, seen };
}

/**
 * The Part A fields the records already answer.
 *
 * @returns { fields, conflicts, source }
 *          `fields` is a draft patch — only the keys actually found.
 *          `conflicts` names the fields where the notices disagree and nothing
 *          was filled.
 */
export function fieldsFromNotices(notices) {
  const primary = primaryNotice(notices);
  if (!primary) return { fields: {}, conflicts: [], source: null };

  // Scoped to the notice that starts the return for DIN and dates: a reminder
  // carries its own DIN and its own date, and neither is the one Part A wants.
  const din = { value: primary.din || "", conflict: false, seen: [] };
  const noticeDate = { value: primary.date || "", conflict: false, seen: [] };

  /* Service and the period allowed are gathered across the proceeding, because
     the portal sometimes records them on the covering entry rather than on the
     notice itself — and there they must agree, or the sixty-day clock is a
     guess. */
  const service = gather(notices, (n) => n.servedOn || "");
  const dueDate = gather(notices, (n) => n.responseDueDate || "");

  const under158BD = /158\s*BD/i.test(`${primary.section || ""} ${primary.subject || ""}`);

  const fields = {};
  if (din.value) fields.noticeDin = din.value;
  if (noticeDate.value) fields.noticeDate = noticeDate.value;
  if (service.value) fields.serviceDate = service.value;
  if (dueDate.value) fields.dueDate = dueDate.value;
  fields.returnSection = under158BD ? "158BC/158BD" : "158BC";

  const conflicts = [];
  if (service.conflict) conflicts.push({ field: "Date of service", seen: service.seen });
  if (dueDate.conflict) conflicts.push({ field: "Due date", seen: dueDate.seen });

  return { fields, conflicts, source: primary };
}

/* Which notices to read, and in what order.
 *
 * EVERY notice on the proceeding that has a file, not just the one that starts
 * the return. The s.158BC notice calls for the return and usually states when
 * the search was initiated; the date it CONCLUDED is in the panchnama, which
 * arrives on its own entry — often a fortnight later, often as a ZIP. Reading
 * the first notice alone reads the one document least likely to answer the
 * question, which is exactly what it did the first time this ran.
 *
 * The notice that starts the return goes first all the same: the reader caches
 * its answer against the first id it is given, and that is the entry a
 * practitioner will look under afterwards.
 */
export function readingOrder({ notices, attachments, replies }) {
  const withFiles = new Set([
    ...(attachments || []).map((a) => a.noticeId),
    ...((replies?.picked) || []).map((a) => a.noticeId),
  ]);
  const ids = (notices || []).filter((n) => withFiles.has(n.id)).map((n) => n.id);
  const first = primaryNotice(notices)?.id;
  return first && ids.includes(first) ? [first, ...ids.filter((id) => id !== first)] : ids;
}

/**
 * A sentence about what the scan found, for the practitioner to read before
 * anything is written into their draft.
 */
export function describeScan({ matters, notices, attachments, replies }) {
  if (!notices.length && !matters.length) return "Nothing on file for this PAN under s.158BC or s.158BD.";
  const bits = [];
  if (matters.length) bits.push(`${matters.length} proceeding${matters.length === 1 ? "" : "s"}`);
  bits.push(`${notices.length} notice${notices.length === 1 ? "" : "s"}`);
  if (attachments.length) bits.push(`${attachments.length} document${attachments.length === 1 ? "" : "s"}`);
  const found = `Found ${bits.join(", ")} under Matters for this PAN.`;
  const picked = replies?.picked?.length || 0;
  if (!picked) return found;
  // Said out loud, because a document out of our OWN filed reply is not where a
  // practitioner expects the app to have been looking.
  return `${found} ${picked} search document${picked === 1 ? "" : "s"} also found in the replies already filed.`;
}
