<p align="center">
  <img src="public/icon/128.png" alt="InputStash icon" width="128" height="128" />
</p>

# InputStash

Never lose what you typed.

A cross-browser extension that quietly remembers what you've typed into form fields, so an accidental `Esc`, a rogue keyboard shortcut, a refresh, or a tab close never destroys your draft again. Open the toolbar icon, find the input you lost, copy it back.

> Built and maintained by one indie developer. If it saves you a painful retype, [☕ buy me a coffee](https://buymeacoffee.com/mekedron) — it keeps InputStash free and ad-free.

## Status

**Scaffold only.** No input-capture logic is wired up yet — the popup, content script, and background entrypoints are stubs with TODOs. The hard parts (catching input across `<input>`, `<textarea>`, `contenteditable`, shadow DOM, iframes, SPAs) are deliberately deferred to a follow-up.

## Stack

- [WXT](https://wxt.dev) — one config builds Chrome, Edge, Opera, Brave, and Firefox from the same source. MV3 by default. Bundled `browser.*` polyfill.
- TypeScript
- Svelte 5 (popup UI)
- HMR in dev: saving the popup reloads instantly; content/background changes trigger an auto-reload of the extension.

## Requirements

- Node 20 LTS (a `.nvmrc` is included)
- pnpm (`npm i -g pnpm`)

## Quickstart

```bash
pnpm install
pnpm dev            # launches Chrome with the extension auto-loaded
pnpm dev:firefox    # same, in Firefox Developer Edition
```

## Build

```bash
pnpm build              # → .output/chrome-mv3/
pnpm build:firefox      # → .output/firefox-mv2/
pnpm zip                # store-ready Chromium zip
pnpm zip:firefox        # store-ready Firefox zip
```

## Loading the built extension

After `pnpm build`, the unpacked extension lives in `.output/chrome-mv3/` (or `.output/firefox-mv2/` after `pnpm build:firefox`).

### Chrome, Edge, Opera, Brave

All four use the same flow — they're all Chromium under the hood.

1. Open `chrome://extensions` (or `edge://extensions`, `opera://extensions`, `brave://extensions`).
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked**.
4. Select `.output/chrome-mv3/`.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select `.output/firefox-mv2/manifest.json`.

(Temporary add-ons are removed when Firefox restarts. For permanent local install, you'd need to sign through AMO.)

### Safari

Deferred. Safari supports the WebExtension API but requires an Xcode wrapper for distribution. When ready, Apple's `safari-web-extension-converter` can wrap `.output/chrome-mv3/` directly:

```bash
xcrun safari-web-extension-converter .output/chrome-mv3/
```

You'll need Xcode and an Apple Developer account to ship; for local testing you can enable unsigned extensions under Safari → Settings → Advanced → Develop menu → Allow unsigned extensions.

## Typecheck

```bash
pnpm compile
```

Runs `svelte-check` followed by `tsc --noEmit`.

## Project layout

```
.
├── wxt.config.ts            # manifest, permissions, browser targets
├── tsconfig.json
├── entrypoints/
│   ├── background.ts        # MV3 service worker — TODO
│   ├── content.ts           # injected into all frames — TODO
│   └── popup/
│       ├── index.html
│       ├── main.ts
│       ├── App.svelte
│       └── app.css
├── components/
│   ├── storage.ts           # thin wrapper around browser.storage.local — TODO
│   └── types.ts             # StashEntry
├── assets/
│   └── icon.svg            # icon source — rasterized into public/icon/
└── public/
    └── icon/                # 16/32/48/96/128 PNGs used by the manifest
```

## Roadmap

The interesting work is still ahead. Rough order:

1. **Capture from regular form fields** — `input` and `change` listeners on `<input>` and `<textarea>`, debounced per element, with a stable per-field identity (form name + field name + index fallback).
2. **`contenteditable`** — the rich-text editors that power Gmail, Notion, Slack, etc. Listen on `input` events of editable elements; serialize as text (and optionally HTML).
3. **Shadow DOM** — walk open shadow roots when attaching listeners; re-walk on `MutationObserver` events.
4. **SPAs** — `MutationObserver` so dynamically-mounted inputs get captured too.
5. **Privacy guardrails** — never capture `<input type="password">`, fields with sensitive `autocomplete` tokens (`cc-number`, `one-time-code`, etc.), or content on origins the user has opted out.
6. **Storage strategy** — `browser.storage.local`, capped at N entries per origin, dedupe consecutive snapshots, age out old entries.
7. **Popup UI** — list grouped by origin / time, search, one-click copy, delete, clear-all, per-origin opt-out toggle.
8. **Safari packaging** — wrap with `safari-web-extension-converter`, address any WebKit-specific quirks.

## Support the project

InputStash is a solo indie effort — no company, no investors, no ads, no analytics. Every snapshot stays on your device.

If it earned its place in your toolbar, the easiest way to help is to chip in a coffee:

**[☕ buymeacoffee.com/mekedron](https://buymeacoffee.com/mekedron)**

Other ways to help that cost nothing:

- Star this repo so more people find it.
- File a bug or feature request in [Issues](../../issues).
- Tell a friend who keeps losing half-written emails.

## License

[MIT](LICENSE) © Nikita R
