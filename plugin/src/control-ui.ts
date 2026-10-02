import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { createFeatureClient } from "openclaw/plugin-sdk/feature-contract";
import { contract } from "./contract.js";
import "./control-ui.css";

// v0: embeds the Agent OS prototype (Vite :5199, API :5198). Card B replaces this with a native page.
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
        const show = (url: string) => {
          const frame = document.createElement("iframe");
          frame.src = url;
          frame.title = "Agent OS";
          frame.className = "agent-os-frame";
          root.replaceChildren(frame);
        };
        feature.invoke("status", {}).then((s) => {
          if (context.signal.aborted) return;
          if (s.up) show(s.url);
          else notice.textContent = "The Agent OS dashboard server isn't running (expected at " + s.url + "). Ask the Chief of Staff to start it.";
        }).catch((e) => { if (!context.signal.aborted) notice.textContent = String(e); });
        return { dispose: () => root.remove() };
      },
    });
  },
});
