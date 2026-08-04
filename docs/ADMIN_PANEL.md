# Admin console & referral system

The console lives at **https://prohippo.in/admin**, inside the same app. It is
lazily imported, so none of it ships in the bundle a practitioner downloads.

**Getting there day to day:** an "Admin console" item appears at the bottom of
the sidebar — but only for accounts carrying the admin claim, so a practitioner
is never shown a door they can't open. Everyone else has no link, no hint, and
no route that resolves to anything but the normal app. Typing the URL works too.

The sidebar reads the claim off the cached ID token rather than forcing a
refresh, so a newly granted admin sees the link from their next sign-in. `/admin`
itself always re-checks against a fresh token.

This is Phase 1 (accounts + admin shell) and Phase 2 (referral codes end to end).
Plans, entitlement enforcement and Razorpay billing are Phase 3–4 and are *not*
in here yet — the `plan` and `status` fields exist and are settable by hand, but
nothing charges anyone or blocks a feature.

---

## 1. What it can and cannot see

| Data | Console access |
|---|---|
| `accounts/{uid}` — firm, email, plan, status, referral, usage **counts** | Read directly (rules), write via audited callables |
| `referralCodes`, `referralRedemptions`, `adminAudit`, `growthDaily` | Read directly, write via callables |
| `users/{uid}/**` — assessees, notices, hearings, portal credentials | **No access. Ever.** |

That last row is the point. Those documents are the practitioner's *clients'*
PANs, notices and assessment records. `firestore.rules` grants admins nothing
there, and no callable in `functions/admin.js` reads it. The console shows
"12 assessees", never which twelve.

---

## 2. First-time setup

### a. Deploy — backend first, then the site

`.github/workflows/firebase-deploy.yml` deploys **hosting only** when a pull
request merges. Rules, indexes and functions are not in it, so they have to go
out by hand:

```bash
firebase deploy --only firestore:rules,firestore:indexes,functions --project prohippo2
```

**Order matters.** Deploy the backend from the feature branch *before* merging.
Merge first and the new front-end goes live against a backend that has no
`accounts` collection and no callables — `/admin` loads to a wall of
permission-denied, and anyone typing a referral code during signup gets an
error. (Their signup still completes: attribution is best-effort by design.)

New functions in this change:

| Function | Who can call it |
|---|---|
| `mirrorAccountProfile` | Firestore trigger on `users/{uid}` |
| `rollupAccounts` | Scheduler, 02:30 IST daily |
| `adminOverview`, `adminLookupUser`, `adminUpdateAccount`, `adminSetRole` | admins |
| `adminCreateReferralCode`, `adminUpdateReferralCode`, `adminReverseRedemption` | admins |
| `validateReferralCode`, `redeemReferralCode`, `myReferralCode` | any signed-in user |
| `trackReferralVisit` | unauthenticated (rate-limited, counter-only) |

### b. Grant yourself admin

Admin is a **custom claim**, not a database flag — it is signed into the ID
token, so the rules and every callable agree without an extra read, and nothing
the browser can write can grant it.

The first admin has to come from outside the system. There is deliberately no
self-service endpoint: one that can make its caller an admin is a
privilege-escalation hole no amount of validation redeems.

The script uses Application Default Credentials, so in Google Cloud Shell (or
anywhere you've run `gcloud auth application-default login`) there is nothing to
download:

```bash
npm --prefix functions install
node scripts/grant-admin.mjs you@example.com     # grant
node scripts/grant-admin.mjs you@example.com --revoke
node scripts/grant-admin.mjs --list
```

If ADC isn't available, fall back to a service account key — Firebase console →
Project settings → Service accounts → Generate new private key, saved **outside**
the repo:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccountKey.json
node scripts/grant-admin.mjs you@example.com
```

Sign out, sign back in, open `/admin`. Every admin after the first is granted
from the console itself — **Customers → open an account → Make admin**.

### c. Backfill existing customers — do this, don't wait

`accounts/{uid}` is created by the mirror trigger when `users/{uid}` is written.
Every profile that existed *before* the trigger was deployed has therefore never
produced an account row, so **a freshly deployed console opens onto an empty
Customers table.** Nothing is broken; there is simply nothing there yet.

Each session does stamp `lastSeenAt`, so those users would trickle in as they
next open the app — but that could be days, and an empty console looks exactly
like a broken one. Run the backfill instead:

```bash
node scripts/backfill-accounts.mjs --dry-run   # see what it would do
node scripts/backfill-accounts.mjs
```

It walks every existing profile, creates the account row, and counts each
practice's collections so the numbers are right immediately rather than after
the 02:30 IST rollup.

Safe to re-run: it merges, and it seeds `plan` / `status` / `trialEndsAt` only
when creating a row. A second run will never knock a paying customer back onto
a trial.

---

## 3. Referral codes

### Kinds

| Kind | For | Typical shape |
|---|---|---|
| `partner` | CA associations, resellers, influencers | 25% off + 20% commission for 12 months |
| `promo` | Campaigns | `LAUNCH50`, 50% off first invoice, 200 redemptions, expires |
| `member` | Word of mouth | Auto-minted per customer, 30 days free both sides |

### How attribution works

1. Partner shares `https://prohippo.in/?ref=AHMCA25`.
2. `src/referral.js` stores the code in `localStorage` and calls
   `trackReferralVisit` (deduped per browser, so refreshes don't inflate
   clicks). The parameter is stripped from the URL.
3. The code survives **30 days**. Both `firstTouch` and `lastTouch` are kept.
   **Partners are paid on first touch** — it credits whoever actually introduced
   the customer, and stops a coupon site intercepting the attribution at the
   last second.
4. Onboarding pre-fills the code and validates it live.
5. On finish, `redeemReferralCode` writes the attribution — inside a
   transaction, to a **deterministic document id** (`{uid}__{CODE}`). Two taps
   on a slow connection cannot redeem twice or push `redemptions` past
   `maxRedemptions`.

Attribution never blocks a signup. If the code was paused ten seconds ago, the
practitioner still gets their account.

### The rules that are enforced server-side

- One code per account, one redemption per code per account. No stacking.
- Nobody redeems their own `member` code.
- `newCustomersOnly` blocks an existing paying account.
- Quota, date window, plan restriction and paused status all checked in
  `evaluateCode()` — the single decision point, shared by the dry run and the
  real redemption so they can never disagree.

### Why the error messages are vague

`not_found`, `inactive`, `expired` and `exhausted` all return the same sentence
to the customer, and `validateReferralCode` is rate-limited to 20 attempts per
account per hour. A precise, unlimited validator is a free oracle telling anyone
which of your discount codes are live. The console shows the real reason.

### The funnel

`clicked → signed_up → activated → converted → renewed → churned`

**Activated** is computed by the nightly rollup from the account's own data
(`counters.assessees > 0`), not reported by the client — it is a number partners
get paid on, so it must not be one a client can fake. Stages only move forward;
a re-run of the rollup can never demote a paying customer.

The activated column is the one worth reading. Signups are easy to buy; a
partner whose signups never activate is sending you people who will never pay,
and you want to know that before the commission is due.

### Undoing an attribution

**Referral codes → open a code → Reverse.** Frees the account to be attributed
again, returns the quota slot, and writes off accrued commission. Audited.

---

## 4. Money

Everything is stored in **paise as integers**. `₹1,499 → 149900`. Rupee floats
and percentage arithmetic do not mix, and a subscription that quietly loses a
paisa per invoice is a support ticket nobody enjoys. The admin form takes rupees
for flat discounts and converts on submit.

---

## 5. Operational notes

- **Composite index**: `accounts(status, trialEndsAt)`, in
  `firestore.indexes.json`. The overview's "expired trials" count degrades to
  blank while it builds rather than erroring the page.
- **Nightly rollup** costs roughly 6 aggregate queries per account. Aggregate
  queries bill one read per 1000 documents, so this stays cheap well past the
  point where it would need rethinking.
- **Revoking admin** calls `revokeRefreshTokens`, so access is gone immediately
  rather than whenever the existing ID token happens to expire.
- **Tests**: `node functions/adminCore.test.mjs` covers the pure half — code
  normalisation, discount maths in paise, commission caps, every validation
  refusal, and that the enumeration-safe messages really are indistinguishable.

---

## 6. What Phase 3–4 add

1. `plans/{planId}` catalogue with limits and prices (the rules already allow
   any signed-in user to read it).
2. `assertEntitlement(uid, "aiParse")` at the top of `summarizePortalNotice`,
   `sendClientMessage` and `ingestPortal*` — those callables are where cost is
   actually incurred, so they are the only place a limit can be enforced.
3. Razorpay subscriptions (UPI Autopay/e-mandate, INR, GST invoices), webhook →
   `subscriptions/{uid}`, dunning, and partner commission accrual on each
   payment — which is what finally moves a redemption to `converted` and fills
   in the revenue columns that currently read ₹0.
