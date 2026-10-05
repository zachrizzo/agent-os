// Reads token usage and the in-flight tool out of Gateway chat.history messages. The transcript shape is not a published contract, so every field is optional
// and several spellings are accepted; with nothing usable the caller estimates (rooms.ts: estimateUsage).
import type { TurnUsage } from './rooms.ts';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const pick = (o: Record<string, unknown>, keys: string[]) => keys.reduce((n, k) => n || num(o[k]), 0);

/** Sum of the usage on these assistant messages (input incl. cache reads/writes, output, cost), or undefined when none carries any. */
export function usageFromMessages(msgs: ReadonlyArray<any>): TurnUsage | undefined {
  let input = 0, output = 0, cost = 0, seen = false;
  for (const m of msgs) {
    if (m?.role !== 'assistant') continue;
    const u = (m.usage ?? m.__openclaw?.usage ?? m.meta?.usage) as Record<string, unknown> | undefined;
    if (!u || typeof u !== 'object') continue;
    const i = pick(u, ['input', 'inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens']) + pick(u, ['cacheRead', 'cacheReadTokens', 'cached_input_tokens', 'cache_read_input_tokens']) + pick(u, ['cacheWrite', 'cacheWriteTokens', 'cache_write_input_tokens', 'cache_creation_input_tokens']);
    const o = pick(u, ['output', 'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens']);
    const c = typeof u.cost === 'number' ? num(u.cost) : u.cost && typeof u.cost === 'object' ? num((u.cost as Record<string, unknown>).total) : pick(u, ['costUsd', 'cost_usd']);
    if (i || o || c) { seen = true; input += i; output += o; cost += c; }
  }
  return seen ? { inputTokens: input, outputTokens: output, ...(cost ? { costUsd: cost } : {}) } : undefined;
}

const TOOL_BLOCK = new Set(['toolCall', 'tool_use', 'tool-call', 'toolUse', 'function_call']);
/** The tool the agent is waiting on right now: the newest message is an assistant turn with a tool call and no tool result has come back yet. */
export function toolInFlight(msgs: ReadonlyArray<any>): string | undefined {
  const last = msgs[msgs.length - 1];
  if (last?.role !== 'assistant' || !Array.isArray(last.content)) return undefined;
  const call = [...last.content].reverse().find((c: any) => c && TOOL_BLOCK.has(c.type) && typeof c.name === 'string');
  return call?.name;
}
