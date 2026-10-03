// Deterministic stand-in for an agent turn in a room (mock fleet and harness/stub-llm.mjs share it). Not used against real agents.
import { PASS_TOKEN } from './rooms.ts';

/** Deterministic stand-in for an agent turn (same rules as harness/stub-llm.mjs): "pingpong" bounces @mentions, "quiet" makes bravo pass, follow-up rounds otherwise settle. */
export function scriptedReply(prompt: string): string {
  const me = /You are (.+?) \(@([\w-]+)\)\./.exec(prompt);
  const ids = [...(/Members: ([^\]]*)\]/.exec(prompt)?.[1] ?? '').matchAll(/\(@([\w-]+)\)/g)].map((m) => m[1]);
  const text = /(?:New|Original) message from You:\n([\s\S]*?)(?:\n\n|$)/.exec(prompt)?.[1] ?? '';
  const follow = /Follow-up round/.test(prompt);
  const id = me?.[2] ?? '';
  const role = /Council role: ([A-Z-]+)\./.exec(prompt)?.[1];
  if (role) return councilReply(role, prompt, me?.[1] ?? 'Agent', id, ids, text);
  if (/pingpong/i.test(text)) {
    const others = ids.filter((x) => x !== id);
    const next = others[(ids.indexOf(id) + 1) % Math.max(1, others.length)] ?? others[0];
    return `@${next} pingpong`;
  }
  if (follow || (/quiet/i.test(text) && id === 'bravo')) return PASS_TOKEN;
  return `${me?.[1] ?? 'Agent'} here. On "${text.replace(/\s+/g, ' ').slice(0, 48)}": noted, nothing blocking from my side.`;
}

/** Council turns. Cues in Zach's message: "badplan" (captain returns non-JSON), "conflict" (the second member contradicts the first; the captain asks the two to settle it),
 *  "crit" (the captain calls the critique round), "endless" (a different follow-up every step), "repeat" (the same follow-up every step), "allpass" (follow-ups get PASS),
 *  "badsteer" (the captain's decision is not JSON), "routeme" (member replies @mention another member). With no cue the captain stops after the first answers. */
function councilReply(role: string, prompt: string, name: string, id: string, ids: string[], text: string): string {
  if (/richmd/i.test(prompt) && role !== 'CAPTAIN-PLAN' && role !== 'CAPTAIN-STEER' && role !== 'FOLLOW-UP') return richReply(role, ids);
  const topic = text.replace(/\s+/g, ' ').slice(0, 48);
  if (role === 'CAPTAIN-PLAN') {
    if (/badplan/i.test(text)) return 'Sure. I think everyone should look at this from their own angle, no JSON from me.';
    return `\`\`\`json\n${JSON.stringify({ tasks: ids.map((m) => ({ agent: m, question: `From the @${m} angle: ${topic}` })), notes: 'Split by specialty, one sub-question each.' })}\n\`\`\``;
  }
  const route = /routeme/i.test(text) ? ` @${ids.find((x) => x !== id) ?? id} please weigh in.` : '';
  if (role === 'SPECIALIST') {
    const q = /Your sub-question:\n([\s\S]*?)(?:\n\n|$)/.exec(prompt)?.[1] ?? topic;
    return `${name}: on "${q.slice(0, 60)}" my view is to proceed, with one caveat from my side.${/conflict/i.test(text) && ids.indexOf(id) === 1 ? ' I disagree with the first member and would not ship it as is.' : ''}${route}`;
  }
  if (role === 'CAPTAIN-STEER') {
    const step = Number(/This is step (\d+) of/.exec(prompt)?.[1] ?? 1);
    if (/badsteer/i.test(text)) return 'Honestly I think we are fine, let us wrap up.';
    if (/endless/i.test(text)) return JSON.stringify({ action: 'ask', targets: [ids[0]], question: `Round ${step}: is there anything else we should weigh?`, unresolved: 'still not sure' });
    if (/repeat/i.test(text)) return JSON.stringify({ action: 'ask', targets: [ids[0]], question: 'Is the rollback plan safe?' });
    if (/allpass/i.test(text) && step === 1) return JSON.stringify({ action: 'ask', targets: [ids[0], ids[1]], question: 'Anything blocking?' });
    if (/crit/i.test(text) && step === 1) return '{"action":"critique"}';
    if (/conflict/i.test(text) && step === 1) return JSON.stringify({ action: 'ask', targets: [ids[0], ids[1]], question: `@${ids[0]} and @${ids[1]} disagree on shipping as is: settle it.`, unresolved: 'whether to ship as is' });
    return '{"action":"synthesize"}';
  }
  if (role === 'FOLLOW-UP') {
    if (/allpass/i.test(text)) return PASS_TOKEN;
    return `${name}: on the follow-up I concede the rollback point and hold the rest; ship behind a flag.${route}`;
  }
  if (role === 'CRITIQUE') {
    if (/Contrarian|CONTRARIAN/.test(prompt) || (/conflict/i.test(text) && ids.indexOf(id) === 2)) return `- Pushback: the answers assume the happy path; nobody covered rollback. Needs an owner.`;
    return PASS_TOKEN;
  }
  const flagged = /Critiques:\n|Follow-ups you asked for:\n/.test(prompt);
  return `Proceed. Members agree on the approach${flagged ? '.\n\nDisagreements resolved: the critique about rollback is valid, so I added it as a pre-condition.\n\nYour call: ship fast with a manual rollback, or wait a day for automation.' : '; nothing conflicting came up.'}`;
}

/** Cue "richmd" in Zach's message: Markdown-heavy replies (and a few hostile bits that must stay inert) for the renderer checks and screenshots. */
export const RICH_MD = [
  '## Recommendation',
  'Ship **Thursday**, behind the flag. Run `npm test` first and read the *rollback* notes in [the runbook](https://example.com/runbook).',
  '',
  '- Owner: @FIRST (see `plugin/src/index.ts:42`)',
  '- Watch the error rate for **30 minutes**',
  '- Keep a manual rollback ready',
  '',
  '1. Merge the flag',
  '2. Enable for 5%',
  '3. Ramp to 100%',
  '',
  '> Rollback is cheap only while the migration is additive.',
  '',
  '| Risk | Likelihood | Mitigation |',
  '|---|---|---|',
  '| Lock contention | Medium | Batch in chunks of 500 |',
  '| Bad backfill | Low | Dry run on a copy |',
  '',
  '```sh',
  'git switch -c rollout/thursday && npm run migrate -- --dry-run   # a long line that has to scroll sideways instead of wrapping into the next block of text',
  '```',
  '',
  'Hostile bits stay inert: <script>alert(1)</script> <img src=x onerror=alert(1)> [click](javascript:alert(1))',
].join('\n');

function richReply(role: string, ids: string[]): string {
  const first = ids[0] ?? 'agent';
  if (role === 'CRITIQUE') return '- **Pushback:** nobody covered `rollback`.\n- Needs an owner before Thursday.';
  if (role === 'SPECIALIST') return `**View:** proceed, one caveat.\n\n- see \`src/ui/rooms.ts:86\`\n- ping @${first}`;
  return RICH_MD.replace('@FIRST', `@${first}`);
}
