// Deterministic stand-in for an agent turn in a room (mock fleet and harness/stub-llm.mjs share it). Not used against real agents.
import { PASS_TOKEN } from './rooms.ts';

/** Zach's message as the room prompts quote it. */
export const triggerText = (prompt: string) => /Zach's message:\n([\s\S]*?)\n\nDiscussion so far:/.exec(prompt)?.[1] ?? '';

/**
 * Deterministic stand-in for an agent turn in an open discussion. Round 1: everyone gives a take. Round 2: the first non-lead member builds on another member,
 * everyone else passes. Round 3: everyone passes, so the discussion ends.
 * Cues in Zach's message: "pingpong" (everyone @mentions the next member every round, forever: use Stop), "quiet" (bravo passes from round 2),
 * "richmd" (Markdown-heavy replies).
 */
export function scriptedReply(prompt: string): string {
  const me = /You are (.+?) \(@([\w-]+)\)\./.exec(prompt);
  const name = me?.[1] ?? 'Agent';
  const id = me?.[2] ?? '';
  const ids = [...(/Members: ([^\]]*?)\.(?: Lead:|\])/.exec(prompt)?.[1] ?? '').matchAll(/\(@([\w-]+)\)/g)].map((m) => m[1]);
  const leadId = /Lead: .+? \(@([\w-]+)\)\./.exec(prompt)?.[1] ?? '';
  const round = Number(/It is round (\d+)\./.exec(prompt)?.[1] ?? 1);
  const text = triggerText(prompt);
  const topic = text.replace(/\s+/g, ' ').slice(0, 48);
  const rich = /richmd/i.test(text);
  const isLead = !!leadId && id === leadId;
  const others = ids.filter((x) => x !== id);
  if (/pingpong/i.test(text)) return `@${others[(ids.indexOf(id) + 1) % Math.max(1, others.length)] ?? others[0]} pingpong`;
  if (/ccnote/i.test(text)) return round === 1 ? `${name} here. Done. cc @${others[0] ?? id}` : PASS_TOKEN;
  if (round === 1) return rich ? RICH_MD.replace('@FIRST', `@${others[0] ?? id}`) : `${name} here. On "${topic}": noted, nothing blocking from my side.`;
  if (isLead) return PASS_TOKEN;
  if (/quiet/i.test(text) && id === 'bravo') return PASS_TOKEN;
  const nonLead = ids.filter((x) => x !== leadId);
  if (round === 2 && id === nonLead[0]) return `Building on @${others.find((x) => x !== leadId) ?? others[0] ?? id}: I would add an owner for the rollback and a dry run on a copy before we flip the flag.`;
  return PASS_TOKEN;
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
