import type { ExtensionDefinition, Kernel } from "@loom/kernel";
import { attach, createKernel, definePlugin } from "@loom/kernel";
import { KernelProvider, RenderRoot } from "@loom/react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { NavigationRef, useCurrentScreen } from "../src/api.js";
import app from "../src/renderer.js";

const kernels: Kernel[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(kernels.splice(0).map((k) => k.dispose()));
});

const wrap = (kernel: Kernel, children: ReactNode): ReactNode => (
  <KernelProvider kernel={kernel}>{children}</KernelProvider>
);

/** A provider fixture: wraps its children and marks its own nesting level. */
const Marker = (mark: string) => {
  const View = ({ children }: { children: ReactNode }) => <div data-p={mark}>{children}</div>;
  return View;
};

const LayoutView = (): ReactNode => <section data-layout>layout body</section>;
const OverlayView = (): ReactNode => <aside data-overlay>overlay body</aside>;

/** Renders the id of `useCurrentScreen()` (or "no-screen" when it is undefined). */
const ScreenProbe = (): ReactNode => {
  const current = useCurrentScreen();
  return <p data-screen>{current?.id ?? "no-screen"}</p>;
};

async function boot(
  extensions: readonly ExtensionDefinition[],
  config: Record<string, unknown> = {},
): Promise<Kernel> {
  const kernel = createKernel({ config });
  kernels.push(kernel);
  await kernel.reconcile([app, definePlugin({ id: "fixtures", version: "1.0.0", extensions })]);
  return kernel;
}

describe("app plugin", () => {
  it("app renders layout inside providers in order", async () => {
    const kernel = await boot([
      attach("app", "providers", { id: "outer", component: Marker("outer") }, { order: 1 }),
      attach("app", "providers", { id: "inner", component: Marker("inner") }, { order: 2 }),
      attach("app", "layout", { id: "main", component: LayoutView }),
      attach("app", "overlays", { id: "toast", component: OverlayView }),
    ]);
    const { container } = render(wrap(kernel, <RenderRoot />));
    // the layout sits inside the inner provider, the inner one inside the outer
    const outer = container.querySelector('[data-p="outer"]') as HTMLElement;
    expect(container.querySelector('[data-p="outer"] [data-p="inner"] [data-layout]')).toBeTruthy();
    expect(container.querySelector('[data-p="inner"] > [data-p="outer"]')).toBeNull();
    // the layout and the overlay are both inside the providers
    expect(within(outer).getByText("layout body")).toBeTruthy();
    expect(within(outer).getByText("overlay body")).toBeTruthy();
    // the overlay comes after the layout element
    const layout = screen.getByText("layout body");
    const overlay = screen.getByText("overlay body");
    expect(layout.compareDocumentPosition(overlay) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("navigation defaults to first screen and go() switches", async () => {
    const kernel = await boot([
      attach("app", "screens", { id: "s-a" }),
      attach("app", "screens", { id: "s-b" }),
    ]);
    render(wrap(kernel, <ScreenProbe />));
    expect(screen.getByText("app/screens/s-a")).toBeTruthy();
    const navigation = kernel.services.use(NavigationRef);
    act(() => {
      navigation.go("app/screens/s-b");
    });
    expect(screen.getByText("app/screens/s-b")).toBeTruthy();
    expect(navigation.current()).toBe("app/screens/s-b");
    // going to the screen that is already current is a no-op, not a crash
    act(() => {
      navigation.go("app/screens/s-b");
    });
    expect(screen.getByText("app/screens/s-b")).toBeTruthy();
  });

  it("app with no layout renders an inline Russian hint", async () => {
    const kernel = await boot([]);
    render(wrap(kernel, <RenderRoot />));
    const hint = screen.getByRole("status");
    expect(hint.textContent).toBe("Раскладка не установлена");
  });

  it("providers without a component are skipped; no screens leaves the current screen undefined", async () => {
    const kernel = await boot([
      attach("app", "providers", { id: "healthy", component: Marker("healthy") }, { order: 1 }),
      attach("app", "providers", { id: "empty" }, { order: 2 }),
      attach("app", "layout", { id: "main", component: LayoutView }),
    ]);
    const { container } = render(
      wrap(
        kernel,
        <>
          <RenderRoot />
          <ScreenProbe />
        </>,
      ),
    );
    // the component-less provider adds no nesting level
    expect(container.querySelector('[data-p="healthy"] > [data-layout]')).toBeTruthy();
    expect(screen.getByText("no-screen")).toBeTruthy();
  });

  it("useCurrentScreen stays undefined when the app extension is not in the tree", async () => {
    const kernel = await boot([], { disabled: ["app"] });
    render(wrap(kernel, <ScreenProbe />));
    expect(screen.getByText("no-screen")).toBeTruthy();
  });
});
