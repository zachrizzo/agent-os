// Host actions for the Agent OS app. The app runs in a sandboxed iframe with no access to the Control UI, so it asks this bridge
// (postMessage) to run the host actions that exist as public SDK calls, and only offers the buttons for the ones listed in the
// capability reply. Today that is one: open a session in the native chat (host.sessions.open).
// Not offered, because the 2026.9.7 SDK has no public call for them: git branch, sidebar toggle, browser panel, split pane.
// Keep the strings in sync with prototype/shared/hostbridge.ts.
import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";

const CAPS_REQUEST = "agent-os:host-caps-request";
const CAPS = "agent-os:host-caps";
const ACTION = "agent-os:host-action";
const RESULT = "agent-os:host-action-result";
/** Only room sessions (agent:<id>:room-r<8 hex>) may be opened from the app; never an arbitrary key. */
const ROOM_KEY_RE = /^agent:([a-z0-9][a-z0-9_-]{0,63}):room-r[0-9a-f]{8}$/;

const actions: Record<string, (host: ControlUiHost, sessionKey: string) => void> = {
  "open-session": (host, sessionKey) => {
    const m = ROOM_KEY_RE.exec(sessionKey);
    if (!m) throw new Error("Not a room session");
    host.sessions.open({ sessionKey, agentId: m[1] });
  },
};

export function bridgeHostActions(frame: HTMLIFrameElement, host: ControlUiHost, signal: AbortSignal): void {
  const post = (msg: unknown) => frame.contentWindow?.postMessage(msg, "*");
  const caps = () => post({ type: CAPS, actions: Object.keys(actions) });
  window.addEventListener("message", (e) => {
    if (e.source !== frame.contentWindow) return; // only the frame we created
    const d = e.data as { type?: string; id?: number; action?: string; sessionKey?: unknown } | null;
    if (d?.type === CAPS_REQUEST) { caps(); return; }
    if (d?.type !== ACTION || typeof d.id !== "number") return;
    const id = d.id;
    try {
      const run = typeof d.action === "string" ? actions[d.action] : undefined;
      if (!run) throw new Error("Unknown action");
      run(host, String(d.sessionKey ?? ""));
      post({ type: RESULT, id, ok: true });
    } catch (err) {
      post({ type: RESULT, id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }, { signal });
  frame.addEventListener("load", caps, { signal });
}
