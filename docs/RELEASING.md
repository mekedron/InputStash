# Releasing InputStash

How a new version of the extension reaches the Chrome Web Store, and the
gotchas worth remembering.

## TL;DR

```bash
# Bump locally if you remember; CI will sync it anyway.
git tag v0.1.4
git push origin v0.1.4
```

That tag push triggers `.github/workflows/release.yml`, which:

1. Syncs `package.json` version to the tag (commits back to `main` if it lagged).
2. Builds Chrome + Firefox zips with `wxt`.
3. Creates a GitHub Release with both zips + a changelog.
4. Uploads the Chrome zip to the Web Store listing and submits it for review.

Google reviews take anywhere from a few hours to a few days. Once approved,
the new version is live for users automatically.

## What runs where

| Step | Where | Source of truth |
| --- | --- | --- |
| Build chrome/firefox zips | GitHub Actions matrix | `wxt.config.ts` |
| Create GitHub Release | `softprops/action-gh-release` | tag + `git log` |
| Upload + auto-publish on CWS | `chrome-webstore-upload-cli@3` | secrets below |
| Deploy `docs/` to GitHub Pages | `.github/workflows/pages.yml` (paths-gated) | `docs/index.html` |

## Secrets

All set on `mekedron/InputStash` → Settings → Secrets and variables → Actions:

| Secret | What | Mirror in 1Password (vault: `InputStash`) |
| --- | --- | --- |
| `CHROME_EXTENSION_ID` | Current Web Store listing id | — |
| `CHROME_CLIENT_ID` | OAuth 2.0 desktop client id (GCP project `nikita-rabykin`) | `Chrome Web Store OAuth Client ID/Client ID` |
| `CHROME_CLIENT_SECRET` | OAuth 2.0 client secret | `Chrome Web Store OAuth Client ID/Client Secret` |
| `CHROME_REFRESH_TOKEN` | OAuth refresh token for the Web Store Publish API | `Chrome Web Store OAuth Client ID/add more/Refresh Token` |

Active listing as of this writing: `njofgcbjfefgocdngdmlegcdigcbjneh`.

## ⚠️ Refresh token expires while consent screen is in "Testing"

While the OAuth consent screen for the `nikita-rabykin` GCP project is in
**Testing** mode, refresh tokens expire after **7 days**. CI will mysteriously
start 401-ing about a week after the token was minted.

Permanent fix: flip the consent screen to **In production** at
<https://console.cloud.google.com/auth/audience?project=nikita-rabykin>.
No Google verification is required because the app only uses its own scope.

If the token *has* expired, re-mint by running the OAuth loopback flow:

```bash
op read "op://InputStash/Chrome Web Store OAuth Client ID/Client ID"
op read "op://InputStash/Chrome Web Store OAuth Client ID/Client Secret"
# Use those with the local OAuth helper script described in the chat history,
# or any equivalent (e.g. `chrome-webstore-upload-keys` npm helper).
# Then:
gh secret set CHROME_REFRESH_TOKEN --repo mekedron/InputStash
```

## ⚠️ Never enable "Verified CRX uploads" on the listing

There's a field in the Chrome Web Store dashboard called **Verified CRX
uploads** where you can paste a public key. It looks like it's about
authenticating CI uploads. It is not — it's a feature for *self-hosted*
extension distribution (proving to end users that a `.crx` they downloaded
from your own server matches what CWS has on file).

Once enabled, plain-ZIP API uploads stop being accepted with
`PKG_MUST_UPDATE_AS_CRX`. The only way to satisfy that is to upload a signed
CRX whose `crx_id` matches the listing's extension ID — but `crx_id` is
`sha256(public_key)[:16]`, deterministic, and the listing's identity key is
held by Google. No CRX you can sign will ever validate. The setting cannot
be disabled once enabled. The listing has to be abandoned.

This is exactly what happened to the original listing
`jgdilgolopilbkaplhabhpddofddlhpb`, which is why the active listing today is
`njofgcbjfefgocdngdmlegcdigcbjneh`.

**Just leave the field alone.**

## Setting up a brand-new Chrome Web Store listing (only if ever needed)

If we ever need to start over (e.g. another extension, or this one really has
to move again), the working sequence is:

1. Build a chrome zip with **no `key` field** in `manifest.json`
   (CWS rejects `manifest.key` on first upload with `PKG_MANIFEST_KEY_NOT_EMPTY`).
2. Create the listing via the API — CWS allocates the id:
   ```bash
   ACCESS_TOKEN=$(curl -s -X POST https://oauth2.googleapis.com/token \
     -d "client_id=$CLIENT_ID" -d "client_secret=$CLIENT_SECRET" \
     -d "refresh_token=$REFRESH_TOKEN" -d "grant_type=refresh_token" \
     | python3 -c "import json,sys;print(json.load(sys.stdin)['access_token'])")

   curl -X POST \
     -H "Authorization: Bearer $ACCESS_TOKEN" \
     -H "x-goog-api-version: 2" \
     -H "Content-Type: application/zip" \
     --data-binary @./inputstash-chrome.zip \
     "https://www.googleapis.com/upload/chromewebstore/v1.1/items"
   ```
   The response `id` is the new extension id. Rotate it into
   `CHROME_EXTENSION_ID` (`gh secret set CHROME_EXTENSION_ID`).
3. Open the new draft in the dashboard and fill in: description (≥25 chars),
   icon, at least one screenshot, category, language, privacy practices tab
   (data-usage certification, host-permission justification, remote-code-use
   justification). The first auto-publish will fail until these are present.
4. Click **Submit for review** once. After approval, all subsequent
   `git tag` pushes auto-publish without further dashboard visits.
5. Do **not** touch "Verified CRX uploads".

## Common failure modes

| Symptom in CI logs | Cause | Fix |
| --- | --- | --- |
| `PKG_MUST_UPDATE_AS_CRX` | Verified CRX uploads got enabled on the listing | Listing is unrecoverable; create a new one (see above) |
| `Publish condition not met: ... mandatory privacy information ...` | Missing dashboard metadata on a fresh listing | Fill out the dashboard fields, then re-tag (or click Submit for review once on the already-uploaded draft) |
| 401 / `invalid_grant` from OAuth | Refresh token expired (7-day Testing-mode limit) | Re-mint refresh token or flip consent screen to In production |
| `Unable to resolve action <name>` | Third-party action was deleted/renamed | Pin to a different action or invoke the underlying CLI via `npx` |
| `mnao305/chrome-webstore-upload-action` not found | That action's repo no longer exists | We invoke `chrome-webstore-upload-cli@3` directly; if you see this you're probably on an old workflow |

## Local sanity checks

```bash
pnpm zip              # chrome zip into .output/
pnpm zip:firefox      # firefox zip into .output/

# Inspect the manifest that ships:
unzip -p .output/inputstash-*-chrome.zip manifest.json | python3 -m json.tool

# Look at current listing state via API:
curl -s -H "Authorization: Bearer $ACCESS_TOKEN" -H "x-goog-api-version: 2" \
  "https://www.googleapis.com/chromewebstore/v1.1/items/$CHROME_EXTENSION_ID?projection=DRAFT"
```

## Firefox

The release workflow builds a Firefox zip and attaches it to the GitHub
Release, but does **not** auto-submit to addons.mozilla.org. That's an
intentional manual step for now; users can sideload from the release zip,
and AMO submission is rare enough not to be worth automating yet.
