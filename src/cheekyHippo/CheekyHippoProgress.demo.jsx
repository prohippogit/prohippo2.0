/*
 * ProHippo — CheekyHippoProgress lifecycle demo.
 *
 * A self-contained harness that drives the component through the whole flow
 * (auth → list → downloading with a mock counter ticking up → processing →
 * done) so you can preview the mascot without hitting the real portal.
 *
 * Quick preview: temporarily render <CheekyHippoDemo /> from App.jsx, e.g.
 *   import CheekyHippoDemo from "./cheekyHippo/CheekyHippoProgress.demo.jsx";
 *   // ...then drop <CheekyHippoDemo /> somewhere in the tree.
 *
 * The controls also let you jump straight to the empty / error states.
 */

import React from "react";
import CheekyHippoProgress from "./CheekyHippoProgress.jsx";

const TOTAL = 12;

export default function CheekyHippoDemo() {
  const [state, setState] = React.useState({
    phase: "authenticating",
    totalPdfs: undefined,
    downloadedCount: 0,
    currentFileName: undefined,
    noticeCounts: undefined,
    errorMessage: undefined,
  });

  const timers = React.useRef([]);
  const later = (fn, ms) => {
    const id = setTimeout(fn, ms);
    timers.current.push(id);
  };
  const clearAll = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };

  const runHappyPath = React.useCallback(() => {
    clearAll();
    setState({ phase: "authenticating", totalPdfs: undefined, downloadedCount: 0, currentFileName: undefined, noticeCounts: undefined, errorMessage: undefined });

    // Phase A: login (indeterminate, unknown duration).
    later(() => setState((s) => ({ ...s, phase: "fetchingList" })), 2600);

    // List returns → totalPdfs known, flip to determinate downloading.
    later(
      () =>
        setState((s) => ({
          ...s,
          phase: "downloading",
          totalPdfs: TOTAL,
          noticeCounts: { assessment: 5, penalty: 3, reassessment: 2, appeal: 2 },
        })),
      5200
    );

    // Mock counter ticking up, one PDF at a time.
    const names = [
      "143(2)-scrutiny-notice-AY2023-24.pdf",
      "142(1)-questionnaire.pdf",
      "148A(b)-show-cause-reassessment.pdf",
      "271(1)(c)-penalty-notice.pdf",
      "Assessment-Order-u-s-143(3)-AY2022-23-final-signed.pdf",
    ];
    for (let i = 1; i <= TOTAL; i++) {
      later(() => {
        setState((s) => ({
          ...s,
          phase: "downloading",
          downloadedCount: i,
          currentFileName: names[i % names.length],
        }));
      }, 5200 + i * 700);
    }

    // Brief processing, then done.
    const afterDownloads = 5200 + TOTAL * 700 + 500;
    later(() => setState((s) => ({ ...s, phase: "processing", currentFileName: undefined })), afterDownloads);
    later(() => setState((s) => ({ ...s, phase: "done" })), afterDownloads + 2200);
  }, []);

  React.useEffect(() => {
    runHappyPath();
    return clearAll;
  }, [runHappyPath]);

  const jump = (patch) => {
    clearAll();
    setState((s) => ({ ...s, ...patch }));
  };

  return (
    <div style={{ maxWidth: 460, margin: "40px auto", display: "flex", flexDirection: "column", gap: 16 }}>
      <CheekyHippoProgress
        {...state}
        onRetry={runHappyPath}
      />

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button className="btn btn-primary btn-sm" onClick={runHappyPath}>
          Replay full flow
        </button>
        <button className="btn btn-secondary btn-sm" onClick={() => jump({ phase: "empty" })}>
          Empty state
        </button>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => jump({ phase: "error", errorMessage: "ITD portal returned 503 (service unavailable)." })}
        >
          Error state
        </button>
      </div>

      <pre style={{ fontSize: 11, color: "var(--p-text-3)", background: "var(--p-card-tint)", padding: 10, borderRadius: 10, overflow: "auto" }}>
        {JSON.stringify(state, null, 2)}
      </pre>
    </div>
  );
}
