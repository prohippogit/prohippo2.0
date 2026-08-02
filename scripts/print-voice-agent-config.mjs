/*
 * Print the Sarvam agent configuration that lives in this repository.
 *
 * The system prompt and the tool definitions are CODE, not dashboard settings —
 * they are built from functions/voiceKnowledge.js and functions/voiceAgentCore.js
 * so the rules the agent is told and the rules the server enforces can never
 * drift apart. This script renders them for pasting into the Sarvam agent.
 *
 * Run after ANY change to voiceKnowledge.js or buildSystemPrompt(), and paste
 * the output over the agent's existing prompt and tools:
 *
 *   node scripts/print-voice-agent-config.mjs
 *   node scripts/print-voice-agent-config.mjs --json   # tools only, machine-readable
 *
 * Setup, end to end: docs/VOICE_AGENT_SETUP.md
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TOOLS, buildSystemPrompt, greeting } = require("../functions/voiceAgentCore.js");
const { FEATURES } = require("../functions/voiceKnowledge.js");

const WEBHOOK = "https://asia-south1-<your-firebase-project>.cloudfunctions.net/sarvamVoiceWebhook";

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ tools: TOOLS.map((t) => ({ ...t, url: WEBHOOK })) }, null, 2));
  process.exit(0);
}

const rule = (label) => `\n${"─".repeat(72)}\n${label}\n${"─".repeat(72)}\n`;

console.log(rule("1. SYSTEM PROMPT — paste into the agent's instructions"));
console.log(buildSystemPrompt(null));
console.log(
  "\n[The line under WHO YOU ARE SPEAKING TO is replaced per call: the webhook\n" +
  " returns caller_name / caller_firm / caller_known at session start. If your\n" +
  " agent supports prompt variables, use them there; if it does not, leave this\n" +
  " version in place — the webhook still refuses account data to an\n" +
  " unidentified caller regardless of what the prompt says.]"
);

console.log(rule("2. FIRST MESSAGE"));
console.log(`Known caller:    ${greeting({ known: true, name: "Jayesh Vyas" })}`);
console.log(`Unknown caller:  ${greeting({ known: false })}`);

console.log(rule(`3. TOOLS — ${TOOLS.length} of them, all pointed at the same webhook URL`));
console.log(`Webhook URL: ${WEBHOOK}`);
console.log("Method: POST   Auth: HMAC-SHA256 of the raw body, sent as x-sarvam-signature\n");
for (const t of TOOLS) {
  console.log(`▸ ${t.name}`);
  console.log(`  ${t.description}`);
  console.log(`  parameters: ${JSON.stringify(t.parameters)}\n`);
}

console.log(rule("4. WHAT THE AGENT KNOWS ABOUT THE APP"));
console.log(`${FEATURES.length} features, folded into the prompt above and searchable via find_feature:`);
for (const f of FEATURES) console.log(`  • ${f.label} → ${f.route}`);

console.log(rule("5. REMINDERS"));
console.log([
  "• Set SARVAM_WEBHOOK_SECRET before the agent goes live — the webhook rejects",
  "  every request until it is set, by design.",
  "• The agent is READ-ONLY. Do not add a tool that writes; the dispatcher would",
  "  refuse it anyway, and the refusal is the point.",
  "• Re-run this script and re-paste after editing functions/voiceKnowledge.js,",
  "  or the agent will describe screens that have moved.",
].join("\n"));
