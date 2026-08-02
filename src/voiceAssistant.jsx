/* ProHippo — the Settings card for the inbound voice help line.
 *
 * The line identifies a caller by their number and nothing else, so the single
 * most useful thing this card does is tell someone whose mobile ISN'T linked
 * that the line will not recognise them — before they ring it and find out.
 * Everything else here is expectation-setting.
 *
 * The agent itself is entirely server-side (functions/voiceAgent.js). This file
 * makes no calls to it and holds no secret.
 */
import React from "react";
import { collection, getDocs, limit, orderBy, query } from "firebase/firestore";
import { db } from "./firebase";
import { useAuth } from "./auth";
import { useData } from "./store";
import { Icon, fmtDateTime } from "./shared";
import { VOICE_HELPLINE, VOICE_HELPLINE_TEL, VOICE_ENABLED, VOICE_CAN, VOICE_CANNOT } from "./voiceConfig";

function Bullet({ icon, color, children }) {
  return (
    <div style={{display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12.5, lineHeight: 1.5}}>
      <span style={{flexShrink: 0, marginTop: 2, color, display: "inline-flex"}}><Icon name={icon} size={14}/></span>
      <span>{children}</span>
    </div>
  );
}

export default function VoiceHelpLineCard() {
  const { user } = useAuth();
  const { profile } = useData();
  const [recent, setRecent] = React.useState([]);

  const linked = Boolean(profile?.phoneVerified && profile?.phone) || Boolean(user?.phoneNumber);
  const callerNumber = profile?.phone || user?.phoneNumber || "";

  /* A one-shot read rather than a live subscription: this is a history list on
     a settings page, not something that has to update while you watch it. */
  React.useEffect(() => {
    if (!user?.uid || !VOICE_ENABLED) return;
    let cancelled = false;
    getDocs(query(collection(db, "users", user.uid, "voiceCalls"), orderBy("startedAt", "desc"), limit(3)))
      .then((snap) => { if (!cancelled) setRecent(snap.docs.map((d) => ({ id: d.id, ...d.data() }))); })
      .catch(() => {}); // no calls yet, or the index isn't warm — neither is worth a message
    return () => { cancelled = true; };
  }, [user?.uid]);

  return (
    <div className="card">
      <div className="between" style={{alignItems: "flex-start", marginBottom: 12}}>
        <div className="center" style={{gap: 12}}>
          <div style={{width: 42, height: 42, borderRadius: 12, background: "var(--p-card-tint)", color: "var(--p-primary)", display: "grid", placeItems: "center"}}>
            <Icon name="phone" size={18}/>
          </div>
          <div>
            <div style={{fontWeight: 700, fontSize: 14}}>Voice help line</div>
            <div className="muted" style={{fontSize: 12}}>Call and ask — a colleague who knows the whole app</div>
          </div>
        </div>
        {VOICE_ENABLED
          ? <span className="pill pill-success">Live</span>
          : <span className="pill pill-muted">Not configured</span>}
      </div>

      {VOICE_ENABLED ? (
        <>
          <a
            href={`tel:${VOICE_HELPLINE_TEL}`}
            className="btn btn-primary"
            style={{alignSelf: "flex-start", textDecoration: "none", marginBottom: 12}}
          >
            <Icon name="phone" size={14}/>{VOICE_HELPLINE}
          </a>

          {!linked && (
            /* The failure this card exists to prevent. */
            <div style={{background: "var(--p-card-tint)", borderLeft: "3px solid var(--p-danger)", borderRadius: 10, padding: "10px 12px", fontSize: 12.5, lineHeight: 1.5, marginBottom: 12}}>
              <strong>Link your mobile first.</strong> The line recognises you by the number you
              call from. Until a mobile is linked to this account it can't look up your practice —
              use “Link mobile” under Account, above.
            </div>
          )}
          {linked && callerNumber && (
            <div className="muted" style={{fontSize: 12, marginBottom: 12}}>
              Call from <strong>{callerNumber}</strong> — that's the number this account is known by.
            </div>
          )}

          <div className="col" style={{gap: 6, marginBottom: 10}}>
            {VOICE_CAN.map((line) => <Bullet key={line} icon="check" color="var(--p-success)">{line}</Bullet>)}
          </div>
          <div className="col" style={{gap: 6}}>
            {VOICE_CANNOT.map((line) => <Bullet key={line} icon="info" color="var(--p-warning)">{line}</Bullet>)}
          </div>

          {recent.length > 0 && (
            <div style={{marginTop: 14, borderTop: "1px solid var(--p-line)", paddingTop: 10}}>
              <div className="muted" style={{fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6}}>Recent calls</div>
              {recent.map((c) => (
                <div key={c.id} className="between" style={{fontSize: 12, padding: "3px 0"}}>
                  <span>{c.startedAt ? fmtDateTime(c.startedAt) : "—"}</span>
                  <span className="muted">
                    {c.durationSec ? `${Math.round(c.durationSec)}s` : "—"}
                    {c.tools?.length ? ` · ${c.tools.length} look-up${c.tools.length === 1 ? "" : "s"}` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="muted" style={{fontSize: 12.5, lineHeight: 1.6}}>
          Ring a number and ask ProHippo anything — where a screen is, what's listed this week,
          which client hasn't paid. It answers in English, Hindi or Gujarati, reads only your own
          records, and never changes anything.
          <br/><br/>
          The number isn't switched on yet. Once it is, it will appear here.
        </div>
      )}
    </div>
  );
}
