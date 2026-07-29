# Google Calendar sync — setup

ProHippo pushes hearings and deadlines into a calendar it creates inside the
practitioner's own Google account. One-way: ProHippo is the record of truth, and
an event dragged in Google never moves a hearing here.

Three one-time steps: create a Google OAuth client, store two secrets, deploy.

**No OAuth verification review is required.** Google classifies
`calendar.app.created` as a **non-sensitive** scope — it appears under "Your
non-sensitive scopes" on the Data access page, and the sensitive and restricted
tables stay empty. That means no scope review, no 100-user cap, and no
"unverified app" warning on the consent screen. This is the payoff for choosing
the narrow scope: `calendar` and `calendar.events` are both sensitive and would
have gated launch behind a one-to-three-week review.

A separate **brand** verification still shows as pending on the Branding and
Audience pages. That one only governs whether your logo and app name are
displayed on the consent screen — it is cosmetic, and it does not limit who can
connect or what the sync can do. Submit it when convenient.

---

## Step 1 — Turn on the Calendar API

1. Go to https://console.cloud.google.com and pick the **prohippo2** project
   (the same project as Firebase — the picker is in the blue bar at the top).
2. **APIs & Services → Library**, search **Google Calendar API**, click
   **Enable**.

## Step 2 — Configure the consent screen

**APIs & Services → OAuth consent screen**

| Field | Value |
| --- | --- |
| User type | **External** |
| App name | ProHippo |
| User support email | your address |
| App logo | upload the ProHippo mark (required for verification) |
| Application home page | https://prohippo.in |
| Privacy policy link | https://prohippo.in/privacy |
| Application Terms of Service link | https://prohippo.in/terms |
| Authorised domain | prohippo.in (keep prohippo2.firebaseapp.com alongside it) |
| Developer contact | your address |

On the **Scopes** step click **Add or remove scopes**, and add exactly one:

```
https://www.googleapis.com/auth/calendar.app.created
```

The console has moved these settings: **Google Auth Platform → Branding** holds
the app details, **Audience** the user type and publishing status, and **Data
access** the scopes. If `calendar.app.created` is not in the scope picker, use
**Manually add scopes** at the bottom of the panel.

> Do **not** add `calendar` or `calendar.events`. The narrow scope is what limits
> ProHippo to calendars it created itself — a bug in the sync engine cannot reach
> a personal diary — and it is a materially faster verification review.

The privacy policy should still say what ProHippo does with Google Calendar
data, and affirm the Limited Use requirements of the Google API Services User
Data Policy. That obligation applies to any Google API data, verification review
or not.

**Publishing status must end up "In production", not "Testing."** This is not
cosmetic: with External user type in Testing, Google expires refresh tokens after
**7 days**, so every practitioner would have to reconnect weekly and the nightly
reconcile would die every Monday. Production with an unverified-app warning is
strictly better than Testing here.

Brand verification, if and when you submit it, requires proving you own the
domain in [Google Search Console](https://search.google.com/search-console) with
the same account. For `prohippo.in` the DNS TXT method covers the whole domain
at once.

## Step 3 — Create the OAuth client

**APIs & Services → Credentials → Create credentials → OAuth client ID**

- Application type: **Web application**
- Name: `ProHippo web`
- Authorised redirect URI — exactly this, no trailing slash. `cloudfunctions.net`
  is a Google-owned domain and does not need to be an authorised domain:

```
https://asia-south1-prohippo2.cloudfunctions.net/calendarAuthCallback
```

Copy the **Client ID** and **Client secret** off the dialog that appears.

> If this URI is off by a character Google refuses the exchange with
> `redirect_uri_mismatch` and the user lands back in the app with a message
> saying so. It is derived in code from the region and project ID, so it changes
> only if one of those changes.

## Step 4 — Store the secrets and deploy

In **Cloud Shell** (https://shell.cloud.google.com):

```
cd ~/prohippo2.0 && git fetch origin && git checkout -f claude/keen-ride-FlIY1 && git reset --hard origin/claude/keen-ride-FlIY1
```

Set the two secrets (each command waits for you to paste the value):

```
firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_ID
firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_SECRET
```

Refresh tokens are encrypted at rest with the **existing** `CREDENTIAL_ENC_KEY`
secret — the same key already protecting stored portal passwords. If you have
not set it yet, see `PORTAL_SYNC_SETUP.md` Step 1.

Then deploy:

```
cd ~/prohippo2.0/functions && npm install && cd .. && firebase deploy --only functions
```

The first deploy of `nightlyCalendarReconcile` needs the Cloud Scheduler API. If
the deploy stops asking for it, run `gcloud services enable
cloudscheduler.googleapis.com` and deploy again.

## Step 5 — Brand verification (optional, cosmetic)

**Google Auth Platform → Verification centre.**

This is the only review left, and it is not a gate: it decides whether your logo
and app name are shown on the consent screen. Nothing about who can connect, the
user cap, or what the sync can do depends on it. Submit it when convenient.

Needs domain ownership in Search Console (above) and a reachable privacy policy.

---

## How it works

| Piece | What it does |
| --- | --- |
| `calendarAuthUrl` | Callable. Takes the Google address the user typed, returns a consent URL carrying it as `login_hint` plus a single-use state nonce. |
| `calendarAuthCallback` | The redirect target. Exchanges the code, **checks the granted account matches the one requested**, creates the calendar, stores the encrypted refresh token. |
| `syncCalendarNow` | Callable. Full reconcile — pushes everything and removes orphaned events. Backs the **Sync now** button and the first-connect backfill. |
| `onHearingWrittenSync` | Firestore trigger on `users/{uid}/hearings/{id}`. The everyday auto-sync. |
| `onCalendarDeadlineWritten` | Same, for the deadline mirror. |
| `nightlyCalendarReconcile` | 02:30 IST. Catches missed triggers, expired tokens and events deleted in Google. |
| `disconnectGoogleCalendar` | Revokes the grant, deletes the token, clears the sync markers. |
| `calendarFeedLink` / `calendarFeed` | The no-OAuth ICS subscription link. |

### Where things are stored

| Path | Holds | Client access |
| --- | --- | --- |
| `users/{uid}/integrations/googleCalendar` | email, calendarId, status, the four switches, lastSyncAt, lastError | read/write — drives the UI live |
| `googleTokens/{uid}` | refresh token, AES-256-GCM encrypted | **denied by rules** — Cloud Functions only |
| `users/{uid}/hearings/{id}.gcal` | `{ eventId, hash, syncedAt }` | read |
| `users/{uid}/calendarDeadlines/{id}` | the derived deadline mirror | read/write |
| `calendarAuthStates/{state}` | 15-minute single-use OAuth nonce | denied by rules |

`googleTokens` and `calendarAuthStates` are top-level collections, so the
existing catch-all `allow read, write: if false` in `firestore.rules` already
denies clients — no rules change was needed, same as `portalCreds`.

### Which domain the user comes back to

ProHippo answers on `prohippo.in` and on Firebase's default `web.app` /
`firebaseapp.com` addresses at the same time. The consent flow therefore records
the origin the user set off from and returns them to that one, rather than to a
single hardcoded address — connect from `prohippo.in` and you land back on
`prohippo.in`. The origin is checked against `ALLOWED_ORIGINS` in
`functions/googleCalendar.js` before use; an unrecognised value falls back to
`APP_ORIGIN`, because an OAuth callback that redirects anywhere it is told is an
open redirect. **Add any new domain to that set**, or users on it will be handed
off mid-flow.

### Why event IDs are derived, not stored

Each event's ID is `sha1(kind + ":" + firestoreDocId)`. A retry after a timeout
therefore *updates* the event it already created rather than adding a second
one — the most common way calendar integrations end up with duplicates, removed
by construction. The `hash` alongside it is of the fields we send, so a sync that
would change nothing makes no API call at all.

### Why deadlines are mirrored, not computed in the backend

Appeal limitation is worked out by `src/appeals.js`, whose own header explains
that a limitation date shown one day late is what costs an appeal. Rather than
port that arithmetic into Cloud Functions and let two copies drift, the client
writes its answers into `users/{uid}/calendarDeadlines` as plain
`{ title, date }` rows, and the sync engine stays ignorant of where a date came
from. `src/CalendarDeadlineMirror.jsx` keeps that collection current.

---

## Using it

**Settings → Integrations → Google Calendar.** Type the Google account to sync,
click Connect, approve on Google's screen. Four switches: sync automatically,
hearings, deadlines, and whether client names and PAN appear in the event.

**Hearings & Calendar** carries the everyday control — a status chip showing when
the last sync ran, with **Sync now** beside it. It also shows "Connect Google
Calendar" when nothing is connected and "Google access expired · Reconnect" when
Google has withdrawn the grant.

Individual hearings can be kept out of Google with the **Skip this one** switch in
the Add/Edit hearing form.

### The subscription link

Settings also offers a read-only ICS link needing no permission at all: paste it
into Google Calendar's **Other calendars → From URL**, Apple Calendar's **New
Calendar Subscription**, or Outlook's **Subscribe from web**. Calendar apps
refresh it on their own schedule — Google is often 8–24 hours behind — so it is
the weaker option where OAuth is available. **Reset link** invalidates a link
that has been forwarded to the wrong person.

---

## Troubleshooting

**"You approved a@… but asked to sync b@…"** — the account chooser landed on the
wrong Google. Nothing was connected; try again and pick the right one.

**"Google didn't return a renewable token"** — Google only issues a refresh token
on a fresh consent. Remove ProHippo at
https://myaccount.google.com/permissions and connect again.

**"Google access expired"** — the grant was revoked, or the password changed.
Reconnect from Settings; nothing else is lost, and the next sync repairs the
calendar.

**Events missing** — only hearings within the last 90 days and anything future
are synced; older ones are deliberately left out. Check the **Hearings** switch,
and that the hearing has both a date and a time.

**Duplicate events** — shouldn't happen (see derived IDs above). If it does, hit
**Sync now**: the orphan sweep removes every ProHippo-owned event that no longer
matches a record.
