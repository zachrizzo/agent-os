import { Type } from "typebox";
import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";

export const contract = defineFeatureContract({
  pluginId: "agent-os",
  operations: {
    status: {
      kind: "query",
      description: "Report whether the Agent OS dashboard server is reachable.",
      input: Type.Object({}, { additionalProperties: false }),
      output: Type.Object({ up: Type.Boolean(), url: Type.String() }),
    },
  },
  events: {},
});
