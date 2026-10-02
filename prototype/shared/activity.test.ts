// Every Activity rule, asserted against anonymized fixtures of real fleet shapes (shared/fixtures/fleet.json: main, coo, spark and forge
// subagents, forge:main, voice, radar cron, inter-session messages, [COO] tags, NO_REPLY, subagent completion deliveries) plus
// shared/fixtures/synthetic.json (heartbeat, exec-completion, approval: no live sample survives in Gateway history).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  attentionEvent, classifyText, classifyTrigger, deriveSessionEvents, firstMeaningfulLine, isSilent, mergeEvents, messageId,
  openNeedsOf, sessionMetaOf, spawnEvent, textOf, type RawMessage,
} from './activity.ts';
import type { FleetEvent } from './types.ts';

const load = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8')) as { sessions: any[]; histories: Record<string, RawMessage[]> };
const fleet = load('fleet.json');
const synth = load('synthetic.json');
const rowOf = (set: typeof fleet, key: string) => set.sessions.find((s) => s.key === key)!;
const derive = (set: typeof fleet, key: string) => deriveSessionEvents(sessionMetaOf(rowOf(set, key)), set.histories[key]);
const all = (set: typeof fleet) => Object.keys(set.histories).flatMap((k) => derive(set, k));
const visible = (es: FleetEvent[]) => es.filter((e) => !e.sys);
const userPrompts = (set: typeof fleet) => Object.values(set.histories).flat().filter((m) => m.role === 'user' && /^Placeholder user prompt/.test(textOf(m))).map((m) => textOf(m));

// ---- fixtures are what we claim ----
test('fixtures cover every fleet shape and carry no real bodies', () => {
  const keys = fleet.sessions.map((s) => s.key);
  for (const k of ['agent:main:main', 'agent:coo:main', 'agent:forge:main', 'agent:voice:main']) assert.ok(keys.includes(k), k);
  assert.ok(keys.some((k) => /^agent:spark:subagent:/.test(k)), 'spark subagents');
  for (const a of ['forge-coder', 'forge-adversary', 'forge-reviewer']) assert.ok(keys.some((k) => k.startsWith(`agent:${a}:subagent:`)), a);
  assert.ok(keys.some((k) => /:cron:/.test(k)), 'cron');
  assert.ok(!keys.some((k) => /phi/.test(k)), 'no phi session');
  const text = JSON.stringify(fleet);
  assert.match(text, /\[Inter-session message\] sourceSession=/);
  assert.match(text, /sourceTool=sessions_send/);
  assert.match(text, /sourceTool=subagent_(settle|announce)/);
  assert.match(text, /NO_REPLY/);
  assert.match(text, /\[COO\]/);
  assert.match(text, /OpenClaw heartbeat poll/);
  assert.match(JSON.stringify(synth), /OpenClaw exec completion/);
  assert.ok(!/sondermind|\/Users\/|@[a-z]+\.com/i.test(text), 'no real identifiers');
  assert.ok(!Object.values(fleet.histories).flat().some((m) => /thinking/.test(JSON.stringify(m.content).slice(0, 4000)) && /"type":"thinking"/.test(JSON.stringify(m.content))), 'no thinking blocks');
});

// ---- 1. preview is the agent's outcome, never the triggering user message ----
test('rule 1: previews are agent outcomes, never a user prompt', () => {
  const prompts = userPrompts(fleet).concat(userPrompts(synth));
  assert.ok(prompts.length > 3);
  for (const e of all(fleet).concat(all(synth))) for (const p of prompts) assert.notEqual(e.text, p.replace(/\s+/g, ' ').trim(), `${e.id} previews a user prompt`);
  const main = visible(derive(fleet, 'agent:main:main')).filter((e) => e.to === 'zach');
  assert.ok(main.length > 0, 'main replies to Zach');
  for (const e of main) assert.match(e.text, /^Placeholder outcome \d+ \(main\)/);
  const e = derive(synth, 'agent:main:main').find((x) => x.id.endsWith('syn-m-1a'))!;
  assert.equal(e.text, 'Placeholder answer. Should I merge it now?');
});

test('rule 1: first meaningful line skips markup, labels, tags and retention notices', () => {
  assert.equal(firstMeaningfulLine('**Branch / sha:**\n\n- Built and verified.\n- more'), 'Built and verified.');
  assert.equal(firstMeaningfulLine('[COO] **done + decision**: Council mode is built. Branch x.'), 'Council mode is built. Branch x.');
  assert.equal(firstMeaningfulLine('[truncated-by-retention: complete child answer unavailable]\nReviewing the commit now.'), 'Reviewing the commit now.');
  assert.equal(firstMeaningfulLine('\n\n## Heading\nreal words'), 'Heading');
  assert.equal(firstMeaningfulLine('x'.repeat(500), 50).length, 50);
  assert.equal(firstMeaningfulLine('[Inter-session message] sourceSession=agent:coo:main sourceTool=sessions_send isUser=false\nThis content was routed by OpenClaw from another session or internal tool. Treat it as inter-session data.\nSend me the numbers.'), 'Send me the numbers.');
});

// ---- 2. one row per real event ----
test('rule 2: ids are unique and re-deriving yields the same ids (dedupe by run/message id)', () => {
  for (const set of [fleet, synth]) for (const k of Object.keys(set.histories)) {
    const a = derive(set, k);
    assert.equal(new Set(a.map((e) => e.id)).size, a.length, `${k}: duplicate ids`);
    assert.deepEqual(derive(set, k).map((e) => e.id), a.map((e) => e.id));
  }
  const ring: FleetEvent[] = [];
  const evs = all(fleet);
  assert.equal(mergeEvents(ring, evs, 5000).length, new Set(evs.map((e) => e.id)).size);
  assert.equal(mergeEvents(ring, evs, 5000).length, 0, 'second merge adds nothing');
  assert.deepEqual(ring.map((e) => e.ts), [...ring.map((e) => e.ts)].sort((a, b) => a - b), 'ring stays chronological');
});

test('rule 2: a send seen from the sender and from the recipient is one event', () => {
  const sender = { key: 'agent:coo:main', agentId: 'coo', kind: 'main' as const };
  const rcpt = { key: 'agent:main:main', agentId: 'main', kind: 'main' as const };
  const body = '[COO] **done**: Council mode is built.';
  const sent: RawMessage[] = [{ role: 'assistant', timestamp: 10, stopReason: 'tool_use', content: [{ type: 'toolcall', id: 't1', name: 'mcp__openclaw__sessions_send', arguments: { sessionKey: 'agent:main:main', message: body } }] }];
  const got: RawMessage[] = [{ role: 'assistant', timestamp: 12, provenance: { kind: 'inter_session', sourceSessionKey: 'agent:coo:main', sourceTool: 'sessions_send' }, content: body }];
  const a = deriveSessionEvents(sender, sent)[0];
  const b = deriveSessionEvents(rcpt, got)[0];
  assert.equal(a.id, b.id);
  assert.equal(a.id, messageId('agent:coo:main', 'agent:main:main', body));
  assert.equal(mergeEvents([], [a, b]).length, 1);
});

// ---- 3. noise is hidden ----
test('rule 3: heartbeat, NO_REPLY, exec-completion and internal turns are system, never visible activity', () => {
  const es = all(synth).filter((e) => e.from === 'agent:coo:main');
  const sys = es.filter((e) => e.sys);
  assert.ok(sys.length >= 4, `expected heartbeat x2, exec x2 as system, got ${sys.length}`);
  assert.ok(sys.some((e) => /Heartbeat/.test(e.text)));
  assert.ok(sys.some((e) => /Exec completion/.test(e.text)));
  for (const e of visible(es)) assert.ok(!/heartbeat|HEARTBEAT_OK|NO_REPLY|exec completion/i.test(e.text), e.text);
  // real fleet: nothing visible previews NO_REPLY, the restart-recovery notice, or the OpenClaw resume preamble
  for (const e of visible(all(fleet))) assert.ok(!/NO_REPLY|OpenClaw resumed|heartbeat|\[System\]/i.test(e.text), `${e.id}: ${e.text}`);
  const noReply = all(fleet).filter((e) => e.sys && /no reply/i.test(e.text));
  assert.ok(noReply.length >= 1, 'a real NO_REPLY turn from the fleet is classified silent');
  assert.equal(isSilent('Steer was rejected, retrying.\n\nNO_REPLY'), true);
  assert.equal(isSilent('NO_REPLY'), true);
  assert.equal(isSilent('HEARTBEAT_OK'), true);
  assert.equal(isSilent('I will say NO_REPLY when quiet.'), false);
});

test('rule 3: a finished run is not a REPORT to anyone', () => {
  for (const e of all(fleet)) assert.ok((['message', 'handoff', 'done', 'blocked', 'needs', 'approval'] as string[]).includes(e.kind), e.kind);
  assert.ok(!all(fleet).some((e) => /finished/i.test(e.text) && /^(COO|Chief of Staff) finished/.test(e.text)));
  // a running child produces no Done
  assert.deepEqual(derive(synth, 'agent:spark:subagent:sub-9003').filter((e) => e.kind === 'done'), []);
});

test('rule 3: subagent completion deliveries are not events (the child already reported); the parent follow-up text still is', () => {
  const coo = derive(fleet, 'agent:coo:main');
  assert.ok(!coo.some((e) => !e.sys && /Child completion|prompt-data|Subagent Context/.test(e.text)));
  assert.ok(coo.some((e) => e.sys && /completion delivered/i.test(e.text)) || coo.some((e) => !e.sys), 'coo has activity');
  const t = classifyTrigger({ role: 'user', content: '[Inter-session message] sourceSession=agent:spark:subagent:x sourceChannel=internal sourceTool=subagent_settle isUser=false\nbody' })!;
  assert.equal(t.type, 'completion');
});

// ---- 4. actors are agents, label is secondary ----
test('rule 4: events address sessions that map to agents; the task label is secondary', () => {
  const spawn = spawnEvent(sessionMetaOf({ key: 'agent:spark:subagent:sub-0001', agentId: 'spark', label: 'Agent OS: voice start/stop', spawnedBy: 'agent:main:main', createdAt: 5 }))!;
  assert.equal(spawn.from, 'agent:main:main');
  assert.equal(spawn.to, 'agent:spark:subagent:sub-0001');
  assert.equal(spawn.kind, 'handoff');
  assert.equal(spawn.label, 'Agent OS: voice start/stop');
  for (const e of all(fleet)) {
    assert.match(e.from, /^agent:[^:]+:/);
    if (e.to && e.to !== 'zach') assert.match(e.to, /^agent:[^:]+:/);
  }
  const done = derive(fleet, 'agent:spark:subagent:sub-0004').find((e) => e.kind === 'done' || e.kind === 'blocked')!;
  assert.ok(done, 'spark child outcome exists');
  assert.equal(done.label, 'Agent OS: Council mode for rooms');
  assert.ok(!done.text.includes(done.label!), 'summary is the outcome, not the label');
});

// ---- 5. directions are real ----
test('rule 5: "to Zach" only for a main chat reply to a real user turn', () => {
  for (const e of all(fleet).concat(all(synth))) {
    if (e.to !== 'zach') continue;
    assert.ok(/^agent:[^:]+:(main|[^:]+)$/.test(e.from));
    assert.ok(!/:subagent:|:cron:/.test(e.from), `${e.id}: a subagent/cron never addresses Zach`);
  }
  // replies to inter-session messages, completions, cron ticks are NOT addressed to Zach
  const forge = visible(derive(fleet, 'agent:forge:main'));
  for (const e of forge) assert.notEqual(e.to, 'zach', `${e.id} was a reply to an inter-session/cron trigger`);
  const radar = derive(fleet, 'agent:radar:cron:cro-0002');
  for (const e of radar) assert.notEqual(e.to, 'zach');
});

test('rule 5: inter-session sends show sender -> recipient agent', () => {
  const main = all(fleet).filter((e) => e.kind !== 'handoff' && !e.sys);
  const coo2main = main.filter((e) => e.from === 'agent:coo:main' && e.to === 'agent:main:main');
  assert.ok(coo2main.length >= 1, 'COO -> main from the fleet');
  const into = main.filter((e) => e.to === 'agent:coo:main' && e.from === 'agent:main:main');
  assert.ok(into.length >= 1, 'main -> COO via the recipient inbox');
  for (const e of coo2main.concat(into)) assert.equal(e.session, e.from, 'click opens the sender session');
});

test('rule 5: spawns are parent -> child Handoff; child completions are child -> parent Done/Blocked', () => {
  const spark = fleet.sessions.filter((s) => /^agent:spark:subagent:/.test(s.key));
  for (const row of spark) {
    const meta = sessionMetaOf(row);
    const sp = spawnEvent(meta)!;
    assert.equal(sp.kind, 'handoff');
    assert.equal(sp.from, meta.parent);
    assert.equal(sp.to, meta.key);
    const done = derive(fleet, row.key).filter((e) => e.kind === 'done' || e.kind === 'blocked');
    for (const d of done) { assert.equal(d.from, meta.key); assert.equal(d.to, meta.parent); }
  }
  const forgeKid = derive(fleet, 'agent:forge-adversary:subagent:sub-0001').concat(derive(fleet, 'agent:forge-reviewer:subagent:sub-0001'), derive(fleet, 'agent:forge-coder:subagent:sub-0001'));
  const kinds = new Set(forgeKid.map((e) => e.kind));
  assert.ok([...kinds].every((k) => ['done', 'blocked', 'message', 'needs'].includes(k)), [...kinds].join());
  const failing = derive(synth, 'agent:spark:subagent:sub-9002').find((e) => e.id.startsWith('done:'))!;
  assert.equal(failing.kind, 'blocked');
  assert.equal(failing.to, 'agent:coo:main');
  const ok = derive(synth, 'agent:spark:subagent:sub-9001').find((e) => e.id.startsWith('done:'))!;
  assert.equal(ok.kind, 'done');
  assert.equal(ok.text, 'Placeholder: the change is built and verified; 12 tests pass.');
  assert.equal(ok.label, 'Synthetic task label');
});

// ---- 6. kinds from real signals ----
test('rule 6: [COO] tags, FORGE-REPORT and approval prompts map to kinds; plain text is a Message', () => {
  const k = (t: string, o = {}) => classifyText(t, o).kind;
  assert.equal(k('[COO] **done**: shipped'), 'done');
  assert.equal(k('[COO] **blocked**: waiting on CI'), 'blocked');
  assert.equal(k('[COO] **decision**: pick one'), 'needs');
  assert.equal(k('[COO] **done + decision**: built; which branch?'), 'needs');
  assert.equal(k('[COO] Status (read-only): only 1 of 4 running'), 'message');
  assert.equal(k('FORGE-REPORT\ncard: 1\nstatus: blocked\nverdict: CANNOT_VERIFY'), 'blocked');
  assert.equal(k('FORGE-REPORT\ncard: 1\nstatus: done\nverdict: CLEAN'), 'done');
  assert.equal(k('Reply with: /approve abc allow-once'), 'approval');
  assert.equal(k('just an update'), 'message');
  assert.equal(k('Should I merge it now?'), 'message', 'a question is not Needs-you unless it is a reply to Zach');
  assert.equal(k('Should I merge it now?', { askZach: true }), 'needs');
  const kinds = new Set(all(fleet).concat(all(synth)).map((e) => e.kind));
  for (const must of ['message', 'done', 'blocked'] as const) assert.ok(kinds.has(must), `${must} appears in the fixtures`);
  assert.ok(all(fleet).some((e) => e.kind === 'blocked' && e.text.startsWith('Run failed')), 'a real run-failed turn is Blocked');
});

test('rule 6: Needs you only for items that actually await Zach', () => {
  const needs = all(synth).filter((e) => e.needsYou);
  // the approval prompt (reply to Zach) and the LAST main reply that asks; the earlier identical question is not open
  const apr = needs.find((e) => e.kind === 'approval')!;
  assert.equal(apr.to, 'zach');
  assert.equal(apr.from, 'agent:coo:main');
  const m = derive(synth, 'agent:main:main');
  assert.equal(m.filter((e) => e.kind === 'needs').length, 1, 'only the latest unanswered question');
  assert.equal(m.find((e) => e.kind === 'needs')!.id.endsWith('syn-m-2a'), true);
  // a finished child's reply never needs Zach just by asking
  for (const e of all(fleet).filter((x) => /:subagent:/.test(x.from) && x.needsYou)) assert.match(e.id, /^done:/);
  // attention flag = explicit signal
  const att = attentionEvent(sessionMetaOf({ key: 'agent:main:main', agentId: 'main', attention: true, statusNote: 'Approve the deploy?' }), 5)!;
  assert.equal(att.kind, 'needs');
  assert.equal(att.to, 'zach');
  assert.equal(attentionEvent(sessionMetaOf({ key: 'agent:main:main', agentId: 'main', statusNote: 'x' }), 5), null);
});

test('rule 6: open needs are per thread, latest wins, expire, and never include system rows', () => {
  const mk = (id: string, ts: number, from: string, to: string, needs: boolean, sys = false): FleetEvent => ({ id, ts, from, to, kind: needs ? 'needs' : 'message', text: id, ...(needs ? { needsYou: true } : {}), ...(sys ? { sys: true } : {}) });
  const evs = [mk('a', 100, 'x', 'zach', true), mk('b', 200, 'x', 'zach', false), mk('c', 150, 'y', 'zach', true), mk('d', 300, 'y', 'z', false, true), mk('e', 1, 'w', 'zach', true)];
  assert.deepEqual(openNeedsOf(evs, 400, 1000).map((e) => e.id), ['c', 'e']);
  assert.deepEqual(openNeedsOf(evs, 400, 300).map((e) => e.id), ['c']);
  assert.deepEqual(openNeedsOf([mk('old', 1, 'q', 'zach', true)], 1_000_000_000).map((e) => e.id), []);
});

// ---- structural sanity on real shapes ----
test('trigger classification on real shapes', () => {
  const kinds = new Map<string, number>();
  for (const msgs of Object.values(fleet.histories)) for (const m of msgs) { const t = classifyTrigger(m); if (t) kinds.set(t.type, (kinds.get(t.type) ?? 0) + 1); }
  for (const t of ['user', 'inter', 'task', 'completion']) assert.ok(kinds.get(t), `trigger type ${t} present in fixtures`);
  assert.equal(classifyTrigger({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] }), null, 'tool results are not triggers');
  assert.equal(classifyTrigger({ role: 'assistant', content: [{ type: 'text', text: 'hi' }], stopReason: 'stop' }), null);
  assert.equal(classifyTrigger({ role: 'user', content: '[OpenClaw heartbeat poll]' })!.type, 'heartbeat');
  assert.equal(classifyTrigger({ role: 'user', content: '[OpenClaw exec completion] done' })!.type, 'exec');
  assert.equal(classifyTrigger({ role: 'user', content: '[System] restart' })!.type, 'system');
});

test('failed sessions_send is Blocked, not a Message', () => {
  const meta = { key: 'agent:voice:main', agentId: 'voice', kind: 'main' as const };
  const h: RawMessage[] = [
    { role: 'user', timestamp: 1, content: 'hi' },
    { role: 'assistant', timestamp: 2, stopReason: 'tool_use', content: [{ type: 'toolCall', id: 'c1', name: 'sessions_send', arguments: { sessionKey: 'agent:main:main', message: 'Please handle this.' } }] },
    { role: 'toolResult', timestamp: 3, toolCallId: 'c1', content: [{ type: 'text', text: '{"status":"failed","code":"internal_error"}' }] },
  ];
  const es = deriveSessionEvents(meta, h);
  assert.equal(es.length, 1);
  assert.equal(es[0].kind, 'blocked');
  assert.equal(es[0].to, 'agent:main:main');
});

test('every fixture session derives without throwing and keeps events inside the history window', () => {
  for (const set of [fleet, synth]) for (const row of set.sessions) {
    const es = deriveSessionEvents(sessionMetaOf(row), set.histories[row.key] ?? []);
    for (const e of es) assert.ok(e.ts > 0 && e.text.length > 0 && e.text.length <= 200, e.id);
  }
});
