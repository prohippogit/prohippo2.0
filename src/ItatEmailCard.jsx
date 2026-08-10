/* ProHippo — Settings → the practice's ITAT email address, and how to point
 * Gmail at it.
 *
 * The Tribunal writes to whichever single address was entered on the portal when
 * the appeal was registered — usually the practitioner's own. So the setup that
 * covers most of a practice is one forwarding rule on that mailbox, done once,
 * by the one person in this story who is comfortable in Gmail's settings.
 *
 * Two things on this card are doing real work and look like decoration:
 *
 *   • The steps say "on a computer" first. Gmail's phone apps do not offer
 *     forwarding settings at all, and somebody who discovers that three steps in
 *     gives up rather than moving to a laptop.
 *   • They lead to a FILTER, not to Gmail's "forward a copy of incoming mail"
 *     switch. That switch would send this address the whole mailbox. Everything
 *     not from the Tribunal is discarded unread on arrival, but the right
 *     instruction is the one that never sends it in the first place.
 */
import React from "react";
import { Icon, TextInput } from "./shared";
import { useData } from "./store";
import { useItatEmailConfig, usePendingGmailCode, itatEmailActions, relativeTime, mailTally } from "./itatEmail";

const GMAIL_FORWARDING_URL = "https://mail.google.com/mail/u/0/#settings/fwdandpop";
const GMAIL_FILTERS_URL = "https://mail.google.com/mail/u/0/#settings/filters";
const TRIBUNAL_SENDER = "no-reply@itat.nic.in";
const MAIL_DOMAIN = "prohippo.info";

function Step({ n, children }) {
  return (
    <div className="row" style={{ gap: 10, alignItems: "flex-start", marginBottom: 10 }}>
      <div style={{
        flex: "none", width: 20, height: 20, borderRadius: 7, background: "var(--p-lavender-2)",
        color: "var(--p-primary-2)", fontSize: 11, fontWeight: 800, display: "grid", placeItems: "center", marginTop: 1,
      }}>{n}</div>
      <div style={{ fontSize: 12.5, lineHeight: 1.5, color: "var(--p-text-2)" }}>{children}</div>
    </div>
  );
}

export default function ItatEmailCard() {
  const { notify } = useData();
  const { cfg, loading, address, provided, connected } = useItatEmailConfig();
  const pendingCode = usePendingGmailCode();
  const [busy, setBusy] = React.useState("");
  const [err, setErr] = React.useState("");
  const [showSteps, setShowSteps] = React.useState(false);
  const [ownAddress, setOwnAddress] = React.useState("");

  const run = (label, fn) => async () => {
    setBusy(label);
    setErr("");
    try { await fn(); }
    catch (e) { console.error(e); setErr(e?.message || "Something went wrong. Please try again."); }
    finally { setBusy(""); }
  };

  /* Minting is idempotent, so asking on mount is safe and means the address is
     simply there when someone opens Settings looking for it.

     A failure here USED TO go to console.error alone, which left the card
     saying "Preparing your address…" for ever — the reader had no way to tell a
     slow call from a backend that was never deployed, and nothing to press. A
     spinner that cannot fail is a lie; say what went wrong and offer the retry. */
  const [minting, setMinting] = React.useState(false);
  const [mintErr, setMintErr] = React.useState("");

  const mint = React.useCallback(async () => {
    setMinting(true);
    setMintErr("");
    try {
      await itatEmailActions.ensureAddress();
    } catch (e) {
      console.error("itat address:", e);
      setMintErr(e?.message || "Could not reach ProHippo's server.");
    } finally {
      setMinting(false);
    }
  }, []);

  /* Called on every mount, EVEN WHEN AN ADDRESS IS ALREADY ON SCREEN.
   *
   * The obvious guard — skip it when we have an address — is what made an
   * earlier repair useless. getItatEmailAddress does not only mint: it also
   * re-registers an address whose alias went missing when the lookup key
   * changed. An account in that state has an address to display and a lookup
   * that resolves to nobody, so guarding on "do we have an address" skipped the
   * repair in exactly the case that needed it, and mail went on being accepted
   * and discarded.
   *
   * The call is idempotent and costs one round trip per visit to Settings.
   *
   * Fired from a timer rather than straight out of the effect body, because
   * mint() sets state the moment it is entered and a synchronous setState
   * inside an effect cascades renders. The ref keeps it to one attempt per
   * mount; after that the Try again button is the way back in. */
  const attempted = React.useRef(false);
  React.useEffect(() => {
    if (loading || attempted.current) return undefined;
    attempted.current = true;
    const id = setTimeout(mint, 0);
    return () => clearTimeout(id);
  }, [loading, mint]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      notify("Address copied");
    } catch {
      setErr("Couldn't copy — select the address and copy it by hand.");
    }
  };

  const useOwn = run("own", async () => {
    const wanted = ownAddress.trim();
    if (!window.confirm(`Receive ProHippo's ITAT email at ${wanted}?\n\nThe current address stops working at once, so any forwarding rule pointing at it must be changed.`)) return;
    await itatEmailActions.useAddress({ address: wanted });
    setOwnAddress("");
    notify("Now listening on your provider's address");
  });

  const reset = run("reset", async () => {
    if (!window.confirm("Get a new address? The current one stops working at once, and every forwarding rule pointing at it must be changed to the new one.")) return;
    await itatEmailActions.resetAddress();
    notify("New address issued — update your forwarding rule");
  });

  const statusPill = loading ? <span className="pill pill-muted">Checking…</span>
    : connected ? <span className="pill" style={{ background: "var(--p-mint)", color: "#1B8C5C" }}>Receiving</span>
      : <span className="pill pill-muted">Not set up yet</span>;

  /* What became of everything the address has taken. Shown only once some of it
     did NOT become a card, because that is the only time the numbers need
     reconciling: five emails forwarded and three on the queue is alarming until
     it says where the other two went. */
  const tally = mailTally(cfg);
  const unaccounted = tally.duplicate + tally.dropped;

  return (
    <div className="card">
      <div className="between" style={{ gap: 12, flexWrap: "wrap" }}>
        <div className="center" style={{ gap: 12 }}>
          <div style={{ width: 42, height: 42, borderRadius: 12, background: "var(--p-card-tint)", color: "var(--p-primary)", display: "grid", placeItems: "center" }}>
            <Icon name="mail" size={18} />
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14 }}>ITAT email</div>
            <div className="muted" style={{ fontSize: 12 }}>
              {connected
                ? `Last email ${relativeTime(cfg?.lastReceivedAt)}${cfg?.receivedCount ? ` · ${cfg.receivedCount} received` : ""}`
                : "Forward the Tribunal's emails here and they become matters and hearings"}
            </div>
          </div>
        </div>
        {statusPill}
      </div>

      {unaccounted > 0 && (
        <div className="muted" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.6 }}>
          {tally.total} email{tally.total === 1 ? "" : "s"} have reached this address
          {" — "}{tally.filed} put on the review list
          {tally.duplicate ? `, ${tally.duplicate} recognised as a copy of one already received` : ""}
          {tally.dropped ? `, ${tally.dropped} from senders other than the Tribunal and discarded unread` : ""}.
        </div>
      )}

      {/* Gmail's verification code. It appears here because Gmail sends it to
          THIS address to prove the address is real — so without showing it, the
          person setting up forwarding has no way to get it. */}
      {pendingCode && (
        <div style={{ marginTop: 14, padding: "14px 16px", borderRadius: 12, background: "var(--p-lavender)", border: "1px solid var(--p-lavender-2)" }}>
          <div className="muted" style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--p-primary-2)" }}>
            {pendingCode.code ? "Type this into Gmail" : "Gmail is waiting for you"}
          </div>
          {pendingCode.code && (
            <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: ".05em", fontVariantNumeric: "tabular-nums", margin: "6px 0 4px" }}>
              {pendingCode.code}
            </div>
          )}
          <div className="muted" style={{ fontSize: 12 }}>
            Gmail asked to forward {pendingCode.requester ? <b>{pendingCode.requester}</b> : "a mailbox"} here.
            {pendingCode.code ? " Paste the code into the box it is showing you — click the word Verify in Gmail if you cannot see one." : ""}
          </div>

          {/* The same email carries a one-click link, and it is the better
              route: Gmail hides the box the code goes in behind a word that
              does not look like a button. This finishes the handshake without
              anyone having to find it. */}
          {pendingCode.confirmUrl && (
            <a
              className="btn btn-primary btn-sm"
              href={pendingCode.confirmUrl}
              target="_blank"
              rel="noreferrer"
              style={{ marginTop: 10, textDecoration: "none" }}
            >
              <Icon name="check" size={13} />Confirm forwarding in Gmail
            </a>
          )}
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <div className="muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".07em", textTransform: "uppercase", marginBottom: 6 }}>
          Your practice address{provided ? " · from your mail provider" : ""}
        </div>
        <div className="between" style={{ gap: 10, padding: "10px 12px", borderRadius: 10, background: "var(--p-card-tint)", border: "1px solid var(--p-line-2)", flexWrap: "wrap" }}>
          <code style={{ fontSize: 13, fontWeight: 600, color: mintErr ? "var(--p-danger)" : "var(--p-primary-2)", wordBreak: "break-all" }}>
            {address || (mintErr ? "No address yet" : "Preparing your address…")}
          </code>
          {address
            ? <button className="btn btn-secondary btn-sm" onClick={copy}><Icon name="doc" size={13} />Copy</button>
            : <button className="btn btn-secondary btn-sm" disabled={minting} onClick={mint}>{minting ? "Trying…" : "Try again"}</button>}
        </div>

        {/* Named plainly, because the two likely causes have different fixes and
            the practitioner cannot see which applies from a spinner: the
            functions have not been deployed yet, or the browser cannot reach
            them. Both are worth saying out loud. */}
        {mintErr && (
          <div style={{ fontSize: 12, color: "var(--p-danger)", marginTop: 6, lineHeight: 1.5 }}>
            {mintErr} — if ProHippo's ITAT functions have just been deployed, give it a moment and press Try again.
          </div>
        )}
        <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
          Only mail from the Income Tax Appellate Tribunal is kept. Anything else is discarded unread
          {cfg?.droppedCount ? ` — ${cfg.droppedCount} so far` : ""}.
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <button className="btn btn-secondary btn-sm" onClick={() => setShowSteps((s) => !s)}>
          <Icon name={showSteps ? "chevron-down" : "chevron-right"} size={13} />
          How to forward the Tribunal's emails here
        </button>
      </div>

      {showSteps && (
        <div style={{ marginTop: 14, padding: "16px 18px", borderRadius: 12, background: "var(--p-card-tint)", border: "1px solid var(--p-line-2)" }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 12 }}>
            In the mailbox the Tribunal writes to — usually your own. Five minutes, once.
          </div>
          <Step n={1}>
            Open Gmail <b>on a computer</b>. Its phone apps do not offer these settings at all.
          </Step>
          <Step n={2}>
            Go to <a href={GMAIL_FORWARDING_URL} target="_blank" rel="noreferrer">Forwarding and POP/IMAP</a>,
            click <b>Add a forwarding address</b>, and paste the address above.
          </Step>
          <Step n={3}>
            Gmail sends a confirmation code here to check the address is real. It appears
            on this card — come back, copy it, and paste it into Gmail.
          </Step>
          <Step n={4}>
            Leave forwarding itself set to <b>Disable forwarding</b>. Then open{" "}
            <a href={GMAIL_FILTERS_URL} target="_blank" rel="noreferrer">Filters and Blocked Addresses</a>,
            create a filter with <b>From: {TRIBUNAL_SENDER}</b>, and tick <b>Forward it to</b> your address.
          </Step>
          <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.55, marginTop: 4 }}>
            Step 4 is the one that matters: Gmail also offers a “forward a copy of incoming mail”
            switch, which would send this address your whole inbox. The filter sends only what the
            Tribunal wrote.
          </div>
          {/* Not every mail provider will hand a practice an address on a
              domain we control — CloudMailin's free tier issues one on
              cloudmailin.net and charges for custom domains. Rather than make
              that a paid prerequisite, let the practice say what to expect. The
              rest of the feature never cared which domain the address was on. */}
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--p-line-2)" }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 4 }}>
              Your mail provider gave you a different address?
            </div>
            <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.5, marginBottom: 8 }}>
              Some only offer an address on their own domain unless you pay for a custom one.
              Paste theirs here and ProHippo will listen on it instead.
            </div>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 240px", minWidth: 200 }}>
                <TextInput value={ownAddress} onChange={setOwnAddress} placeholder="e.g. f6012235e360a493f857@cloudmailin.net" mono/>
              </div>
              <button className="btn btn-secondary btn-sm" disabled={!ownAddress.trim() || Boolean(busy)} onClick={useOwn}>
                {busy === "own" ? "Saving…" : "Use this address"}
              </button>
            </div>
          </div>

          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--p-line-2)" }}>
            <button className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={reset}>
              {busy === "reset" ? "Issuing…" : `Get a new ${MAIL_DOMAIN} address`}
            </button>
            <span className="muted" style={{ fontSize: 11.5, marginLeft: 8 }}>
              If this one has been shared with the wrong person.
            </span>
          </div>
        </div>
      )}

      {err && <div style={{ fontSize: 12.5, color: "var(--p-danger)", marginTop: 10 }}>{err}</div>}
    </div>
  );
}
