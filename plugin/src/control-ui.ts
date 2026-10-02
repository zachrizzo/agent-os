import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { createFeatureClient } from "openclaw/plugin-sdk/feature-contract";
import { contract } from "./contract.js";
import "./control-ui.css";

// v0.1: frames the built Agent OS app served by this plugin at /agent-os/ (same origin, sandboxed). Card B replaces this with a native page.
export default defineControlUiPlugin({
  id: contract.pluginId,
  activate(host) {
    host.ui.registerNavigation({ id: "agent-os", label: "Agent OS", page: { id: "agent-os" }, icon: "activity" });
    host.ui.registerPage({
      id: "agent-os", label: "Agent OS",
      mount(container, context) {
        const feature = createFeatureClient(contract, context.host);
        const root = document.createElement("section");
        root.className = "agent-os-page";
        const notice = document.createElement("div");
        notice.className = "agent-os-notice";
        notice.textContent = "Connecting to the Agent OS dashboard…";
        root.append(notice);
        container.append(root);
        const fallback = (url: string, why: string) => {
          notice.replaceChildren();
          const msg = document.createElement("p");
          msg.textContent = why;
          const open = document.createElement("a");
          open.href = new URL(url, location.origin).toString();
          open.target = "_blank";
          open.rel = "noopener noreferrer";
          open.className = "agent-os-open";
          open.textContent = "Open Agent OS in browser";
          notice.append(msg, open);
          root.replaceChildren(notice);
        };
        const show = (url: string) => {
          const frame = document.createElement("iframe");
          frame.src = url;
          frame.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox");
          frame.title = "Agent OS";
          frame.className = "agent-os-frame";
          let loaded = false;
          frame.addEventListener("load", () => { loaded = true; });
          const timer = setTimeout(() => {
            if (!loaded && !context.signal.aborted) fallback(url, "The Agent OS view didn't load here.");
          }, 4000);
          context.signal.addEventListener("abort", () => clearTimeout(timer));
          const bar = document.createElement("div");
          bar.className = "agent-os-bar";
          const hint = document.createElement("span");
          hint.textContent = "Blank below?";
          const link = document.createElement("a");
          link.href = new URL(url, location.origin).toString();
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = "Open Agent OS";
          bar.append(hint, link);
          root.replaceChildren(bar, frame);
        };
        feature.invoke("status", {}).then((s) => {
          if (context.signal.aborted) return;
          if (s.up) show(s.url);
          else fallback(s.url, "The Agent OS data server (127.0.0.1:5198) isn't running. Ask the Chief of Staff to start it.");
        }).catch((e) => { if (!context.signal.aborted) notice.textContent = String(e); });
        return { dispose: () => root.remove() };
      },
    });
  },
});
