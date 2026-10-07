import { SESSION_KIND_LABEL, SESSION_STATE_LABEL, ageShort, sessionTree } from '../../shared/sessions';
import { createSessionsApi } from '../sessions-api';
import type { ShellStore } from '../store';

const INDENT = '   ';

export function mountSessionPicker(select: HTMLSelectElement, store: ShellStore, onPick: (key: string) => void) {
  const api = createSessionsApi(store.source);
  let agent = '';
  let active = '';
  let seq = 0;

  const placeholder = (text: string) => { select.innerHTML = `<option value="">${text}</option>`; };

  async function load() {
    const mine = ++seq;
    if (!agent) { placeholder('Sessions'); select.disabled = true; return; }
    try {
      const rows = await api.list({ agent });
      if (mine !== seq) return;
      const now = Date.now();
      select.innerHTML = `<option value="">Sessions (${rows.length})</option>`;
      for (const n of sessionTree(rows)) {
        const o = document.createElement('option');
        o.value = n.row.key;
        o.textContent = `${INDENT.repeat(n.depth)}${SESSION_KIND_LABEL[n.row.kind]} · ${n.row.label} · ${SESSION_STATE_LABEL[n.row.state]} · ${n.row.updatedAt ? ageShort(n.row.updatedAt, now) : '—'}`;
        select.append(o);
      }
      select.value = active && rows.some((r) => r.key === active) ? active : '';
      select.disabled = !rows.length;
    } catch {
      if (mine !== seq) return;
      placeholder('Sessions unavailable');
      select.disabled = true;
    }
  }

  select.addEventListener('change', () => {
    const key = select.value;
    if (key) onPick(key);
  });
  select.addEventListener('focus', () => { if (agent) void load(); });

  return {
    set(agentId: string, activeKey = '') {
      const changed = agentId !== agent;
      agent = agentId;
      active = activeKey;
      if (changed || !select.options.length) void load();
      else if (activeKey && [...select.options].some((o) => o.value === activeKey)) select.value = activeKey;
      else if (!activeKey) select.value = '';
      else void load();
    },
  };
}
