# Cost tracking

What ProHippo spends on outside APIs, consolidated and per-account, at
**https://prohippo.in/admin/costs**.

---

## 1. What's metered

Every paid outbound call in the codebase, all writing the same shape through
`functions/spend.js`:

| Vendor | Where | Billing unit | Attributed to |
|---|---|---|---|
| Gemini | `callGemini` (notice parsing, ×2 on escalation), `callGeminiSummary`, `callGeminiDocuments` | tokens in + out, per model | the signed-in practice |
| 2Factor | `sendSmsOtp` — **AUTOGEN only** | 1 SMS credit | nobody (login) |
| Resend | `sendEmailOtp` | 1 email | nobody (login) |
| Resend | `sendViaResend` (client messages) | 1 email | the signed-in practice |
| Firebase | — | monthly invoice | entered by hand |

Deliberately **not** metered: `checkSmsOtp` (2Factor VERIFY) is free, and
counting it would double every SMS figure in the console. Google OAuth, the
Calendar API and the income-tax portal cost nothing.

## 2. Rates — read this before trusting a number

**Every rate lives in `functions/pricing.js` and nowhere else.**

The values shipped are **placeholders**. Until you replace them, the Costs page
shows an amber "these rates have not been verified" banner over every total — a
figure you know is wrong is survivable; one you believe is not.

To make it real:

1. Put the current prices into `functions/pricing.js` from
   [Gemini](https://ai.google.dev/pricing), your 2Factor dashboard (the per-SMS
   credit price you actually bought at), and [Resend](https://resend.com/pricing)
2. Set `USD_INR` to a rate you're happy with
3. Set `RATES_VERIFIED = true` and bump `RATE_VERSION`
4. Deploy

### Three rules the pricing module exists to enforce

**Cost is computed at write time and frozen.** A spend record stores the rupees
it cost, not just the tokens it used, plus the `RATE_VERSION` that priced it.
Vendors change prices; last quarter's numbers must not quietly change when they
do.

**The FX rate is frozen too.** Gemini and Resend bill in USD, 2Factor bills in
INR, the business runs in INR. Convert at read time and every historical report
moves with the rupee.

**Money is integer micro-units.** A single flash-lite call costs a small
fraction of a cent — paise cannot hold it, and floats accumulate error over a
month of calls. `costMicroInr` is millionths of a rupee.

## 3. Where the data goes

```
spend/{id}                  one document per call — drill-down and failures
spendDaily/{YYYY-MM-DD}     consolidated: by vendor, by SKU, by feature
usageDaily/{uid}_{date}     per-account, per-day
accounts/{uid}.spend        running totals — powers the ₹ column in Customers
manualCosts/{YYYY-MM}       the Firebase invoice, typed in
```

No dashboard ever scans `spend` for a total. `spendDaily` exists so a refresh
costs a handful of document reads however many API calls sit behind it.

**Add a Firestore TTL policy on `spend` at 90 days** (Firestore console →
TTL → collection `spend`, field `at`). Rollups are permanent; raw calls are for
drill-down.

## 4. Decisions worth knowing about

**Login OTPs have no owner.** `sendSmsOtp` and `sendEmailOtp` fire before anyone
is authenticated, and for someone who never completes signup there is no account
to attribute to even in principle. They record `uid: null` and appear under
"Login & signup". That is customer-acquisition cost, not cost-to-serve; folding
it into a customer's row would make both numbers lie.

**Failures are recorded, with their cost.** A Gemini call that returns tokens
and then fails validation still cost money. Undercounting exactly when things
break is the worst time to undercount. A send the vendor *rejected* bills zero
units — nothing left their gateway.

**The meter is awaited, not fire-and-forget.** The instinct is to return the
user's result first and write the meter after. In Cloud Functions that loses
records: once the response is sent the instance may be frozen, and a dangling
promise is dropped. It is one batched in-region round trip against calls that
already take seconds, and it is wrapped so a metering failure can never fail —
or even surface in — the user's request.

**Nothing about content is logged.** Token counts, model, latency, uid. Never a
prompt, a response, a phone number or an email address. `spend` is
admin-readable, so anything in it is something support can read, and these calls
carry the practitioner's clients' tax records.

**Escalation is visible.** `parseNotice` calls Gemini twice when the first pass
misses a critical field, and the second call uses a costlier model. Both are
recorded with `attempt: 1 | 2`, so the by-SKU panel shows what escalation is
really costing you — a number nothing in the system reported before.

**Email totals are gross of Resend's free tier.** Below the monthly free
allowance the real invoice is lower than the figure shown. Noted on the page.

## 5. Firebase, and why it's typed in

Firebase is not an API this codebase calls — Firestore reads, Storage and
function invocations only appear on the monthly bill, so there is no response to
meter. **Costs → Monthly invoice** takes the figure by hand and folds it into
the same totals, labelled as manual. A consolidated cost that silently omits
your hosting bill is not consolidated.

If you'd rather automate it later, Cloud Billing export to BigQuery is the
proper route.

**A standing saving while you're here:** `KEEP_WARM = 1` applies *per region*,
and `REGIONS` currently holds both `asia-south1` and `us-central1` — so you are
paying for two always-on instances. Step 3 of the region migration
(`functions/index.js:26`) retires the Iowa copies once no old connector is in
the wild.

## 6. Reconcile monthly

Compare the console's monthly total against the three real invoices. A
hand-maintained rate table drifts; catching a 15% gap in month two beats
discovering it in month twelve. When you correct a rate, bump `RATE_VERSION` —
old records keep the price that was actually charged.

## 7. Tests

```bash
node functions/pricing.test.mjs
```

Covers the discount-free arithmetic that everything else rests on: per-token
pricing, the escalation model being the expensive one, unknown models being
flagged rather than priced at zero, frozen FX, zero-unit failed sends, and that
model ids full of dots survive being used as Firestore map keys.
