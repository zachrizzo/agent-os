// Compact rendering of agent-to-agent traffic. sessions_send delivers "[Inter-session message] sourceSession=… sourceTool=… isUser=false"
// plus a fixed routing explanation ahead of the real text. This only reads that wrapper for display; stored transcripts are never rewritten.
export const INTER_PREFIX = '[Inter-session message]';
const HEADER_RE = /\[Inter-session message\]([^\n]*)/;
const EXPLANATION_RE = /^This content was routed by OpenClaw from another session or internal tool\.[^\n]*\n?/;

export interface InterSession {
  /** Session key of the sender, e.g. "agent:coo:main". */
  from: string;
  /** Delivery tool, e.g. "sessions_send" or "subagent_announce". */
  tool?: string;
  /** The message as the sender wrote it, wrapper removed. */
  body: string;
  /** The wrapper text (header + explanation), for a collapsed "routing" view. */
  routing: string;
}

/** Null unless `text` carries the inter-session wrapper. A timestamp envelope before the header is ignored. */
export function parseInterSession(text: string): InterSession | null {
  const m = HEADER_RE.exec(text);
  if (!m) return null;
  const attrs = m[1];
  const from = /\bsourceSession=(\S+)/.exec(attrs)?.[1];
  if (!from) return null;
  const tool = /\bsourceTool=(\S+)/.exec(attrs)?.[1];
  const after = text.slice(m.index + m[0].length).replace(/^\r?\n/, '');
  const expl = EXPLANATION_RE.exec(after);
  const body = (expl ? after.slice(expl[0].length) : after).replace(/^\s+/, '').trimEnd();
  return { from, ...(tool ? { tool } : {}), body, routing: text.slice(m.index, text.length - body.length).trim() };
}

/** "agent:coo:main" -> "coo"; "agent:forge:subagent:abc" -> "forge subagent". */
export function shortSession(key: string): string {
  const m = key.match(/^agent:([^:]+):(.*)$/);
  if (!m) return key;
  return m[2] === 'main' ? m[1] : `${m[1]} ${m[2].split(':')[0]}`;
}
