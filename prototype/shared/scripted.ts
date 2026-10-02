// Deterministic stand-in for an agent turn in a room (mock fleet and harness/stub-llm.mjs share it). Not used against real agents.
import { PASS_TOKEN } from './rooms.ts';

/** Deterministic stand-in for an agent turn (same rules as harness/stub-llm.mjs): "pingpong" bounces @mentions, "quiet" makes bravo pass, follow-up rounds otherwise settle. */
export function scriptedReply(prompt: string): string {
  const me = /You are (.+?) \(@([\w-]+)\)\./.exec(prompt);
  const ids = [...(/Members: ([^\]]*)\]/.exec(prompt)?.[1] ?? '').matchAll(/\(@([\w-]+)\)/g)].map((m) => m[1]);
  const text = /(?:New|Original) message from You:\n([\s\S]*?)(?:\n\n|$)/.exec(prompt)?.[1] ?? '';
  const follow = /Follow-up round/.test(prompt);
  const id = me?.[2] ?? '';
  if (/pingpong/i.test(text)) {
    const others = ids.filter((x) => x !== id);
    const next = others[(ids.indexOf(id) + 1) % Math.max(1, others.length)] ?? others[0];
    return `@${next} pingpong`;
  }
  if (follow || (/quiet/i.test(text) && id === 'bravo')) return PASS_TOKEN;
  return `${me?.[1] ?? 'Agent'} here. On "${text.replace(/\s+/g, ' ').slice(0, 48)}": noted, nothing blocking from my side.`;
}
