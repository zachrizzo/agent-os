// "Message agent" composer, shared by the session drawer and the agent/team view. Enter sends, Shift+Enter adds a line.
import { agentOfSession, canSendDirect, isMainAgent } from '../../shared/route';
import type { SendResult, ShellStore } from '../store';
import { esc, svg } from './format';

export interface ComposerTarget { key: string; label: string }

type Mode = 'direct' | 'relay';

export function mountComposer(el: HTMLElement, store: ShellStore, onSent?: (key: string, text: string, result: SendResult) => void) {
  el.classList.add('composer');
  el.innerHTML = `
    <div class="cmp-row">
      <textarea rows="1" maxlength="4000" aria-label="Message agent"></textarea>
      <button type="button" class="cmp-send" title="Send (Enter)">${svg('send', 15)}<span>Send</span></button>
    </div>
    <div class="cmp-route"><div class="cmp-mode" role="radiogroup" aria-label="How the message is delivered" hidden><button type="button" role="radio" data-mode="direct">Direct</button><button type="button" role="radio" data-mode="relay">Via Chief of Staff</button></div><span class="cmp-via"></span></div>
    <div class="cmp-status" role="status"></div>`;
  const box = el.querySelector('textarea')!;
  const btn = el.querySelector<HTMLButtonElement>('.cmp-send')!;
  const status = el.querySelector<HTMLElement>('.cmp-status')!;
  const via = el.querySelector<HTMLElement>('.cmp-via')!;
  const modeWrap = el.querySelector<HTMLElement>('.cmp-mode')!;
  let target: ComposerTarget | null = null;
  let mode: Mode = 'direct';
  let busy = false;

  const direct = () => !!target && canSendDirect(target.key) && mode === 'direct';
  const sync = () => {
    box.disabled = busy || !target;
    btn.disabled = busy || !target || !box.value.trim();
    const agent = target ? agentOfSession(target.key) : '';
    const main = !!target && isMainAgent(target.key);
    modeWrap.hidden = !target || main || !canSendDirect(target.key);
    for (const b of modeWrap.querySelectorAll<HTMLButtonElement>('[data-mode]')) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
    via.textContent = !target ? '' : main ? 'Goes straight to this Chief of Staff session' : direct() ? `Goes straight to this @${agent} session, marked as from you` : `Goes to the Chief of Staff, who relays it to @${agent} and tracks it`;
    box.placeholder = !target ? 'No live session to message' : main || direct() ? `Message ${target.label}…` : `Message @${agent} via Chief of Staff…`;
  };
  const grow = () => { box.style.height = 'auto'; box.style.height = `${Math.min(box.scrollHeight, 120)}px`; };

  async function submit() {
    const text = box.value.trim();
    if (!target || !text || busy) return;
    const key = target.key;
    const label = target.label;
    busy = true; sync();
    status.className = 'cmp-status';
    status.textContent = 'Sending…';
    try {
      const result = await store.sendMessage(key, text, direct());
      box.value = ''; grow();
      status.className = 'cmp-status ok';
      status.textContent = result.relayed ? `Sent to the Chief of Staff to relay to @${result.agent}` : `Sent to ${label}`;
      onSent?.(key, text, result);
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
  modeWrap.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-mode]');
    if (!b) return;
    mode = b.dataset.mode as Mode;
    sync();
  });

  sync();
  return {
    /** Retarget; keeps the draft when the target is unchanged, clears the status line otherwise. */
    setTarget(t: ComposerTarget | null) {
      if (t?.key !== target?.key) { status.textContent = ''; status.className = 'cmp-status'; mode = 'direct'; }
      target = t;
      sync();
    },
    focus() { box.focus(); },
  };
}
