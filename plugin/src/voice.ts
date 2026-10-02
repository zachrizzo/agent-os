import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";

// Talk only starts from the pinned Voice session and is owned by its mounted chat pane: the Control UI
// ends Talk when that pane unmounts, and the plugin host exposes no Talk API. So "voice from the tab"
// is: open the Voice session, press its composer mic once.
//
// Composer semantics (Control UI 2026.9.7, read from the bundle): the Talk button is a tap/hold control.
// A plain click (no pointerdown) is the tap path, which starts Talk, but only when (a) the composer draft
// is empty (otherwise a tap SENDS the draft), and (b) the UI's own talk.catalog check has finished ready
// (otherwise a tap just opens the mic picker). Hold, which we never synthesize, starts dictation. A second
// "voice" button (class chat-mobile-dictation-action, label "Dictation") is dictation-only, so it is excluded.
export const VOICE_SESSION_KEY = "agent:voice:main";
const START = "button.chat-send-btn--voice";
const LIVE = "button.chat-send-btn--voice-live";
const DICTATION_ONLY = ".chat-mobile-dictation-action";

export type VoiceResult = { ok: boolean; detail: string };

function deepQueryAll<T extends Element>(selector: string, root: ParentNode = document, out: T[] = []): T[] {
  out.push(...root.querySelectorAll<T>(selector));
  for (const el of root.querySelectorAll("*")) if (el.shadowRoot) deepQueryAll(selector, el.shadowRoot, out);
  return out;
}

const deepQuery = <T extends Element = HTMLButtonElement>(selector: string): T | null => deepQueryAll<T>(selector)[0] ?? null;

// The Talk "Start voice input" button: not the live/stop button, not the dictation-only twin, not the camera toggle.
function findStart(): HTMLButtonElement | null {
  return deepQueryAll<HTMLButtonElement>(START).find((b) =>
    !b.classList.contains("chat-send-btn--voice-live") && !b.hasAttribute("aria-pressed") && !b.closest(DICTATION_ONLY)) ?? null;
}

// Readiness rows in the mic picker ("realtime" / "dictation"); `data-status` is checking | unknown | ready | unavailable.
const capabilities = () => deepQueryAll<HTMLElement>("[data-chat-talk-capability]").filter((el) => el.getClientRects().length > 0);
const isPending = (el: HTMLElement) => el.dataset.status === "checking" || el.dataset.status === "unknown";

// Text typed into the composer that owns `button`. A tap with a draft sends it instead of starting Talk.
function composerDraft(button: HTMLElement): string {
  let node: Node | null = button;
  while (node) {
    const parent: Node | null = node.parentNode ?? (node instanceof ShadowRoot ? node.host : null);
    if (parent instanceof Element || parent instanceof ShadowRoot) {
      const box = parent.querySelector("textarea");
      if (box) return box.value.trim();
    }
    node = parent;
  }
  return "";
}

function waitFor<T>(probe: () => T | null | false | undefined, ms: number, signal: AbortSignal): Promise<T | null> {
  return new Promise((resolve) => {
    const finish = (value: T | null) => {
      clearInterval(timer);
      clearTimeout(limit);
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(null);
    const check = () => { const value = probe(); if (value) finish(value); };
    const timer = setInterval(check, 100);
    const limit = setTimeout(() => finish(null), ms);
    signal.addEventListener("abort", onAbort);
    check();
  });
}

const sameKey = (host: ControlUiHost, a: string, b: string) => host.sessions.normalizeKey(a) === host.sessions.normalizeKey(b);
const onVoice = (host: ControlUiHost) => sameKey(host, host.sessions.selectedKey, VOICE_SESSION_KEY);
export const isVoiceSession = (host: ControlUiHost, sessionKey: string) => sameKey(host, sessionKey, VOICE_SESSION_KEY);

export async function startVoice(host: ControlUiHost): Promise<VoiceResult> {
  const { signal } = host;
  if (!host.connection.connected) return { ok: false, detail: "Gateway isn't connected." };
  // Always open: while an Agent OS page is showing, the Voice chat pane isn't mounted even if Voice was last selected.
  host.sessions.open({ sessionKey: VOICE_SESSION_KEY });
  if (!(await waitFor(() => onVoice(host), 5000, signal))) return { ok: false, detail: "Couldn't open the Voice session." };
  await new Promise((r) => setTimeout(r, 150)); // let a previous chat pane unmount
  if (deepQuery(LIVE)) return { ok: true, detail: "Voice is already live." };
  const start = await waitFor(() => { const b = findStart(); return b && !b.disabled ? b : null; }, 8000, signal);
  if (!start) return { ok: false, detail: "The Voice mic isn't available yet. Press it in the Voice session." };
  if (composerDraft(start)) return { ok: false, detail: "The Voice composer has a draft, so a tap would send it. Clear it, then press the mic." };
  // The composer asked talk.catalog when it mounted, so by the time this answers the UI's own readiness is settled.
  // A tap before then, or while realtime is unavailable, only opens the mic picker.
  const catalog = await host.request<{ realtime?: { ready?: boolean } }>("talk.catalog", {}).catch(() => null);
  if (catalog && catalog.realtime?.ready !== true) return { ok: false, detail: "Realtime voice isn't ready on the Gateway. Check the Talk provider in Settings." };
  await new Promise((r) => setTimeout(r, 250));
  if (signal.aborted) return { ok: false, detail: "Cancelled." };
  (findStart() ?? start).click();
  let live = await waitFor(() => deepQuery(LIVE), 1500, signal);
  // The talk.catalog answers can arrive out of order; if the tap only opened the picker while it still read
  // "checking", wait for it to settle and tap once more (the first tap started nothing, so this can't double-toggle).
  if (!live && capabilities().some(isPending)) {
    await waitFor(() => !capabilities().some(isPending), 5000, signal);
    const unavailable = capabilities().find((c) => c.dataset.status === "unavailable");
    if (unavailable) return { ok: false, detail: unavailable.textContent?.trim().replace(/\s+/g, " ") || "Realtime voice isn't available." };
    (findStart() ?? start).click();
  }
  live ??= await waitFor(() => deepQuery(LIVE), 12000, signal);
  return live
    ? { ok: true, detail: "Voice is live." }
    : { ok: false, detail: "Talk didn't start. Allow the microphone, then press the mic in the Voice session." };
}

// Leaving the Voice view ends Talk anyway; pressing Stop first lets it close its session cleanly.
export async function stopVoiceAndReturn(host: ControlUiHost): Promise<void> {
  const live = deepQuery(LIVE);
  if (live) {
    live.click();
    await waitFor(() => !deepQuery(LIVE), 4000, host.signal);
  }
  host.navigation.openPage({ id: "agent-os" });
}

function micIcon(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const [tag, attrs] of [
    ["rect", { x: "9", y: "3", width: "6", height: "11", rx: "3" }],
    ["path", { d: "M5 11a7 7 0 0 0 14 0M12 18v3" }],
  ] as const) {
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  }
  return svg;
}

function toast(message: string) {
  const el = document.createElement("div");
  el.className = "agent-os-toast";
  el.setAttribute("role", "status");
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 9000);
}

export function createVoiceControl(host: ControlUiHost, signal: AbortSignal): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "agent-os-voice";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "agent-os-voice__btn";
  button.title = "Open the Voice session and start Talk";
  const label = document.createElement("span");
  label.textContent = "Talk to Voice";
  button.append(micIcon(), label);
  const status = document.createElement("span");
  status.className = "agent-os-voice__status";
  status.setAttribute("role", "status");
  wrap.append(button, status);
  button.addEventListener("click", async () => {
    button.disabled = true;
    status.textContent = "Opening Voice…";
    status.removeAttribute("data-error");
    try {
      const result = await startVoice(host);
      // Opening Voice disposes this page; the tab status is only visible for early failures (no Gateway, session didn't open).
      // After that the user is looking at the Voice session, so a failure needs a toast that outlives the page.
      if (signal.aborted) {
        if (!result.ok) toast(result.detail);
        return;
      }
      status.textContent = result.detail;
      if (!result.ok) status.dataset.error = "true";
    } finally {
      if (!signal.aborted) button.disabled = false;
    }
  });
  return wrap;
}
