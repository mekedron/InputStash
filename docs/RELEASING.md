# Releasing InputStash

How a new version of the extension reaches the Chrome Web Store and the
Firefox Add-ons marketplace, and the gotchas worth remembering.

## TL;DR

```bash
# Bump locally if you remember; CI will sync it anyway.
git tag v0.1.4
git push origin v0.1.4
```

That tag push triggers `.github/workflows/release.yml`, which:

1. Syncs `package.json` version to the tag (commits back to `main` if it lagged).
2. Builds Chrome + Firefox zips with `wxt` (Firefox build also produces a sources zip for AMO review).
3. Creates a GitHub Release with both zips + a changelog.
4. Submits the Chrome zip to the Web Store via `wxt submit`.
5. Submits the Firefox zip + sources zip to addons.mozilla.org via `wxt submit`.

Both stores review submissions. Chrome takes anywhere from a few hours to a
few days; AMO is typically faster (often hours, sometimes minutes for
already-approved listings). Once approved, the new version rolls out to
users automatically.

## What runs where

| Step | Where | Source of truth |
| --- | --- | --- |
| Build chrome/firefox zips | GitHub Actions matrix | `wxt.config.ts` |
| Create GitHub Release | `softprops/action-gh-release` | tag + `git log` |
| Submit to Chrome Web Store | `wxt submit --chrome-zip` | secrets below |
| Submit to addons.mozilla.org | `wxt submit --firefox-zip --firefox-sources-zip` | secrets below |
| Deploy `docs/` to GitHub Pages | `.github/workflows/pages.yml` (paths-gated) | `docs/index.html` |

## Secrets

All set on `mekedron/InputStash` → Settings → Secrets and variables → Actions:

| Secret | What | Mirror in 1Password (vault: `InputStash`) |
| --- | --- | --- |
| `CHROME_EXTENSION_ID` | Current Web Store listing id | — |
| `CHROME_CLIENT_ID` | OAuth 2.0 desktop client id (GCP project `nikita-rabykin`) | `Chrome Web Store OAuth Client ID/Client ID` |
| `CHROME_CLIENT_SECRET` | OAuth 2.0 client secret | `Chrome Web Store OAuth Client ID/Client Secret` |
| `CHROME_REFRESH_TOKEN` | OAuth refresh token for the Web Store Publish API | `Chrome Web Store OAuth Client ID/add more/Refresh Token` |
| `FIREFOX_EXTENSION_ID` | Gecko add-on id (`inputstash@rabykin.dev`); also pinned in `wxt.config.ts` | — |
| `FIREFOX_JWT_ISSUER` | AMO API JWT issuer | `Firefox Add-on Marketplace API Key/JWT issuer` |
| `FIREFOX_JWT_SECRET` | AMO API JWT secret | `Firefox Add-on Marketplace API Key/JWT secret` |

Active Chrome listing as of this writing: `njofgcbjfefgocdngdmlegcdigcbjneh`.
Active Firefox listing id: `inputstash@rabykin.dev`.

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

## Bootstrapping a fresh repo from scratch

End-to-end checklist for setting up a brand-new browser-extension repo with
the same `git tag` → auto-publish flow. Roughly 30–45 minutes the first
time; most of it is filling in the Chrome Web Store dashboard.

Prerequisites on your machine: `gcloud`, `gh`, `op` (1Password CLI), `node`,
`pnpm`, `python3`. All `brew install`-able.

### 1. Initialize the extension project

Any extension build system works as long as it produces a Chrome zip whose
`manifest.json` does **not** include a `key` field. With wxt:

```bash
pnpm create wxt@latest my-extension
cd my-extension
pnpm install
pnpm zip   # smoke test: produces .output/<name>-<version>-chrome.zip
```

Initialize git and push to a GitHub repo (`gh repo create` or the web UI).

### 2. Set up Google Cloud for the Web Store Publish API

```bash
# Pick or create the GCP project that will own the OAuth client.
gcloud projects create my-extension-publisher        # or use an existing one
gcloud config set project my-extension-publisher
gcloud services enable chromewebstore.googleapis.com
```

Then in the Cloud Console (these two pages have no CLI equivalent —
OAuth clients of type *Desktop* cannot be created via `gcloud`):

1. <https://console.cloud.google.com/auth/overview?project=my-extension-publisher>
   → configure OAuth consent screen as **External**, fill in app name +
   support email. Skip Scopes. Add yourself under **Test users** (otherwise
   the OAuth flow in step 3 rejects you with "Access blocked: developer
   hasn't completed Google verification").
2. <https://console.cloud.google.com/auth/clients/create?project=my-extension-publisher>
   → Application type **Desktop app** → Create.
   Copy the **Client ID** and **Client secret**.

Why Desktop and not "Chrome Extension"? The Chrome Extension OAuth type is
for browser-runtime OAuth (`chrome.identity.getAuthToken`). For headless CI
publishing you need an installed-app refresh token, which only the Desktop
type produces.

### 3. Mint a refresh token via local OAuth loopback

Save this as `mint_token.py`:

```python
#!/usr/bin/env python3
import http.server, json, os, socket, sys, threading, urllib.parse, urllib.request, webbrowser

CLIENT_ID, CLIENT_SECRET = os.environ["CWS_CLIENT_ID"], os.environ["CWS_CLIENT_SECRET"]
SCOPE = "https://www.googleapis.com/auth/chromewebstore"
with socket.socket() as s: s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]
REDIRECT = f"http://127.0.0.1:{port}/callback"

auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
    "response_type": "code", "client_id": CLIENT_ID, "redirect_uri": REDIRECT,
    "scope": SCOPE, "access_type": "offline", "prompt": "consent",
})

got, done = {}, threading.Event()
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        got.update({k: v[0] for k, v in qs.items()})
        self.send_response(200); self.end_headers()
        self.wfile.write(b"OK, return to terminal.")
        done.set()

srv = http.server.HTTPServer(("127.0.0.1", port), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
print(auth_url, file=sys.stderr); webbrowser.open(auth_url)
done.wait(300); srv.shutdown()

resp = urllib.request.urlopen(urllib.request.Request(
    "https://oauth2.googleapis.com/token",
    data=urllib.parse.urlencode({
        "code": got["code"], "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
        "redirect_uri": REDIRECT, "grant_type": "authorization_code",
    }).encode(),
))
print(f"REFRESH_TOKEN={json.load(resp)['refresh_token']}")
```

Run:

```bash
export CWS_CLIENT_ID=...     # from step 2
export CWS_CLIENT_SECRET=...
python3 mint_token.py
# Approve in browser. Token prints on stdout.
```

(Optional but recommended) Store everything in 1Password:

```bash
op item create --vault MyVault --category "Secure Note" \
  --title "Chrome Web Store OAuth Client ID" \
  "add more.Client ID[text]=$CWS_CLIENT_ID" \
  "add more.Client Secret[password]=$CWS_CLIENT_SECRET" \
  "add more.Refresh Token[password]=<refresh-token-from-above>"
```

### 4. Create the Web Store listing via API

Build a chrome zip with **no `key` field** in `manifest.json` (CWS rejects
`manifest.key` on first upload with `PKG_MANIFEST_KEY_NOT_EMPTY`).

```bash
ACCESS_TOKEN=$(curl -s -X POST https://oauth2.googleapis.com/token \
  -d "client_id=$CWS_CLIENT_ID" -d "client_secret=$CWS_CLIENT_SECRET" \
  -d "refresh_token=$CWS_REFRESH_TOKEN" -d "grant_type=refresh_token" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['access_token'])")

curl -X POST \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "x-goog-api-version: 2" \
  -H "Content-Type: application/zip" \
  --data-binary @./.output/my-extension-0.1.0-chrome.zip \
  "https://www.googleapis.com/upload/chromewebstore/v1.1/items"
```

The response `id` is your new extension id. Save it — you'll need it for the
next step.

### 5. Wire up GitHub secrets

Chrome:

```bash
gh secret set CHROME_EXTENSION_ID  --repo OWNER/REPO --body "<id from step 4>"
gh secret set CHROME_CLIENT_ID     --repo OWNER/REPO --body "$CWS_CLIENT_ID"
gh secret set CHROME_CLIENT_SECRET --repo OWNER/REPO --body "$CWS_CLIENT_SECRET"
gh secret set CHROME_REFRESH_TOKEN --repo OWNER/REPO --body "$CWS_REFRESH_TOKEN"
```

Firefox (see [§ AMO setup](#firefox-amo-setup) below for how to obtain these):

```bash
gh secret set FIREFOX_EXTENSION_ID --repo OWNER/REPO --body "<gecko-id-from-wxt.config.ts>"
gh secret set FIREFOX_JWT_ISSUER   --repo OWNER/REPO --body "$AMO_JWT_ISSUER"
gh secret set FIREFOX_JWT_SECRET   --repo OWNER/REPO --body "$AMO_JWT_SECRET"
```

### 6. Add the release workflow

Copy [`.github/workflows/release.yml`](../.github/workflows/release.yml) from
this repo into your new repo. It assumes:

- `pnpm zip` / `pnpm zip:firefox` produce chrome and firefox zips into
  `.output/` (default for wxt).
- A `.nvmrc` file pins the Node version.
- Tags follow `vX.Y.Z` (or `vX.Y.Z-suffix`) format.

(Optional) If you want gated GitHub Pages deploys for project docs, also
copy [`.github/workflows/pages.yml`](../.github/workflows/pages.yml) and
flip Pages source to workflow-based:

```bash
gh api --method PUT repos/OWNER/REPO/pages -f 'build_type=workflow'
```

### 7. Fill out the dashboard before first publish

Open <https://chrome.google.com/webstore/devconsole>, find your new draft,
and complete:

- Detailed description (≥25 characters)
- Icon image (128×128)
- At least one screenshot or video
- Category
- Language
- Privacy practices tab: data-usage certification, host-permission
  justification, remote-code-use justification (whichever apply)

Click **Submit for review**. Google reviews the first publish manually; this
can take a few hours to a few days.

### 8. Flip the OAuth consent screen to production

To avoid the [refresh token expiring after 7 days](#-refresh-token-expires-while-consent-screen-is-in-testing),
switch the consent screen from *Testing* to **In production** at
<https://console.cloud.google.com/auth/audience?project=my-extension-publisher>.
For a single-developer app using only its own scope, no Google verification
is required.

### 9. Ship

```bash
git tag v0.1.1
git push origin v0.1.1
```

That's the whole loop forever after.

### Things never to do

- **Do not enable "Verified CRX uploads"** on the listing. See the warning
  section above — once enabled it cannot be undone and the listing is
  bricked for API publishing.
- **Do not put `manifest.key`** in the chrome zip you upload to CWS. It's a
  dev-only convenience; CWS assigns the identity key itself.
- **Do not depend on `mnao305/chrome-webstore-upload-action`** or other
  community wrappers — they get deleted. Call `chrome-webstore-upload-cli`
  directly via `npx`.

## Common failure modes

| Symptom in CI logs | Cause | Fix |
| --- | --- | --- |
| `PKG_MUST_UPDATE_AS_CRX` | Verified CRX uploads got enabled on the listing | Listing is unrecoverable; create a new one (see above) |
| `Publish condition not met: ... mandatory privacy information ...` | Missing dashboard metadata on a fresh listing | Fill out the dashboard fields, then re-tag (or click Submit for review once on the already-uploaded draft) |
| 401 / `invalid_grant` from OAuth | Refresh token expired (7-day Testing-mode limit) | Re-mint refresh token or flip consent screen to In production |
| `Unable to resolve action <name>` | Third-party action was deleted/renamed | Pin to a different action or invoke the underlying CLI via `npx` |
| `mnao305/chrome-webstore-upload-action` not found | That action's repo no longer exists | The repo now uses `wxt submit`; if you see this you're on an old workflow |
| AMO: `Version <X> already exists` | That version number was previously uploaded to AMO (any channel) | Bump the version and re-tag — AMO version numbers are write-once per add-on |
| AMO: `Source code upload is required` | First submission without `--firefox-sources-zip`, or sources zip didn't make it into the artifact | Verify `pnpm zip:firefox` produced `*-sources.zip` and that it's included in the firefox build artifact |
| AMO: `401 Unauthorized` | JWT issuer/secret wrong or rotated | Re-mint at <https://addons.mozilla.org/developers/addon/api/key/> and update `FIREFOX_JWT_*` secrets |
| AMO: `GET .../addons/addon/<id>: 404 Not Found` | Listing was never created on AMO | Do the first submission manually through the AMO dashboard (see [§ AMO setup step 4](#4-bootstrap-the-listing-manually-first-version-only)) — `wxt submit` only handles updates to existing listings |

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

## Firefox AMO setup

The release workflow auto-submits to addons.mozilla.org via `wxt submit`.
Setting up a fresh add-on:

### 1. Pin the gecko id

`wxt.config.ts` needs `browser_specific_settings.gecko.id` set to a stable
id you control (any string of the form `<slug>@<your-domain>`). This repo
uses `inputstash@rabykin.dev`. The id is the Firefox equivalent of the
auto-assigned Chrome extension id and is what `FIREFOX_EXTENSION_ID`
points at.

### 2. Mint AMO API credentials

Sign in to addons.mozilla.org and visit
<https://addons.mozilla.org/en-US/developers/addon/api/key/>.

Generate a new credential — you get a **JWT issuer** (looks like
`user:1234567:8`) and a **JWT secret** (a hex string). The secret is shown
once; copy it immediately.

Store both in 1Password:

```bash
op item create --vault InputStash --category "API Credential" \
  --title "Firefox Add-on Marketplace API Key" \
  "JWT issuer[text]=$AMO_JWT_ISSUER" \
  "JWT secret[password]=$AMO_JWT_SECRET"
```

### 3. Set the GitHub secrets

```bash
gh secret set FIREFOX_EXTENSION_ID --repo OWNER/REPO --body "<gecko-id>"
gh secret set FIREFOX_JWT_ISSUER   --repo OWNER/REPO --body "$AMO_JWT_ISSUER"
gh secret set FIREFOX_JWT_SECRET   --repo OWNER/REPO --body "$AMO_JWT_SECRET"
```

### 4. Bootstrap the listing manually (first version only)

`wxt submit` requires the AMO listing to already exist — it does a
`GET /api/v5/addons/addon/<gecko-id>` before uploading and aborts with 404
if the add-on isn't registered yet. So the very first submission has to go
through the dashboard:

1. Build the zips locally: `pnpm zip:firefox` produces both
   `.output/<name>-<version>-firefox.zip` and
   `.output/<name>-<version>-sources.zip`.
2. Go to <https://addons.mozilla.org/developers/addon/submit/>, choose
   **On this site** (listed channel), upload the firefox zip, then upload
   the sources zip when prompted.
3. Fill in listing metadata: name, summary, description, categories,
   license, support email, icon (auto-pulled from the package), screenshots,
   tags.
4. Submit for review.

Once Mozilla approves that first version, the listing is live and the
gecko id is registered. From that point on, every tagged release in CI
flows through `wxt submit` against this same listing — no dashboard
intervention needed unless metadata changes.

### Why `wxt submit` needs the sources zip

AMO requires unminified source code for human review whenever the
distributed bundle was produced by a build tool — which is always true for
wxt projects. `pnpm zip:firefox` produces both
`<name>-<version>-firefox.zip` (what users install) and
`<name>-<version>-sources.zip` (what reviewers read), and the release
workflow forwards both to `wxt submit`. Without the sources zip, AMO
rejects the upload outright.
