import type { PluginDefinition } from "@loom/sdk";
import { definePlugin, HostRef } from "@loom/sdk";

import { StorageRef } from "./api.js";
import { createStorage } from "./main/storage.js";

const plugin: PluginDefinition = definePlugin({
  id: "storage",
  version: "0.1.0",
  setup(ctx) {
    const storage = createStorage({
      dataDir: ctx.use(HostRef).dataDir,
      onCorrupt: (ns, backup) => {
        ctx.emit("storage.corrupt", { ns, backup });
      },
    });
    ctx.provide(StorageRef, storage);
  },
});

export default plugin;
