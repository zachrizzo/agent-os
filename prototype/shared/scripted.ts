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

/** Council turns. Cues in Zach's message: "badplan" (captain returns non-JSON), "conflict" (the second member contradicts the first). */
function councilReply(role: string, prompt: string, name: string, id: string, ids: string[], text: string): string {
  const topic = text.replace(/\s+/g, ' ').slice(0, 48);
  if (role === 'CAPTAIN-PLAN') {
    if (/badplan/i.test(text)) return 'Sure. I think everyone should look at this from their own angle, no JSON from me.';
    return `\`\`\`json\n${JSON.stringify({ tasks: ids.map((m) => ({ agent: m, question: `From the @${m} angle: ${topic}` })), notes: 'Split by specialty, one sub-question each.' })}\n\`\`\``;
  }
  if (role === 'SPECIALIST') {
    const q = /Your sub-question:\n([\s\S]*?)(?:\n\n|$)/.exec(prompt)?.[1] ?? topic;
    return `${name}: on "${q.slice(0, 60)}" my view is to proceed, with one caveat from my side.${/conflict/i.test(text) && ids.indexOf(id) === 1 ? ' I disagree with the first member and would not ship it as is.' : ''}`;
  }
  if (role === 'CRITIQUE') {
    if (/Contrarian|CONTRARIAN/.test(prompt) || (/conflict/i.test(text) && ids.indexOf(id) === 2)) return `- Pushback: the answers assume the happy path; nobody covered rollback. Needs an owner.`;
    return PASS_TOKEN;
  }
  const flagged = /Critiques:\n/.test(prompt);
  return `Proceed. Members agree on the approach${flagged ? '.\n\nDisagreements resolved: the critique about rollback is valid, so I added it as a pre-condition.\n\nYour call: ship fast with a manual rollback, or wait a day for automation.' : '; nothing conflicting came up.'}`;
}
