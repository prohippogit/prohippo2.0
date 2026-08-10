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

What identifies an inbound caller is the **on-start hook**: an API tool set to
run *when the call starts*, which Sarvam fires once before the conversation
begins, passing the caller's number from telephony metadata. The webhook
resolves that number to an account and returns a `session_token` — the same
variable, bound to the same body field, verified by the same signature as the
"Call me" path. Two doors, one lock. See `identifyForCall()`.

The token is minted per call and lives fifteen minutes, which is a call.

**The console invariant that carries the security:** the hook's `caller_phone`
body field must be bound to an **agent variable**, never to "let the agent
decide". A model-filled field would mean anyone could say a number out loud and
be handed that account's token — worse than the caller-ID spoofing we already
accept. The webhook cannot tell the two bindings apart, so this is written down
rather than enforced.

An earlier version of this used Sarvam's **known-callers CSV**, and
`scripts/known-callers-csv.mjs` still generates one. It worked, but it was a
snapshot: someone who signed up this morning stayed a stranger until a human
re-ran the script and re-uploaded the file, and every row was a long-lived
bearer credential sitting in a spreadsheet. Keep it as a fallback if the hook
ever stops firing; don't run it as routine.

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

## Step 6 — The on-start hook, or the phone line knows nobody

Skip this and every account question on an inbound call comes back "I can only
look up records for a registered ProHippo account" — for callers who *are*
registered. Sarvam does not pass the caller's number to a mid-call tool; this
is what supplies it.

**Build → Agents →** *the agent* **→ Tools → Add tool → API tool.**

| Field | Value |
| --- | --- |
| Tool name | `identify_caller` |
| When should this tool run? | **When the call starts** |
| Method / URL | `POST` `https://asia-south1-prohippo2.cloudfunctions.net/sarvamVoiceWebhook/identify_caller` |
| Auth | Bearer → `PROHIPPO_WEBHOOK_SECRET` |
| Body | one field, `caller_phone`, bound via ⚙ → **Agent variable** → the telephony caller-number variable |

Then map the reply back onto agent variables — **Save reply into variables**, or
the `@` picker under *Send fields from the API response to the agent*:

| Response field | Agent variable |
| --- | --- |
| `session_token` | `session_token` |
| `caller_name` | `caller_name` |
| `caller_firm` | `caller_firm` |
| `caller_known` | `caller_known` |

Press **Send** once before using the `@` picker. Until Sarvam has seen a
response it has no field names to offer, and a hand-typed `@session_token` is
four literal characters that carry nothing — which cost us a day of believing
the tools were broken when they were answering perfectly into a void.

Two things that will bite:

- **`caller_phone` must be an agent variable, not "let the agent decide".** See
  the security note above; nothing in the code can check this for you.
- **`identify_caller` must stay on "When the call starts".** The console has
  been seen to revert this to "During the conversation" after a save — re-open
  the tool and confirm it stuck, because a hook that fires mid-conversation
  identifies nobody.

### If the hook cannot get the number — which is where we are

It can't, today. Sarvam's SDK exposes the caller as `user_identifier` on the
on-start tool context, but that is a property of a *self-hosted SDK tool*; a
console-configured API tool has no way to bind a body field to it. Declaring an
input variable of that name does not get it populated — we tested it, and the
field arrives empty. Sarvam confirmed the gap.

So identity is staged **ahead** of the call, through Sarvam's Cohorts API, and
`functions/voiceKnownCallers.js` keeps it current:

- **`syncVoiceKnownCallers`** runs nightly at 03:10 IST — outside the line's
  07:00–23:00 window, so a list is never swapped mid-call. It rebuilds the
  roster from every user with a verified mobile and uploads it as a cohort.
- **`syncVoiceKnownCallersNow`** is the same job as an admin-only callable, for
  when you have just onboarded someone and don't want to wait for tonight.

Two things it does that are worth knowing about:

- **It skips the upload when nothing has changed.** Sarvam creates a new cohort
  per upload and documents no delete, so an unconditional nightly job would
  leave a cohort a day behind it forever. The cohort's *name* carries the roster
  fingerprint, so an unchanged roster is a no-op.
- **…but not forever.** The name also carries a period counter that ticks every
  `COHORT_REFRESH_DAYS` (7), because the tokens expire after
  `COHORT_TOKEN_DAYS` (14) whether the roster moved or not. Without that, a
  practice with a settled client list would stop being recognised on an ordinary
  Tuesday with nothing failing anywhere.

It needs `deploymentId` in `functions/voiceAgentConfig.js` — the **inbound
deployment**, from its page URL (`.../deploy-v2/inbounds/{deployment_id}`), not
the agent id.

`scripts/known-callers-csv.mjs` still writes the same CSV by hand for **Deploy →
Inbound calls →** *the deployment* **→ Add known callers**. Keep it for
bootstrapping a new environment or for when the API is unavailable; it is not
part of the routine any more. Its output is a credential — gitignored, and
delete it after upload.

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
