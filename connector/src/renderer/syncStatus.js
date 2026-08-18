/* What a sync list says about itself while it is running.
 *
 * Three questions a practitioner asks of a running sync, in order:
 *
 *   which ones are being worked on right now?
 *   which ones are finished, so I can stop watching them?
 *   is that one stuck, or just slow?
 *
 * A single flat list answered none of them. Progress was painted on each row
 * where it happened, so five workers moving through two hundred rows scattered
 * the news across a list nobody could hold in their head — and the moment a PAN
 * finished, its row was reloaded back to "idle" and the evidence that it had
 * synced at all disappeared.
 *
 * So the list SORTS ITSELF by what each row is doing: the ones being fetched
 * right now on top, the ones already done collected at the bottom under
 * "Synced", where they stay. And a row that has not said anything for a while
 * says so, in seconds, rather than sitting at 62% looking identical to a row
 * that is working perfectly well.
 *
 * Everything here is pure — no DOM, no timers, no `Date.now()` reached for
 * internally — because these are the rules the window is judged by and they are
 * worth pinning in a test (test/connectorSyncStatus.test.mjs). The renderer
 * owns the painting; this owns the decisions.
 */
"use strict";

const SyncStatus = (function () {
  /* Silence long enough to be worth mentioning.
   *
   * Not a timeout — nothing is cancelled here. The portal genuinely takes
   * fifteen or twenty seconds over a large document and that is normal, so the
   * threshold sits well above a slow step and well below the point where
   * somebody starts wondering whether the app has died. The main process has
   * its own, much longer deadlines (config.js TIMEOUTS); this is only about
   * what the window admits to. */
  const STALL_AFTER_MS = 45000;
  // ...and this long without a word is no longer "slow", it is a problem, and
  // the row says what can be done about it.
  const STALL_HARD_MS = 150000;

  /* The order the list is read in. Work in progress at the top, because that is
     the only part that is changing; finished work at the bottom, because its
     whole value is that it needs no more attention. */
  const GROUPS = [
    { key: "running", label: "Syncing now" },
    { key: "queued", label: "Waiting" },
    { key: "failed", label: "Needs attention" },
    /* A run that finished without getting everything. Its own section, above
       the finished work and below the broken, because it is neither: nothing
       needs fixing, but nothing should be read as complete either. It used to
       land in "Synced" — a green pill over an assessee whose filed appeal had
       come down without its PDF, which is the reported complaint in one word. */
    { key: "partial", label: "Partly synced" },
    { key: "idle", label: "Not synced yet" },
    { key: "done", label: "Synced" },
  ];
  const GROUP_KEYS = new Set(GROUPS.map((g) => g.key));

  /* Where one event moves a row to.
   *
   * Driven by the event's PHASE, not its level. The login state machine reports
   * "Logged in" at level `success` a fifth of the way through a sync — reading
   * the level alone put a row in "Synced" while its notices were still being
   * fetched, and then took it out again. The phase is unambiguous: the pool
   * emits `done` exactly once per PAN, at the end, and `error`/`stopped`
   * instead of it when there is nothing to be done. */
  function stageFor(prev, evt) {
    const phase = (evt && evt.phase) || "";
    if (phase === "queued") return "queued";
    if (phase === "start") return "running";
    /* `done` is the only phase whose LEVEL is read, and only to tell the two
       kinds of finished apart: the pool warns on a PAN it could not fetch
       everything for (pool.js), and the difference between that and a clean run
       is the whole point of this row. */
    if (phase === "done") return (evt && evt.level) === "warn" ? "partial" : "done";
    if (phase === "error" || phase === "stopped") return "failed";
    // A finished row is not dragged back into "Syncing now" by a late straggler
    // (the pool emits `synced` and `timing` around the end of a PAN).
    if (prev === "done" || prev === "failed" || prev === "partial") return prev;
    return "running";
  }

  // Which section a row belongs to. A row nothing has happened to is "idle" —
  // including one whose recorded stage is from an older build of this file.
  function groupOf(st) {
    const stage = st && st.stage;
    return stage && GROUP_KEYS.has(stage) ? stage : "idle";
  }

  /* Split the visible rows into sections, in GROUPS order, dropping the empty
     ones. Row order WITHIN a section is the order it was given — a row that
     jumps its section is telling the user something, a row that shuffles inside
     one is just noise. */
  function groupJobs(jobs, stateFor) {
    const buckets = new Map(GROUPS.map((g) => [g.key, []]));
    for (const j of jobs || []) buckets.get(groupOf(stateFor(j))).push(j);
    return GROUPS
      .map((g) => ({ key: g.key, label: g.label, jobs: buckets.get(g.key) }))
      .filter((s) => s.jobs.length > 0);
  }

  /* Headings are worth their space only once the list is actually divided.
     Before the first sync of a session every row is "Not synced yet", and a
     lone heading saying so over the whole list is furniture. */
  function shouldShowHeadings(sections) {
    return sections.some((s) => s.key !== "idle") && sections.length > 1;
  }

  // "8s", "1m 12s", "22m 04s" — seconds stay visible at every scale, because
  // the number people watch to decide whether something is moving is the one
  // that changes every second.
  function durationText(ms) {
    const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    if (!mins) return `${secs}s`;
    return `${mins}m ${String(secs).padStart(2, "0")}s`;
  }

  /* What to add to a running row's status line.
   *
   * While things are moving this is just the clock — a number that changes
   * every second is the difference between "working" and "hung", and it costs
   * nothing to show. Once the row goes quiet it changes to how long it has been
   * quiet FOR, which is the number that actually answers the question being
   * asked, and past STALL_HARD_MS it says what can be done instead. */
  function progressNote(st, now) {
    if (!st || st.stage !== "running") return null;
    const last = st.at || st.startedAt || now;
    const quietMs = Math.max(0, now - last);
    if (quietMs < STALL_AFTER_MS) {
      return { stalled: false, hard: false, text: durationText(now - (st.startedAt || last)) };
    }
    if (quietMs < STALL_HARD_MS) {
      return { stalled: true, hard: false, text: `still on this step — ${durationText(quietMs)}` };
    }
    return {
      stalled: true,
      hard: true,
      text: `the portal hasn't answered for ${durationText(quietMs)} — it will be given up on, or press Skip`,
    };
  }

  /* The word on the right-hand pill. The stage says where the row is; the phase
     separates a sync somebody stopped from one that broke, because those two
     need very different things from the reader. */
  function pillFor(st) {
    const stage = groupOf(st);
    const phase = (st && st.phase) || "";
    if (stage === "done") return { cls: "success", text: "synced" };
    if (stage === "partial") return { cls: "warn", text: "partly synced" };
    if (stage === "failed") return phase === "stopped"
      ? { cls: "warn", text: "stopped" }
      : { cls: "error", text: "error" };
    if (stage === "queued") return { cls: "queued", text: "waiting" };
    if (stage === "running") return { cls: "info", text: "syncing" };
    return { cls: "idle", text: "idle" };
  }

  return {
    STALL_AFTER_MS, STALL_HARD_MS, GROUPS,
    stageFor, groupOf, groupJobs, shouldShowHeadings, durationText, progressNote, pillFor,
  };
})();

/* Loaded twice on purpose: as a plain <script> in the window, where the const
   above is the whole interface, and as a CommonJS module by the tests. */
if (typeof module === "object" && module.exports) module.exports = SyncStatus;
