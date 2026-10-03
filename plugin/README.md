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

Try it without the Gateway: `node harness/serve.mjs 5299`, then open `http://127.0.0.1:5299/` (mock host; no audio). `node harness/check.mjs` runs six scenarios (desktop, narrow layout, out-of-order catalog, realtime unavailable, draft present, no mic) in WebKit and Chromium against a mock composer modelled on the 2026.9.7 bundle. `node harness/shoot.mjs <outdir>` runs the click-through in WebKit (`... chromium` for Chromium).

## Light / dark theme

Agent OS follows the Control UI's mode live (no reload). The app runs in a sandboxed iframe, so it cannot inherit the host's CSS variables: `plugin/src/theme-bridge.ts` posts `{ type: 'agent-os:theme', mode, vars }` to the frame (on load, on the app's `agent-os:theme-request`, and whenever `<html>` changes `data-theme-mode`/`data-theme`/`class`/`style` or `prefers-color-scheme` flips) with the host values of `--bg --card --text --text-strong --muted --border --accent --accent-foreground --ok --warn --danger --info --accent-2 --font-body --mono`. `prototype/src/theme.ts` sets them as `--h-*` on `:root` and `data-mode`; every colour in `src/style.css` derives from those tokens (`color-mix`), so custom Control UI themes carry through. The map canvas reads the resolved palette (`P` in `theme.ts`: background glow, stars, labels, halos, rings, additive `lighter` blend in dark and `multiply` in light) and repaints on the next frame. The Voice button, status and toast are host-side and already use the host variables.

Standalone (dev server, "Open Agent OS" in a browser tab, no host) it follows `prefers-color-scheme` live. The only raw colours left are the fallback palettes at the top of `src/style.css` (dark `:root`, light `:root[data-mode='light']`, used when no host is present), the per-mode event-kind colours there, and the team/avatar identity hues (`TEAM_PALETTE`, `AVATAR_HUES`: data-driven mid-tone accents shared by both modes; text on them is mixed toward the foreground). `node harness/check.mjs` checks host-var mapping, the map canvas pixel, the drawer, rooms, composer and a WCAG contrast sweep (4.5:1, 3:1 for 18px+) in both modes and engines, and the live toggle without a reload. The mock host (`harness/index.html`) has a **Theme** button that flips `data-theme-mode` like the Control UI.

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

## Council mode (default for every room)

Rooms work like Grok 4.20's multi-agent mode. Each room has one **captain** (room settings; default = first member, `rfc-lead` when it is a member). Per message from Zach (`prototype/shared/council.ts`):

1. **Plan**: the captain splits the message into one sub-question per member and replies with JSON (`{"tasks":[{"agent","question"}],"notes"}`). Parsing accepts a fenced block, bare JSON, an array or an id->question map; unknown members/empty questions are dropped. If nothing parses (or the captain fails/times out) the fallback gives every member the whole question and the panel flags "fallback plan".
2. **Work**: members answer their sub-question **in parallel**, each in its own `agent:<id>:room-<roomId>` session.
3. **Steer** (captain-led): after the first answers the captain returns ONE structured decision per step, as JSON: `{"action":"ask","targets":[ids],"question":"…","unresolved":"…"}` (a directed follow-up to chosen members; two members against each other on a disagreement is just an ask to both), `{"action":"critique"}` (the parallel critique round, at most once; one critic is the contrarian) or `{"action":"synthesize"}`. The prompt makes it act as a lead: name what is unresolved, pick who resolves it, stop as soon as the answer is good enough (stopping is the default). Targets answer in parallel and may reply `PASS`.
4. **Synthesize**: the captain writes the ONE reply to Zach: answer first, "Disagreements resolved" and "Your call" (real trade-offs) only when they apply, and one line naming members that timed out. If the captain itself fails, Zach still gets one reply built from the member answers.

The protocol is injected by the data server into every message (role line `Council role: CAPTAIN-PLAN|SPECIALIST|CAPTAIN-STEER|FOLLOW-UP|CRITIQUE|CAPTAIN-SYNTHESIZE` plus instructions); nothing depends on an agent's AGENTS.md and the agent's own rules still apply on top.

UI: the thread shows Zach's message and one captain reply (a placeholder while the council works). Under it a collapsible **Council thinking** panel updates live: a `step N/limit` count, a `stopped: done | step limit | turn cap | no progress | unusable decision | captain failed` chip, per-agent status chips (planning, working, deciding, critiquing, synthesizing, done, timed out, failed, skipped, stopped) and compact note rows like the A2A rows (plan, answers, each captain decision as `Step N: asked X about: …`, follow-ups, critiques, the stop reason; long notes fold behind "more"). Open while running, collapsed once done (a user toggle is remembered across polls).

**Not a loop** (enforced in `runCouncil`, not only in the prompt): (1) only the captain routes: member replies are data, `@mentions` in them start nothing and no member calls another; (2) `maxSteps` (room setting, default 3, max 4) limits captain decisions, on top of the `maxTurns` backstop (default 3n+3, clamp 32); (3) one turn is always reserved for the synthesis, and a step needs decision + 1 reply + synthesis (3 turns) left, so hitting the step limit or the cap forces the synthesis and Zach always gets one reply; (4) no-progress forces synthesis: the same targets and question repeated (the repeat is never sent), every target replies `PASS`, every target times out or fails, a second critique request; (5) a malformed, unknown or failed captain decision means synthesize, never a retry. Bounds: the cap is hard across all phases: answers come first, skipped steps are noted. Each member turn has a timeout (`memberTimeoutSec`, default 90, room setting): on timeout the member is marked timed out, its Gateway run is aborted and the captain proceeds. **Stop** aborts every in-flight run. Both use `chat.abort {sessionKey}` through the data server's existing `openclaw gateway call` path, accepted only for room sessions (`agent:<id>:room-<roomId>`); the browser/plugin route needs nothing new (`POST api/rooms/:id/stop` already existed). `phi` is never listed, joined, captain or messaged.

Bypass and other modes: a message that `@mentions` a member (mention gating on) goes straight to that agent through the classic round-table path, with no council. `@all`/`@everyone` or no mention runs the council. A one-member room has nothing to split and uses the classic path. The classic loop (everyone answers in turn, maxRounds, PASS) is kept as room mode **Round-table**.

Persistence: `rooms.json` (version 2) stores `mode`, `captain`, `maxSteps`, `memberTimeoutSec` and `councils[]` (plan, per-agent status, notes, `steps[]`, `stop`, `finalId`) next to the messages; the captain's reply is a normal message with `council: <triggerId>`. Old version-1 files load unchanged: `migrateRoom` fills `mode: council`, resolves the captain (saved one, else `rfc-lead` when a member, else the first member), raises an old default turn cap (= member count) to a full council, adds `maxSteps` 3 and raises the previous 2n+2 default to 3n+3 once (a room with `maxSteps` already set, or any other custom cap, is left alone), and nothing is written until the room's next save. A council that was running when the data server died loads as `stopped`.

Cost: plan + n answers + 1 decision + synthesis = n+3 agent turns when the captain stops at once (RFC Council with 4 members: 7); every step adds 1 decision + the asked members (or n critics). Worst case is bounded by `maxSteps` and `maxTurns` (3n+3 by default). Tune with `maxSteps`, `maxTurns`, `memberTimeoutSec`, or Round-table mode.

Proof: `node harness/council-proof.mjs <dir> [port=19480]` (throwaway Gateway, stub model; parallelism by overlapping run intervals, directed follow-up, step limit, repeat, all-PASS, malformed decision, cap, single reply, timeout, Stop, bypass, restart persistence, old-file migration, phi). `rooms-proof.mjs` keeps proving the round-table mode.

## Group rooms

Topbar **Rooms**: create a room, pick agents from the live agent list (`agents.list`; the `phi` agent is never listed, joined or messaged), rename it, add/remove members, archive/restore. One thread shows every member with avatar and name; Zach's messages show as **You**. Rooms and threads persist in `~/.openclaw/agent-os/rooms.json` (0600; `AGENT_OS_ROOMS_FILE` overrides, mock mode keeps rooms in memory only).

Semantics mirror OpenClaw broadcast groups (`channels/broadcast-groups.md`), implemented in Agent OS because broadcast groups don't cover the Control UI:

- **@mention gating**: `@id` or `@Name` picks who answers round 1; no match (or `@all`) means everyone.
- **maxRounds** 1-4 (default 1, counting the first round). Later rounds run only for members that replied or were @mentioned in the previous round, each with a digest of the others' replies; they can answer `PASS` to stay out.
- **maxTurns** 1-32 (default = member count) caps agent runs started per message, so ping-pong loops stop. Hitting a cap is written into the thread ("Stopped: turn cap reached …").
- (Round-table mode.) Turns in a round run one after another so each agent sees the earlier replies; every agent is sent the new message plus the last 12 room messages.
- Each member answers on its own session `agent:<id>:room-<roomId>` (created on first use), never its main session. Those sessions are kept off the fleet map and Activity.
- The pass token is `PASS`, not `NO_REPLY`: in a direct session the Gateway treats an exact `NO_REPLY` as a failed turn and re-prompts the agent (seen on a throwaway Gateway). `NO_REPLY` is still accepted as a pass.

Write path: browser `POST api/rooms[/:id[/send|/stop]]` with the same guard as `/api/send` (JSON + `x-agent-os-send: 1`, 16 KB cap, same-origin rule in the plugin route) -> data server -> `openclaw gateway call` (`sessions.send`, `chat.history`, `agents.list`, plus `sessions.create`, accepted only for `agent:<id>:room-<roomId>` keys). No new token, port or scope in the browser. `sessions.send` to any `agent:phi:*` key is refused by the data server.

Checks: `cd prototype && npm test` (unit: mentions, gating, caps, passes, a2a parsing); `node harness/check.mjs` (mock fleet: compact row, room create/gating/members/caps/archive/persistence/guards); `node harness/shoot.mjs <dir> [baseUrl] [chromium]` (screenshots in dark and light, plus a live theme toggle; committed in `harness/screens/`). Throwaway-Gateway proof with a stub model provider (`harness/stub-llm.mjs`, no credentials): `node harness/rooms-proof.mjs <dir> [port=19470]` uses ports 19470-19473, covers real `sessions.create`/`sessions.send`/`chat.history`, gating, caps, PASS, phi refusal, restart persistence and the compact row against real `chat.history`, then cleans up.

## Activity panel semantics

The right panel is one chronological stream (newest first, team colour dots; **By team** groups it, optional). Each row reads `Sender → Recipient`, a kind chip and the outcome; the task label is secondary text; clicking opens the relevant session thread. Names are agent names (Spark, COO, Chief of Staff, You), never a subagent's task label, and never truncated; the summary is ellipsized.

- **Preview** = first meaningful line of the agent's own final assistant text (`prototype/shared/activity.ts`, read from `chat.history`), never the message that triggered the run. The list-row `lastMessagePreview` is no longer used for events.
- **One row per real event**: stable ids (`spawn:`, `done:<session>:<run>`, `turn:<session>:<message>`, `msg:<from>><to>:<hash>`), so a send read from the sender's tool call and from the recipient's inbox is one row, and re-reads never duplicate.
- **Kinds**: Message, Handoff, Done, Blocked, Needs you, Approval. Handoff = a spawn (parent → child). Done/Blocked = a child run ended (child → parent) or an explicit `[COO] **done|blocked|decision**` / `FORGE-REPORT status:` tag, a failed send or failed run. Needs you = the session's attention flag, a `[COO]` decision tag, or the latest reply to Zach that asks him something (open until a later event in that thread). A run finishing is not a REPORT.
- **→ You** only for a main-chat reply to a real user turn. Replies to inter-session messages, completions and cron ticks carry no recipient; sessions_send shows sender → recipient agent.
- **System** (hidden by default, behind the System chip): heartbeat polls, NO_REPLY / silent turns, exec-completion notices, restart-recovery and other internal turns, subagent completion deliveries.
- The data server reads `chat.history` for a session only when its run state changes (newest first, 2 reads per poll), so a fresh start backfills over about a minute.

Tests: `cd prototype && npm test` (`shared/activity.test.ts` runs every rule over `shared/fixtures/fleet.json`, anonymized real fleet shapes, plus `synthetic.json` for heartbeat / exec-completion / approval turns that Gateway history does not retain).

## Installing this build

The Agent OS tab (plugin) and its data server (`prototype/server`, the process on 127.0.0.1:5198) are separate. Rooms, the compact rows and Markdown rendering need both (the renderer is bundled into the plugin's `app/`, so the plugin install alone ships it; the data server carries the mock/scripted cues and room logic).

The data server runs under launchd as `com.zach.agent-os-api` (`~/Library/LaunchAgents/com.zach.agent-os-api.plist`, `KeepAlive`, logs in `~/.openclaw/logs/agent-os-api.log`). The plist's `WorkingDirectory` and its `--import …/node_modules/tsx/dist/loader.mjs` path both point at one worktree's `prototype/`, so installing a build means repointing **both** to this worktree and reloading the job. Do not start it with `nohup`: launchd owns it, and Gateway message RPCs are refused inside an agent `exec` subprocess, so it must start from launchd or a normal terminal.

```sh
WT=<this worktree>                 # e.g. ~/.openclaw/worktrees/d1ce9eeff932b0b2/agent-os-council
PLIST=~/Library/LaunchAgents/com.zach.agent-os-api.plist
OLD=$(/usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$PLIST" | sed 's#/prototype$##')   # the worktree it runs from now; note it for rollback

# 1. plugin: route proxy + app bundle, applies via the running Gateway, no restart
(cd "$WT/plugin" && npm run build && npm run validate && openclaw plugins install . --force)

# 2. data server: repoint WorkingDirectory + tsx loader to $WT, then bootout/bootstrap
cp "$PLIST" "$PLIST.bak"
sed -i '' "s#$OLD#$WT#g" "$PLIST"                 # rewrites both the WorkingDirectory and the loader.mjs path
plutil -lint "$PLIST" && grep -c "$WT" "$PLIST"   # lint passes, 2 matches
launchctl bootout gui/$(id -u)/com.zach.agent-os-api
launchctl bootstrap gui/$(id -u) "$PLIST"
curl -s http://127.0.0.1:5198/api/snapshot?source=live | head -c 120    # serving again
```

Roll back: reinstall the previous plugin (`cd $OLD/plugin && openclaw plugins install . --force`), restore the plist (`cp "$PLIST.bak" "$PLIST"`), then `launchctl bootout gui/$(id -u)/com.zach.agent-os-api && launchctl bootstrap gui/$(id -u) "$PLIST"`. `~/.openclaw/agent-os/rooms.json` can stay or be trashed; room sessions remain in the Gateway as ordinary `agent:<id>:room-…` sessions.

## Markdown in messages

Agent text is rendered as Markdown (`prototype/shared/markdown.ts`): **marked 18.0.14** parses, **DOMPurify 3.4.16** sanitizes (both pinned exactly in `prototype/package.json`, bundled by Vite, no CDN; jsdom 30.1.1 is a dev dependency for the unit tests only). Where: room thread messages (Zach, captain, members, Round-table), Council-thinking notes, the session drawer thread and A2A rows, and Activity previews (inline only: bold, italic, code, links, one line). Supported: headings, bold/italic/strike, inline code, fenced code (monospace, horizontal scroll, Copy button), bullet/numbered lists, blockquotes, GFM tables, line breaks, task-list checkboxes (read-only). Links open in a new tab with `rel="noopener noreferrer"`; `@member` mentions keep the `.rm-at` chip; `path/to/file.ts:42` (plain or in backticks) is marked and copies on click; bare URLs autolink.

Safety: raw HTML in the source is escaped to text before sanitizing (never passed through), images are replaced by their alt text, and DOMPurify allows only a short tag list, `href/title/class/align` attributes and `http(s):`, `mailto:`, `#` and root-relative URLs (no `javascript:`, `data:`, `vbscript:`, no `style`, no event handlers). Tests: `cd prototype && npm test` (`shared/markdown.test.ts`: rendering plus XSS: script, onerror, javascript:/data: links, raw HTML, iframe, svg/math/form, malicious table cell and code fence); `node harness/check.mjs` has a Markdown scenario in both engines. Cue `richmd` in a mock room message to get Markdown-heavy council answers.
