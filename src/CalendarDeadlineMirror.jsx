/* ProHippo — keeps users/{uid}/calendarDeadlines in step with what the practice
 * owes, so the Google Calendar sync engine never has to derive a deadline
 * itself. See the note at the top of googleCalendar.jsx for why that split
 * matters: src/appeals.js is the only place appeal limitation is worked out.
 */
import React from "react";
import { useAuth } from "./auth";
import { useData } from "./store";
import { buildDeadlines, fingerprintDeadlines, writeDeadlineMirror, useCalendarConfig } from "./googleCalendar";

/* Mounted once, renders nothing. Recomputes the mirror whenever the notices or
   matters it derives from change, and only while the user actually wants
   deadlines in their calendar — there is no point maintaining a mirror nobody
   reads. */
export function CalendarDeadlineMirror() {
  const { user } = useAuth();
  const { data, ready } = useData();
  const { cfg, connected } = useCalendarConfig();
  const uid = user?.uid;
  const enabled = connected && cfg?.syncDeadlines !== false;
  const lastWritten = React.useRef("");

  const rows = React.useMemo(() => (enabled && ready ? buildDeadlines(data) : []), [enabled, ready, data]);

  React.useEffect(() => {
    if (!uid || !enabled || !ready) return undefined;
    const print = fingerprintDeadlines(rows);
    if (print === lastWritten.current) return undefined;

    // A short delay coalesces the burst of writes a portal sync produces into
    // one mirror pass.
    const timer = setTimeout(() => {
      writeDeadlineMirror(uid, rows)
        .then(() => { lastWritten.current = print; })
        .catch((e) => console.error("calendar deadline mirror:", e));
    }, 1500);
    return () => clearTimeout(timer);
  }, [uid, enabled, ready, rows]);

  return null;
}
