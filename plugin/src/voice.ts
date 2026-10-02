import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";

// Talk only starts from the pinned Voice session and is owned by its mounted chat pane: the Control UI
// ends Talk when that pane unmounts, and the plugin host exposes no Talk API. So "voice from the tab"
// is: open the Voice session, press its composer mic once. Selectors are the Control UI 2026.9.7
// composer buttons ("Start voice input" / "Stop voice input"); if they change, the fallback message
// tells the user to press the mic themselves.
export const VOICE_SESSION_KEY = "agent:voice:main";
const START = "button.chat-send-btn--voice";
const LIVE = "button.chat-send-btn--voice-live";

export type VoiceResult = { ok: boolean; detail: string };

function deepQuery(selector: string, root: ParentNode = document): HTMLButtonElement | null {
  const hit = root.querySelector<HTMLButtonElement>(selector);
  if (hit) return hit;
  for (const el of root.querySelectorAll("*")) {
    if (el.shadowRoot) {
      const found = deepQuery(selector, el.shadowRoot);
      if (found) return found;
    }
  }
  return null;
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
  const start = await waitFor(() => { const b = deepQuery(START); return b && !b.disabled ? b : null; }, 8000, signal);
  if (!start) return { ok: false, detail: "The Voice mic isn't available yet. Press it in the Voice session." };
  start.click();
  const live = await waitFor(() => deepQuery(LIVE), 12000, signal);
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
      // Opening Voice navigates away and disposes this page, so only early failures (no Gateway, session didn't open) show here.
      if (signal.aborted) return;
      status.textContent = result.detail;
      if (!result.ok) status.dataset.error = "true";
    } finally {
      if (!signal.aborted) button.disabled = false;
    }
  });
  return wrap;
}
