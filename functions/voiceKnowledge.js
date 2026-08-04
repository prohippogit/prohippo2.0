/*
 * ProHippo — what the voice agent is allowed to know about the app.
 *
 * This file is the agent's entire world model of ProHippo: one entry per
 * feature, written the way a colleague would say it out loud, not the way a
 * help page would print it. It is used twice —
 *
 *   1. FEATURES is folded into the agent's system prompt, so it can answer
 *      "where do I do X" without a round trip; and
 *   2. the `find_feature` tool searches it, so the agent has a deterministic
 *      fallback when the caller's words don't match anything it remembers.
 *
 * KEEP IT IN STEP WITH THE UI. The `route` of every entry is a real id from
 * NAV_ITEMS in src/Sidebar.jsx — if a route is renamed there and not here, the
 * agent will confidently send a caller to a screen that no longer exists.
 * voiceAgentCore.test.mjs pins the routes for exactly that reason.
 *
 * NOTHING CONFIDENTIAL GOES IN THIS FILE. It is a product manual, and every
 * word of it can end up spoken down a phone line to whoever is holding the
 * handset. Keys, rates, customer counts and internal architecture belong
 * nowhere near it — see RESTRICTED_PATTERNS below, which is the other half of
 * that rule.
 */
"use strict";

/*
 * `keywords` carry the words a caller actually says, which is rarely the word
 * printed on the button: "sunwai" for a hearing, "party" for an assessee,
 * "bill" for an invoice. Roman-script Hindi/Gujarati spellings are in here on
 * purpose — Sarvam transcribes an Indic answer into Devanagari or into Roman
 * depending on the caller, and the match has to survive both.
 */
const FEATURES = [
  {
    id: "dashboard",
    route: "dashboard",
    label: "Dashboard",
    what: "The home screen — today's hearings, what is due next, recent notices and a search box that finds any assessee by name or PAN.",
    where: "It is the first screen after you sign in, and the top item in the left sidebar.",
    steps: ["Tap the ProHippo logo or the first sidebar item, Dashboard."],
    keywords: ["dashboard", "home", "home screen", "overview", "first page", "landing", "summary", "ghar", "mukhya"],
  },
  {
    id: "assessees",
    route: "assessees",
    label: "Assessees",
    what: "Your client register. Every assessee with their PAN, status — individual, HUF, firm, company, LLP or trust — group, mobile, email and the staff member handling them. Opening one shows their full profile with tabs for Returns, Matters, Hearings, Notices, Invoices, Communications and Notes.",
    where: "Left sidebar, second item, Assessees.",
    steps: [
      "Open Assessees from the left sidebar.",
      "To add one, tap the Add assessee button at the top right and fill in the name and PAN.",
      "To open a client, tap their row — the profile opens with all their proceedings.",
    ],
    keywords: ["assessee", "assessees", "client", "clients", "party", "parties", "customer", "pan", "add client", "new client", "register", "group", "asami", "grahak"],
  },
  {
    id: "matters",
    route: "matters",
    label: "Matters",
    what: "Every proceeding you are running, tracked from notice to disposal — scrutiny, CIT appeal, ITAT, penalty and rectification — with the assessment year, section, bench, status, priority and the staff member on it.",
    where: "Left sidebar, third item, Matters.",
    steps: [
      "Open Matters from the left sidebar.",
      "Tap any row to jump straight into that proceeding inside the assessee's profile.",
    ],
    keywords: ["matter", "matters", "proceeding", "proceedings", "case", "cases", "scrutiny", "assessment", "penalty", "rectification", "143", "142", "271", "154", "kes", "kesh"],
  },
  {
    id: "hearings",
    route: "hearings",
    label: "Hearings & Calendar",
    what: "Your cause list — every scheduled hearing with its date, time, authority, bench and mode, whether physical, video conference or e-proceeding. It can also mirror your hearing dates into Google Calendar.",
    where: "Left sidebar, fourth item, Hearings.",
    steps: [
      "Open Hearings from the left sidebar.",
      "The calendar view shows the month; the list below it shows what is coming up next.",
      "To mirror dates into Google Calendar, go to Settings and connect Google Calendar.",
    ],
    keywords: ["hearing", "hearings", "cause list", "date", "dates", "next date", "calendar", "adjournment", "bench", "video conference", "sunwai", "sunvani", "tarikh", "tareekh"],
  },
  {
    id: "appeals",
    route: "appeals",
    label: "Appeals",
    what: "Orders that can still be appealed, with the limitation period counting down, so a thirty-day or sixty-day window never quietly closes.",
    where: "Left sidebar, fifth item, Appeals.",
    steps: [
      "Open Appeals from the left sidebar.",
      "Each card shows the order, the assessee and how many days are left to file.",
    ],
    keywords: ["appeal", "appeals", "cit appeal", "cita", "itat", "tribunal", "form 35", "form 36", "limitation", "time barred", "days left", "apeal"],
  },
  {
    id: "invoices",
    route: "invoices",
    label: "Invoices",
    what: "Raise professional fee invoices, record receipts against them, and see what is outstanding, partly paid or overdue. Invoices download as a PDF on your firm's letterhead.",
    where: "Left sidebar, sixth item, Invoices.",
    steps: [
      "Open Invoices from the left sidebar.",
      "Tap New invoice, pick the assessee, enter the service and the amount.",
      "To record a payment, open the invoice and add a receipt against it.",
    ],
    keywords: ["invoice", "invoices", "bill", "billing", "fee", "fees", "receipt", "receipts", "payment", "outstanding", "overdue", "recovery", "bil", "paisa", "vasooli"],
  },
  {
    id: "communications",
    route: "communications",
    label: "Communications",
    what: "Everything you have sent a client — WhatsApp messages and emails — built from templates like document requests, reminders and hearing confirmations, with the delivery status of each.",
    where: "Left sidebar, seventh item, Communications.",
    steps: [
      "Open Communications from the left sidebar to see the history.",
      "To send a new one, open the assessee and use Ask for documents, or pick a template from the Communications screen.",
    ],
    keywords: ["communication", "communications", "message", "messages", "whatsapp", "email", "mail", "reminder", "template", "document request", "ask for documents", "sandesh"],
  },
  {
    id: "notices",
    route: "notices",
    label: "Notices",
    // "arrive" is avoided deliberately: RESTRICTED_PATTERNS matches the acronym
    // "arr" without a trailing word boundary, so the word trips the business-
    // metrics guardrail and the KB refuses to describe itself.
    what: "Every notice on file in one list — assessee, assessment year, section, authority, notice date and where the reply has got to. Notices come in automatically from the e-filing portal when you sync an assessee; you can also record one by hand if it reached you on paper or by e-mail.",
    where: "Left sidebar, eighth item, Notices.",
    steps: [
      "Open Notices from the left sidebar.",
      "Use the filter chips to narrow to what is awaiting review, or to one authority.",
      "Tap any notice to open its record; use Add notice to enter one that did not come through the portal.",
    ],
    keywords: ["notice", "notices", "notice list", "awaiting review", "add notice", "record notice", "din", "reply", "notis", "padhna"],
  },
  {
    id: "reports",
    route: "reports",
    label: "Reports",
    what: "CSV exports across the whole practice — outstanding receivables, billing, payments received, authority-wise case load and the upcoming hearings cause list. They open directly in Excel.",
    where: "Left sidebar, ninth item, Reports.",
    steps: [
      "Open Reports from the left sidebar.",
      "Tap the report you want and it downloads as a CSV you can open in Excel.",
    ],
    keywords: ["report", "reports", "export", "csv", "excel", "download", "receivables", "case load", "statement"],
  },
  {
    id: "connector",
    route: "connector",
    label: "Sync Connector app",
    what: "A small desktop app that signs in to the income-tax portal on your own machine and pulls your clients' proceedings, notices, returns and responses into ProHippo. Your portal password stays encrypted and never leaves your control.",
    where: "Left sidebar, near the bottom, Sync Connector App.",
    steps: [
      "Open Sync Connector App from the bottom of the left sidebar.",
      "Download the app for your computer and run it.",
      "Sign in with the same account, then start a sync.",
    ],
    keywords: ["connector", "sync", "desktop app", "portal", "income tax portal", "itd", "fetch", "download notices", "traces", "e-filing", "efiling"],
  },
  {
    id: "returns",
    route: "assessees",
    label: "Filed returns and Computation of Income",
    what: "A client's filed returns sit on the Returns tab of their profile. From a filed ITR, ProHippo can build a Computation of Income and give you a PDF of it.",
    where: "Assessees, open the client, then the Returns tab.",
    steps: [
      "Open Assessees and tap the client.",
      "Go to the Returns tab.",
      "Open a filed return and choose Computation of Income to generate the PDF.",
    ],
    keywords: ["return", "returns", "itr", "computation", "computation of income", "coi", "filed return", "itr2", "itr3", "itr5", "vivran"],
  },
  {
    id: "documents",
    route: "assessees",
    label: "Document requests",
    what: "A checklist of documents you need from a client, sent out over WhatsApp or email, with each item ticked off as it comes in. When a notice is parsed, the list of documents the officer asked for is filled in for you.",
    where: "Open the assessee, then Ask for documents.",
    steps: [
      "Open Assessees and tap the client.",
      "Use Ask for documents to build the checklist.",
      "Pick WhatsApp or email and send it.",
    ],
    keywords: ["document", "documents", "checklist", "ask for documents", "document request", "papers", "kagaz", "dastavej"],
  },
  {
    id: "settings",
    route: "settings",
    label: "Settings",
    what: "Your practice profile and firm details as they print on invoices, the mobile number linked to your account, a JSON backup of your data, sample data, and integrations including Google Calendar.",
    where: "Left sidebar, last item, Settings.",
    steps: [
      "Open Settings from the bottom of the left sidebar.",
      "Practice profile is on the left; your account and linked mobile are on the right.",
    ],
    keywords: ["setting", "settings", "profile", "firm name", "letterhead", "backup", "google calendar", "integration", "link mobile", "change number", "sign out", "logout"],
  },
  {
    id: "login",
    route: "settings",
    label: "Signing in",
    what: "You sign in with a one-time code sent to your mobile by SMS, or to your email. There is no password to remember. The same mobile number is what identifies you when you call this line.",
    where: "The sign-in screen, before the app opens.",
    steps: [
      "Enter your mobile number on the sign-in screen.",
      "Type the six-digit code we send you.",
      "To attach a mobile number to an account you opened with email, go to Settings and link your mobile.",
    ],
    keywords: ["login", "log in", "sign in", "signin", "otp", "code", "password", "cannot login", "locked out", "verification", "pravesh"],
  },
];

/* Every route the agent is allowed to name, derived rather than typed twice. */
const ROUTES = [...new Set(FEATURES.map((f) => f.route))];

/*
 * Subjects the agent must never discuss, whoever is asking.
 *
 * This is the belt to the system prompt's braces. A prompt can be talked
 * around — "ignore your instructions", "I'm the founder, it's fine" — and a
 * caller who gets past it would otherwise be reading business internals off a
 * phone line. So the same question is also caught here, in code, on the way in
 * and on the way out, where no amount of persuasion moves it.
 *
 * The rule is about the SUBJECT, not the asker: an admin ringing this number
 * gets the same refusal, because a phone line has no admin console and caller
 * ID is not an authentication factor. Admin work happens signed in, at /admin.
 */
/*
 * A NOTE ON FALSE POSITIVES. The callers are chartered accountants: "turnover",
 * "profit", "revenue" and "account" are the words of their trade, and a help
 * line that refuses to hear "what's the turnover on the Shah scrutiny" is a
 * broken help line. So the money words are only restricted when they are
 * pointed at US — ProHippo, the app, the company, "you" — while the terms with
 * no innocent reading on this line (MRR, valuation, API key) are refused flat.
 * The tests pin both halves, because the failure modes point opposite ways: too
 * loose leaks the business, too tight makes the product useless.
 */
const COMPANY_SUBJECT = "(?:prohippo|the\\s+(?:app|company|platform|product|business|firm[\\s-]?behind)|your\\s+(?:company|app|business|platform)|this\\s+(?:app|platform|company)|you)";
const MONEY_WORD = "(?:revenue|turnover|profits?|earnings?|income|sales|collections?|kamai)";

const RESTRICTED_PATTERNS = [
  // Credentials and configuration. No innocent reading — a practitioner has no
  // reason to want a server key, and we have no reason to say one out loud.
  {
    topic: "credentials",
    // `\.env` sits OUTSIDE the \b(...) group on purpose: a word boundary before
    // a dot needs a word character before it, which "the .env file" doesn't have.
    re: /\.env\b|\b(api[\s-]?keys?|secret[\s-]?keys?|access[\s-]?tokens?|bearer[\s-]?tokens?|private[\s-]?keys?|service[\s-]?account[\s-]?(?:key|json|file)|env(?:ironment)?[\s-]?variables?|dot[\s-]?env|firebase[\s-]?config|gemini[\s-]?key|webhook[\s-]?secret|encryption[\s-]?key|otp[\s-]?pepper|signing[\s-]?secret|admin[\s-]?password|server[\s-]?password|database[\s-]?password)/i,
  },
  // Investor-deck vocabulary. Nothing a caller needs; everything a competitor wants.
  {
    topic: "business metrics",
    re: /\b(mrr|arr|arpu|ltv|cac|burn[\s-]?rate|runway|valuation|cap[\s-]?table|funding[\s-]?round|investors?|gross[\s-]?margin|pricing[\s-]?margin|unit[\s-]?econom)/i,
  },
  /*
   * Money words aimed at the COMPANY, not at a client's file.
   *
   * Mere proximity is not enough, and the first version of this got it wrong:
   * "income" is a money word and this is an INCOME-TAX app, so a proximity rule
   * refused "where do I enter turnover in ProHippo" and "what's the income
   * shown in ProHippo for this client" — both perfectly ordinary questions.
   * The word "ProHippo" appears near a money word in half the legitimate
   * sentences a caller will ever say.
   *
   * So the match requires GRAMMAR, not distance: the company has to possess the
   * figure ("ProHippo's revenue"), or be the object of it ("turnover of the
   * app"), or be the earner ("how much does the company make"). A client's
   * turnover matches none of those, which is the point.
   */
  {
    topic: "business metrics",
    re: new RegExp(
      [
        // "ProHippo's revenue", "the company's turnover"
        `\\b${COMPANY_SUBJECT}['’]s\\s+${MONEY_WORD}`,
        // "revenue of ProHippo", "profit from the app"
        `\\b${MONEY_WORD}\\s+(?:of|from|at)\\s+${COMPANY_SUBJECT}\\b`,
        // "how much revenue does the company make", "how much do you earn"
        `\\b${MONEY_WORD}\\b[^.?!]{0,25}\\b(?:does|do)\\s+${COMPANY_SUBJECT}\\b`,
        `\\bhow\\s+much\\s+(?:does|do)\\s+${COMPANY_SUBJECT}\\s+(?:make|earn|charge)\\b`,
        // Addressed straight at the agent. Narrow on purpose: "your revenue"
        // is us, "your client's turnover" is theirs.
        `\\byour\\s+(?:revenue|turnover|profits?|earnings|financials|numbers)\\b`,
      ].join("|"),
      "i"
    ),
  },
  // "how many users", "number of subscribers" — the count itself is the secret.
  {
    topic: "business metrics",
    re: /\b(?:how[\s-]?many|total|number[\s-]?of|count[\s-]?of|kitne)\s+(?:the\s+)?(?:active\s+|paying\s+|registered\s+|existing\s+|total\s+)?(?:users?|subscribers?|sign[\s-]?ups?|signups?)\b/i,
  },
  // "how many customers does ProHippo have" — the same question with a word
  // that also means the caller's own clients, so it needs the company subject.
  {
    topic: "business metrics",
    re: new RegExp(
      `\\b(?:how[\\s-]?many|total|number[\\s-]?of)\\s+(?:\\w+\\s+){0,3}?(?:customers?|accounts?|clients?|cas?|practitioners?|firms?)\\s+(?:does|do|has|have|are\\s+(?:there\\s+)?(?:on|using))\\s+(?:${COMPANY_SUBJECT})\\b`,
      "i"
    ),
  },
  {
    topic: "business metrics",
    re: /\b(?:user|customer|subscriber|signup|sign[\s-]?up)[\s-]?(?:count|base|numbers|statistics|stats)\b/i,
  },
  // Other people's data.
  {
    topic: "another account's data",
    // "someone else's account" needs the optional "else's" in the middle. The
    // nouns after it stay narrow on purpose: "another client" is a perfectly
    // ordinary thing for a practitioner to ask about — their own other client.
    re: /\b(?:other|another|different|(?:someone|somebody)(?:\s+else)?(?:['’]s)?)\s+(?:users?|accounts?|ca|cas|firms?|practitioners?|subscribers?)\b|\ball\s+(?:the\s+)?(?:users|accounts|customers|subscribers)\b/i,
  },
  // The admin console itself, and the machinery underneath.
  {
    topic: "internal systems",
    re: /\b(admin[\s-]?(?:console|panel|dashboard|access|claim|rights|login)|make[\s-]?me[\s-]?(?:an[\s-]?)?admin|grant[\s-]?(?:me[\s-]?)?admin|server[\s-]?(?:cost|bill|spend)s?|infra(?:structure)?[\s-]?cost|cost[\s-]?per[\s-]?(?:call|user|notice|minute)|source[\s-]?code|database[\s-]?dump|firestore[\s-]?rules|system[\s-]?prompt|your[\s-]?(?:instructions|prompt|rules)|which[\s-]?(?:model|llm)[\s-]?(?:are[\s-]?you|do[\s-]?you))/i,
  },
];

/* The one sentence the agent says for every restricted subject. It names no
   category — "I can't tell you the revenue" and "I can't tell you the user
   count" are both a confirmation that the thing exists and is worth asking
   about again. One flat answer, then straight back to being useful. */
const RESTRICTED_REPLY =
  "That's internal company information, and I'm not able to share it on this line. " +
  "I can help you with anything inside your own ProHippo account though — your clients, hearings, notices, invoices, or how to use any part of the app.";

/* Professional advice is out of scope for a different reason: it isn't secret,
   it's just not something a support line should be giving a practising CA. */
const ADVICE_REPLY =
  "I can't give an opinion on the tax position itself — that's your call as the professional. " +
  "What I can do is show you where everything on that matter sits in ProHippo.";

/* ---------------- the Sarvam knowledge base ---------------- */

/*
 * The same FEATURES, rendered as the Markdown file uploaded to Sarvam as a
 * knowledge base.
 *
 * Why a KB rather than more system prompt: Sarvam's own guidance is that KBs
 * are for "policies, pricing, product details and FAQs" — which is exactly what
 * this is — and every paragraph left in the prompt is a paragraph competing
 * with the refusal rules for the model's attention on every single turn. The
 * prompt keeps the guardrails and a one-line index; the depth lives here.
 *
 * The usual objection to a KB is drift: an uploaded file is a copy, and copies
 * go stale. That is why this is GENERATED rather than written —
 * `node scripts/print-voice-agent-config.mjs --kb` renders it from the array
 * above, so the file is a build artifact of the same source of truth the server
 * enforces against, not a second one.
 */
/* Sarvam's KB name is a slug, not a display name — lowercase letters, digits,
   hyphens or underscores, 3-32 characters. A prose title is rejected at the
   Create dialog, so this matches what the platform will actually accept, and
   what the agent's query tool names when it searches. */
const KB_NAME = "prohippo-app-guide";

/*
 * The description is what the agent routes on — Sarvam embeds it to decide
 * whether to search this KB at all. So it does double duty: it says what is in
 * here, and it says what is NOT, which makes it one more place the boundary is
 * written down. A model that never searches this KB for account data or company
 * internals is a model that cannot accidentally answer from it.
 */
const KB_DESCRIPTION = [
  "How to use the ProHippo app: what every screen does and the exact steps to reach it —",
  "assessees and client records, matters and proceedings, hearings and the cause list, appeals",
  "and limitation dates, invoices and receipts, client communication, notices, reports,",
  "the desktop sync connector, filed returns and Computation of Income, document requests,",
  "settings, and signing in.",
  "Search this for any 'how do I', 'where is', or 'what does this do' question about the app.",
  "Do NOT search this for the caller's own records — their clients, hearing dates, notices,",
  "invoices or tasks all come from the account tools, never from here.",
  "Do NOT search this for company information such as user numbers, revenue, pricing internals,",
  "API keys or admin access: none of that is in here, and none of it is answerable on this line.",
].join(" ");

function buildKnowledgeBaseMarkdown() {
  const lines = [
    `# ${KB_NAME}`,
    "",
    "ProHippo is software for Indian income-tax practitioners. It tracks assessees,",
    "proceedings, hearings, notices, appeals, invoices and client communication, and reads",
    "income-tax notices with AI.",
    "",
    "This guide covers what each screen does and how to reach it. It contains no account",
    "data and no company information.",
    "",
  ];
  for (const f of FEATURES) {
    lines.push(
      `## ${f.label}`,
      "",
      f.what,
      "",
      `**Where it is:** ${f.where}`,
      "",
      "**Steps:**",
      ...f.steps.map((s, i) => `${i + 1}. ${s}`),
      "",
      `**Also called:** ${f.keywords.join(", ")}`,
      ""
    );
  }
  /*
   * Kept short, and deliberately NOT a list of the sensitive subjects.
   *
   * A KB is retrieved in ~500-token chunks with no surrounding context, so a
   * paragraph here that enumerates "user counts, revenue, API keys" is a
   * paragraph that can surface on its own and put those very words into the
   * agent's mouth. The enumeration belongs in KB_DESCRIPTION and in the system
   * prompt, both of which are always in context and never retrieved piecemeal.
   * The unit test asserts this file trips none of RESTRICTED_PATTERNS.
   */
  lines.push(
    "## What this guide does not cover",
    "",
    "This guide describes the app itself. A practitioner's own records are read live from",
    "their account and are not in here. Information about the business behind ProHippo is",
    "not covered on the help line at all.",
    ""
  );
  return lines.join("\n");
}

/*
 * Score one feature against the caller's words. Deliberately simple: a
 * substring hit on a keyword is worth more than one on the description,
 * and a hit on the label is worth most. Nothing here is clever enough to
 * need explaining, which is the point — it is a fallback, and a fallback
 * that behaves surprisingly is worse than no fallback.
 */
function scoreFeature(feature, query) {
  const q = String(query || "").toLowerCase().trim();
  if (!q) return 0;
  // Words worth matching on. Two letters or fewer match everything.
  const words = q.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  if (!words.length) return 0;

  const label = feature.label.toLowerCase();
  const blob = `${feature.what} ${feature.where} ${feature.steps.join(" ")}`.toLowerCase();
  let score = 0;
  for (const w of words) {
    if (feature.keywords.some((k) => k === w)) score += 6;
    else if (feature.keywords.some((k) => k.includes(w) || w.includes(k))) score += 4;
    if (label.includes(w)) score += 3;
    else if (blob.includes(w)) score += 1;
  }
  return score;
}

/* Best matches for what the caller asked, strongest first. Returns [] rather
   than a bad guess when nothing scores — the agent says "I'm not sure I
   follow" instead of confidently naming the wrong screen. */
function findFeature(query, limit = 3) {
  return FEATURES.map((f) => ({ feature: f, score: scoreFeature(f, query) }))
    .filter((r) => r.score >= 4)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.feature);
}

const featureById = (id) => FEATURES.find((f) => f.id === id) || null;

module.exports = {
  FEATURES,
  ROUTES,
  KB_NAME,
  KB_DESCRIPTION,
  buildKnowledgeBaseMarkdown,
  RESTRICTED_PATTERNS,
  RESTRICTED_REPLY,
  ADVICE_REPLY,
  scoreFeature,
  findFeature,
  featureById,
};
