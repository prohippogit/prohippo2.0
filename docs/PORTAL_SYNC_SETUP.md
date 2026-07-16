# Income-tax Portal Sync — setup (Phase 0 + 1)

This adds the ability to store each assessee's e-filing portal login (encrypted)
and open the portal already logged in, via the **ProHippo Sync** Chrome extension.

There are three one-time steps: set an encryption key, deploy the functions, and
load the extension.

---

## Step 1 — Create the encryption key secret

The portal passwords are encrypted at rest with a key ProHippo holds. Generate a
random key and store it as a Firebase secret. In **Cloud Shell**
(https://shell.cloud.google.com), run:

```
cd ~/prohippo2.0 && git fetch origin && git checkout -f claude/keen-ride-FlIY1 && git reset --hard origin/claude/keen-ride-FlIY1
```

Then generate + set the key (copy this whole block):

```
KEY=$(openssl rand -base64 32) && printf '%s' "$KEY" | firebase functions:secrets:set CREDENTIAL_ENC_KEY --data-file=-
```

> ⚠️ This key protects every stored portal password. If you ever change or lose
> it, previously saved passwords can't be decrypted and must be re-entered. You
> don't need to remember the key yourself — it stays in Firebase — just don't
> rotate it casually.

## Step 2 — Deploy the functions

```
cd ~/prohippo2.0/functions && npm install && cd .. && firebase deploy --only functions
```

Wait for **`✔ Deploy complete!`** (type `3` if it asks about container images).

The web app auto-deploys from GitHub, so no hosting step is needed.

## Step 3 — Load the ProHippo Sync extension (desktop Chrome)

1. Chrome → `chrome://extensions` → turn on **Developer mode**.
2. Click **Load unpacked** and select the `extension/` folder from the repo.
   (In Cloud Shell you can't load it; do this on your own computer — either
   clone the repo locally, or download the `extension/` folder.)
3. **ProHippo Sync** appears in the list.

See `extension/README.md` for details.

---

## Using it

1. Open an assessee → **Edit** (or Add) → fill **Income-tax portal login**
   (user ID = usually PAN, and the password), tick the consent box, save.
2. On the assessee's **Overview**, the **Income-tax portal** card now shows
   **Open e-Proceedings (auto-login)**.
3. Click it — a portal tab opens and logs in automatically.

## First-run calibration

The portal's login field names can change; the extension's auto-fill is
best-effort. If the on-page ProHippo badge says it couldn't fill the form,
report what you see and the selectors in `extension/portal-login.js` will be
tuned once. This is normal for portal automation.

## Phase 2 — e-Proceedings + notice/order PDFs (implemented)

The extension now, after login, calls the portal's JSON API directly to pull the
e-Proceedings list, then for each proceeding pulls its notices/orders and
downloads each PDF. PDFs are uploaded to **Firebase Storage** under
`users/{uid}/assessees/{id}/notices/…` and their metadata (DIN, section, dates,
Storage path) is recorded via the `ingestPortalNotice` Cloud Function
(deduped by DIN).

Two extra one-time deploy steps for this phase:

1. **Enable Firebase Storage** for the project (Firebase console → Build →
   Storage → Get started), if it isn't already.
2. **Deploy the new rules + function:**

   ```
   firebase deploy --only functions,storage
   ```

   `storage.rules` restricts every user to their own `users/{uid}/…` files.
