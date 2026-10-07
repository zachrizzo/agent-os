import { COS_ID } from './types.ts';

export const RELAY_PREFIX = '[agent-os]';
export const DIRECT_AGENTS: ReadonlySet<string> = new Set(['coder', 'radar', 'scout', 'scrum', 'voice', 'claude']);

export const agentOfSession = (key: string) => /^agent:([^:]+):/.exec(key)?.[1] ?? '';

export const isMainAgent = (key: string) => agentOfSession(key) === 'main';

export const canSendDirect = (key: string) => DIRECT_AGENTS.has(agentOfSession(key));

export interface Routed {
  key: string;
  message: string;
  relayed: boolean;
  agent: string;
}

export function routeMessage(key: string, text: string, direct = false): Routed {
  const agent = agentOfSession(key);
  if (!agent) throw new Error('unknown session');
  if (agent === 'main') return { key, message: text, relayed: false, agent };
  if (direct) {
    if (!DIRECT_AGENTS.has(agent)) throw new Error(`direct send is only for agents with no lead or main approval chain (${[...DIRECT_AGENTS].join(', ')})`);
    return { key, message: text, relayed: false, agent };
  }
  const session = key === `agent:${agent}:main` ? '' : `\n(session: ${key})`;
  return { key: COS_ID, message: `${RELAY_PREFIX} Zach → @${agent}: ${text}${session}`, relayed: true, agent };
}
