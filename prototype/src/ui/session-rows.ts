import { SESSION_KIND_LABEL, SESSION_STATE_LABEL, ageShort, sessionTree, type SessionNode, type SessionRow } from '../../shared/sessions';
import { esc } from './format';

export function sideTabsHtml(active: 'activity' | 'sessions'): string {
  const tab = (id: 'activity' | 'sessions', label: string) => `<button type="button" role="tab" data-side-tab="${id}" aria-selected="${id === active}" class="${id === active ? 'on' : ''}">${label}</button>`;
  return `<div class="side-tabs" role="tablist">${tab('activity', 'Activity')}${tab('sessions', 'Sessions')}</div>`;
}

export interface SessionRowsOpts {
  now: number;
  activeKey?: string;
  agentName?: (agentId: string) => string;
  showAgent: boolean;
}

export function sessionRowHtml(n: SessionNode, o: SessionRowsOpts): string {
  const r = n.row;
  const agent = o.showAgent && o.agentName ? `<span class="ss-agent">${esc(o.agentName(r.agentId))}</span>` : '';
  return `<button type="button" class="ss-row st-${r.state}${r.key === o.activeKey ? ' on' : ''}" data-session="${esc(r.key)}" data-kind="${r.kind}" style="--depth:${n.depth}" title="${esc(r.key)}">
    <i class="ss-dot" aria-hidden="true"></i>
    <span class="ss-main"><span class="ss-line"><span class="ss-kind k-${r.kind}">${SESSION_KIND_LABEL[r.kind]}</span><span class="ss-label">${esc(r.label)}</span></span>
    <span class="ss-sub">${agent}<span class="ss-state">${SESSION_STATE_LABEL[r.state]}</span>${r.preview && r.kind !== 'main' ? `<span class="ss-preview">${esc(r.preview)}</span>` : ''}</span></span>
    <time datetime="${new Date(r.updatedAt).toISOString()}" title="${esc(new Date(r.updatedAt).toLocaleString())}">${r.updatedAt ? ageShort(r.updatedAt, o.now) : '—'}</time>
  </button>`;
}

export function sessionRowsHtml(rows: readonly SessionRow[], o: SessionRowsOpts): string {
  return sessionTree(rows).map((n) => sessionRowHtml(n, o)).join('');
}
