export interface RunProgress {
  tool?: string;
  step?: string;
}

const TOOL_VERBS: Record<string, string> = {
  bash: 'Running a command',
  exec: 'Running a command',
  read: 'Reading files',
  edit: 'Editing files',
  multiedit: 'Editing files',
  write: 'Writing a file',
  grep: 'Searching code',
  glob: 'Searching code',
  webfetch: 'Reading the web',
  web_fetch: 'Reading the web',
  websearch: 'Searching the web',
  web_search: 'Searching the web',
  agent: 'Running a subagent',
  task: 'Running a subagent',
  sessions_spawn: 'Starting a worker',
  sessions_send: 'Messaging an agent',
  sessions_yield: 'Waiting on workers',
  agents_wait: 'Waiting on workers',
  browser: 'Using the browser',
  todowrite: 'Updating its plan',
};

export function toolVerb(tool: string): string {
  const t = tool.trim();
  const k = t.toLowerCase().replace(/^mcp__[^_]+__/, '');
  return TOOL_VERBS[k] ?? `Using ${t.replace(/^mcp__([^_]+)__/, '$1 ').replace(/_/g, ' ')}`;
}

const stripMd = (s: string) => s.replace(/[`*_#>|]+/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();

export function lastStep(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  for (let i = paras.length - 1; i >= 0; i--) {
    const p = paras[i];
    if (/^\s*[|-]{3,}|^\s*\|/.test(p)) continue;
    const line = stripMd(p.split('\n')[0]);
    if (line.length >= 3) return line.split(/(?<=[.!?])\s/)[0];
  }
  return undefined;
}

export function progressOf(inFlight: unknown): RunProgress | undefined {
  if (!inFlight || typeof inFlight !== 'object') return undefined;
  const run = inFlight as { text?: unknown; events?: unknown };
  const open = new Map<string, string>();
  for (const e of Array.isArray(run.events) ? run.events : []) {
    const d = (e as { stream?: unknown; data?: Record<string, unknown> })?.data;
    if ((e as { stream?: unknown }).stream !== 'tool' || !d || typeof d.name !== 'string') continue;
    const id = String(d.toolCallId ?? d.name);
    if (d.phase === 'start') open.set(id, d.name);
    else if (d.phase === 'result' || d.phase === 'end' || d.phase === 'error') open.delete(id);
  }
  const tool = open.size ? [...open.values()].pop() : undefined;
  const step = lastStep(run.text);
  if (!tool && !step) return undefined;
  return { ...(tool ? { tool } : {}), ...(step ? { step } : {}) };
}

export function nowFromProgress(p: RunProgress | undefined, fallback: string): string {
  if (!p) return fallback;
  if (p.tool && p.step) return `${toolVerb(p.tool)} · ${p.step}`;
  if (p.tool) return toolVerb(p.tool);
  return p.step ?? fallback;
}
