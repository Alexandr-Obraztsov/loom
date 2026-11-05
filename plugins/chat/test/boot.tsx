import { act, render } from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";
import { createKernel, createMemoryTransportPair, createRpcEndpoint } from "@loom/kernel";
import type { Kernel, PluginDefinition } from "@loom/kernel";
import { KernelProvider, Render, RenderRoot } from "@loom/react";
import { NavigationRef, useCurrentScreen } from "@loom/plugin-app";
import type { Navigation } from "@loom/plugin-app";
import { SessionsRef } from "@loom/plugin-acp";
import type { SessionSnapshot, Sessions } from "@loom/plugin-acp";
import { HostRef, definePlugin } from "@loom/sdk";
import type { ReactNode } from "react";
import chat from "../src/renderer.js";
import type { FakeSessions } from "./fixtures.js";

export const PROJECT_DIR = "/tmp/loom-project";

function stubNavigation(): Navigation {
  let currentId: string | undefined;
  const listeners = new Set<() => void>();
  return {
    current: () => currentId,
    go(screenId: string): void {
      currentId = screenId;
      for (const fn of listeners) fn();
    },
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

/** Экран приложения — как настоящий app-рендерер, но без провайдеров и раскладки. */
function AppShell(): ReactNode {
  return <Render node={useCurrentScreen()} />;
}

/** Заглушка app: тот же id, корневые входы и навигация (загружать чужой renderer.tsx нельзя). */
const app = definePlugin({
  id: "app",
  version: "0.1.0",
  setup(ctx) {
    ctx.provide(NavigationRef, stubNavigation());
  },
  extensions: [
    {
      id: "app",
      inputs: {
        providers: { multiple: true },
        layout: {},
        screens: { multiple: true },
        overlays: { multiple: true },
      },
      factory: () => ({ component: AppShell }),
    },
  ],
});

const kernels: Kernel[] = [];

/** Поднимает ядро с app + chat + acp-заглушкой, поставляющей `sessions`. */
export async function bootChat(
  sessions: Sessions,
  extra: readonly PluginDefinition[] = [],
): Promise<Kernel> {
  const [transport] = createMemoryTransportPair();
  const kernel = createKernel({
    hostServices: [
      [
        HostRef,
        {
          process: "renderer",
          projectDir: PROJECT_DIR,
          dataDir: "",
          endpoint: createRpcEndpoint(transport),
        },
      ],
    ],
  });
  kernels.push(kernel);
  const acp = definePlugin({
    id: "acp",
    version: "0.1.0",
    setup(ctx) {
      ctx.provide(SessionsRef, sessions);
    },
  });
  await kernel.reconcile([app, acp, chat, ...extra]);
  return kernel;
}

export function renderApp(kernel: Kernel): RenderResult {
  return render(
    <KernelProvider kernel={kernel}>
      <RenderRoot />
    </KernelProvider>,
  );
}

/** Даёт микрозадачам (ensure/опрос) отработать внутри act. */
export async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Мутирует снимок и проводит отклик опроса через act. */
export async function applyUpdate(
  sessions: FakeSessions,
  fn: (s: SessionSnapshot) => SessionSnapshot,
): Promise<void> {
  await act(async () => {
    sessions.emit(fn);
    await Promise.resolve();
  });
}

export async function disposeKernels(): Promise<void> {
  await Promise.all(kernels.splice(0).map((k) => k.dispose()));
}
