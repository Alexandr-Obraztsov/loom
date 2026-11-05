import type { AgentRegistry, AgentSpec } from "../api.js";

export function createAgentRegistry(): AgentRegistry {
  const specs = new Map<string, AgentSpec>();
  return {
    add(spec) {
      const own = { ...spec };
      specs.set(own.id, own);
      return () => {
        if (specs.get(own.id) === own) specs.delete(own.id);
      };
    },
    list: () => [...specs.values()],
  };
}
