# ProHippo Sync — browser extension (Phase 1)

This Chrome extension lets ProHippo open the Income-tax e-filing portal **already
logged in** for a chosen assessee. It's the desktop companion to the ProHippo web
app. (Phase 2 will add reading e-Proceedings and pulling notice PDFs.)

## What it does today (Phase 1)

- Runs a small bridge on your ProHippo pages so the app can detect the extension.
- When you click **"Open e-Proceedings (auto-login)"** on an assessee, the app
  fetches that assessee's stored portal password (decrypted server-side, over
  HTTPS), hands it to the extension, and the extension opens the portal and
  fills in the login for you.

## What it needs

- Google Chrome (desktop). Chrome-only for now.
- The `parseNotice`/credential Cloud Functions deployed, and the assessee must
  have a portal login saved in ProHippo (Assessee → **Add portal login**).

## Load it for testing (no developer account needed)

1. Open Chrome → address bar → `chrome://extensions`
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select this `extension/` folder.
5. You'll see **ProHippo Sync** appear. That's it.

Now open the ProHippo app, go to an assessee that has a portal login saved, and
click **Open e-Proceedings (auto-login)**. A new tab opens on the portal and a
purple **ProHippo** badge shows the login progress.

## Calibration note (important)

The portal is built with Angular, and the exact names of its login fields can
change. The auto-fill in `portal-login.js` uses best-effort detection. On the
first real run, if the badge says *"Couldn't fill the form automatically"*, tell
the ProHippo team what the login page looks like (or share the field details)
and the selectors in `portal-login.js` will be tuned — this is a normal one-time
step for portal automation.

The e-Proceedings landing route (`EPROCEEDINGS_HASH` in `portal-login.js`) is
also best-effort and may need the same one-line calibration.

## Files

- `manifest.json` — permissions (portal host + ProHippo pages) and scripts.
- `bridge.js` — runs on ProHippo pages; relays messages app ↔ extension.
- `background.js` — opens the portal tab, holds the credential in memory only
  until the portal tab picks it up, then deletes it.
- `portal-login.js` — runs on the portal; fills User ID + password and submits,
  then (sync mode) fetches the e-Proceedings list.
- `portal-net.js` — **approach (a) prototype.** Runs in the page's own world and
  watches the JSON API calls the portal makes to itself, then replays the
  e-Proceedings call directly (see below).

## Approach (a): fetch via the portal's JSON API (prototype)

Instead of scraping the rendered e-Proceedings screen (slow + fragile), we call
the portal's **own** data API and get structured JSON in one shot. We can't
hard-code the API URL (it can change and may need an in-memory auth token), so
`portal-net.js` discovers it automatically:

1. It installs before the portal's app boots and quietly records the API calls
   the portal makes — including the e-Proceedings list call, with its auth
   headers. (Auth headers never leave that page-world script.)
2. On a **sync**, `portal-login.js` opens e-Proceedings once (which triggers the
   portal's own API call), then asks `portal-net.js` to **replay** that call and
   **times it**. If the JSON maps to proceedings, that's the result — no
   scraping. Otherwise it falls back to the old screen-scrape automatically.

### How to test it and read the per-PAN number

1. Reload the extension at `chrome://extensions` (it must show **v0.10.0**).
2. Open DevTools → **Console** on the portal tab before/while syncing.
3. Run a sync for one assessee. Watch the purple badge and the console:
   - **Fast path worked:** badge shows `API sync ✓ N proceedings in XXX ms`, and
     the console logs `API fast path OK — N rows in XXX ms via <endpoint>`.
     **`XXX ms` is your real per-PAN API time** — multiply by the number of PANs
     (and divide by how many you run in parallel) to size a bulk run.
   - **API reached but shape needs calibration:** badge shows
     `API reached in XXX ms (mapping needs calibration)` and the console prints
     `=== PROHIPPO API PROBE === endpoint: … ms: … json: …`. Copy that
     `endpoint` and `json` sample to the team — the field mapping in
     `mapProceedingsJson()` is then finalised once, and every future run uses the
     fast path. (Scraping still runs meanwhile, so you're never left without
     data.)

The timing you see is the pure API round-trip, so it's the honest number to base
the 200-PAN estimate on — not the slow screen-render time.

## Privacy

The extension only runs on `incometax.gov.in` and your ProHippo pages. Passwords
are held in memory just long enough to fill the login form and are not stored by
the extension.
