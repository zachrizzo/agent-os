// The Agent OS app runs in a sandboxed iframe (opaque origin), so it can't inherit the Control UI's CSS variables or read
// its theme. This bridge posts the host's light/dark mode and the variable values the app uses, and re-posts whenever the
// host's theme changes (the Control UI toggles data-theme-mode / data-theme / the stylesheet variables on <html>).
// Keep VARS in sync with HOST_VARS in prototype/src/theme.ts.
const VARS = [
  "--bg", "--card", "--text", "--text-strong", "--muted", "--border", "--accent", "--accent-foreground",
  "--ok", "--warn", "--danger", "--info", "--accent-2", "--font-body", "--mono",
] as const;
const MSG = "agent-os:theme";
const REQ = "agent-os:theme-request";

const modeOf = (el: HTMLElement): "light" | "dark" => {
  const m = el.dataset.themeMode ?? el.dataset.themeResolved;
  if (m === "light" || m === "dark") return m;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
};

export function bridgeTheme(frame: HTMLIFrameElement, signal: AbortSignal): void {
  const root = document.documentElement;
  const post = () => {
    const cs = getComputedStyle(root);
    const vars: Record<string, string> = {};
    for (const v of VARS) vars[v] = cs.getPropertyValue(v).trim();
    frame.contentWindow?.postMessage({ type: MSG, mode: modeOf(root), vars }, "*");
  };
  // Only the frame we created may ask; it re-asks on every boot, which covers a frame that loaded before this listener.
  window.addEventListener("message", (e) => { if (e.source === frame.contentWindow && e.data?.type === REQ) post(); }, { signal });
  frame.addEventListener("load", post, { signal });
  // Theme switches change attributes/classes/inline style on <html>; coalesce to one post per frame.
  let queued = false;
  const schedule = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; post(); }); };
  const mo = new MutationObserver(schedule);
  mo.observe(root, { attributes: true, attributeFilter: ["data-theme", "data-theme-mode", "data-theme-id", "data-theme-resolved", "class", "style"] });
  const mq = matchMedia("(prefers-color-scheme: light)");
  mq.addEventListener("change", schedule, { signal });
  signal.addEventListener("abort", () => mo.disconnect());
}
