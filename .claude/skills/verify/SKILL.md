---
name: verify
description: Build InputStash, load it into a disposable Chrome, and verify capture/storage/popup behavior end-to-end, including input-lag measurements with a large stash.
---

# Verify InputStash end-to-end

The extension's surface is a real browser: a content script capturing typing,
a background service worker writing storage, and the popup UI. Verify by
driving all three, not by unit-calling modules.

## Build

```bash
pnpm build            # .output/chrome-mv3
pnpm build:firefox    # .output/firefox-mv2 (build-only check; no FF harness here)
```

## Harness

`harness/bench.mjs` (in this skill directory) drives everything with
puppeteer-core. One-time setup inside `harness/`:

```bash
npm init -y && npm i puppeteer-core@24 --no-audit --no-fund
npx @puppeteer/browsers install chrome@stable --path ./browsers
# then update CHROME in bench.mjs to the printed binary path
```

Gotchas learned the hard way:

- **Branded Google Chrome ignores `--load-extension`** (removed in Chrome 137).
  Use the Chrome for Testing binary installed above.
- **Headless never starts the MV3 service worker** in this setup — run headful
  (`headless: false`); windows open briefly at an offscreen position.
- The extension's storage can only be inspected/seeded through the service
  worker target (`browser.waitForTarget(t => t.type() === 'service_worker')`,
  then `target.worker().evaluate(...)`).
- Seed data, then **relaunch with the same `userDataDir`** so startup paths
  (e.g. storage migrations) run against the seeded state.

## Run

```bash
node bench.mjs <path-to-extension-build> fixed     # perf + 16 functional checks
node bench.mjs <path-to-old-build>       baseline  # perf numbers only, for A/B
```

The `fixed` mode asserts: legacy v1 blob migrates to per-domain v2 keys +
index; typing is captured and coalesced; shadow DOM (incl. nested) and
contenteditable capture works; `<select>` change captures; password values are
never stored; a settings push blocks new captures; the popup lists, filters
and renders domains. Results land in `result-<mode>.json` + `popup.png`.

## Perf regression bar

With a ~7.6 MB stash (400 domains), typing 25 bursts in one tab must produce
**0 ms of measured main-thread blocking in a second open tab**. The v1
architecture measured ~1100 ms blocked / 5 long tasks in that scenario (the
storage.onChanged broadcast storm). If the probe tab shows blocking again,
someone re-introduced a content-script `storage.onChanged` listener or a
whole-stash write on the capture path.
