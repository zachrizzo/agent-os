# Agent OS

This OpenClaw feature plugin includes a typed draft-analysis operation, a model tool, a native page, and a composer replacement. The browser entry owns its DOM and uses the host's canonical draft and send operations.

## Build and install

```sh
npm install
npm run build
npm run validate
openclaw plugins install .
```

Installation applies the plugin in the running local Gateway. If the Gateway is stopped, start it to load the saved installation.

For native UI, enable **Settings > Labs > Custom plugin UI** (`gateway.controlUi.experimental.customPlugins: true`), then restart the Gateway and reload the browser tab. This setting is off by default; backend installation does not require it.

Select Agent OS in the Control UI sidebar. Open **Plugins > Customize UI** and choose Draft composer to try the replacement; choose Built-in to restore it.

For agent-requested activation, run `npm run pack`. The receipt contains the exact archive path and SHA-256 digest for `plugin_activate_artifact`. Approval applies to those bundled bytes and does not enable Custom plugin UI. The archive has no install scripts or package dependencies; backend activation applies through the running Gateway.

After browser-only changes, run the build again and use **Plugins > Customize UI > Reload plugin UI** as an administrator. After editing installed backend source, run `openclaw plugins reload agent-os`. Rebuild compiled code before reloading; for a copied installation, reinstall the rebuilt package. Plugin install and update commands apply changes through the running Gateway. Native plugins run trusted code in the Gateway and browser; install only code you trust.

Keep browser imports on the browser-safe `control-ui` and `feature-contract` SDK entrypoints. Bundle framework dependencies with the plugin. Return a dispose handle for DOM, subscriptions, and other resources; check the view's abort signal after asynchronous work.

## Voice from the tab

The tab bar has a **Talk to Voice** button. It opens `agent:voice:main` and presses that session's composer mic with a plain click, which is the composer's tap path (Talk can only start from the Voice session). It refuses to click if the composer has a draft (a tap would send it) or if `talk.catalog` says realtime isn't ready, skips the dictation-only twin button, and shows a toast if Talk doesn't start. Leaving the Voice view ends Talk, so the Voice session header gets **Stop voice · Agent OS**, which presses Stop and returns to this tab. Code: `src/voice.ts`.

Try it without the Gateway: `node harness/serve.mjs 5299`, then open `http://127.0.0.1:5299/` (mock host; no audio). `node harness/check.mjs` runs six scenarios (desktop, narrow layout, out-of-order catalog, realtime unavailable, draft present, no mic) in WebKit and Chromium against a mock composer modelled on the 2026.9.7 bundle. `node harness/shoot.mjs <outdir>` replays the click-through in WebKit (`... chromium` for Chromium).
