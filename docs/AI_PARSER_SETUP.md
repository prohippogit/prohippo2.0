# AI Notice Parser — one-time setup

The AI parser reads a notice PDF with Google's Gemini 3.1 Flash-Lite, checks the
result with strict rules (PAN format, assessment-year format, date sanity), and
automatically retries once on the stronger Gemini 3.1 Flash model if a critical
field could not be read. Nothing is saved until you review the pre-filled form.

The code is already in this repository. You only need to do the steps below
**once**, copy-pasting each command into a terminal (Command Prompt / Terminal)
opened inside the project folder.

---

## Step 1 — Get a Gemini API key

1. Open https://aistudio.google.com/apikey and sign in with your Google account.
2. Click **Create API key** and choose your Google Cloud project
   (or let it create one).
3. Copy the key (it looks like `AIzaSy...`) and keep it handy for Step 4.

> **Important (privacy):** enable billing on that Google Cloud project so you
> are on the **paid tier**. On the free tier Google may use your data to
> improve its models — not acceptable for notices containing PANs and income
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

## Step 5 — Deploy the parsing backend

```
firebase deploy --only functions
```

The first deploy can take a few minutes. It should end with
`Deploy complete!`.

## Step 6 — Deploy the updated app

```
npm install
npm run build
firebase deploy --only hosting
```

## Step 7 — Try it

Open the app → **AI Parser** in the sidebar → drop a notice PDF. After a few
seconds the intake form opens with the extracted fields marked **AI**. Verify
each field against the original notice, then save.

---

## Troubleshooting

**"Gemini model … was not found for this API key"**
Google occasionally renames models. List the models your key can use:

```
curl "https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY_HERE"
```

Then open `functions/index.js`, update the two lines near the top
(`PRIMARY_MODEL` and `ESCALATION_MODEL`) to matching names, and re-run
`firebase deploy --only functions`.

**"AI parsing failed — enter the details manually"**
The app still works — the form opens empty and you can type the details.
Check the function's logs to see what went wrong:

```
firebase functions:log --only parseNotice
```

**Costs**
Each notice costs a fraction of a rupee (Flash-Lite ≈ ₹0.15 per notice; the
stronger retry model only runs when needed). The function is capped at 5
concurrent instances so a bug can never run up a large bill.
