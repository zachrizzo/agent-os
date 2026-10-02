// "Message agent" composer, shared by the session drawer and the agent/team view. Enter sends, Shift+Enter adds a line.
import type { ShellStore } from '../store';
import { esc, svg } from './format';

export interface ComposerTarget { key: string; label: string }

export function mountComposer(el: HTMLElement, store: ShellStore, onSent?: (key: string, text: string) => void) {
  el.classList.add('composer');
  el.innerHTML = `
    <div class="cmp-row">
      <textarea rows="1" maxlength="4000" aria-label="Message agent"></textarea>
      <button type="button" class="cmp-send" title="Send (Enter)">${svg('send', 15)}<span>Send</span></button>
    </div>
    <div class="cmp-status" role="status"></div>`;
  const box = el.querySelector('textarea')!;
  const btn = el.querySelector<HTMLButtonElement>('.cmp-send')!;
  const status = el.querySelector<HTMLElement>('.cmp-status')!;
  let target: ComposerTarget | null = null;
  let busy = false;

  const sync = () => {
    box.disabled = busy || !target;
    btn.disabled = busy || !target || !box.value.trim();
    box.placeholder = target ? `Message ${target.label}…` : 'No live session to message';
  };
  const grow = () => { box.style.height = 'auto'; box.style.height = `${Math.min(box.scrollHeight, 120)}px`; };

  async function submit() {
    const text = box.value.trim();
    if (!target || !text || busy) return;
    const key = target.key;
    busy = true; sync();
    status.className = 'cmp-status';
    status.textContent = 'Sending…';
    try {
      await store.sendMessage(key, text);
      box.value = ''; grow();
      status.className = 'cmp-status ok';
      status.textContent = `Sent to ${target?.label ?? 'agent'}`;
      onSent?.(key, text);
    } catch (e) {
      status.className = 'cmp-status err';
      status.innerHTML = `Not sent: ${esc((e as Error).message)}`;
    } finally {
      busy = false; sync();
    }
  }

  box.addEventListener('input', () => { grow(); sync(); });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void submit(); }
    if (e.key !== 'Escape') e.stopPropagation(); // typing stays out of global shortcuts; Esc still closes the drawer
  });
  btn.addEventListener('click', () => void submit());

  sync();
  return {
    /** Retarget; keeps the draft when the target is unchanged, clears the status line otherwise. */
    setTarget(t: ComposerTarget | null) {
      if (t?.key !== target?.key) { status.textContent = ''; status.className = 'cmp-status'; }
      target = t;
      sync();
    },
    focus() { box.focus(); },
  };
}
