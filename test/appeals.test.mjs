/* One assessment year, more than one order.
 *
 * A contested year does not hold one order. It holds the assessment and the
 * penalty that follows it; the set-aside and the fresh assessment made in its
 * place; the first-appeal order on the quantum and another on the penalty. The
 * appeals page used to match the evidence that an appeal had been taken against
 * PAN + AY alone, so the first step in a year answered for every order in it and
 * the newest order — the one whose limitation is actually running — never
 * appeared. These tests hold each order apart by its own date. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appealableOrders,
  appealRoute,
  appealedOrders,
  checklistFor,
  isAppealed,
} from "../src/appeals.js";

const PAN = "CUXPS9996L";
const AY = "2016-17";

let seq = 0;
const order = (o) => ({
  id: `n${++seq}`, assessee: "Dhiraj Laxmandas Shivnani", pan: PAN, ay: AY,
  isOrder: true, ...o,
});
const listed = (data) => appealableOrders(data, { withinDays: null }).map((x) => x.notice.id);

test("two CIT(A) orders in one year are two appeals, not one", () => {
  const older = order({ date: "2025-10-16", docType: "appealOrder", authority: "CIT(A)", section: "250" });
  const newer = order({ date: "2026-07-24", docType: "appealOrder", authority: "CIT(A)", section: "250" });
  const data = { notices: [older, newer], matters: [] };
  assert.deepEqual(listed(data), [older.id, newer.id]);
});

test("one ITAT appeal answers one order — the earlier one — and leaves the later", () => {
  const older = order({ date: "2025-10-16", docType: "appealOrder", authority: "CIT(A)" });
  const newer = order({ date: "2026-07-24", docType: "appealOrder", authority: "CIT(A)" });
  // A matter typed in by hand: an ITA number, a bench, and no date anywhere.
  const matter = { type: "ITAT", pan: PAN, ay: AY, ref: "ITA No. 1762/Ahd/2026", status: "Active" };
  const data = { notices: [older, newer], matters: [matter] };
  assert.deepEqual(listed(data), [newer.id]);
  assert.equal(isAppealed(older, data.notices, data.matters), true);
  assert.equal(isAppealed(newer, data.notices, data.matters), false);
});

test("an appellate order answers the order it followed, never one passed after it", () => {
  // The CIT(A) sets the assessment aside; the AO passes a fresh order. The
  // fresh order is appealable and the 2025 appellate order says nothing of it.
  const first = order({ date: "2024-03-11", docType: "assessmentOrder", authority: "Scrutiny", section: "143(3)" });
  const decided = order({ date: "2025-03-10", docType: "appealOrder", authority: "CIT(A)", section: "250" });
  const fresh = order({ date: "2026-06-30", docType: "assessmentOrder", authority: "Scrutiny", section: "144" });
  const data = { notices: [first, decided, fresh], matters: [] };
  // `decided` is itself appealable to the Tribunal; `first` is answered by it.
  assert.deepEqual(listed(data).sort(), [decided.id, fresh.id].sort());
});

test("a penalty appeal answers the penalty order, not the assessment in the same year", () => {
  const asmt = order({ date: "2024-03-11", docType: "assessmentOrder", authority: "Scrutiny", section: "143(3)" });
  const pen = order({ date: "2024-09-20", docType: "penaltyOrder", authority: "Penalty", section: "271(1)(c)" });
  const decided = order({
    date: "2025-10-16", docType: "appealOrder", authority: "CIT(A)", section: "250",
    subject: "Order u/s 250 — appeal against penalty u/s 271(1)(c) dismissed",
  });
  const data = { notices: [asmt, pen, decided], matters: [] };
  // The penalty order is answered; the quantum assessment is still unappealed.
  assert.deepEqual(listed(data).sort(), [asmt.id, decided.id].sort());
});

test("a Form 35 answers the order it names, and only that one", () => {
  const first = order({ date: "2024-03-11", docType: "assessmentOrder", authority: "Scrutiny", din: "AAA1" });
  const second = order({ date: "2026-02-02", docType: "assessmentOrder", authority: "Scrutiny", din: "BBB2" });
  const form = {
    id: "f1", pan: PAN, ay: AY, isAppealForm: true, isOrder: false,
    appeal: { dateFiling: "2026-03-01", dateOrder: "2024-03-11", orderDin: "AAA1" },
  };
  const data = { notices: [first, second, form], matters: [] };
  assert.deepEqual(listed(data), [second.id]);
});

test("a Form 35 with no order metadata answers one order, the earliest open one", () => {
  const first = order({ date: "2024-03-11", docType: "assessmentOrder", authority: "Scrutiny" });
  const second = order({ date: "2026-02-02", docType: "assessmentOrder", authority: "Scrutiny" });
  const form = { id: "f1", pan: PAN, ay: AY, isAppealForm: true, appeal: { dateFiling: "2024-04-01" } };
  const data = { notices: [first, second, form], matters: [] };
  assert.deepEqual(listed(data), [second.id]);
});

test("evidence with nothing on file before it answers nothing", () => {
  // An appeal decided in 2020 cannot be the answer to a 2026 order.
  const stale = order({ date: "2020-01-10", docType: "appealOrder", authority: "CIT(A)" });
  const fresh = order({ date: "2026-06-30", docType: "assessmentOrder", authority: "Scrutiny" });
  const data = { notices: [stale, fresh], matters: [] };
  assert.equal(listed(data).includes(fresh.id), true);
});

test("one order, one appeal against it, and the order drops off the list", () => {
  const asmt = order({ date: "2024-03-11", docType: "assessmentOrder", authority: "Scrutiny" });
  const decided = order({ date: "2025-03-10", docType: "appealOrder", authority: "CIT(A)" });
  assert.deepEqual(listed({ notices: [asmt, decided], matters: [] }), [decided.id]);
  const withMatter = { notices: [decided], matters: [{ type: "ITAT", pan: PAN, ay: AY }] };
  assert.deepEqual(listed(withMatter), []);
});

test("the forum is read off the document when the proceeding bucket is Other", () => {
  // The portal names first-appeal proceedings a dozen ways; an unrecognised one
  // lands in "Other", which used to keep the order off this page entirely.
  const n = order({ date: "2026-07-24", docType: "appealOrder", authority: "Other" });
  assert.equal(appealRoute(n), "ITAT");
  assert.deepEqual(listed({ notices: [n], matters: [] }), [n.id]);
});

test("a Tribunal order is not appealed here — the High Court is out of scope", () => {
  const itat = order({ date: "2026-05-05", authority: "ITAT", docType: "order", subject: "Order u/s 254(1)" });
  assert.equal(appealRoute(itat), null);
  assert.deepEqual(listed({ notices: [itat], matters: [] }), []);
});

test("each row says where its order stands among the year's orders", () => {
  const older = order({ date: "2025-10-16", docType: "appealOrder", authority: "CIT(A)" });
  const newer = order({ date: "2026-07-24", docType: "appealOrder", authority: "CIT(A)" });
  const rows = appealableOrders({ notices: [older, newer], matters: [] }, { withinDays: null });
  const by = Object.fromEntries(rows.map((r) => [r.notice.id, r]));
  assert.deepEqual(
    [by[older.id].ayIndex, by[older.id].ayCount, by[older.id].ayLatest],
    [1, 2, false]
  );
  assert.deepEqual(
    [by[newer.id].ayIndex, by[newer.id].ayCount, by[newer.id].ayLatest],
    [2, 2, true]
  );
});

test("the practitioner's own mark still wins, and answers only that order", () => {
  const older = order({ date: "2025-10-16", docType: "appealOrder", authority: "CIT(A)", appealStatus: "filed" });
  const newer = order({ date: "2026-07-24", docType: "appealOrder", authority: "CIT(A)" });
  const data = { notices: [older, newer], matters: [] };
  assert.equal(appealedOrders(data).has(older), true);
  assert.deepEqual(listed(data), [newer.id]);
});

test("the checklist ticks the enclosure that came with THIS order", () => {
  const first = order({ date: "2024-03-11", docType: "assessmentOrder", authority: "Scrutiny", storagePath: "a.pdf", proceedingReqId: "P1" });
  const fresh = order({ date: "2026-06-30", docType: "assessmentOrder", authority: "Scrutiny", storagePath: "b.pdf", proceedingReqId: "P2" });
  const demand = order({ date: "2024-03-11", docType: "demandNotice", authority: "Scrutiny", proceedingReqId: "P1", storagePath: "d.pdf" });
  const all = [first, fresh, demand];
  const rows = appealableOrders({ notices: all, matters: [] }, { withinDays: null });
  const row = rows.find((r) => r.notice.id === fresh.id);
  const demandItem = checklistFor(row, all).find((i) => i.key === "demand");
  // The 2024 demand notice belongs to the 2024 order, not to this one.
  assert.equal(demandItem.auto, false);
});

test("the ITAT checklist points at the assessment the CIT(A) actually decided", () => {
  const first = order({ date: "2024-03-11", docType: "assessmentOrder", authority: "Scrutiny", storagePath: "a.pdf" });
  const decided = order({ date: "2025-03-10", docType: "appealOrder", authority: "CIT(A)", storagePath: "c.pdf" });
  const fresh = order({ date: "2026-06-30", docType: "assessmentOrder", authority: "Scrutiny" }); // no PDF on file
  const all = [first, decided, fresh];
  const row = appealableOrders({ notices: all, matters: [] }, { withinDays: null }).find((r) => r.notice.id === decided.id);
  const asmt = checklistFor(row, all).find((i) => i.key === "asmt");
  // The 2024 order, which this appellate order decided, is on file.
  assert.equal(asmt.auto, true);
});

test("a Form 35 and the order that decided it are one appeal, not two", () => {
  // Both are on file for every decided first appeal. Counted twice they used to
  // take the penalty order down with the assessment they were about.
  const asmt = order({ date: "2024-03-11", docType: "assessmentOrder", authority: "Scrutiny", din: "AAA1" });
  const pen = order({ date: "2024-09-20", docType: "penaltyOrder", authority: "Penalty", section: "271(1)(c)" });
  const form = {
    id: "f1", pan: PAN, ay: AY, isAppealForm: true,
    appeal: { dateFiling: "2024-04-10", dateOrder: "2024-03-11", orderDin: "AAA1" },
  };
  const decided = order({ date: "2025-10-16", docType: "appealOrder", authority: "CIT(A)", section: "250" });
  const data = { notices: [asmt, pen, form, decided], matters: [] };
  assert.deepEqual(listed(data).sort(), [pen.id, decided.id].sort());
});

test("an ITAT matter and the Tribunal order that closed it are one appeal", () => {
  const first = order({ date: "2024-03-11", docType: "appealOrder", authority: "CIT(A)" });
  const second = order({ date: "2026-07-24", docType: "appealOrder", authority: "CIT(A)" });
  const itatOrder = order({ date: "2025-08-01", authority: "ITAT", docType: "order", subject: "Order u/s 254(1)" });
  const matter = { type: "ITAT", pan: PAN, ay: AY, ref: "ITA No. 1244/Ahd/2024" };
  const data = { notices: [first, second, itatOrder], matters: [matter] };
  assert.deepEqual(listed(data), [second.id]);
});
