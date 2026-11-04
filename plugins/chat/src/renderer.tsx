import { attach, definePlugin } from "@loom/sdk";
import type { PluginDefinition } from "@loom/sdk";
import { ChatSessionRef } from "./api.js";
import { ChatSessionDriverRef, ChatView, createChatSession } from "./timeline.js";

const chatScreen = attach("app", "screens", { id: "chat", title: "Чат", component: ChatView });

/** Экран чата: лента сеанса, под ней инлайны и композер (задача 7). */
const plugin: PluginDefinition = definePlugin({
  id: "chat",
  version: "0.1.0",
  dependsOn: { acp: "^0.1.0" },
  setup(ctx) {
    const session = createChatSession();
    ctx.provide(ChatSessionRef, session);
    ctx.provide(ChatSessionDriverRef, session);
  },
  extensions: [
    {
      ...chatScreen,
      inputs: { composer: {}, inline: { multiple: true } },
    },
  ],
});

export default plugin;
