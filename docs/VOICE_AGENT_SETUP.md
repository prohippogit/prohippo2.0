# Voice agent (Sarvam) — setup

A practitioner talks to a colleague who knows the whole app: where every screen
is, what is listed this week, which client hasn't paid. English, Hindi or
Gujarati. It reads only that person's own records, and changes nothing.

The ProHippo number is **+91 80715 82778** — the line users ring, and the number
"Call me" dials out from.

```
  ┌ inbound call ────────────► caller ID
  │                                          ┐
  └ "Call me" in the app ────► outbound API  │
      (Firebase session)        + signed token
                                             │
                              Sarvam agent ──┘ (voice, language, turn-taking)
                                    │  HTTPS + HMAC
                                    ▼
                       sarvamVoiceWebhook  (functions/voiceAgent.js)
                                    │
                                    ├─ identify   → token, else caller ID
                                    ├─ guardrail  → functions/voiceKnowledge.js
                                    └─ read       → users/{uid}/… only
```

---

## What it can and cannot do — read this before configuring anything

**There are two doors, and they are not equally strong.**

*"Call me" (`requestVoiceCallback`) is the good one.* The request arrives on an
authenticated callable, so Firebase has proved the uid before a line of the
function runs. ProHippo then dials **the number that account has verified** —
never a number from the request, which would make this a free outbound dialler
billed to us — and sends a signed, 15-minute token that the webhook checks. This
is what "the person who has signed up and logged in" actually means.

*Inbound goes through Sarvam's known-callers list, because it has to.* The
obvious design — resolve the number on the wire with
`admin.auth().getUserByPhoneNumber()` — cannot be built on this platform.
**Sarvam passes a tool only the body fields declared on that tool, and the
caller's number is not among them under any name.** That is not a reading of the
docs; it is what a live call logged:

```
voice: unidentified caller on upcoming_hearings — from=(none)
phoneish=[none] keys=[days, assessee, session_token]
```

The number-on-the-wire path is still in `identifyCaller()` and still correct if
a platform ever sends one. But what actually identifies an inbound caller today
is the **known-callers CSV**: upload a list of numbers against the inbound
deployment, and a call from one of them starts with that row's values already in
the agent's variables. We put a signed token in the `session_token` column — the
same variable, bound to the same body field, verified by the same signature as
the "Call me" path. Two doors, one lock.

The column could just as easily have held the caller's phone number, and that
would work. It holds a token instead because a body field is one dropdown away
from being model-filled rather than variable-bound, and the moment it is, anyone
can *say* a number and be believed. A caller who reads a token down the phone
still cannot produce an HMAC for it. See `scripts/known-callers-csv.mjs`.

A number we don't recognise gets no account data at all: not a partial answer,
not a hint. It can still be told what the app does, because that is a product
manual and not anybody's data.

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

## Step 1 — Set the secrets

The webhook rejects **every** request until the first of these exists. That is
deliberate: the endpoint reads a practitioner's client list out loud.

```bash
openssl rand -base64 32 | firebase functions:secrets:set SARVAM_WEBHOOK_SECRET
firebase functions:secrets:set SARVAM_API_KEY   # from the Sarvam console
```

Keep the webhook secret — Sarvam needs the same string in step 4. It does double
duty: it authenticates Sarvam's requests *and* signs the "Call me" session
tokens, so rotating it invalidates in-flight callbacks (they last 15 minutes;
rotate whenever you like).

`SARVAM_API_KEY` is only used server-side to place outbound calls. It never
reaches the browser — the app asks ProHippo to place a call, never Sarvam.

## Step 2 — Deploy

```bash
firebase deploy --only functions:sarvamVoiceWebhook,functions:requestVoiceCallback
```

The webhook URL it prints is what Sarvam calls. It is single-region
(`asia-south1`, co-located with Firestore) because there is exactly one URL
configured upstream:

```
https://asia-south1-<project>.cloudfunctions.net/sarvamVoiceWebhook
```

Put that URL into `functions/voiceAgentConfig.js` (`webhookUrl`) — the outbound
call carries it per-call in `webhook_config.url`.

## Step 3 — Build and upload the knowledge base

```bash
node scripts/print-voice-agent-config.mjs --kb
```

This writes `prohippo-app-guide.md` and prints the KB name and description to
use. Create the KB in **Knowledge base**, upload the file, and **wait for
ingestion to finish** before attaching it.

The file is generated, never hand-edited — it renders from `FEATURES` in
`functions/voiceKnowledge.js`, so it stays a build artifact of the same source
of truth the server enforces against rather than a second copy going stale. It
is gitignored for that reason.

Paste the printed description **verbatim**. Sarvam routes on it, and it is
written to pull the agent *toward* this KB for how-to questions and *away* from
it for account data and company internals — one more place the boundary is
stated, and the one the retrieval step actually reads.

Nothing confidential is in that file. A unit test asserts the generated
Markdown trips none of the restricted-topic patterns, so a pricing table or a
customer count pasted into `voiceKnowledge.js` fails the build rather than
reaching a phone line.

## Step 4 — Create the agent on Sarvam

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
| Knowledge base | attach **ProHippo app guide** from step 3 — this adds the query tool automatically, do not add it by hand |
| Webhook secret | the value from step 1 |
| Languages | English, Hindi, Gujarati (add others as you need them) |
| Events | send `call.started` and `call.ended` to the same URL |

The system prompt is deliberately an **index**, not a manual: it names the
screens and holds all the guardrails, and sends everything deeper to
`find_feature` or the KB. Every paragraph left in a prompt is a paragraph
competing with the refusal rules for the model's attention on every single turn.

If the agent supports prompt variables, wire `caller_name`, `caller_firm` and
`caller_known` — the webhook returns them at session start, which is what lets
the agent open with a name instead of asking who it is speaking to. If it does
not support them, leave the unknown-caller prompt in place; the webhook still
refuses account data to an unidentified caller whatever the prompt says.

## Step 5 — Attach the number, and fill in the outbound config

Attach **+91 80715 82778** to the agent for inbound. Then complete
`functions/voiceAgentConfig.js` — these are identifiers, not secrets, which is
why they live in code rather than in deploy-time parameters nobody can read
back:

| Field | Where it comes from |
| --- | --- |
| `orgId`, `workspaceId` | the trigger-call URL on the agent's page: `.../orgs/{org_id}/workspaces/{workspace_id}/outbounds` |
| `agentId` | the agent's id — `app_id` in the trigger-call body |
| `agentVersion` | optional; pin it to stop a console edit changing behaviour under a live feature |
| `connectionId` | the Connection dropdown on the trigger-call page |
| `agentPhoneNumber` | already set to +918071582778 |
| `webhookUrl` | from step 2 |

Until every required field is filled, `requestVoiceCallback` returns a clear
"not switched on yet" error rather than posting a half-formed request at Sarvam.

**Then, last of all, flip `VOICE_LIVE` to `true` in `src/voiceConfig.js`.**

That switch exists because Hosting deploys on every merge to the default branch
while Cloud Functions go out by hand — so there is a window where the card is
live in production and the callable it invokes is not. Knowing the number is not
the same as being ready to answer it. Until the flag flips, the Settings card
shows the feature as coming, which is true.

The card shows **Call me** as the primary action and the dial-in number
alongside it, and — the useful part — warns anyone whose mobile isn't linked
that neither path can work for them, **before** they try.

---

## Step 6 — Upload the known callers, or the phone line knows nobody

Skip this and every account question on an inbound call comes back "I can only
look up records for a registered ProHippo account" — for callers who *are*
registered. Sarvam does not tell a tool who is calling; this is what does.

```bash
npm --prefix functions install   # once
export SARVAM_WEBHOOK_SECRET="$(firebase functions:secrets:access SARVAM_WEBHOOK_SECRET --project prohippo2)"
node scripts/known-callers-csv.mjs
```

That writes `known-callers.csv` — one row per user with a verified mobile,
carrying their name, firm, and a signed token:

```
phone_number,caller_name,caller_firm,caller_known,session_token
9879166912,Vivek Chavda,Chavda & Associates,yes,v1.…
```

Upload it at **Deploy → Inbound calls →** *the deployment* **→ Add known
callers**. Sarvam matches the columns onto agent variables **by name**, so the
header row has to keep matching the variables on the agent — rename one and the
mapping silently stops.

Three things that will bite:

- **The file is a credential.** Each token grants read access to that account
  over the phone. It is gitignored; delete it once uploaded.
- **The tokens expire** — 180 days by default (`--days=`). Re-run and re-upload
  before then, or the line quietly stops recognising everybody.
- **A new user is not on the list.** Until someone re-runs this, they get the
  unregistered-caller answer. This is the honest weak point of the design: the
  list is a snapshot, and nothing yet keeps it in step with sign-ups.

---

## Confirming the payload contract

`parseRequest()` and `toolResponse()` in `functions/voiceAgentCore.js` are the
only two places that touch Sarvam's field names. They accept every spelling
these things go by across agent platforms (`tool_name` / `function.name` /
`name`; `from` / `caller_id` / `call.from`), and the reply is populated into
`speech`, `result`, `output` and `response` at once, so whichever field Sarvam
reads gets the same words.

That breadth is a deliberate hedge, not a substitute for checking. **The tool
webhook's request and response shapes are still unconfirmed** — Sarvam's
`/conversations/build/tools` page is the one to check them against. If they
differ from every alternative listed, adjust those two functions — **nothing
else in the feature needs to change**, because everything downstream speaks our
own shape.

What *is* confirmed, from the trigger-call quickstart: `app_config.app_id`,
`connection_config`, `agent_variables`, `app_overrides.initial_bot_message`,
`user_config.user_phone_number` and `webhook_config.{url,metadata}`. Those are
built in `buildOutboundCall()` and pinned by tests. The parser reads
`user_config.user_phone_number` for the inbound caller too, on the reasoning
that a platform which names the far end that way outbound is likely to name it
that way inbound — **verify this**; it is the one assumption the inbound
identity path rests on.

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

For the "Call me" path, call `requestVoiceCallback` from the app while signed in
with a linked mobile. Three failures to check deliberately, because each is a
control rather than an edge case:

- **not signed in** → `unauthenticated`
- **no linked mobile** → `failed-precondition`, pointing at Settings
- **config incomplete** → `failed-precondition`, and the log names the missing
  fields

There is no parameter for the number to call, and there must never be one:
accepting a destination would turn this into a free outbound dialler for anyone
with an account, billed to us. The only number it will ever ring is the one on
the Firebase user record, put there by `linkPhone` after an OTP proved
possession.

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
look-ups per account per day, counting inbound and "Call me" together. Voice
minutes cost real money and a wedged agent can loop; this is the ceiling that
keeps one bad afternoon off the card. Change them in `RATE_LIMITS` in
`voiceAgentCore.js`.

**Cost.** Minutes are metered through the same `recordSpend` as everything else
(`vendor: "sarvam"`, `sku: "voice-agent"`, `units` = minutes). The per-minute
rate is **deliberately unpriced** in `functions/pricing.js` — same reasoning as
the escalation Gemini model: a made-up rate is worse than a visible gap, so these
show on the Costs page under "no rate" until you enter the real figure off a
Sarvam invoice and bump `RATE_VERSION`.

A callback that Sarvam *rejects* is metered with `units: 0` — no minutes were
spent, and recording the attempt at zero says that without hiding it.

**The call log** is the one write in the whole module:
`users/{uid}/voiceCalls/{callId}` — start, end, duration, language, direction
and which tools ran. It lives under `users/{uid}` so the practitioner can see
their own line's history, covered by the same Firestore rule as the rest of
their data. No
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

Then re-run **both**, and re-paste / re-upload:

```bash
node scripts/print-voice-agent-config.mjs        # prompt + tools
node scripts/print-voice-agent-config.mjs --kb   # knowledge base file
```

The prompt only names the screens; the KB carries the detail. Regenerating one
and not the other leaves the agent naming a screen it can't describe.

**Nothing confidential goes in that file.** It is a product manual, and every
word of it can end up spoken down a phone line to whoever is holding the
handset. The test suite enforces this — the generated Markdown is checked
against the restricted-topic patterns.
