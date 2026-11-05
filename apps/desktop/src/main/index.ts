import { join } from "node:path";

import type { Kernel } from "@loom/kernel";
import { createKernel } from "@loom/kernel";
import { HostRef } from "@loom/sdk";
import { app, BrowserWindow, dialog, ipcMain, MessageChannelMain } from "electron";
import { plugins } from "virtual:loom/main-plugins";

import config from "../../../../builds/minimal/loom.config.json";
import { overrideAgent } from "./agent-command.js";
import { appTarget, isAppUrl } from "./app-url.js";
import { createSwitchableEndpoint } from "./host-endpoint.js";
import type { Link } from "./link.js";
import { createLink } from "./link.js";
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
  const indexFile = join(import.meta.dirname, "../renderer/index.html");
  // the dev server is for unpackaged runs only
  const target = appTarget(
    app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL,
    indexFile,
  );
  // only the app's own page may hold the port (Sessions and AgentRegistry can spawn processes)
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const guardNavigation = (details: { readonly url: string; preventDefault(): void }): void => {
    if (!isAppUrl(target, details.url)) details.preventDefault();
  };
  webContents.on("will-navigate", guardNavigation);
  webContents.on("will-redirect", guardNavigation);
  ipcMain.handle("loom:project", (event) => {
    if (event.sender !== webContents) throw new Error("Unknown sender");
    return projectDir;
  });
  // a new app document (reload) or a dead renderer ends the current connection; a foreign
  // navigation is still announced here before `will-navigate` cancels it, so it must not count
  webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument && isAppUrl(target, details.url))
      link.close();
  });
  webContents.on("render-process-gone", () => {
    link.close();
  });
  webContents.on("did-finish-load", () => {
    if (isAppUrl(target, webContents.getURL())) link.open();
  });
  win.on("closed", () => {
    link.close();
    ipcMain.removeHandler("loom:project");
  });
  if (target.kind === "dev") void win.loadURL(process.env.ELECTRON_RENDERER_URL as string);
  else void win.loadFile(indexFile);
  return win;
}

async function start(): Promise<void> {
  // test hooks (LOOM_*) exist only in unpackaged runs
  const hooks = app.isPackaged ? {} : process.env;
  const projectDir = await resolveProjectDir({
    env: hooks.LOOM_PROJECT_DIR,
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
  overrideAgent(kernel, hooks.LOOM_AGENT_COMMAND);
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
  let isDisposing = false;
  app.on("before-quit", (event) => {
    if (isDisposing) return;
    isDisposing = true;
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
