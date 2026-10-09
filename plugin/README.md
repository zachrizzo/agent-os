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

Try it without the Gateway: `node harness/serve.mjs 5299`, then open `http://127.0.0.1:5299/` (mock host; no audio). `node harness/check.mjs` runs six voice scenarios plus the fleet, rooms, markdown, theme and Docs scenarios (desktop, narrow layout, out-of-order catalog, realtime unavailable, draft present, no mic) in WebKit and Chromium against a mock composer modelled on the 2026.9.7 bundle. `node harness/shoot.mjs <outdir>` runs the click-through in WebKit (`... chromium` for Chromium).

## Light / dark theme

Agent OS follows the Control UI's mode live (no reload). The app runs in a sandboxed iframe, so it cannot inherit the host's CSS variables: `plugin/src/theme-bridge.ts` posts `{ type: 'agent-os:theme', mode, vars }` to the frame (on load, on the app's `agent-os:theme-request`, and whenever `<html>` changes `data-theme-mode`/`data-theme`/`class`/`style` or `prefers-color-scheme` flips) with the host values of `--bg --card --text --text-strong --muted --border --accent --accent-foreground --ok --warn --danger --info --accent-2 --font-body --mono`. `prototype/src/theme.ts` sets them as `--h-*` on `:root` and `data-mode`; every colour in `src/style.css` derives from those tokens (`color-mix`), so custom Control UI themes carry through. The map canvas reads the resolved palette (`P` in `theme.ts`: background glow, stars, labels, halos, rings, additive `lighter` blend in dark and `multiply` in light) and repaints on the next frame. The Voice button, status and toast are host-side and already use the host variables.

Standalone (dev server, "Open Agent OS" in a browser tab, no host) it follows `prefers-color-scheme` live. The only raw colours left are the fallback palettes at the top of `src/style.css` (dark `:root`, light `:root[data-mode='light']`, used when no host is present), the per-mode event-kind colours there, and the team/avatar identity hues (`TEAM_PALETTE`, `AVATAR_HUES`: data-driven mid-tone accents shared by both modes; text on them is mixed toward the foreground). `node harness/check.mjs` checks host-var mapping, the map canvas pixel, the drawer, rooms, composer and a WCAG contrast sweep (4.5:1, 3:1 for 18px+) in both modes and engines, and the live toggle without a reload. The mock host (`harness/index.html`) has a **Theme** button that flips `data-theme-mode` like the Control UI.

## Work view (default tab)

The tab opens on **Work**: one row per piece of work in flight, keyed by the Jira ticket (`AIPIT-6358`) or MR (`!980`) found in session labels (the briefs), Activity text and labels. An MR that appears next to a ticket folds into that ticket's row. A running labelled worker or an unanswered question with no ticket still gets its own row.

Each row: state (**Needs Zach** / **Blocked** / **Working** / **Done**), the owning lead (the `*-lead` agent that spawned or reports the work, else the parent), the last real milestone (MR merged, review verdict, security verdict, push, MR opened, QA/tests passed, commit; negated phrases such as "nothing is pushed" do not count, chatter never does), the blocker (the question for Zach, a blocked outcome, an aborted last session, or an open `CHANGES_REQUESTED`), the age since the first sign of the work, and what the active session is doing now. Needs Zach rows are pinned on top. Automation/cron-only work and work done more than 4 hours ago are hidden until **Show idle + automation**. Clicking a row opens the session that matters (the asker, the active worker, else the lead).

The map moved to the **Fleet** tab (selecting an agent in the rail switches there). The tok/min and $/hr meters are gone from the top bar. Logic: `prototype/shared/work.ts` (pure, unit-tested in `shared/work.test.ts`); view: `src/ui/work.ts`.

"Now" lines say what a running agent is doing: the data server reads `inFlightRun` from `chat.history` (limit 1) for up to two running sessions per poll, at most every 8 s each, and turns the open tool call plus the latest progress line into e.g. `Running a command · Full gate, then commit.` (`shared/progress.ts`). Finished sessions show their own last outcome, never "Message from …".

## Sessions (all of an agent's threads)

Selecting an agent or team switches the right panel to **Sessions** (the **Activity** tab brings the stream back). It lists every session of that agent or team, newest first, each with its kind (Main, Subagent, Automation, Room, Dashboard), state (Running, Needs Zach, Failed, Done, Idle) and last-activity time. Subagent runs nest under the session that spawned them, even when they run under another agent id (a lead's coder, simplifier and reviewer children). Clicking a row opens its full thread in the drawer. The drawer and the **Thread** button in the agent view each have a session picker for the selected agent; Work rows show chips for the sessions behind them. `GET /api/sessions?source=live|mock&agent=<id>|team=<id>` serves the list and `GET /api/history` reads any listed session (the `phi` agent is excluded from both). Code: `prototype/shared/sessions.ts`, `src/ui/sessions.ts`, `src/ui/session-picker.ts`.

## Live-only fleet

The map/fleet shows live agents only, for every team alike. A session is live if it is running, or not finished and updated within `RECENT_ACTIVITY_MS` (15 min, `prototype/shared/liveness.ts`). done/aborted/timeout/killed/failed/cancelled/error, archived and stale sessions are `retired`: hidden from map nodes, rail and the "agents" count, and revealed by the topbar **History N** toggle (N = hidden count). A running session is always shown even if its lead or sibling sessions are finished (orphans re-attach to Chief of Staff). Logic test: `cd prototype && npm test`. Harness: `node harness/serve.mjs 5299 --mock` (own mock data server on :6299; `check.mjs`/`shoot.mjs` start it themselves if nothing is serving). Rebuild the bundle with `cd prototype && npx vite build --base ./ --outDir ../plugin/app --emptyOutDir`.

## Message agent

Zach can message any agent or session from Agent OS: the composer sits in the session drawer (click an Activity item, or **Thread** on the agent/team view) and at the bottom of the map when an agent or a team is selected (a team targets its lead). It is not tied to "Needs you". Enter sends, Shift+Enter adds a line, up to 4000 characters. Approval / Needs-you items stay read-only displays.

The composer has a **Direct / Via Chief of Staff** toggle for every non-main session; **Direct** is the default. Direct sends straight to that session with `sessions.send` as `[agent-os] Zach: <text>`, so the agent and the thread both know it came from Zach. Via Chief of Staff sends to `agent:main:main` as `[agent-os] Zach → @<agent>: <text>` (plus a `(session: <key>)` line when the target is not that agent's main session), so main relays and tracks it. Main's own sessions are always messaged directly and show no toggle. The hint under the box states the route. Code: `prototype/shared/route.ts`, `src/ui/composer.ts`.

The session drawer reads `GET /api/thread?source=..&key=<session>`: transcript items, the session status and the in-flight run. A subagent's first message (the `[Subagent Context] … [Subagent Task]` wrapper) shows as a collapsed **Task** card naming the session that sent it. Senders: **You** only for messages tagged as the Gateway owner or sent from Agent OS; relayed and inter-session messages show the sending agent (Chief of Staff for `agent:main:*`). Replies render as Markdown; each tool call is one collapsible line (arguments and result on expand; six or more in a row fold into one "N tool calls" line). Long messages are collapsed with **Show more** (nothing is cut by Agent OS); a message the Gateway itself shortened for display says so. While a run is in progress the drawer polls every 3 s and shows the live run (streaming text and tool lines from `inFlightRun`); idle sessions refresh every 15 s. The header shows Working (with run time), Needs you, Failed, Done or Idle; **Spend** is the session's `totalTokens` and `estimatedCostUsd` from `sessions.list`, falls back to `sessions.usage` when the list has none, and says *Counting* while a first turn is running and the Gateway has not reported usage yet. The drawer is 600 px wide by default; drag its left edge to resize (double-click resets; the width is remembered) or use the expand button for full width. The agent-view composer hides while the drawer is open. Code: `prototype/shared/transcript.ts`, `src/ui/thread.ts`, `src/ui/drawer.ts`.

Send path: browser `POST api/send?source=live` `{key, message, direct?}` (needs header `x-agent-os-send: 1`) -> this plugin's `/agent-os` route (`src/index.ts`, same origin rule: no Origin, `null` from the sandboxed tab, or same host) -> data server (`prototype/server/index.ts`) -> `openclaw gateway call sessions.send` to `agent:main:main` (or the target, when direct) for a session the fleet already lists. That is the same CLI and auth the data server already uses to read sessions; no new token, port or Gateway method scope in the browser. The data server then adds a `You -> agent` message event to Activity. `source=mock` records the message locally only. Data-server note: Gateway message RPCs are refused inside an agent `exec` subprocess (`OPENCLAW_SHELL=exec`), so start the data server from a normal terminal or launchd, not from an agent.

Proof on a throwaway Gateway (temp HOME, ports 19400-19499, never the live or PHI Gateways): `node harness/live-proof.mjs <outdir>` creates a session, sends from the built UI, then checks `chat.history`, the Activity feed (`You -> agent`, once), the drawer thread and the guards. `node harness/check.mjs` covers the composer (agent view, team view, drawer) and the live-only erroring count against the mock fleet.

Rail footer "N agents erroring" counts live sessions only, with History on too.

## Compact agent-to-agent messages

A `sessions_send` reaches the receiving session as `[Inter-session message] sourceSession=… sourceTool=sessions_send isUser=false` plus a fixed routing explanation ahead of the sender's text. Agent OS shows it as one compact row, `coo → forge  <text>`, in the session drawer thread, with the wrapper folded behind a **routing** toggle (non-`sessions_send` tools such as `subagent_announce` get a small tool chip). Activity rows for those messages carry the sender's words instead of "Message to X". This is display only: `chat.history` is parsed on read (`prototype/shared/a2a.ts`), stored transcripts are never rewritten and nothing hooks `before_message_write`.

The Control UI's own chat bubbles are not changed. The plugin API has a `transcript` replacement surface (`docs/plugins/feature-plugins.md`, `registerReplacement`: `workspace`, `session-list`, `composer`, `transcript`, `tool-result`), but it swaps the whole transcript view for one the plugin renders itself (only `mountDefault` can reuse the built-in view, with no per-message hook), is chosen per browser under Plugins > Customize UI, and is not persistent config. Compact bubbles would mean re-implementing the full message renderer, so this build does not ship one. Note `docs/web/control-ui/chat.md` says newer hosts already render forwarded messages as left-aligned bubbles with a **From** row.

## Quiet rooms (the default)

New rooms, and rooms saved before this mode existed (`rooms.json` version < 5), are **Quiet**: only the members Zach `@mentions` answer; with no mention only the lead answers; `@all` asks everyone. Each answers once, then the run pauses (**One round done**) until Zach presses **Continue** (another round for whoever was handed a point, else the same members, reply-or-PASS) or writes again. **Everyone**, **Mentions only** and **Lead first** stay available in the room header.

The first turn on each member's room session starts with a short context note: the room name and purpose (optional field at create, `purpose` on update, 300 chars), the members and lead, how replies work in this mode, and pointers to relevant files (`~/.openclaw/workspace/MEMORY.md` and each member team's `~/.openclaw/teams/<team>/MEMORY.md`, when they exist; nothing PHI). Members that got it are recorded in the room's `primed` list. The phi refusal and the write guards are unchanged.

## Open discussion (Everyone mode)

A room is a group chat. When Zach posts, every member replies in the shared thread (round 1, in parallel; each bubble lands as soon as that agent finishes, with a typing bubble while it works). In every later round each member sees the whole discussion so far and either replies (builds on it, disagrees, answers, `@`-hands a point to a member) or says `PASS`. Members talk to each other in the open.

The **lead** (room setting; default `rfc-lead` when it is a member, else the first member) is a normal member that also moderates: it speaks last in each round, steers by addressing members with `@id`, and can summarise when asked, as an ordinary message. It does not conclude the discussion and there is no "final answer" bubble or marker.

The discussion ends only when a whole round is `PASS` (the agents decide that themselves; a failed turn is NOT a pass, see *Failures and Stop* below), or when Zach hits **Stop** (which also aborts the in-flight Gateway runs). There is no round cap and no "adds nothing new" heuristic: a short "agreed" is a reply and keeps it going, so the prompt tells agents to `PASS` instead. No steps, turn caps, round settings or timeouts in the UI.

A message that `@`mentions members is a direct question: only they reply, and replies that `@`mention others pull those in; no lead wrap-up. Logic: `prototype/shared/rooms.ts` (`runDiscussion`), unit-tested in `shared/rooms.test.ts` and `server/rooms.test.ts`. Older `rooms.json` files (captain-led council) load as plain discussion rooms; the pipeline fields and the old council/final message flags are dropped.

Not token streaming: the Gateway path waits for each agent's run to finish, so a reply appears as a whole bubble when that agent is done (typing bubbles show who is still working).

## Rooms v2 (soft pause, queue, usage, modes, notes, hand-offs)

Still no cap: nothing below stops a discussion by itself. A long run **pauses** and waits for Zach.

- **Soft pause + Continue.** After `pauseAfterPosts` bot replies (default 24; 0 = off) or `pauseAfterTokens` tokens (default 0 = off) since Zach last wrote, or when a member repeats itself (near-identical to its own earlier reply) or members hand a point round a ring (A→B→C→A for 3 laps), the run holds (`status: paused`, `pause.reason` posts/tokens/repeat/ring). The composer banner offers **Continue**, **End now** and **Stop**; writing a message also releases it. Pauses are counted from Zach's last message or the last Continue. Logic: `runDiscussion`, `detectLoop` in `shared/rooms.ts`.
- **Usage chip.** Per run and per room: turns, tokens, cost, last speaker. Tokens/cost come from the assistant messages in `chat.history` (`shared/turn-usage.ts`, tolerant of several field spellings); a turn with none is estimated (~4 chars/token) and the chip shows `~`.
- **Responder modes** (header select, `responderMode`): *Everyone* (default: an unaddressed message goes to all), *Mentions only* (nobody answers until an `@mention`/`@all`; the room says so), *Lead first* (the lead answers alone; others join when `@mentioned` or handed a point). `@mentions` still address members directly in every mode.
- **Follow-up queue.** A message sent while a discussion runs is stored flagged `queued` (shown dashed, hidden from the agents), joins at the next round boundary (agents are told Zach posted again), and resets the pause counters. At most 5 queued; Stop or End now drops them with a note.
- **Notes and decisions.** ⋯ → *Notes & decisions*: shared notes (4000 chars) and pinned messages (pin icon on a bubble, max 20) are quoted to every member on every turn, and pinned messages survive the 400-message transcript cap. Only Zach writes them (no control tags).
- **Participants strip.** While a run is active each member shows thinking / using `<tool>` / waiting on `<names>` / idle with a timer. The tool name is read from the transcript while the Gateway run is active (an assistant tool call with no result yet); it degrades to "thinking" when none is visible.
- **Hand-off chips.** A reply that `@mentions` members shows `→ Member` chips with a hop count (1 = first hand-off after Zach spoke). Derived from the thread (`handoffsOf`), nothing stored.
- **Interrupted runs.** `rooms.json` (now `version: 4`) stores the run state next to the rooms. After a data-server restart a run that was running or paused is shown as **interrupted** with a thread note; it is never replayed (its tools may already have run) and queued messages are reported as not delivered.
- **Speak filter (opt-in, off by default).** ⋯ → *Room settings* → "Skip turns with nothing to add": from round 2, one small-model call (`AGENT_OS_JUDGE_MODEL`, default `anthropic/claude-haiku-4-5`, on a dedicated session `agent:<lead>:room-<id>-judge` created with `sessions.create` `model`) decides who has something new to add. Members who were just `@mentioned` always answer, round 1 is never filtered, a reply that cannot be read or any error lets everyone speak. The chip shows how many turns it saved.
- **Wrap up / End now** (⋯ menu). *Ask lead to summarize* posts an ordinary `@lead` message. *End discussion now* is a soft stop: replies in flight land, nothing new starts (`stopReason: ended`); **Stop** still aborts the Gateway runs.

- **Failures and Stop (#11, #12).** A failed turn is classified: rate limit / overload (429, 503, 529) is retried twice with ~1s, ~2s jittered backoff; auth and billing (401/403/402/insufficient_quota) are terminal, not retried, and the member is not asked again in that run; anything else (timeouts, dropped connections, unknown) is not retried because the send may have been accepted. Every failure is a system note in the thread, and a run whose last round had a failure ends `stopReason: failed`, never `passed`. Stop records `cutoffAt` on the run; replies from that run that arrive afterwards are dropped in `add()` (`server/rooms.ts`), counted in `run.dropped`, and noted once in the thread.

New routes (same guard as `/api/send`): `POST /api/rooms/:id/continue|end|wrapup|pin`; the update body also takes `notes`, `responderMode`, `pauseAfterPosts`, `pauseAfterTokens`, `speakFilter`. The plugin proxy whitelist (`ROOMS_WRITE` in `src/index.ts`) and the harness proxy were widened to match, so the plugin must be rebuilt and reloaded with the data server.

Proof: `node harness/rooms-v2-proof.mjs <outdir> [port=19470]` runs every item on a throwaway Gateway with the stub model (ports 19470-19473, temp HOME) through the real UI; screenshots in `harness/screens/rooms-v2/`. Unit: `cd prototype && npm test` (now includes `src/ui/*.test.ts`).

## Docs (rendered Markdown viewer)

The **Docs** button in the top bar opens a read-only viewer for the Markdown files in the workspace (`~/.openclaw/workspace`: `reports/`, `memory/`, `MEMORY.md`, `USER.md`, `AGENTS.md`, ...). It exists because the Control UI's Files panel shows `.md` files only as raw text, with no way to see them rendered.

- **Rendered / Raw.** The toggle at the top right of the document switches between the two. Rendered is the default and uses the same sanitising renderer as the rooms (`shared/markdown.ts`: marked + DOMPurify): headings, GFM tables, task lists (read-only), block quotes, links (http(s)/mailto only, new tab), code blocks with a **Copy** button. Raw HTML, scripts, event handlers, `javascript:` links and images are never rendered (images show as nothing, HTML as literal text). Colours come from the theme tokens, so it follows light/dark.
- **List.** Files grouped by folder, newest first, with a filter box. The reload buttons re-read the list or the open file (nothing polls).
- **Deep link.** `.../agent-os/?file=reports/phi-gateway-setup.md` opens straight into Docs with that file. A path that is not a workspace-relative `.md`/`.markdown` path is ignored. Esc closes the view.
- **Relative links** between documents are not followed (the shared renderer allows only absolute and `#` links).

Data server (`prototype/server/docs.ts`, `GET /api/docs` and `GET /api/docs/file?path=reports/x.md`), fail-closed and read-only:

- One root only: `~/.openclaw/workspace` (`AGENT_OS_DOCS_ROOT` overrides it for tests; `--mock` serves `prototype/server/fixtures/docs`, never the real workspace).
- `path` is relative to the root and must end in `.md`/`.markdown` (415 otherwise). Absolute paths, `..`, `.` and empty segments, backslashes, NUL, and any segment starting with `.` (`.git`, `.env`, ...) are refused with 400.
- No symlink anywhere on the path, realpath must stay inside the root, and the file must have exactly one hard link (a hard link can point at a file outside the root). The file is opened with `O_NOFOLLOW` and re-checked on the descriptor. Anything that fails these looks like a plain 404.
- 256 KiB cap (413); the list is capped at 3000 files and 8 levels, skips dot-directories and `node_modules`.
- PHI: a directory named `phi`, `phi-*`, `openclaw-phi` or `workspace-phi` is never listed or read, at any depth, and nothing outside the workspace root is reachable at all (`~/.openclaw-phi` is not under it). A *file* named `phi-gateway-setup.md` is an ordinary document.
- Same guard as the writes: the `x-agent-os-send: 1` header is required (a cross-origin page cannot add it without a preflight, and the server sends no CORS headers), plus the localhost Host check. The plugin proxy adds the header itself and answers the preflight for `GET`. Responses pass through the same secret redaction as everything else the data server returns.

Tests: `prototype/server/docs.test.ts` (traversal, absolute and odd paths, extension, size, symlink file/dir, hard link, PHI directories, missing root, and the HTTP guard against the real server in mock mode). Harness: `docsChecks` in `harness/check.mjs` (rendered + raw in light and dark, contrast, hostile input, deep link).

## Group rooms

Topbar **Rooms**: create a room, pick agents from the live agent list (`agents.list`; the `phi` agent is never listed, joined or messaged), rename it, add/remove members, archive/restore. One thread shows every member with avatar and name; Zach's messages show as **You**. Rooms and threads persist in `~/.openclaw/agent-os/rooms.json` (0600; `AGENT_OS_ROOMS_FILE` overrides, mock mode keeps rooms in memory only).

- **@mention gating**: `@id` or `@Name` in Zach's message picks who answers (a direct question); no match (or `@all`) means everyone, as an open discussion (see above).
- There is no turn cap and no member timeout; **Stop** ends a run.
- Each member answers on its own session `agent:<id>:room-<roomId>` (created on first use), never its main session. Those sessions are kept off the fleet map and Activity.
- The pass token is `PASS`, not `NO_REPLY`: in a direct session the Gateway treats an exact `NO_REPLY` as a failed turn and re-prompts the agent (seen on a throwaway Gateway). `NO_REPLY` is still accepted as a pass.

Write path: browser `POST api/rooms[/:id[/send|/stop]]` with the same guard as `/api/send` (JSON + `x-agent-os-send: 1`, 16 KB cap, same-origin rule in the plugin route) -> data server -> `openclaw gateway call` (`sessions.send`, `chat.history`, `agents.list`, plus `sessions.create`, accepted only for `agent:<id>:room-<roomId>` keys). No new token, port or scope in the browser. `sessions.send` to any `agent:phi:*` key is refused by the data server.

Checks: `cd prototype && npm test` (unit: mentions, gating, the discussion loop, passes, a2a parsing); `node harness/check.mjs` (mock fleet: compact row, room create/gating/members/caps/archive/persistence/guards); `node harness/shoot.mjs <dir> [baseUrl] [chromium]` (screenshots in dark and light, plus a live theme toggle; committed in `harness/screens/`). Throwaway-Gateway proof with a stub model provider (`harness/stub-llm.mjs`, no credentials): `node harness/rooms-proof.mjs <dir> [port=19470]` uses ports 19470-19473, covers real `sessions.create`/`sessions.send`/`chat.history`, gating, caps, PASS, phi refusal, restart persistence and the compact row against real `chat.history`, then cleans up.

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


Note: `harness/check.mjs`, `harness/shoot.mjs` and `harness/rooms-proof.mjs` still describe the removed council/round-table UI and need a rewrite for the open discussion; `harness/council-proof.mjs` was deleted with the council code.
