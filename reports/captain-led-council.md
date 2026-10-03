# Captain-led council (no loop)

Branch `openclaw/agent-os-captain-led`, worktree `~/.openclaw/worktrees/d1ce9eeff932b0b2/agent-os-captain-led`, based on `1157b63` (`openclaw/agent-os-council`, the live build). Nothing installed, pushed or restarted; the live worktree, plist and installed plugin were not touched.

## What changed
The fixed pipeline PLAN -> WORK -> one CRITIQUE -> SYNTHESIZE became PLAN -> WORK -> **STEER (captain decisions)** -> SYNTHESIZE.

After the members' first answers the captain returns one JSON decision per step:
- `{"action":"ask","targets":[ids],"question":"…","unresolved":"…"}`: a directed follow-up (two members against each other = an ask to both; they answer in parallel and may PASS)
- `{"action":"critique"}`: the existing parallel critique round (at most once)
- `{"action":"synthesize"}`: write the one reply

The steer prompt makes the captain a lead: name what is unresolved, pick who resolves it, stopping is the default.

### Not-a-loop guarantees (all in `prototype/shared/council.ts`, one unit test each)
1. Only the captain routes. Member replies are data: no @mention parsing, no member-to-member calls; a decision hiding a target in prose is invalid.
2. `maxSteps` room setting (default 3, clamp 1-4) bounds captain decisions; `maxTurns` stays the backstop, default now 3n+3 (clamp 32). Hitting the step limit forces synthesis without asking the captain again.
3. One turn is always reserved for synthesis; a step starts only with decision + 1 reply + synthesis (3 turns) left, asks/critiques are clipped to what remains. Step limit or cap -> synthesis, always one reply.
4. No-progress forces synthesis: same targets + same normalized question (the repeat is never sent), every target PASS, every target timed out/failed, second critique request.
5. Malformed, unknown-action, unknown-target, empty or failed captain decision -> synthesize. Exactly one decision turn, no retry.
6. Stop and the per-member timeout apply to follow-ups and the decision turn (aborts the Gateway run).
7. UI "Council thinking": `step N/limit`, a `stopped: done | step limit | turn cap | no progress | unusable decision | captain failed` chip, each decision as `Step N: asked X, Y about: …` (+ "Still unresolved: …"), follow-up rows, stop-reason row, "deciding" status; new `steps` number input in room settings.

### Data / migration
- `RoomSettings.maxSteps`; `Council.maxSteps`, `Council.steps[]` (`step, action, targets, question, unresolved, outcome`), `Council.stop {reason, detail}`; note kinds `decision` / `followup`; phase+status `steering`; roles `CAPTAIN-STEER`, `FOLLOW-UP`.
- `migrateRoom`: rooms without `maxSteps` get 3, and a cap equal to the old default 2n+2 becomes 3n+3 once; custom caps and rooms that already have `maxSteps` are left alone; round-table caps unchanged. Nothing is written on load. Old councils (no steps/stop) still render.
- API: `POST /api/rooms` and `POST /api/rooms/:id` accept `maxSteps`; room summary and run state carry it.

## Proof
| Check | Result |
|---|---|
| `npm test` (prototype) | **96/96** (was 84; +12 tests, 10 old ones adapted) |
| `tsc --noEmit` | clean |
| `plugin/harness/check.mjs` | **32/32**, 10/10 runs (see flake note) |
| `council-proof.mjs` | **49** ok (was 37), exit 0 |
| `live-proof.mjs` | **11** ok, exit 0 |
| `rooms-proof.mjs` | **27** ok, exit 0 |

Note on check.mjs (flake, fixed): "rail erroring count is live-only" was flaky on the base too, not caused by the council change. Same machine, interleaved back to back, 10 runs each, full check.mjs: base `1157b63` **7/10**, branch before the fix (`b4b7a98`) **7/10**; every failure was only that check (e.g. `off: 1 agent erroring, on: 2 agents erroring`), both engines. Earlier "3/3 baseline" was luck. Cause: it reads the rail count, clicks History, waits 0.8s and reads again, while the mock fleet keeps flipping workers to/from `error` (`prototype/server/mock.ts`, `emit`/`churn`, ~1 flip/s), so the two reads can differ by chance. Fix (`erroringCountChecks` only): after the page settles it stops applying stream `delta` events (frozen fleet), so the reads must match exactly; the assertion is unchanged. After the fix: branch **10/10** full runs at 32/32. `reports/check-output.txt` is one of them. This commit supersedes `b4b7a98` (amended: same change, honest message, flake fix; not pushed).

Unit tests added (`shared/council.test.ts`, `shared/rooms.test.ts`, `server/rooms.test.ts`): parseDecision strictness; early finish; follow-up (only targets run, parallel, head-to-head context, step trace); repeat -> forced synthesis; all-PASS / all-failed / all-timed-out / second critique -> synthesis; step limit (maxSteps 1,2,3,4 and 9->4); cap hit still synthesizes (maxTurns 1..10) plus a sweep (8 cues x 11 caps x 3 step limits: turns <= maxTurns, last turn is the synthesis, one reply); malformed (6 shapes + captain throws) -> one decision turn, no retry; members can't route (@mention replies start nothing); Stop during a follow-up; settings clamp/default; rooms.json migration.

`council-proof.mjs` (throwaway Gateway, stub model) now also proves on the real path: follow-up goes only to the two named members, in parallel; step limit (3 decisions then one synthesis, 11 turns); repeat (1 follow-up, repeat never sent); all-PASS; malformed -> 1 decision turn; @mentions in member replies start nothing; hard cap (maxTurns 7 -> 7 turns, stop `cap`, one reply); `maxSteps` API clamp; migration (maxTurns 3 -> 12, maxSteps 3); UI panel (3 decision rows, "stopped: step limit").

### Live run (one, real agents, RFC Council members)
Not against the live data server: a second data server on `:5297` from this worktree with `AGENT_OS_ROOMS_FILE` = a copy of the RFC Council room (new id `r1ee7ca11`, no history, same members `rfc-lead, rfc-architect, rfc-skeptic, rfc-risk`, captain `rfc-lead`, maxTurns 8 as stored) against the real Gateway. The live server was not touched; the temp server was stopped afterwards.

Question: audit-log storage, event sourcing vs append-only table + nightly snapshot, "pick one, name the single biggest risk".
- plan (rfc-lead) -> architect, skeptic, risk answered in parallel. **rfc-skeptic's run ended without a reply** ("model unavailable?"), marked `error`, captain proceeded.
- Captain step trace: **decision 1: `synthesize`** (architect and risk both picked the append-only table). 0 follow-ups, stop reason **done**.
- Synthesis: one reply, 6 of 8 turns used, run `complete`.
Outcome: the early-finish path works on real agents. **The `ask` path was not exercised on real agents** (the two answers agreed, so a good lead stopped); only one live run was allowed. The ask/limit/repeat/cap paths are proven by unit tests and the throwaway-Gateway proof. Side effect: new room sessions `agent:rfc-{lead,architect,risk,skeptic}:room-r1ee7ca11` exist on the Gateway (ordinary room sessions, left in place).

Caveat for install: the live RFC Council room has `maxTurns: 8` and 4 members. A custom cap is kept by the migration, so there a step needs 3 turns left after plan + 4 answers = 5 turns -> room for at most one step. Raise it to 15 (3n+3) in room settings after install if you want steering headroom.

## Diff summary
- `prototype/shared/council.ts`: steer loop, `steerPrompt`/`followupPrompt`, `parseDecision`, stop reasons, synthesis gets follow-ups + why steering stopped.
- `prototype/shared/rooms.ts`: types, `maxSteps` settings, `councilTurns` = 3n+3, `legacyCouncilTurns`, migration.
- `prototype/shared/scripted.ts`: deterministic steer/follow-up replies for mock + stub (cues: `conflict`, `crit`, `endless`, `repeat`, `allpass`, `badsteer`, `routeme`).
- `prototype/server/rooms.ts`, `server/index.ts`, `src/rooms-api.ts`: `maxSteps` in create/update/summary/run state, passed to the run.
- `prototype/src/ui/rooms.ts`, `src/style.css`: panel (step count, stop chip, decision/follow-up rows), steps setting.
- `plugin/app/**`: rebuilt bundle. `plugin/harness/check.mjs`, `council-proof.mjs`: updated. `plugin/README.md`: council section.
- Tests: `shared/council.test.ts`, `shared/rooms.test.ts`, `server/rooms.test.ts`.

## Install (not done)
Same shape as the README's launchd section; `WT` = this worktree.
```sh
WT=~/.openclaw/worktrees/d1ce9eeff932b0b2/agent-os-captain-led
PLIST=~/Library/LaunchAgents/com.zach.agent-os-api.plist
OLD=$(/usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$PLIST" | sed 's#/prototype$##')   # expect .../agent-os-council

# the new worktree needs its own dependencies (it only has a symlink used for testing; tsx must resolve from $WT/prototype)
(cd "$WT/prototype" && rm -f node_modules && npm ci)

# 1. plugin: app bundle (rebuilt and committed in plugin/app), applies via the running Gateway, no restart
(cd "$WT/plugin" && npm run build && npm run validate && openclaw plugins install . --force)

# 2. data server: repoint WorkingDirectory + tsx loader to $WT, then bootout/bootstrap
cp "$PLIST" "$PLIST.bak"
sed -i '' "s#$OLD#$WT#g" "$PLIST"
plutil -lint "$PLIST" && grep -c "$WT" "$PLIST"     # 2 matches
launchctl bootout gui/$(id -u)/com.zach.agent-os-api
launchctl bootstrap gui/$(id -u) "$PLIST"
curl -s http://127.0.0.1:5198/api/snapshot?source=live | head -c 120
```
Then open Rooms > RFC Council: settings show `steps 3`; optionally raise `turns` to 15.

## Rollback
Back to `openclaw/agent-os-council` @ `1157b63`:
```sh
OLD=~/.openclaw/worktrees/d1ce9eeff932b0b2/agent-os-council
(cd $OLD/plugin && openclaw plugins install . --force)
cp "$PLIST.bak" "$PLIST"      # or sed the paths back to $OLD
launchctl bootout gui/$(id -u)/com.zach.agent-os-api && launchctl bootstrap gui/$(id -u) "$PLIST"
```
`rooms.json` stays compatible both ways: the old build ignores `maxSteps`, `steps`, `stop`; its `councils[]` rendering ignores the new note kinds (`decision`, `followup`) only by showing them as plain notes. A room migrated to 3n+3 keeps that cap on rollback.
