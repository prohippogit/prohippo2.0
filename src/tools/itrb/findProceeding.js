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
  const matters = (data?.matters || []).filter((m) => samePan(m, PAN) && looksBlock(m));
  const proceedingIds = [...new Set(matters.map((m) => m.proceedingReqId).filter(Boolean))];

  const notices = (data?.notices || []).filter((n) => {
    if (!samePan(n, PAN)) return false;
    return looksBlock(n) || (n.proceedingReqId && proceedingIds.includes(n.proceedingReqId));
  });

  // Every file hanging off those notices — the notice PDF itself plus whatever
  // the department sent with it. This is what the reader will be given.
  const attachments = notices.flatMap((n) => [
    ...(n.storagePath ? [{ noticeId: n.id, storagePath: n.storagePath, filename: n.fileName || "Notice", primary: true }] : []),
    ...((n.attachments || []).filter((a) => a && a.storagePath).map((a) => ({
      noticeId: n.id, storagePath: a.storagePath, filename: a.filename || a.label || "Attachment", primary: false,
    }))),
  ]);

  return { matters, notices, attachments, proceedingIds };
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

/**
 * A sentence about what the scan found, for the practitioner to read before
 * anything is written into their draft.
 */
export function describeScan({ matters, notices, attachments }) {
  if (!notices.length && !matters.length) return "Nothing on file for this PAN under s.158BC or s.158BD.";
  const bits = [];
  if (matters.length) bits.push(`${matters.length} proceeding${matters.length === 1 ? "" : "s"}`);
  bits.push(`${notices.length} notice${notices.length === 1 ? "" : "s"}`);
  if (attachments.length) bits.push(`${attachments.length} document${attachments.length === 1 ? "" : "s"}`);
  return `Found ${bits.join(", ")} under Matters for this PAN.`;
}
