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

## 2. Rates in force

Confirmed against the vendors' own pages on 2026-07-29 and set in
`functions/pricing.js` (`RATE_VERSION = "2026-07-B"`).

| | Rate | Source |
|---|---|---|
| `gemini-3.1-flash-lite` | $0.25 / M input tokens (text, image, video)<br>$1.50 / M output tokens | ai.google.dev/pricing, paid tier |
| 2Factor SMS | ₹0.22 per send | ₹2,200 for 10,000 credits |
| Resend email | **₹0 marginal** | Free plan, 3,000/month |
| Firebase | entered by hand | monthly invoice |
| USD → INR | 88.0 | set to your settlement rate |

### All rates are exclusive of GST

The 2Factor pack cost ₹2,596 — ₹2,200 plus 18% GST. The rate used is **₹0.22**,
the ex-GST figure, because the LLP is registered and takes input credit on that
invoice: the GST is recovered, so it is not a cost. The USD vendors quote ex-tax
already, which keeps all three consistent.

If you are *not* claiming input credit, set `SMS_INR_PER_SEND` to `0.2596` and
bump `RATE_VERSION`. Do not mix the two.

### Email is a subscription, not a per-unit charge

Resend Free has no overage billing — it stops you at 100/day and 3,000/month.
So the marginal cost of one more email is genuinely **zero**, and pricing each
message at some notional rate would invent a cost you are not incurring.

What matters is the **cliff**: at 3,000/month the next step is Pro at $20/month
for 50,000, then $0.90 per 1,000 beyond that. The Costs page therefore shows an
**email allowance meter** — volume against the 3,000, amber at 70%, red at 90% —
so the jump is visible before it arrives rather than on the invoice after.

When you move to Pro: set `RESEND_PLAN.name` to `"pro"`, `includedPerMonth` to
`50000`, `overageUsdPer1000` to `0.90`, and enter the $20 under
**Costs → Monthly invoice**.

### Thinking tokens are counted

Google's output price is *"including thinking tokens"*, and the API reports
those separately as `thoughtsTokenCount`. The meter adds them to
`candidatesTokenCount` — counting only the visible answer would under-report
every call.

### One gap: the escalation model

`ESCALATION_MODEL = "gemini-3.1-flash"` (`functions/index.js:83`) has **no rate
in the table**, deliberately — its price was not on the pricing page that was
checked, and inventing one would be worse than leaving it out. Calls to it are
recorded with `priced: false` and surface on the Costs page as *"N calls had no
rate in the price table"*. A visible gap beats a confident wrong total.

**That counter is also worth watching for a second reason.** If it shows calls,
escalation is happening and you need the rate. If it stays at zero while notices
are being parsed, escalation is either never triggering or failing — the code
catches an escalation error and falls back to the first-pass result
(`functions/index.js:393`), so a model id that no longer exists would degrade
parse quality silently.

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
