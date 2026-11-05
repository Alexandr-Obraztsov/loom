import type { Kernel, PluginDefinition, ResolvedNode } from "@loom/kernel";
import { attach, createKernel, definePlugin } from "@loom/kernel";
import type { Navigation } from "@loom/plugin-app";
import { NavigationRef } from "@loom/plugin-app";
import { KernelProvider, Render } from "@loom/react";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import layoutBare from "../src/renderer.js";

const kernels: Kernel[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(kernels.splice(0).map((k) => k.dispose()));
});

const wrap = (kernel: Kernel, children: ReactNode): ReactNode => (
  <KernelProvider kernel={kernel}>{children}</KernelProvider>
);

/** A stand-in for the real app plugin: same id, root inputs and NavigationRef. */
const fakeApp: PluginDefinition = definePlugin({
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
      factory: () => ({}),
    },
  ],
});

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

const Screen = (label: string) => {
  const View = (): ReactNode => <div data-screen={label}>{label}</div>;
  return View;
};

const TitlebarView = (): ReactNode => <header>titlebar body</header>;
const NavigationView = (): ReactNode => <nav>navigation body</nav>;
const StatusBarView = (): ReactNode => <footer>status body</footer>;

async function boot(): Promise<Kernel> {
  const kernel = createKernel({ config: {} });
  kernels.push(kernel);
  await kernel.reconcile([
    fakeApp,
    layoutBare,
    definePlugin({
      id: "fixtures",
      version: "1.0.0",
      extensions: [
        attach("app", "screens", { id: "s-a", component: Screen("screen a body") }),
        attach("app", "screens", { id: "s-b", component: Screen("screen b body") }),
        attach("layout-bare", "titlebar", { id: "bar", component: TitlebarView }),
        attach("layout-bare", "navigation", { id: "nav", component: NavigationView }),
        attach("layout-bare", "status", { id: "st", component: StatusBarView }),
      ],
    }),
  ]);
  return kernel;
}

describe("layout-bare plugin", () => {
  it("layout-bare renders only the current screen", async () => {
    const kernel = await boot();
    expect(kernel.tree.orphans).toEqual([]);
    const layout = kernel.tree.root?.inputs.layout as ResolvedNode | undefined;
    expect(layout).toBeTruthy();
    render(wrap(kernel, <Render node={layout} />));
    // the first screen shows by default, the other one does not
    expect(screen.getByText("screen a body")).toBeTruthy();
    expect(screen.queryByText("screen b body")).toBeNull();
    // the other roles are accepted as inputs but not shown
    expect(screen.queryByText("titlebar body")).toBeNull();
    expect(screen.queryByText("navigation body")).toBeNull();
    expect(screen.queryByText("status body")).toBeNull();
    // the screen area fills the window
    const main = screen.getByRole("main");
    expect(main.getAttribute("style")).toContain("position: fixed");
    expect(main.getAttribute("style")).toContain("inset");
    // navigation switches the visible screen
    const navigation = kernel.services.use(NavigationRef);
    act(() => {
      navigation.go("app/screens/s-b");
    });
    expect(screen.getByText("screen b body")).toBeTruthy();
    expect(screen.queryByText("screen a body")).toBeNull();
  });
});
