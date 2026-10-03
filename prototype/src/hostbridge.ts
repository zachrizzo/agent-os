// App side of the host bridge (shared/hostbridge.ts): which Control UI host actions the framing plugin can run, and a way to run them.
// Standalone (no parent frame) or an older plugin that never answers: no capabilities, so no host buttons are drawn.
import { MSG_ACTION, MSG_CAPS, MSG_CAPS_REQUEST, MSG_RESULT, isHostAction, type HostAction, type HostActionMessage, type HostResultMessage } from '../shared/hostbridge';

export interface HostBridge {
  has(action: HostAction): boolean;
  run(action: HostAction, sessionKey: string): Promise<void>;
  /** Called when the set of available actions changes (the plugin answers after boot). */
  onChange(fn: () => void): void;
}

export function createHostBridge(win: Window = window): HostBridge {
  const caps = new Set<HostAction>();
  const listeners: Array<() => void> = [];
  const pending = new Map<number, { ok: () => void; fail: (e: Error) => void }>();
  let seq = 0;
  const parent = win.parent !== win ? win.parent : null;

  win.addEventListener('message', (e: MessageEvent) => {
    if (!parent || e.source !== parent) return;
    const d = e.data as { type?: string; actions?: unknown[]; id?: number; ok?: boolean; error?: string } | null;
    if (d?.type === MSG_CAPS) {
      caps.clear();
      for (const a of d.actions ?? []) if (isHostAction(a)) caps.add(a);
      for (const fn of listeners) fn();
    } else if (d?.type === MSG_RESULT && typeof d.id === 'number') {
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      if (d.ok) p.ok(); else p.fail(new Error(d.error ?? 'The host could not do that'));
    }
  });
  parent?.postMessage({ type: MSG_CAPS_REQUEST }, '*');

  return {
    has: (a) => caps.has(a),
    onChange: (fn) => { listeners.push(fn); },
    run(action, sessionKey) {
      if (!parent || !caps.has(action)) return Promise.reject(new Error('Not available here'));
      const id = ++seq;
      const msg: HostActionMessage = { type: MSG_ACTION, id, action, sessionKey };
      return new Promise<void>((ok, fail) => {
        pending.set(id, { ok, fail });
        parent.postMessage(msg, '*');
        setTimeout(() => { if (pending.delete(id)) fail(new Error('The host did not answer')); }, 5000);
      });
    },
  };
}
export type { HostResultMessage };
