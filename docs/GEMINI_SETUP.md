# Gemini — one-time setup

Two features read a PDF with Google's Gemini 3.1 Flash-Lite:

| feature | what it reads | where it shows |
|---|---|---|
| `summarizePortalNotice` | an order the portal issued — a short summary, and **which** document it is (assessment order vs its computation sheet vs the notice of demand) | the Matters view; it also drives appeal detection |
| `extractNoticeDocuments` | the list of documents a notice calls for | "Ask for documents" on a notice |
| `readIntimationOrder` | the comparison table inside a s.143(1) / s.154 order, and the earlier years' demand in its annexures | "Read the order" on the Intimations page |
| `onReturnWritten` | the same read, fired automatically for red-flagged orders | off by default — Settings → "Read red-flagged intimations automatically" |

Both run on documents the **portal** gave us, and both extract only what a PDF
is the sole source of. Nothing else in the app is read by a model: a notice's
PAN, assessment year, section, DIN and dates come from the portal's own
structured data, and the s.143(1)/s.154 variance is arithmetic on figures the
department stated. That boundary is deliberate — see the header of
`functions/index.js`.

> An earlier **AI Parser** screen let you upload a notice PDF and had Gemini
> pre-fill the intake form from it. It was removed once notices began arriving
> through the portal sync with their fields already authoritative: re-reading
> them cost money to produce a worse answer. Notices that arrive on paper or by
> e-mail are entered by hand from **Notices → Add notice**.

The code is already in this repository. You only need to do the steps below
**once**, copy-pasting each command into a terminal opened inside the project
folder.

---

## Step 1 — Get a Gemini API key

1. Open https://aistudio.google.com/apikey and sign in with your Google account.
2. Click **Create API key** and choose your Google Cloud project
   (or let it create one).
3. Copy the key (it looks like `AIzaSy...`) and keep it handy for Step 4.

> **Important (privacy):** enable billing on that Google Cloud project so you
> are on the **paid tier**. On the free tier Google may use your data to
> improve its models — not acceptable for orders containing PANs and income
> details. At real usage this costs well under ₹200/month.

## Step 2 — Upgrade Firebase to the Blaze plan

Cloud Functions require the pay-as-you-go plan (there is a permanent free
allowance; light usage typically costs ₹0).

1. Open https://console.firebase.google.com → project **prohippo2**.
2. Bottom-left, click **Upgrade** → choose **Blaze** → link the billing account.

## Step 3 — Install the Firebase CLI and sign in

```
npm install -g firebase-tools
firebase login
firebase use prohippo2
```

## Step 4 — Store your Gemini key as a secret

```
firebase functions:secrets:set GEMINI_API_KEY
```

When it asks for the value, paste the API key from Step 1 and press Enter.
The key is stored in Google Secret Manager — it never appears in the code or
in the browser.

## Step 5 — Deploy the functions

```
cd functions && npm install && cd ..
firebase deploy --only functions
```

The first deploy can take a few minutes. It should end with
`Deploy complete!`.

## Step 6 — Deploy the app

```
npm install
npm run build
firebase deploy --only hosting
```

Hosting also deploys automatically on every push to the default branch — see
`.github/workflows/firebase-deploy.yml`. **Functions are not in that workflow**
and always need the manual deploy in Step 5.

## Step 7 — Try it

Sync an assessee that has a closed proceeding, then open **Matters** and pick
the order. Its summary and document type appear on the tile within a few
seconds of the sync recording it.

---

## Troubleshooting

**"Gemini model … was not found for this API key"**
Google occasionally renames models. List the models your key can use:

```
curl "https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY_HERE"
```

Then open `functions/index.js`, update `PRIMARY_MODEL` near the top to a
matching name, and re-run `firebase deploy --only functions`.

**A summary never appears on an order**
The read is best-effort and records its own failure rather than retrying for
ever: look at `aiSummaryError` on the notice document in Firestore, and at the
logs:

```
firebase functions:log --only summarizePortalNotice
```

"Parse with AI" on the proceeding tile re-runs it by hand.

**Costs**
Each document costs a fraction of a rupee (Flash-Lite ≈ ₹0.15). Both functions
are capped at 5 concurrent instances so a bug can never run up a large bill.
Per-feature spend is broken out in the admin console — see
`docs/COST_TRACKING.md`.
