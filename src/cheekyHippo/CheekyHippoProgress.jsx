/*
 * ProHippo — CheekyHippoProgress
 *
 * A presentational, mascot-driven progress card for the portal fetch flow.
 * It is driven ENTIRELY by props — no fetch/network code lives here. The
 * parent (e.g. the portal-sync card in Assessees.jsx) owns the real fetch and
 * feeds this component the current phase + counts.
 *
 * Two honest phases:
 *   Phase A (authenticating / fetchingList / processing): indeterminate —
 *     shimmer/slider bar + rotating hippo lines, NO fake percentage.
 *   Phase B (downloading, once totalPdfs is known): a real determinate bar
 *     driven by downloadedCount / totalPdfs, with a count-up "X of N".
 *
 * ── Wiring guide (JS repo, so props are plain objects; the TS shape below
 *    mirrors the spec) ────────────────────────────────────────────────────
 * The extension streams messages (see portalSync.js / portalIngest.js). Map
 * them to props roughly like this in the parent:
 *   • before openPortalLogin resolves ............. phase="authenticating"
 *   • kind "proceedings" arrives (list known) ..... phase="fetchingList" →
 *       set totalPdfs = count of documents to download, then
 *       phase="downloading"
 *   • each kind "notice" ingested ................. downloadedCount++ and
 *       currentFileName = notice.filename
 *   • noticeCounts{} ............................... tally by section as they
 *       stream (148/148A → reassessment, 271* → penalty, etc.)
 *   • after the last PDF, brief ................... phase="processing" → "done"
 *   • no documents at all ......................... phase="empty"
 *   • request threw ............................... phase="error", errorMessage,
 *       onRetry = () => launch("sync")
 */

/**
 * @typedef {'authenticating'|'fetchingList'|'downloading'|'processing'|'done'|'error'|'empty'} FetchPhase
 *
 * @typedef {Object} NoticeCounts
 * @property {number} [assessment]
 * @property {number} [penalty]
 * @property {number} [appeal]
 * @property {number} [reassessment]  148 / 148A
 *
 * @typedef {Object} CheekyHippoProgressProps
 * @property {FetchPhase} phase
 * @property {number} [totalPdfs]        known once the list is fetched
 * @property {number} [downloadedCount]  increments during 'downloading'
 * @property {NoticeCounts} [noticeCounts]
 * @property {string} [currentFileName]  current PDF being fetched
 * @property {string} [errorMessage]
 * @property {() => void} [onRetry]
 */

import React from "react";
import { Icon } from "../shared.jsx";
import { pickNoRepeat } from "./pickRandom.js";
import { resolveLines, fillTemplate, contextualKey } from "./hippoLines.js";
import "./cheekyHippo.css";

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/* ── Hooks ─────────────────────────────────────────────────────────────── */

/** True when the user has asked the OS to reduce motion. */
function usePrefersReducedMotion() {
  const [reduce, setReduce] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduce(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduce;
}

/**
 * Count-up hook — eases an integer from its previous value to `target` with
 * requestAnimationFrame (easeOutCubic). This is the house count-up primitive;
 * reuse it elsewhere if other counters want the same feel. When disabled
 * (reduced motion), it snaps instantly.
 */
function useCountUp(target, { duration = 600, disabled = false } = {}) {
  const [value, setValue] = React.useState(target);
  const fromRef = React.useRef(target);
  const rafRef = React.useRef(0);

  React.useEffect(() => {
    if (disabled) {
      // Reduced motion: keep the ref in sync but don't animate. The caller
      // reads `done` directly in this mode, so no setState is needed here.
      fromRef.current = target;
      return;
    }
    const from = fromRef.current;
    const to = target;
    if (from === to) return;

    const start = performance.now();
    cancelAnimationFrame(rafRef.current);
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setValue(Math.round(from + (to - from) * eased));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = to;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration, disabled]);

  return value;
}

/**
 * Rotating status line. Picks a fresh (non-repeating) template on phase change
 * and every ~2.5s thereafter. The chosen *template* is stored, not the filled
 * string, so live values (the download count) are interpolated on each render
 * without resetting the rotation timer.
 */
function useRotatingTemplate(phase, props) {
  const [template, setTemplate] = React.useState("");
  const prevRef = React.useRef(null);
  const ctxKey = contextualKey(props);

  React.useEffect(() => {
    const templates = resolveLines(phase, props);
    const pick = () => {
      const next = pickNoRepeat(templates, prevRef.current);
      prevRef.current = next;
      setTemplate(next || "");
    };
    pick(); // immediately on phase / applicability change
    const id = setInterval(pick, 2500);
    return () => clearInterval(id);
    // ctxKey (not the whole props object) keeps the timer stable across count
    // ticks; it only resets when the phase or which contextual lines apply changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, ctxKey]);

  return template;
}

/** Debounce a value so the aria-live region announces at most every `ms`. */
function useDebounced(value, ms) {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

/* ── Mascot avatar ─────────────────────────────────────────────────────── */

/**
 * The hippo mascot. Uses the existing `/prohippo-mark.png` asset; if it ever
 * goes missing it degrades to an emoji placeholder.
 * TODO: swap in a dedicated cheeky-hippo illustration/sprite here when design
 * produces one — this file is the only place that references the asset.
 */
function HippoAvatar({ celebrate }) {
  const [broken, setBroken] = React.useState(false);
  return broken ? (
    <div
      className={"chp-avatar" + (celebrate ? " chp-avatar--celebrate" : "")}
      aria-hidden="true"
    >
      <span className="chp-avatar-fallback">🦛</span>
    </div>
  ) : (
    <img
      src="/prohippo-mark.png"
      alt="" /* decorative — the status text carries meaning */
      aria-hidden="true"
      className={"chp-avatar" + (celebrate ? " chp-avatar--celebrate" : "")}
      onError={() => setBroken(true)}
    />
  );
}

/* ── Component ─────────────────────────────────────────────────────────── */

/**
 * @param {CheekyHippoProgressProps} props
 */
export default function CheekyHippoProgress({
  phase,
  totalPdfs,
  downloadedCount = 0,
  noticeCounts,
  currentFileName,
  errorMessage,
  onRetry,
}) {
  const reduce = usePrefersReducedMotion();

  const total = Number(totalPdfs) || 0;
  const done = clamp(Number(downloadedCount) || 0, 0, total || Infinity);
  const isDeterminate = phase === "downloading" && total > 0;
  const pct = isDeterminate ? clamp(Math.round((done / total) * 100), 0, 100) : null;

  const props = { phase, totalPdfs, downloadedCount, noticeCounts, currentFileName, errorMessage };
  const template = useRotatingTemplate(phase, props);

  const animatedCount = useCountUp(done, { disabled: reduce });
  const displayCount = reduce ? done : animatedCount;

  const line = fillTemplate(template, {
    current: displayCount,
    total,
    remaining: Math.max(0, total - done),
    reassessment: noticeCounts?.reassessment ?? 0,
    penalty: noticeCounts?.penalty ?? 0,
    appeal: noticeCounts?.appeal ?? 0,
    assessment: noticeCounts?.assessment ?? 0,
    currentFileName: truncateName(currentFileName),
  });

  // Debounced announcement so screen readers aren't spammed as the count ticks.
  const announced = useDebounced(line, 1400);

  // Milestone micro-celebration at 50% and 100% (and on the done state).
  const [burst, setBurst] = React.useState(null);
  const prevPctRef = React.useRef(0);
  React.useEffect(() => {
    if (reduce) return;
    if (pct != null) {
      const prev = prevPctRef.current;
      if (prev < 50 && pct >= 50) fire("✨");
      if (prev < 100 && pct >= 100) fire("🎉");
      prevPctRef.current = pct;
    }
    function fire(emoji) {
      setBurst(emoji);
      setTimeout(() => setBurst(null), 900);
    }
  }, [pct, reduce]);

  React.useEffect(() => {
    if (phase === "done" && !reduce) {
      setBurst("🎉");
      const id = setTimeout(() => setBurst(null), 900);
      return () => clearTimeout(id);
    }
  }, [phase, reduce]);

  const isError = phase === "error";
  const isEmpty = phase === "empty";
  const isDone = phase === "done";

  // Progressbar a11y: real values in Phase B; aria-busy in the indeterminate
  // phases so assistive tech knows work is ongoing without a bogus number.
  const barA11y = isDeterminate
    ? {
        role: "progressbar",
        "aria-valuemin": 0,
        "aria-valuemax": total,
        "aria-valuenow": done,
        "aria-valuetext": `${done} of ${total} downloaded`,
      }
    : { role: "progressbar", "aria-busy": !isDone && !isError && !isEmpty };

  return (
    <div className="chp animate-in" role="group" aria-label="Portal fetch progress">
      <div className="chp-head">
        <HippoAvatar celebrate={Boolean(burst)} />
        {burst && (
          <span className="chp-burst" aria-hidden="true">
            {burst}
          </span>
        )}
        <div className="chp-status">
          <div className="chp-line" aria-hidden="true">
            {line || " "}
          </div>
          {phase === "downloading" && currentFileName && (
            <div className="chp-sub" title={currentFileName}>
              {truncateName(currentFileName)}
            </div>
          )}
        </div>
      </div>

      {/* Bar: hidden for empty/error, which are terminal non-progress states. */}
      {!isEmpty && !isError && (
        <div className="chp-track" {...barA11y}>
          {isDeterminate ? (
            <div className="chp-fill" style={{ width: `${pct}%` }} />
          ) : isDone ? (
            <div className="chp-fill chp-fill--done" />
          ) : (
            <div className="chp-fill chp-fill--indeterminate" />
          )}
        </div>
      )}

      {/* Determinate meta row: count-up "X of N" + percentage. */}
      {isDeterminate && (
        <div className="chp-meta">
          <span>
            <span className="chp-count">{displayCount}</span> of {total} notices
          </span>
          <span className="chp-pct">{pct}%</span>
        </div>
      )}

      {/* Downloading with no known total (scrape fallback): honest running count,
          no fake denominator or percentage. */}
      {phase === "downloading" && !isDeterminate && (
        <div className="chp-meta">
          <span>
            <span className="chp-count">{displayCount}</span>{" "}
            {displayCount === 1 ? "notice" : "notices"} fetched
          </span>
        </div>
      )}

      {/* Error: copy is already in `line`; always pair it with Retry. */}
      {isError && (
        <div className="chp-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={onRetry}>
            <Icon name="arrow-right" size={13} />
            Try again
          </button>
          {errorMessage && (
            <span className="chp-sub" title={errorMessage}>
              {errorMessage}
            </span>
          )}
        </div>
      )}

      {isDone && (
        <div className="chp-meta">
          <span className="chp-count">
            <Icon name="check" size={13} /> All done
          </span>
        </div>
      )}

      {/* Debounced polite live region for screen readers. */}
      <span className="chp-sr-only" role="status" aria-live="polite">
        {announced}
      </span>
    </div>
  );
}

/** Truncate a long filename in the middle so the extension stays visible. */
function truncateName(name, max = 34) {
  if (!name || name.length <= max) return name || "";
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
}
