/* The filed-Form-35 pass, and the three faults reported against it.
 *
 *   node --test test/portalAppeals.test.mjs
 *
 * Reported: "When it tries to fetch the data of Form 35 and its attachments, it
 * takes much time and most of the time it does not fetch the pdfs of all the
 * Form 35 and its attachments. It stalls at a place and skips everything which
 * is yet to be fetched after Form 35. Moreover, it shows the user that the data
 * is synced though the data is not synced."
 *
 * Three faults, each hiding the next:
 *
 *   the rendered form was asked for six times over sixteen minutes, which is
 *   longer than the whole PAN is given;
 *   a form was recorded as held however badly it had gone, so no later sync
 *   went back for it;
 *   and the run reported success either way.
 *
 * The portal is stubbed at the same seam portalFetchReplies.test.mjs uses, and
 * the clock is a counter this file moves by hand — a test that actually waited
 * for these deadlines would take a quarter of an hour to tell us anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const P = (m) => require.resolve(`../connector/src/main/${m}`);
function stub(mod, exports) { require.cache[P(mod)] = { id: P(mod), filename: P(mod), loaded: true, exports }; }

const PAN = "AAAPZ1000A";

/* ---------------- the portal, as it answers ---------------- */

// Three filed appeals, which is an ordinary number for an assessee in dispute.
const FORMS = [
  { ackNum: "132456789012345", ackDt: "23-Nov-2024", formStatus: "Completed", formName: "Appeal to the Commissioner (Appeals)" },
  { ackNum: "132456789012346", ackDt: "14-Feb-2025", formStatus: "Completed", formName: "Appeal to the Commissioner (Appeals)" },
  { ackNum: "132456789012347", ackDt: "02-Aug-2025", formStatus: "Completed", formName: "Appeal to the Commissioner (Appeals)" },
];

// Two grounds uploaded with each, plus the copy of the order being appealed —
// which this pass deliberately leaves to the assessment proceeding.
const ATTACHMENTS = [
  { satDocId: 441000001, docName: "Grounds of Appeal.pdf" },
  { satDocId: 441000002, docName: "Statement of Facts.pdf" },
  { satDocId: 441000003, docName: "Order us 143(3).pdf" },
];

/* A stubbed portal whose slowness is DECLARED rather than waited for: every call
   moves the test's clock by what that call would really have cost. That is what
   makes "the pass ran out of its share of the run" a thing a test can assert. */
function portal(opts = {}) {
  const calls = [];
  const clock = { t: 1_000_000 };
  const cost = (ms) => { clock.t += ms; };
  const api = {
    apiCall: async (_page, { serviceName }) => {
      calls.push(serviceName);
      if (serviceName === "viewFiledForms") { cost(1000); return { ok: true, json: { forms: FORMS } }; }
      if (serviceName === "myPanDetailsService") { cost(1000); return { ok: true, json: { firstNm: "SAMPLE", surname: "NAME", commnLine1: "1 Road" } }; }
      if (serviceName === "viewFiledFormService") { cost(opts.formDataMs || 2000); return { ok: true, json: { data: { selectyear: "2021", din: "ITBA/AST/1", dateFiling: "23-Nov-2024" } } }; }
      if (serviceName === "attachmentDetails") { cost(2000); return { ok: true, json: ATTACHMENTS }; }
      cost(500);
      return { ok: true, json: {} };
    },
    postDoc: async (_page, { serviceName }) => {
      calls.push("render:" + serviceName);
      cost(serviceName === "F35" ? (opts.renderMs || 4000) : 2000);
      if (serviceName === "F35" && opts.renderFails) return { ok: false, status: 502 };
      return { ok: true, status: 200, base64: "JVBERi0=", contentType: "application/pdf", bytes: 2048 };
    },
    getDoc: async (_page, { docId }) => {
      calls.push("doc:" + docId);
      cost(opts.docMs || 3000);
      if (opts.docFails && opts.docFails.includes(String(docId))) return { ok: false, status: 500 };
      return { ok: true, status: 200, base64: "JVBERi0=", filename: docId + ".pdf", contentType: "application/pdf", bytes: 4096 };
    },
  };
  return { calls, clock, api };
}

function load(p) {
  stub("pacing", { jsleep: async () => {}, PACE: { betweenDocs: [0, 0] } });
  stub("f35Template", { loadF35Template: () => null });
  const ingested = [];
  stub("ingest", { ingestSyncMessage: async (m) => { ingested.push(m); return { ok: true }; } });
  const realApi = require("../connector/src/main/portalApi.js");
  stub("portalApi", { ...realApi, ...p.api });
  /* The one piece of the real thing this test replaces: Date.now. The budget
     module takes its clock as a parameter for exactly this reason, but the pass
     builds its own budget, so the global is what has to move. */
  const realNow = Date.now;
  Date.now = () => p.clock.t;
  delete require.cache[P("portalAppeals")];
  delete require.cache[P("syncBudget")];
  const mod = require("../connector/src/main/portalAppeals.js");
  return { ...mod, ingested, restore: () => { Date.now = realNow; } };
}

async function run(p, { knowns = {}, deadlineIn = 15 * 60 * 1000 } = {}) {
  const { syncAppealForms, ingested, restore } = load(p);
  const events = [];
  const summary = { appeals: 0 };
  const job = { assesseeId: "a1", pan: PAN, knowns, deadlineAt: p.clock.t + deadlineIn };
  try {
    await syncAppealForms({}, job, PAN, summary, (phase, message, level) => events.push({ phase, message, level }));
  } finally { restore(); }
  return { summary, ingested, events, spentMs: p.clock.t - (job.deadlineAt - deadlineIn) };
}

/* ---------------- it fetches what it is there for ---------------- */

test("a clean run brings down every form, its receipt and its grounds", async () => {
  const p = portal();
  const { summary, ingested } = await run(p);
  assert.equal(summary.appeals, 3);
  assert.equal(summary.incomplete, undefined, "and claims nothing is outstanding only when nothing is");

  const first = ingested[0].appeal;
  assert.deepEqual(first.attachments.map((a) => a.label), [
    "Form 35 (filed)", "Acknowledgement (ARN)", "Grounds / attachment", "Grounds / attachment",
  ]);
  // The copy of the assessment order is not fetched twice: it comes with the
  // proceeding it was passed in.
  assert.equal(first.attachmentsExpected, 2);
  assert.deepEqual(first.attachmentsMissing, []);
});

test("one ask for the rendered form, not six", async () => {
  /* THE TIME. There used to be a loop of three attempts around a call portalApi
     already retries once by itself — six renders of one small PDF at the ceiling
     meant for an 11 MB return, which is sixteen minutes for one form's first
     document. The retry belongs to portalApi and stays there. */
  const p = portal({ renderFails: true });
  await run(p, { knowns: {} });
  const renders = p.calls.filter((c) => c === "render:F35").length;
  assert.equal(renders, 3, "one per form — the retry inside portalApi is stubbed out with it");
});

/* ---------------- it stops before it takes the run ---------------- */

test("the pass stops short of the PAN's deadline, so what comes after it still runs", async () => {
  // Every call slow enough that three forms cannot fit. The old pass would have
  // spent the lot and left the returns pass unrun.
  const p = portal({ renderMs: 200000, docMs: 60000, formDataMs: 30000 });
  const { summary, spentMs } = await run(p, { deadlineIn: 15 * 60 * 1000 });
  assert.ok(summary.appeals < 3, "it did not get through them all");
  assert.ok(spentMs <= 15 * 60 * 1000 - 3 * 60 * 1000,
    `it left the reserve alone (spent ${Math.round(spentMs / 1000)}s of 900s)`);
  assert.ok((summary.incomplete || []).some((s) => /not fetched/.test(s)), "and said what it did not reach");
});

test("a PAN already near its deadline starts no form at all", async () => {
  // Right, not an edge case: a form begun with a minute left is a form abandoned
  // mid-render, which costs the minute and saves nothing.
  const p = portal();
  const { summary, ingested } = await run(p, { deadlineIn: 60000 });
  assert.equal(summary.appeals, 0);
  assert.equal(ingested.length, 0);
  assert.deepEqual(summary.incomplete, ["3 filed appeal(s) not fetched"]);
});

/* ---------------- and it comes back for what it missed ---------------- */

test("a form whose PDF would not render is saved, reported, and left pending", async () => {
  const p = portal({ renderFails: true });
  const { summary, ingested, events } = await run(p);
  assert.equal(summary.appeals, 3, "the form's DATA is still worth saving");
  for (const m of ingested) {
    assert.match(m.appeal.formPdfError, /502/, "with the reason its PDF is absent recorded on it");
  }
  assert.equal((summary.incomplete || []).length, 3);
  assert.ok(events.some((e) => e.level === "warn"), "and the row says so rather than reporting a clean run");
});

test("an attachment that does not come down is named, not dropped in silence", async () => {
  /* It used to be dropped entirely: a Form 35 on file with no grounds attached
     to it looked exactly like one filed without any. */
  const p = portal({ docFails: ["441000001"] });
  const { ingested, summary } = await run(p);
  assert.deepEqual(ingested[0].appeal.attachmentsMissing, ["Grounds of Appeal.pdf"]);
  assert.equal(ingested[0].appeal.attachmentsExpected, 2);
  assert.ok((summary.incomplete || []).every((s) => /attachment/.test(s)));
});

test("a form held WITHOUT its documents is fetched again; a form held whole is not", async () => {
  /* The heart of it. The ingest writes `f35:<ackNum>` however the fetch went, so
     this pass — which skips on exactly that key — walked past its own failures
     for ever. That is why re-syncing changed nothing for the practitioner. */
  const knowns = {
    knownDins: FORMS.map((f) => "f35:" + f.ackNum),
    appealFormsPending: [{ ackNum: "132456789012346", tries: 1 }],
  };
  const p = portal();
  const { summary, ingested } = await run(p, { knowns });
  assert.equal(summary.appeals, 1, "only the incomplete one");
  assert.equal(ingested[0].appeal.ackNum, "132456789012346");
});

test("nothing is fetched twice: every form held and complete costs the list call and nothing else", async () => {
  const p = portal();
  const { summary } = await run(p, { knowns: { knownDins: FORMS.map((f) => "f35:" + f.ackNum) } });
  assert.equal(summary.appeals, 0);
  assert.equal(summary.incomplete, undefined);
  assert.ok(!p.calls.some((c) => c.startsWith("render:")), "no renders at all");
});

test("a form asked for MAX_TRIES times over says so, and stops being promised", async () => {
  const { MAX_TRIES } = load(portal());
  const p = portal({ renderFails: true });
  const knowns = {
    knownDins: ["f35:132456789012345"],
    appealFormsPending: [{ ackNum: "132456789012345", tries: MAX_TRIES - 1 }],
  };
  const { events, summary } = await run(p, { knowns });
  assert.ok(events.some((e) => e.level === "warn" && /could not be fetched after/.test(e.message)));
  assert.ok((summary.incomplete || []).some((s) => /unavailable/.test(s)),
    "the word changes from 'still to fetch' to 'unavailable' — the app has stopped trying");
});
