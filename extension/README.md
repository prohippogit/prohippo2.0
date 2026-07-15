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
- `portal-login.js` — runs on the portal; fills User ID + password and submits.

## Privacy

The extension only runs on `incometax.gov.in` and your ProHippo pages. Passwords
are held in memory just long enough to fill the login form and are not stored by
the extension.
