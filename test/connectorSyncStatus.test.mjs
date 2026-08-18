/* What the connector's sync list says about itself while it is running.

   Three complaints from a practice using it, all about the same list:

     a PAN that finished lost its green bar seconds later, so there was no
     record on screen that it had synced at all;

     with five workers moving through two hundred rows there was no way to see
     which ones were being fetched and which were done, short of scrolling the
     whole list and reading every pill;

     and when the portal stalled on a document, the row sat at the same
     percentage looking exactly like a row that was working — so the app looked
     dead when it was merely waiting.

   The rules those three fixes rest on live in syncStatus.js, away from the DOM,
   precisely so they can be pinned here. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../connector/src/renderer/syncStatus.js");

const NOW = Date.parse("2026-08-14T18:30:00.000Z");
const ago = (ms) => NOW - ms;

test("a sync ends in Synced and stays there", () => {
  let stage;
  stage = S.stageFor(undefined, { phase: "queued" });
  assert.equal(stage, "queued");
  stage = S.stageFor(stage, { phase: "start" });
  assert.equal(stage, "running");
  stage = S.stageFor(stage, { phase: "fetch" });
  assert.equal(stage, "running");
  stage = S.stageFor(stage, { phase: "done" });
  assert.equal(stage, "done");
  // The pool emits "synced" and "timing" around the end of a PAN. Neither may
  // drag a finished row back into "Syncing now" — the whole point is that a
  // synced row stays synced and visibly so.
  assert.equal(S.stageFor(stage, { phase: "synced" }), "done");
  assert.equal(S.stageFor(stage, { phase: "timing" }), "done");
  assert.deepEqual(S.pillFor({ stage: "done" }), { cls: "success", text: "synced" });
});

test("a run that finished short of the portal's documents does not say 'synced'", () => {
  /* The fourth complaint, and the one that hid the other three from anybody
     looking at the window: "it shows the user that the data is synced though the
     data is not synced."

     A PAN whose filed Form 35 came down without its PDF, or whose appeals pass
     ran out of its share of the run, finished successfully — it logged in, it
     read the portal, it saved what came — and got the same green pill as a run
     that got everything. The pool now warns on the `done` event when something
     is outstanding (see pool.js), and that is the ONE place a level is read. */
  const stage = S.stageFor("running", { phase: "done", level: "warn" });
  assert.equal(stage, "partial");
  assert.deepEqual(S.pillFor({ stage }), { cls: "warn", text: "partly synced" });
  // And it stays partial: the pool's own trailing "synced"/"timing" events must
  // not quietly promote it.
  assert.equal(S.stageFor(stage, { phase: "synced" }), "partial");
  assert.equal(S.stageFor(stage, { phase: "timing" }), "partial");
  // It has its own section, and it reads between "needs attention" and "synced".
  const order = S.GROUPS.map((g) => g.key);
  assert.ok(order.indexOf("partial") > order.indexOf("failed"));
  assert.ok(order.indexOf("partial") < order.indexOf("done"));
});

test("'Logged in' does not count as finished", () => {
  /* THIS IS THE BUG THAT MADE THE OLD LIST UNREADABLE. The login state machine
     reports success a fifth of the way through a sync, and the row was coloured
     by the LEVEL of the last event — so a PAN turned green, said "done", and
     then went back to running while its notices were still being fetched. */
  const stage = S.stageFor("running", { phase: "login", level: "success" });
  assert.equal(stage, "running");
  assert.equal(S.pillFor({ stage, level: "success" }).text, "syncing");
});

test("a re-run puts a finished row back on the list", () => {
  assert.equal(S.stageFor("done", { phase: "queued" }), "queued");
  // The schedule doesn't queue anything — its first word about a PAN is "start".
  assert.equal(S.stageFor("done", { phase: "start" }), "running");
});

test("stopping is told apart from failing", () => {
  assert.equal(S.stageFor("running", { phase: "error" }), "failed");
  assert.equal(S.stageFor("running", { phase: "stopped" }), "failed");
  // Same section — both need the user's attention — but never the same word:
  // reporting somebody's own Stop back to them as an error is a lie.
  assert.deepEqual(S.pillFor({ stage: "failed", phase: "error" }), { cls: "error", text: "error" });
  assert.deepEqual(S.pillFor({ stage: "failed", phase: "stopped" }), { cls: "warn", text: "stopped" });
});

test("the list reads top to bottom: in progress first, finished last", () => {
  const jobs = ["a", "b", "c", "d", "e"].map((id) => ({ assesseeId: id }));
  const state = {
    a: { stage: "done" },
    b: { stage: "running" },
    c: undefined,          // never touched
    d: { stage: "failed" },
    e: { stage: "queued" },
  };
  const sections = S.groupJobs(jobs, (j) => state[j.assesseeId]);
  assert.deepEqual(sections.map((s) => s.key), ["running", "queued", "failed", "idle", "done"]);
  assert.deepEqual(sections.map((s) => s.label),
    ["Syncing now", "Waiting", "Needs attention", "Not synced yet", "Synced"]);
  assert.deepEqual(sections.map((s) => s.jobs.map((j) => j.assesseeId)),
    [["b"], ["e"], ["d"], ["c"], ["a"]]);
});

test("rows keep the order they were given inside their own section", () => {
  // A row jumping sections is telling the user something. A row shuffling
  // within one is just noise, and noise on a list of two hundred is expensive.
  const jobs = ["a", "b", "c"].map((id) => ({ assesseeId: id }));
  const [section] = S.groupJobs(jobs, () => ({ stage: "done" }));
  assert.deepEqual(section.jobs.map((j) => j.assesseeId), ["a", "b", "c"]);
});

test("headings appear only once there is something to separate", () => {
  const flat = S.groupJobs([{ assesseeId: "a" }], () => undefined);
  assert.equal(S.shouldShowHeadings(flat), false, "a list nobody has synced looks as it always did");

  const oneSection = S.groupJobs([{ assesseeId: "a" }], () => ({ stage: "done" }));
  assert.equal(S.shouldShowHeadings(oneSection), false, "everything in one bucket needs no divider");

  const split = S.groupJobs(
    [{ assesseeId: "a" }, { assesseeId: "b" }],
    (j) => (j.assesseeId === "a" ? { stage: "running" } : undefined)
  );
  assert.equal(S.shouldShowHeadings(split), true);
});

test("a running row carries a clock, and says so when it goes quiet", () => {
  const working = { stage: "running", startedAt: ago(12000), at: ago(3000) };
  assert.deepEqual(S.progressNote(working, NOW), { stalled: false, hard: false, text: "12s" });

  const quiet = { stage: "running", startedAt: ago(200000), at: ago(60000) };
  const note = S.progressNote(quiet, NOW);
  assert.equal(note.stalled, true);
  assert.equal(note.hard, false);
  assert.match(note.text, /^still on this step — 1m 00s$/);

  // Long enough that "slow" is no longer an honest description of it, so the
  // row names the way out rather than leaving the reader to guess.
  const stuck = { stage: "running", startedAt: ago(400000), at: ago(200000) };
  const hard = S.progressNote(stuck, NOW);
  assert.equal(hard.hard, true);
  assert.match(hard.text, /Skip/);
});

test("only a row being fetched right now gets a clock", () => {
  for (const stage of ["queued", "done", "failed", "idle"]) {
    assert.equal(S.progressNote({ stage, at: ago(600000) }, NOW), null, stage);
  }
  assert.equal(S.progressNote(undefined, NOW), null);
});

test("the clock keeps seconds visible at every scale", () => {
  assert.equal(S.durationText(0), "0s");
  assert.equal(S.durationText(8400), "8s");
  assert.equal(S.durationText(60000), "1m 00s");
  assert.equal(S.durationText(1325000), "22m 05s");
  // A row whose last event somehow post-dates "now" reads as zero, not as a
  // negative that would make the whole line look broken.
  assert.equal(S.durationText(-5000), "0s");
});

test("a stage this build doesn't recognise is treated as untouched", () => {
  assert.equal(S.groupOf({ stage: "something-newer" }), "idle");
  assert.equal(S.groupOf(undefined), "idle");
});
