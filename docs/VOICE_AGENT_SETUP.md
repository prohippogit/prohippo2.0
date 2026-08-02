# Inbound voice agent (Sarvam) — setup

A practitioner rings a number and gets a colleague who knows the whole app:
where every screen is, what is listed this week, which client hasn't paid. It
answers in English, Hindi or Gujarati, reads only that caller's own records, and
changes nothing.

```
inbound call ─► Sarvam agent (voice, language, turn-taking)
                     │  HTTPS + HMAC
                     ▼
              sarvamVoiceWebhook  (functions/voiceAgent.js)
                     │
                     ├─ identify caller by number  → Firebase Auth
                     ├─ guardrail                  → functions/voiceKnowledge.js
                     └─ read                       → users/{uid}/… only
```

Four one-time steps: set the secret, deploy, create the agent, point a number at
it.

---

## What it can and cannot do — read this before configuring anything

**Identity is the caller's number, and nothing else.** The webhook resolves it
with `admin.auth().getUserByPhoneNumber()` — the same lookup SMS login uses, so a
number that can sign in is a number that can call. A number we don't recognise
gets no account data at all: not a partial answer, not a hint. It can still be
told what the app does, because that is a product manual and not anybody's data.

**It is read-only.** Seven tools, all reads. Nothing adds, edits, deletes, sends
or files. A misheard word must never become a changed hearing date, and the
dispatcher refuses any tool name outside the table regardless of what the model
asks for.

**Company internals are refused in code, not just in the prompt.** API keys,
customer counts, revenue, another account's data, the admin console — the
patterns are in `functions/voiceKnowledge.js` and are checked on the way in
(the caller's words *and* the model's own tool arguments) and on the way out
(`scrub`). A prompt can be argued with; a regex cannot. **An admin calling this
line is just a caller** — caller ID is not an authentication factor, so there is
no elevated mode to reach. Admin work stays behind a signed-in session at
`/admin`.

**It gives no tax opinions.** Not because it's secret, but because a support line
should not be advising a practising CA on their own file.

The tests that hold all of this up: `node functions/voiceAgentCore.test.mjs`.

---

## Step 1 — Set the webhook secret

The webhook rejects **every** request until this exists. That is deliberate: the
endpoint reads a practitioner's client list out loud.

```bash
openssl rand -base64 32 | firebase functions:secrets:set SARVAM_WEBHOOK_SECRET
```

Keep the value — Sarvam needs the same string in step 3.

## Step 2 — Deploy

```bash
firebase deploy --only functions:sarvamVoiceWebhook
```

The URL it prints is what Sarvam calls. It is single-region (`asia-south1`,
co-located with Firestore) because there is exactly one URL configured upstream:

```
https://asia-south1-<project>.cloudfunctions.net/sarvamVoiceWebhook
```

## Step 3 — Create the agent on Sarvam

Print the configuration this repository holds, and paste it in:

```bash
node scripts/print-voice-agent-config.mjs          # prompt + tools, readable
node scripts/print-voice-agent-config.mjs --json   # tools only, machine-readable
```

**The prompt and the tool list are code, not dashboard settings.** They are built
from `functions/voiceKnowledge.js` and `buildSystemPrompt()` so that what the
agent is *told* and what the server *enforces* cannot drift apart. Re-run the
script and re-paste after editing either, or the agent will confidently send
callers to screens that have moved.

In the Sarvam agent, set:

| Setting | Value |
| --- | --- |
| System prompt | section 1 of the script output |
| First message | section 2 (or leave the agent to use `first_message` from the webhook) |
| Tools | all seven from section 3, each pointing at the webhook URL, `POST` |
| Webhook secret | the value from step 1 |
| Languages | English, Hindi, Gujarati (add others as you need them) |
| Events | send `call.started` and `call.ended` to the same URL |

If the agent supports prompt variables, wire `caller_name`, `caller_firm` and
`caller_known` — the webhook returns them at session start, which is what lets
the agent open with a name instead of asking who it is speaking to. If it does
not support them, leave the unknown-caller prompt in place; the webhook still
refuses account data to an unidentified caller whatever the prompt says.

## Step 4 — Point a number at it, and switch the card on

Provision the inbound number on Sarvam and attach it to the agent. Then put the
number into `src/voiceConfig.js`:

```js
export const VOICE_HELPLINE = "+91 79 4890 1234";
```

The Settings → Integrations card goes from "Not configured" to "Live", shows the
number as a tap-to-call button, and — the useful part — warns anyone whose
mobile isn't linked that the line won't recognise them, **before** they ring it.

---

## Confirming the payload contract

`parseRequest()` and `toolResponse()` in `functions/voiceAgentCore.js` are the
only two places that touch Sarvam's field names. They accept every spelling
these things go by across agent platforms (`tool_name` / `function.name` /
`name`; `from` / `caller_id` / `call.from`), and the reply is populated into
`speech`, `result`, `output` and `response` at once, so whichever field Sarvam
reads gets the same words.

That breadth is a deliberate hedge, not a substitute for checking. Confirm the
exact request and response shapes against
<https://docs.sarvam.ai/conversations/overview> and, if they differ from every
alternative listed, adjust those two functions — **nothing else in the feature
needs to change**, because everything downstream speaks our own shape.

The same applies to the signature header. `verifyWebhook()` accepts
`x-sarvam-signature`, `sarvam-signature`, `x-signature`, `x-webhook-signature`
and `x-hub-signature-256`, hex or base64, bare or `sha256=`-prefixed, and
handles a `<timestamp>.<body>` signing scheme if that is what Sarvam uses. If it
signs something else again, `SIGNATURE_HEADERS` and `verifyWebhook` are the
place to say so.

---

## Testing before a number is live

```bash
# 1. A signed session-start for a registered number.
BODY='{"event":"call.started","from":"+919825011234","call_id":"test-1"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SARVAM_WEBHOOK_SECRET" -hex | sed 's/^.* //')
curl -sS -X POST "$URL" -H 'content-type: application/json' \
  -H "x-sarvam-signature: $SIG" -d "$BODY"
# → { "known": true, "speech": "Hello Jayesh, ProHippo here…" }

# 2. The same call from a number nobody has linked → known:false, no data.
# 3. An unsigned request → 401. This one matters most; check it after every deploy.
```

For the guardrails themselves, the unit tests are faster and cover more than a
curl loop will:

```bash
node functions/voiceAgentCore.test.mjs
```

They pin both directions — that "what is ProHippo's revenue" is refused, *and*
that "what is the turnover of Shah Textiles" is not. A line that refuses a CA's
own vocabulary is as broken as one that leaks; the second list is why the money
words are only restricted when they are pointed at the company.

---

## Limits, cost and what gets recorded

**Rate limits** (`voiceRateLimits/{uid}`, Admin-SDK only): 30 calls and 300
look-ups per account per day. Voice minutes cost real money and a wedged agent
can loop; this is the ceiling that keeps one bad afternoon off the card. Change
them in `RATE_LIMITS` in `voiceAgentCore.js`.

**Cost.** Minutes are metered through the same `recordSpend` as everything else
(`vendor: "sarvam"`, `sku: "voice-agent"`, `units` = minutes). The per-minute
rate is **deliberately unpriced** in `functions/pricing.js` — same reasoning as
the escalation Gemini model: a made-up rate is worse than a visible gap, so these
show on the Costs page under "no rate" until you enter the real figure off a
Sarvam invoice and bump `RATE_VERSION`.

**The call log** is the one write in the whole module:
`users/{uid}/voiceCalls/{callId}` — start, end, duration, language and which
tools ran. It lives under `users/{uid}` so the practitioner can see their own
line's history, covered by the same Firestore rule as the rest of their data. No
rules change was needed for this feature, and none should be needed to extend
it — if a change to `firestore.rules` ever looks necessary here, something has
reached outside `users/{uid}` and should be reconsidered instead.

The caller's number is masked (`+91••••••1234`) even in that log: the account
already knows its own number, and an unmasked copy buys nothing.

---

## Adding a feature to what the agent knows

Edit `FEATURES` in `functions/voiceKnowledge.js` — one entry per screen, written
the way you would say it out loud, with the words callers actually use in
`keywords` (including Roman-script Hindi/Gujarati; speech-to-text produces
both). `route` must be a real id from `NAV_ITEMS` in `src/Sidebar.jsx`; the test
suite fails if it isn't, which is the whole reason that test exists.

Then re-run `node scripts/print-voice-agent-config.mjs` and re-paste the prompt.

**Nothing confidential goes in that file.** It is a product manual, and every
word of it can end up spoken down a phone line to whoever is holding the
handset.
