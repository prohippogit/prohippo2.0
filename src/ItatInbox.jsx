/* ProHippo — what arrived from the Tribunal, waiting for one look.
 *
 * Every email the practice's ITAT address receives lands here with its fields
 * already read; a practitioner presses Confirm and the matter or hearing is
 * written. Nothing applies itself, on purpose — an address that receives mail
 * from the internet can be sent a convincing forgery, and a hearing date in
 * somebody's diary on the wrong day is the mistake this app exists to prevent.
 *
 * The card is deliberately quiet when the queue is empty: it renders nothing at
 * all rather than an "all clear" panel nobody needs to read every morning.
 */
import React from "react";
import { Icon, SelectInput, titleCase, fmtDateLong } from "./shared";
import { useData } from "./store";
import { useItatMail, itatEmailActions, describeMail, MAIL_KIND_LABEL, relativeTime } from "./itatEmail";

const KIND_TINT = {
  registration: { bg: "var(--p-lavender-2)", fg: "var(--p-primary-2)" },
  hearing: { bg: "var(--p-mint)", fg: "#1B8C5C" },
  unrecognised: { bg: "var(--p-card-tint)", fg: "var(--p-text-3)" },
};

// The fields worth showing before someone commits to them. Anything the parser
// could not find is left out rather than shown blank — a row of empty labels
// reads as a broken screen, and what matters is what WAS read.
function factsOf(row) {
  const f = row.parsed || {};
  const facts = [];
  if (f.appealNo) facts.push(["Appeal", f.appealNo]);
  if (f.appellant) facts.push(["Appellant", titleCase(f.appellant)]);
  if (f.ay) facts.push(["AY", f.ay]);
  if (f.pan) facts.push(["PAN", f.pan]);
  if (f.date) facts.push(["Hearing", `${fmtDateLong(f.date)}${f.time ? ` · ${f.time}` : ""}`]);
  if (f.bench) facts.push(["Bench", f.bench]);
  if (f.filedOn) facts.push(["Filed", fmtDateLong(f.filedOn)]);
  if (f.caseType) facts.push(["Case type", f.caseType]);
  return facts;
}

function MailRow({ row }) {
  const { data, notify } = useData();
  const [busy, setBusy] = React.useState("");
  const [err, setErr] = React.useState("");

  /* The assessee the backend matched, unless the practitioner has picked
     someone else. Held as null-means-not-overridden rather than copied into
     state, so a match that arrives after this row first rendered — the
     subscription can deliver the email before the assessee list has streamed in
     — is picked up without an effect racing the user's own choice. */
  const [override, setOverride] = React.useState(null);
  const assesseeId = override ?? (row.assesseeId || "");
  const setAssesseeId = setOverride;

  const tint = KIND_TINT[row.kind] || KIND_TINT.unrecognised;
  const chosen = data.assessees.find((a) => a.id === assesseeId);

  /* With nobody on file for this PAN, the email itself opens the client — the
     PAN is an exact key, so a name and a PAN together are a file, not a guess.
     Said on the button before it is pressed, because "Confirm" quietly adding a
     client to somebody's list is not a confirmation of anything. */
  const f = row.parsed || {};
  const willCreate = !chosen && Boolean(f.pan) && Boolean(f.appellant);
  const canApply = row.kind !== "unrecognised" && Boolean(f.appealNo) && (Boolean(chosen) || willCreate);

  const run = (label, fn) => async () => {
    setBusy(label);
    setErr("");
    try { await fn(); }
    catch (e) { console.error(e); setErr(e?.message || "That didn't go through. Try again."); }
    finally { setBusy(""); }
  };

  const confirm = run("apply", async () => {
    const out = await itatEmailActions.apply({ id: row.id, assesseeId });
    const what = row.kind === "hearing" ? "Hearing added to your calendar" : "Matter added";
    // Say when a client was opened. It is the one side effect a practitioner
    // would otherwise only discover later, in a list that has grown by one.
    notify(out?.createdAssessee ? `${titleCase(out.assesseeName || "Assessee")} added · ${what.toLowerCase()}` : what);
  });

  const dismiss = run("dismiss", async () => {
    await itatEmailActions.dismiss({ id: row.id });
    notify("Email dismissed");
  });

  return (
    <div style={{ padding: "14px 0", borderTop: "1px solid var(--p-line-2)" }}>
      <div className="between" style={{ gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
        <div className="center" style={{ gap: 9 }}>
          <span className="pill" style={{ background: tint.bg, color: tint.fg }}>
            {MAIL_KIND_LABEL[row.kind] || "Email"}
          </span>
          <span style={{ fontSize: 13.5, fontWeight: 650 }}>{row.parsed?.appealNo || row.subject || "(no subject)"}</span>
        </div>
        <span className="muted" style={{ fontSize: 12 }}>
          {relativeTime(row.receivedAt)}
          {row.forwardedBy ? ` · via ${row.forwardedBy}` : ""}
        </span>
      </div>

      {factsOf(row).length > 0 && (
        <div className="row" style={{ gap: 18, flexWrap: "wrap", marginBottom: 10 }}>
          {factsOf(row).map(([label, value]) => (
            <div key={label}>
              <div className="muted" style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: ".07em", textTransform: "uppercase" }}>{label}</div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{value}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: 12.5, color: "var(--p-text-2)", marginBottom: 10 }}>{describeMail(row)}</div>

      {row.kind === "unrecognised" ? (
        <div className="muted" style={{ fontSize: 12.5 }}>
          Kept so you can see it. ProHippo did not recognise this as a registration
          or a notice of hearing — if the Tribunal has changed its wording, this is
          where it shows.
        </div>
      ) : (
        <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ minWidth: 220, flex: "1 1 220px" }}>
            <SelectInput
              value={chosen ? chosen.id : ""}
              onChange={setAssesseeId}
              options={data.assessees.map((a) => ({ value: a.id, label: `${titleCase(a.name)} · ${a.pan || "no PAN"}` }))}
              placeholder={willCreate ? `Open ${titleCase(f.appellant)}'s file` : data.assessees.length ? "Which assessee?" : "No assessees yet"}
            />
          </div>
          <button className="btn btn-primary btn-sm" disabled={!canApply || Boolean(busy)} style={{ opacity: canApply && !busy ? 1 : 0.5 }} onClick={confirm}>
            <Icon name="check" size={13} />
            {busy === "apply" ? "Adding…" : willCreate ? "Confirm & add client" : "Confirm"}
          </button>
          <button className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={dismiss}>
            {busy === "dismiss" ? "…" : "Dismiss"}
          </button>
        </div>
      )}

      {/* The PAN on the email is what found the assessee. When it found nobody,
          say what pressing the button will do about it — a file opened from the
          email, or nothing until somebody picks one. */}
      {!chosen && row.kind !== "unrecognised" && (
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          {willCreate
            ? `Nobody on file with PAN ${f.pan}. Confirming opens ${titleCase(f.appellant)}${f.appellantAddress ? ", with the address on this notice" : ""}. Pick someone above instead if this appeal is already on file under another PAN.`
            : f.pan
              ? `No assessee on file with PAN ${f.pan}, and this email does not name one. Add them, or pick the right one above.`
              : "No PAN was found in this email — choose the assessee yourself."}
        </div>
      )}

      {err && <div style={{ fontSize: 12.5, color: "var(--p-danger)", marginTop: 8 }}>{err}</div>}
    </div>
  );
}

export default function ItatInbox() {
  const { rows, loading } = useItatMail();
  if (loading || rows.length === 0) return null;

  const actionable = rows.filter((r) => r.status === "needs-review").length;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="between" style={{ gap: 12, flexWrap: "wrap" }}>
        <div className="center" style={{ gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 11, background: "var(--p-card-tint)", color: "var(--p-primary)", display: "grid", placeItems: "center" }}>
            <Icon name="mail" size={17} />
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14 }}>From the Tribunal</div>
            <div className="muted" style={{ fontSize: 12 }}>
              {actionable
                ? `${actionable} email${actionable === 1 ? "" : "s"} to check — nothing is added until you confirm`
                : "Nothing to confirm"}
            </div>
          </div>
        </div>
      </div>
      {rows.map((row) => <MailRow key={row.id} row={row} />)}
    </div>
  );
}
