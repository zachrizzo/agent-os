import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { contract } from "./contract.js";

const DASHBOARD_URL = "http://127.0.0.1:5199/";

export default defineFeaturePlugin({
  contract,
  name: "Agent OS",
  description: "God's-eye view of the agent fleet as a Control UI tab.",
  setup() {
    return {
      status: async () => {
        try {
          const res = await fetch(DASHBOARD_URL, { signal: AbortSignal.timeout(2000) });
          return { up: res.ok, url: DASHBOARD_URL };
        } catch {
          return { up: false, url: DASHBOARD_URL };
        }
      },
    };
  },
});
