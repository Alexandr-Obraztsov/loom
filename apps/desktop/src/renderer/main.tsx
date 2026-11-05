import { createRoot } from "react-dom/client";
import { HostRef } from "@loom/host";
import { createKernel, createRpcEndpoint } from "@loom/kernel";
import { KernelProvider, RenderRoot } from "@loom/react";
import config from "../../../../builds/minimal/loom.config.json";
import { plugins } from "virtual:loom/renderer-plugins";
import { createPortTransport } from "./transport.js";

/** Main sends the port right after the page loads; listen before anything else awaits. */
const portReady = new Promise<MessagePort>((resolve) => {
  window.addEventListener("message", (event) => {
    const [port] = event.ports;
    if (event.source === window && event.data === "loom:port" && port) resolve(port);
  });
});

async function start(): Promise<void> {
  const port = await portReady;
  const projectDir = await window.loom.project();
  const endpoint = createRpcEndpoint(createPortTransport(port));
  // tell main right away when the page goes away, so it cancels the running turn
  window.addEventListener("pagehide", () => {
    endpoint.close();
  });
  const kernel = createKernel({
    config,
    trust: () => true,
    hostServices: [[HostRef, { process: "renderer", projectDir, dataDir: "", endpoint }]],
  });
  await kernel.reconcile(plugins);
  const root = document.getElementById("root");
  if (!root) throw new Error("#root is missing");
  createRoot(root).render(
    <KernelProvider kernel={kernel}>
      <RenderRoot />
    </KernelProvider>,
  );
}

void start();
