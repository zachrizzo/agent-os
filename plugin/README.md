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

## Live-only fleet

The map/fleet shows live agents only, for every team alike. A session is live if it is running, or not finished and updated within `RECENT_ACTIVITY_MS` (15 min, `prototype/shared/liveness.ts`). done/aborted/timeout/killed/failed/cancelled/error, archived and stale sessions are `retired`: hidden from map nodes, rail and the "agents" count, and revealed by the topbar **History N** toggle (N = hidden count). A running session is always shown even if its lead or sibling sessions are finished (orphans re-attach to Chief of Staff). Logic test: `cd prototype && npm test`. Harness: `node harness/serve.mjs 5299 --mock` (own mock data server on :6299; `check.mjs`/`shoot.mjs` start it themselves if nothing is serving). Rebuild the bundle with `cd prototype && npx vite build --base ./ --outDir ../plugin/app --emptyOutDir`.

## Message agent

Zach can message any agent or session from Agent OS: the composer sits in the session drawer (click an Activity item, or **Thread** on the agent/team view) and at the bottom of the map when an agent or a team is selected (a team targets its lead). It is not tied to "Needs you". Enter sends, Shift+Enter adds a line, up to 4000 characters. Approval / Needs-you items stay read-only displays.

Send path: browser `POST api/send?source=live` `{key, message}` (needs header `x-agent-os-send: 1`) -> this plugin's `/agent-os` route (`src/index.ts`, same origin rule: no Origin, `null` from the sandboxed tab, or same host) -> data server (`prototype/server/index.ts`) -> `openclaw gateway call sessions.send` for a session the fleet already lists. That is the same CLI and auth the data server already uses to read sessions; no new token, port or Gateway method scope in the browser. The data server then adds a `You -> agent` message event to Activity. `source=mock` records the message locally only. Data-server note: Gateway message RPCs are refused inside an agent `exec` subprocess (`OPENCLAW_SHELL=exec`), so start the data server from a normal terminal or launchd, not from an agent.

Proof on a throwaway Gateway (temp HOME, ports 19400-19499, never the live or PHI Gateways): `node harness/live-proof.mjs <outdir>` creates a session, sends from the built UI, then checks `chat.history`, the Activity feed (`You -> agent`, once), the drawer thread and the guards. `node harness/check.mjs` covers the composer (agent view, team view, drawer) and the live-only erroring count against the mock fleet.

Rail footer "N agents erroring" counts live sessions only, with History on too.

## Compact agent-to-agent messages

A `sessions_send` reaches the receiving session as `[Inter-session message] sourceSession=… sourceTool=sessions_send isUser=false` plus a fixed routing explanation ahead of the sender's text. Agent OS shows it as one compact row, `coo → forge  <text>`, in the session drawer thread, with the wrapper folded behind a **routing** toggle (non-`sessions_send` tools such as `subagent_announce` get a small tool chip). Activity rows for those messages carry the sender's words instead of "Message to X". This is display only: `chat.history` is parsed on read (`prototype/shared/a2a.ts`), stored transcripts are never rewritten and nothing hooks `before_message_write`.

The Control UI's own chat bubbles are not changed. The plugin API has a `transcript` replacement surface (`docs/plugins/feature-plugins.md`, `registerReplacement`: `workspace`, `session-list`, `composer`, `transcript`, `tool-result`), but it swaps the whole transcript view for one the plugin renders itself (only `mountDefault` can reuse the built-in view, with no per-message hook), is chosen per browser under Plugins > Customize UI, and is not persistent config. Compact bubbles would mean re-implementing the full message renderer, so this build does not ship one. Note `docs/web/control-ui/chat.md` says newer hosts already render forwarded messages as left-aligned bubbles with a **From** row.

## Group rooms

Topbar **Rooms**: create a room, pick agents from the live agent list (`agents.list`; the `phi` agent is never listed, joined or messaged), rename it, add/remove members, archive/restore. One thread shows every member with avatar and name; Zach's messages show as **You**. Rooms and threads persist in `~/.openclaw/agent-os/rooms.json` (0600; `AGENT_OS_ROOMS_FILE` overrides, mock mode keeps rooms in memory only).

Semantics mirror OpenClaw broadcast groups (`channels/broadcast-groups.md`), implemented in Agent OS because broadcast groups don't cover the Control UI:

- **@mention gating**: `@id` or `@Name` picks who answers round 1; no match (or `@all`) means everyone.
- **maxRounds** 1-4 (default 1, counting the first round). Later rounds run only for members that replied or were @mentioned in the previous round, each with a digest of the others' replies; they can answer `PASS` to stay out.
- **maxTurns** 1-32 (default = member count) caps agent runs started per message, so ping-pong loops stop. Hitting a cap is written into the thread ("Stopped: turn cap reached …").
- Turns in a round run one after another so each agent sees the earlier replies; every agent is sent the new message plus the last 12 room messages.
- Each member answers on its own session `agent:<id>:room-<roomId>` (created on first use), never its main session. Those sessions are kept off the fleet map and Activity.
- The pass token is `PASS`, not `NO_REPLY`: in a direct session the Gateway treats an exact `NO_REPLY` as a failed turn and re-prompts the agent (seen on a throwaway Gateway). `NO_REPLY` is still accepted as a pass.

Write path: browser `POST api/rooms[/:id[/send|/stop]]` with the same guard as `/api/send` (JSON + `x-agent-os-send: 1`, 16 KB cap, same-origin rule in the plugin route) -> data server -> `openclaw gateway call` (`sessions.send`, `chat.history`, `agents.list`, plus `sessions.create`, accepted only for `agent:<id>:room-<roomId>` keys). No new token, port or scope in the browser. `sessions.send` to any `agent:phi:*` key is refused by the data server.

Checks: `cd prototype && npm test` (unit: mentions, gating, caps, passes, a2a parsing); `node harness/check.mjs` (mock fleet: compact row, room create/gating/members/caps/archive/persistence/guards); `node harness/shoot.mjs <dir>` (screenshots). Throwaway-Gateway proof with a stub model provider (`harness/stub-llm.mjs`, no credentials): `node harness/rooms-proof.mjs <dir> [port=19470]` uses ports 19470-19473, covers real `sessions.create`/`sessions.send`/`chat.history`, gating, caps, PASS, phi refusal, restart persistence and the compact row against real `chat.history`, then cleans up.

## Installing this build

The Agent OS tab (plugin) and its data server (`prototype/server`, the process on 127.0.0.1:5198) are separate. Rooms and the compact rows need both.

```sh
cd <worktree>/plugin && npm run build && npm run validate && openclaw plugins install . --force   # plugin: route proxy + app bundle, applies via the running Gateway, no restart
# data server: stop the old one, start this worktree's from a normal terminal (agent exec subprocesses are refused by Gateway message RPCs)
cd <worktree>/prototype && nohup npx tsx server/index.ts >/tmp/agent-os-api.log 2>&1 &
```

Roll back by reinstalling the previous plugin (`cd ~/.openclaw/worktrees/d1ce9eeff932b0b2/agent-os-spark-voice/plugin && openclaw plugins install . --force`) and starting the previous data server again. `~/.openclaw/agent-os/rooms.json` can stay or be trashed; room sessions remain in the Gateway as ordinary `agent:<id>:room-…` sessions.
