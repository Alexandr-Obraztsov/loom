import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, MessageChannelMain } from "electron";
import { HostRef } from "@loom/host";
import { createKernel } from "@loom/kernel";
import type { Kernel } from "@loom/kernel";
import config from "../../../../builds/minimal/loom.config.json";
import { plugins } from "virtual:loom/main-plugins";
import { overrideAgent } from "./agent-command.js";
import { createSwitchableEndpoint } from "./host-endpoint.js";
import { createLink } from "./link.js";
import type { Link } from "./link.js";
import { resolveProjectDir } from "./project.js";
import { createTurnGuard } from "./turn-guard.js";

/** Longest `kernel.dispose()` may delay quitting; agents that survive it are the acp plugin's SIGKILL's job. */
const DISPOSE_TIMEOUT_MS = 8000;

function openWindow(link: Link, projectDir: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: "Loom",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const { webContents } = win;
  ipcMain.handle("loom:project", (event) => {
    if (event.sender !== webContents) throw new Error("Unknown sender");
    return projectDir;
  });
  // a new document (reload, navigation) or a dead renderer ends the current connection
  webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) link.close();
  });
  webContents.on("render-process-gone", () => {
    link.close();
  });
  webContents.on("did-finish-load", () => {
    link.open();
  });
  win.on("closed", () => {
    link.close();
    ipcMain.removeHandler("loom:project");
  });
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  return win;
}

async function start(): Promise<void> {
  const projectDir = await resolveProjectDir({
    env: process.env.LOOM_PROJECT_DIR,
    lastFile: join(app.getPath("userData"), "last-project.json"),
    pick: async () => {
      const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
      return result.canceled ? undefined : result.filePaths[0];
    },
  });
  if (projectDir === undefined) {
    app.quit();
    return;
  }
  const host = createSwitchableEndpoint();
  const guard = createTurnGuard();
  const kernel = createKernel({
    config,
    trust: () => true,
    hostServices: [
      [
        HostRef,
        { process: "main", projectDir, dataDir: app.getPath("userData"), endpoint: host.endpoint },
      ],
    ],
  });
  kernel.on("kernel.error", (error) => {
    console.error("[loom]", error);
  });
  await kernel.reconcile([...plugins, guard.plugin]);
  overrideAgent(kernel, process.env.LOOM_AGENT_COMMAND);
  const link = createLink({
    kernel,
    host,
    guard,
    channel: () => new MessageChannelMain(),
    send: (port) => {
      BrowserWindow.getAllWindows()[0]?.webContents.postMessage("loom:port", null, [port]);
    },
  });
  openWindow(link, projectDir);
  quitWith(kernel, link);
}

/** Quit path: the page link goes first (cancels turns), then every plugin is disposed (kills agents). */
function quitWith(kernel: Kernel, link: Link): void {
  let disposing = false;
  app.on("before-quit", (event) => {
    if (disposing) return;
    disposing = true;
    event.preventDefault();
    link.close();
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, DISPOSE_TIMEOUT_MS));
    void Promise.race([kernel.dispose().catch(() => undefined), timeout]).finally(() => {
      app.quit();
    });
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      app.quit();
    });
  }
}

app.on("window-all-closed", () => {
  app.quit();
});

void app
  .whenReady()
  .then(start)
  .catch((error: unknown) => {
    dialog.showErrorBox(
      "Loom не запустился",
      error instanceof Error ? error.message : String(error),
    );
    app.exit(1);
  });
