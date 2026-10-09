import type { HistoryItem, HistoryTool } from '../../shared/types';
import type { LiveRun, SessionStatus } from '../../shared/transcript';
import { renderMarkdown } from '../../shared/markdown';
import { toolVerb } from '../../shared/progress';
import { ageShort } from '../../shared/sessions';
import type { ShellState } from '../store';
import { esc, fmtK, fmtTime, hueOf, nameOf } from './format';

const LONG_CHARS = 1400;
const LONG_LINES = 22;
const TOOL_GROUP_MIN = 6;
const PREVIEW_CHARS = 140;
const MCP_RE = /^mcp__([^_]+)__/;

const toolLabel = (name: string) => name.replace(MCP_RE, '$1 · ');

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function stateBadge(st: SessionStatus | undefined, now: number): string {
  if (!st) return '';
  const age = st.updatedAt ? ` · ${ageShort(st.updatedAt, now)}` : '';
  if (st.running) return `<span class="d-state st-run" title="A run is in progress"><i></i>Working${st.startedAt ? ` · ${fmtDuration(now - st.startedAt)}` : ''}</span>`;
  if (st.state === 'needs') return `<span class="d-state st-needs"><i></i>Needs you</span>`;
  if (st.state === 'error') return `<span class="d-state st-error"><i></i>Failed${age}</span>`;
  if (st.state === 'done') return `<span class="d-state st-done"><i></i>Done${age}</span>`;
  return `<span class="d-state st-idle"><i></i>Idle${age}</span>`;
}

export function spendText(st: SessionStatus | undefined): string {
  if (!st) return '—';
  if (st.tokens) return `${fmtK(st.tokens)} tok · ${st.costUsd ? `$${st.costUsd.toFixed(2)}` : 'cost not reported'}`;
  if (st.usagePending) return 'Counting · the Gateway reports usage when this turn ends';
  return '—';
}

function senderOf(s: ShellState, key: string, it: HistoryItem): { label: string; agent?: string; hue: string } {
  if (it.role === 'assistant') return { label: nameOf(s, key), hue: hueOf(s, key) };
  if (it.from === 'zach') return { label: 'You', hue: 'var(--amber)' };
  if (it.from) return { label: nameOf(s, it.from), agent: it.from, hue: hueOf(s, it.from) };
  return { label: it.sender ?? 'User', hue: 'var(--idle)' };
}

const isLong = (text: string) => text.length > LONG_CHARS || text.split('\n').length > LONG_LINES;
const firstLine = (text: string) => {
  const line = text.replace(/[`*#>_]+/g, '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1)}…` : line;
};
const whoHtml = (label: string, agent?: string) => agent ? `<button class="who-btn m-who" data-agent="${esc(agent)}">${esc(label)}</button>` : `<span class="m-who">${esc(label)}</span>`;

function textHtml(it: HistoryItem, k: string): string {
  const long = isLong(it.text);
  return `<div class="m-text md${long ? ' m-long' : ''}" data-k="long:${esc(k)}">${renderMarkdown(it.text)}</div>`
    + (long ? '<button type="button" class="m-more" data-more>Show more</button>' : '')
    + (it.truncated ? '<div class="m-capped">The Gateway shortened this message for display.</div>' : '');
}

export function toolLine(t: HistoryTool, k: string): string {
  const body = (t.detail ? `<pre class="tl-pre">${esc(t.detail)}</pre>` : '') + (t.result ? `<div class="tl-res">Result</div><pre class="tl-pre">${esc(t.result)}</pre>` : '');
  const cls = `tl${t.error ? ' err' : ''}${t.running ? ' run' : ''}${body ? '' : ' bare'}`;
  return `<details class="${cls}" data-k="tool:${esc(t.id ?? k)}"><summary><span class="tl-name">${esc(toolLabel(t.name))}</span><span class="tl-sum">${esc(t.summary || toolVerb(t.name))}</span>${t.error ? '<span class="tl-flag">error</span>' : ''}${t.running ? '<span class="tl-flag run">running</span>' : ''}</summary>${body}</details>`;
}

function toolsBlock(tools: Array<{ t: HistoryTool; k: string }>): string {
  const lines = tools.map(({ t, k }) => toolLine(t, k)).join('');
  if (tools.length < TOOL_GROUP_MIN) return `<div class="tools">${lines}</div>`;
  const counts = new Map<string, number>();
  for (const { t } of tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  const mix = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => `${esc(toolLabel(n))} ×${c}`).join(', ');
  const errs = tools.filter(({ t }) => t.error).length;
  return `<details class="tl-group" data-k="grp:${esc(tools[0].k)}"><summary><b>${tools.length} tool calls</b><span class="tl-sum">${mix}</span>${errs ? `<span class="tl-flag">${errs} error${errs === 1 ? '' : 's'}</span>` : ''}</summary><div class="tools">${lines}</div></details>`;
}

function taskCard(s: ShellState, it: HistoryItem, k: string): string {
  const from = it.from ? nameOf(s, it.from) : 'its requester';
  return `<details class="task-card" data-k="task:${esc(k)}" style="--hue:${it.from ? hueOf(s, it.from) : 'var(--idle)'}">
    <summary><span class="tc-tag">Task</span><span class="tc-from">from ${it.from ? whoHtml(from, it.from) : esc(from)}</span>${it.task?.depth ? `<span class="tc-depth">depth ${esc(it.task.depth)}</span>` : ''}<time>${fmtTime(it.ts)}</time><span class="tc-preview">${esc(firstLine(it.text))}</span></summary>
    <div class="tc-body md">${renderMarkdown(it.text)}</div></details>`;
}

function noticeRow(it: HistoryItem, k: string): string {
  const head = firstLine(it.text);
  const more = it.text.trim() !== head;
  const cls = `notice n-${it.notice}`;
  if (!more) return `<div class="${cls}"><span class="n-tag">${it.notice === 'error' ? 'Error' : 'System'}</span><span class="n-text">${esc(head)}</span><time>${fmtTime(it.ts)}</time></div>`;
  return `<details class="${cls}" data-k="notice:${esc(k)}"><summary><span class="n-tag">${it.notice === 'error' ? 'Error' : 'System'}</span><span class="n-text">${esc(head)}</span><time>${fmtTime(it.ts)}</time></summary><pre>${esc(it.text)}</pre></details>`;
}

function a2aRow(s: ShellState, key: string, it: HistoryItem, k: string): string {
  const from = it.a2a!.from;
  const tool = it.a2a!.tool && it.a2a!.tool !== 'sessions_send' ? `<span class="kchip a2a-tool">${esc(it.a2a!.tool.replace(/_/g, ' '))}</span>` : '';
  return `<div class="a2a" style="--hue:${hueOf(s, from)}">
    <div class="a2a-line"><button class="who-btn a2a-from" data-agent="${esc(from)}">${esc(nameOf(s, from))}</button><span class="arr">→</span><span class="a2a-to">${esc(nameOf(s, key))}</span>${tool}<time>${fmtTime(it.ts)}</time></div>
    ${textHtml(it, k).replace('class="m-text md', 'class="a2a-text md')}
    <details class="a2a-routing" data-k="route:${esc(k)}"><summary>routing</summary><pre>${esc(it.a2a!.routing)}</pre></details></div>`;
}

function bubble(s: ShellState, key: string, it: HistoryItem, k: string): string {
  const who = senderOf(s, key, it);
  const mine = it.role === 'assistant';
  const relay = it.relay ? `<span class="kchip m-relay">relayed to @${esc(it.relay)}</span>` : '';
  return `<div class="msg ${mine ? 'me' : 'them'} r-${esc(it.role)}${it.from === 'zach' ? ' you' : ''}" data-id="${esc(k)}" style="--hue:${who.hue}">
    <div class="m-head">${whoHtml(who.label, who.agent)}${relay}<time>${fmtTime(it.ts)}</time></div>
    ${textHtml(it, k)}</div>`;
}

function liveBlock(s: ShellState, key: string, live: LiveRun | undefined): string {
  const open = live?.tools.filter((t) => t.running).pop();
  const now = open ? toolVerb(open.name) : live?.text ? 'Writing' : 'Thinking';
  const text = live?.text ? `<div class="msg me lr-msg" style="--hue:${hueOf(s, key)}">${textHtml({ role: 'assistant', ts: 0, text: live.text }, 'live')}</div>` : '';
  const tools = live?.tools.length ? toolsBlock(live.tools.map((t, i) => ({ t, k: `live:${i}` }))) : '';
  return `<div class="live-run" style="--hue:${hueOf(s, key)}"><div class="lr-head"><i></i><b>Working</b><span>· ${esc(now)}</span></div>${text}${tools}</div>`;
}

export function renderThread(s: ShellState, key: string, items: readonly HistoryItem[], live?: LiveRun, running = false): string {
  const out: string[] = [];
  let pending: Array<{ t: HistoryTool; k: string }> = [];
  const flush = () => { if (pending.length) out.push(toolsBlock(pending)); pending = []; };
  items.forEach((it, i) => {
    const k = it.id ?? `${i}:${it.ts}`;
    if (it.task) { flush(); out.push(taskCard(s, it, k)); return; }
    if (it.notice) { flush(); out.push(noticeRow(it, k)); return; }
    if (it.a2a) { flush(); out.push(a2aRow(s, key, it, k)); return; }
    if (it.text) { flush(); out.push(bubble(s, key, it, k)); }
    for (const [j, t] of (it.tools ?? []).entries()) pending.push({ t, k: `${k}:${j}` });
  });
  flush();
  if (running || live) out.push(liveBlock(s, key, live));
  return out.join('');
}

export function threadSignature(items: readonly HistoryItem[], live?: LiveRun, running = false): string {
  const last = items[items.length - 1];
  return [items.length, last?.id ?? last?.ts ?? '', last?.text.length ?? 0, last?.tools?.length ?? 0, running ? 1 : 0, live ? JSON.stringify(live).length : 0, live?.tools.filter((t) => t.running).length ?? 0].join('|');
}
