# Agent OS — god's-eye view for OpenClaw

A native Control UI **tab** (not a dashboard widget) that shows, live and beautifully,
every agent on this Gateway: what each one is doing right now, who is talking to whom,
what they said, and what it is costing. You can step in anywhere.

**Not in scope:** ticket status, kanban, card management (Workboard owns that), config
editing, raw trace waterfalls as the default view (only on drill-down).

## Why (research, 2026-10-01)

- Subagents are invisible until they finish ([claude-code #34468](https://github.com/anthropics/claude-code/issues/34468)).
  The popular OSS dashboards all sell the same thing: a live parent→child tree plus
  streaming tool calls ([agents-observe](https://github.com/simple10/agents-observe),
  [disler hooks observability](https://github.com/disler/claude-code-hooks-multi-agent-observability)).
- Topology + time travel: people dislike traces that flatten branching runs into a line
  (HN on AgentLens, *unverified snippet*). [LangGraph Studio](https://brightbean.xyz/blog/langgraph-studio-first-agent-ide-debugging-ai-agents/)
  animates the graph live and forks from checkpoints; [Phoenix](https://arize.com/docs/phoenix/integrations/typescript/openai-agents)
  draws handoffs as an agent graph.
- "Tell me when an agent needs me": cmux's notification rings and per-workspace sidebar
  (branch, PR, ports, latest message) are its headline feature ([cmux](https://github.com/manaflow-ai/cmux)).
- Agents as characters / RTS "god mode": [Pixel Agents](https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents),
  [AgentCraft](https://www.getagentcraft.com/docs) (it already has a read-only OpenClaw
  integration that relies on agents self-reporting), [ABCC](https://github.com/mrdushidush/agent-battle-command-center),
  and the [God Mode UX](https://medium.com/sadasant) argument for a map, resource bars,
  and an alert log instead of chat threads.
- Intervention matters most: in the CHI'25 [AGDebugger study](https://arxiv.org/abs/2503.02068),
  the top pain was localizing errors in long agent conversations, and the most valued
  feature was editing/resetting messages. Claude Code agent teams let you message any
  teammate ([docs](https://code.claude.com/docs/en/agent-teams)).
- Recurring complaints: no live refresh (Langfuse), noisy or garbled traces, several
  overlapping views of the same data, watch-only tools, and terminal sprawl beyond about 3 agents.

## v1 features (ranked)

1. **Live comms map.** Agents are nodes: a role glyph, a per-agent color, and a ring that
   pulses while the agent is active. Edges are parent/child and message relationships.
   Each message travels along its edge as an animated particle, colored by kind (brief,
   report, finding, approval, steer).
2. **"Now" line per agent.** One live sentence for each agent ("running pytest, 4m",
   "reviewing a8413d64", "waiting on you"), derived from tool and progress events.
3. **IPC stream.** A timeline of every inter-agent message. Click one to open a drawer
   with the full text, sender and receiver, the related card and commit, and any
   `FORGE-REPORT` rendered as a structured verdict.
4. **Focus mode.** Click an agent to see its live tool-call stream, recent messages,
   worktree/branch/HEAD, model, tokens and cost, and runtime. Actions: **message, steer,
   pause/stop, open session**.
5. **Attention inbox.** Approvals waiting on Zach, blocked agents, gate denials, stalls
   (no progress for 30 minutes), failed runs. A badge in the top bar plus an optional
   subtle sound.
6. **Replay scrubber.** Drag back through time and the map, "now" lines, and stream
   rewind to that moment. A live / paused toggle.
7. **Resource meters.** Token and cost burn per minute (total and per agent), active
   runs, local Kind cluster memory and namespaces per card, and worktrees.
8. **⌘K command palette.** Message an agent, jump to an agent or message, approve or
   deny, stop a run, open its session, toggle ambient mode.

Later: ambient full-screen second-monitor mode (v1.1), checkpoint fork/edit-and-resend
(AGDebugger-style), a pixel/character skin.

## Layout

```
┌ top bar: Agent OS · live●/paused · meters (tok/min · $ · runs · k8s mem) · inbox(3) · ⌘K ┐
├ left rail ────────┬ center: live comms map ──────────────────────┬ right: IPC stream ──┤
│ agents (procs)    │  force/radial graph, animated message         │ newest first,        │
│ role · now line   │  particles, orchestrator at center,           │ filter by agent/kind,│
│ status dot · cost │  workers orbiting, idle agents dimmed         │ click → drawer       │
├───────────────────┴───────────────────────────────────────────────┴──────────────────────┤
│ bottom: replay scrubber (event density sparkline, live head)                             │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

## Visual language

- **Mood:** calm mission control, closer to Linear/Raycast/Vercel polish than an admin
  panel. Dark first (follow the host theme tokens; also support light). Dense but quiet:
  motion means "something is happening", stillness means idle.
- **Color:** neutral graphite surfaces. Each agent gets one stable hue from a curated
  categorical palette that stays legible in dark and light themes; state is separate from
  identity (ok/warn/danger only for state). Message kinds are encoded by shape and color,
  never by color alone.
- **Type:** host `--font-body` for the UI, `--font-mono` for SHAs, commands and tool
  calls. Large numerals for the meters.
- **Motion:** particles take 400–900 ms along an edge; node pulses use opacity/scale
  only; new events ease in; no bouncing. Respect `prefers-reduced-motion` (swap
  particles for a flash). Target 60 fps with 20 agents and 10 messages/s.
- **Graph tech:** the coder chooses and justifies, e.g. d3-force over Canvas/SVG,
  xyflow, sigma.js, or Pixi for particles. Everything bundled at build time, with no
  runtime CDN and no eval.

## Architecture

**Plugin `agent-os`** (native OpenClaw plugin):
- **Capture.** Typed hooks: `subagent_spawned`, `subagent_ended`, `subagent_progress`,
  `message_received`, `message_sent`, `after_tool_call`, `session_start`,
  `session_end`. Gotchas: `subagent_ended` is best-effort, and it correlates via
  `targetSessionKey` == `subagent_spawned.childSessionKey`. Hooks never throw into the
  agent run.
- **Store.** Plugin-owned SQLite holding a bounded event log (retention configurable,
  default 7 days) plus a derived current-state snapshot. **Redact secrets**
  (tokens/keys/passwords in tool args and outputs) before storing. Message bodies stay
  local.
- **API.** `operator.read` RPCs `agentos.snapshot`, `agentos.events.list` (time range,
  filters) and `agentos.message.get`, plus a live push feed (`feature.watch`/`feature.on`,
  no polling). `operator.write` actions: message, steer, stop, open session. All
  actions go through existing Gateway session APIs and are logged as events.
- **UI.** `package.json.openclaw.controlUi` entry with `registerPage` +
  `registerNavigation` adds the **Agent OS** nav tab; build with `openclaw plugins build`.
  It requires **Settings → Labs → Custom plugin UI**
  (`gateway.controlUi.experimental.customPlugins`) plus a Gateway restart and browser
  reload.
- **Relationship to forge-guard.** forge-guard keeps enforcement (card linking, report
  and SHA checks, gates). agent-os is observe-and-act. They share no code at first; if
  both need the same capture, agent-os owns the event store and forge-guard can read it.

## Security

Native UI runs with full Control UI trust, so use the **high-assurance** recipe:
security review of the actions, redaction tests, and no network egress from the UI.
Activation (enabling Labs custom UI, installing the plugin, and restarting the Gateway)
is a separate step done with Zach after review CLEAN and QA PASS.
