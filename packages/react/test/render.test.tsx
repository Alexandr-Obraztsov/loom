import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createKernel, createServiceRef, definePlugin } from "@loom/kernel";
import type { ExtensionDefinition, Kernel, PluginDefinition, ResolvedNode } from "@loom/kernel";
import type { ComponentType, ReactNode } from "react";
import { createHook } from "@loom/kernel";
import {
  KernelProvider,
  Render,
  RenderRoot,
  useHookRunner,
  useKernel,
  useService,
  useTree,
} from "../src/index.js";

type View = ComponentType<{ node: ResolvedNode }>;

const kernels: Kernel[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(kernels.splice(0).map((k) => k.dispose()));
});

const ext = (
  id: string,
  component: View | undefined,
  rest: Partial<ExtensionDefinition> = {},
): ExtensionDefinition => ({
  id,
  factory: () => ({ component }),
  ...rest,
});

const Children: View = ({ node }) => (
  <section>
    {(node.inputs.items as ResolvedNode[] | undefined)?.map((n) => (
      <Render key={n.id} node={n} />
    ))}
  </section>
);

function plugin(id: string, extensions: ExtensionDefinition[]): PluginDefinition {
  return definePlugin({ id, version: "1.0.0", extensions });
}

async function boot(plugins: PluginDefinition[]): Promise<Kernel> {
  const kernel = createKernel({ config: { rootId: "root" } });
  kernels.push(kernel);
  await kernel.reconcile(plugins);
  return kernel;
}

const wrap = (kernel: Kernel, children: ReactNode): ReactNode => (
  <KernelProvider kernel={kernel}>{children}</KernelProvider>
);
const Hello: View = () => <p>hello</p>;

describe("@loom/react", () => {
  it("RenderRoot renders the root component", async () => {
    const kernel = await boot([plugin("p", [ext("root", Hello)])]);
    render(wrap(kernel, <RenderRoot />));
    expect(screen.getByText("hello")).toBeTruthy();
  });

  it("node with error renders the alert placeholder naming the extension", async () => {
    const bad: ExtensionDefinition = {
      id: "root",
      factory: () => {
        throw new Error("boom");
      },
    };
    const kernel = await boot([plugin("p", [bad])]);
    render(wrap(kernel, <RenderRoot />));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Расширение «root» не загрузилось:");
    expect(alert.textContent).toContain("threw");
  });

  it("component that throws renders the placeholder and siblings still render", async () => {
    const Boom: View = () => {
      throw new Error("render failed");
    };
    const kernel = await boot([
      plugin("p", [
        ext("root", Children, { inputs: { items: { multiple: true } } }),
        ext("bad", Boom, { attachTo: { id: "root", input: "items" } }),
        ext("good", Hello, { attachTo: { id: "root", input: "items" } }),
      ]),
    ]);
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void errors.push(a);
    try {
      render(wrap(kernel, <RenderRoot />));
    } finally {
      console.error = original;
    }
    expect(screen.getByRole("alert").textContent).toContain("«bad»");
    expect(screen.getByRole("alert").textContent).toContain("render failed");
    expect(screen.getByText("hello")).toBeTruthy();
  });
});

describe("@loom/react updates and services", () => {
  it("tree change after reconcile re-renders", async () => {
    const kernel = await boot([plugin("p", [ext("root", () => <p>one</p>)])]);
    render(wrap(kernel, <RenderRoot />));
    expect(screen.getByText("one")).toBeTruthy();
    await act(async () => {
      await kernel.reconcile(
        [plugin("p", [ext("root", () => <p>two</p>)])].map((p) => ({ ...p, version: "1.0.1" })),
      );
    });
    expect(screen.getByText("two")).toBeTruthy();
  });
});

describe("@loom/react recovery", () => {
  it("a component that throws a non-Error still renders the placeholder", async () => {
    const Odd: View = () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the case under test
      throw "just a string";
    };
    const kernel = await boot([plugin("p", [ext("root", Odd)])]);
    const original = console.error;
    console.error = () => undefined;
    try {
      render(wrap(kernel, <RenderRoot />));
    } finally {
      console.error = original;
    }
    expect(screen.getByRole("alert").textContent).toContain("just a string");
  });

  it("a failed boundary recovers when the tree changes", async () => {
    let broken = true;
    const Flaky: View = () => {
      if (broken) throw new Error("flaky");
      return <p>fine</p>;
    };
    const mk = (version: string): PluginDefinition => ({
      ...plugin("p", [ext("root", Flaky)]),
      version,
    });
    const kernel = await boot([mk("1.0.0")]);
    const original = console.error;
    console.error = () => undefined;
    try {
      render(wrap(kernel, <RenderRoot />));
    } finally {
      console.error = original;
    }
    expect(screen.getByRole("alert")).toBeTruthy();
    broken = false;
    await act(async () => {
      await kernel.reconcile([mk("1.0.1")]);
    });
    expect(screen.getByText("fine")).toBeTruthy();
  });

  it("nodes without a component and missing nodes render nothing or the fallback", async () => {
    const kernel = await boot([plugin("p", [ext("root", undefined)])]);
    const { container } = render(wrap(kernel, <RenderRoot />));
    expect(container.innerHTML).toBe("");
    render(wrap(kernel, <Render node={undefined} fallback={<i>nothing</i>} />));
    expect(screen.getByText("nothing")).toBeTruthy();
    const empty = render(wrap(kernel, <Render node={undefined} />));
    expect(empty.container.innerHTML).toBe("");
  });
});

describe("@loom/react services", () => {
  it("useService returns a live proxy (call after override hits new impl)", async () => {
    const ref = createServiceRef<{ name(): string }>("svc.name");
    const base = definePlugin({
      id: "base",
      version: "1.0.0",
      setup: (ctx) => {
        ctx.provide(ref, { name: () => "old" });
      },
    });
    const kernel = await boot([base, plugin("p", [])]);
    let service: { name(): string } | undefined;
    const Probe = (): ReactNode => {
      service = useService(ref);
      return null;
    };
    render(wrap(kernel, <Probe />));
    expect(service?.name()).toBe("old");
    const over = definePlugin({
      id: "over",
      version: "1.0.0",
      dependsOn: { base: "^1.0.0" },
      setup: (ctx) => {
        ctx.override(ref, { name: () => "new" });
      },
    });
    await act(async () => {
      await kernel.reconcile([base, plugin("p", []), over]);
    });
    expect(service?.name()).toBe("new");
  });

  it("useHookRunner runs the hook with the fallback", async () => {
    const hook = createHook<{ n: number }, number>("test.double", { mode: "sync" });
    const kernel = await boot([plugin("p", [])]);
    let result = 0;
    const Probe = (): ReactNode => {
      const run = useHookRunner(hook);
      result = run({ n: 2 }, (c) => c.n * 2);
      return useKernel() === kernel ? <p>ok</p> : null;
    };
    render(wrap(kernel, <Probe />));
    expect(result).toBe(4);
  });

  it("hooks outside a provider throw a clear error", () => {
    const Probe = (): ReactNode => {
      useTree();
      return null;
    };
    const original = console.error;
    console.error = () => undefined;
    try {
      expect(() => render(<Probe />)).toThrow("KernelProvider");
    } finally {
      console.error = original;
    }
  });
});
