import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ElectronApplication, Page } from "@playwright/test";
import { _electron as electron, expect, test } from "@playwright/test";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const stub = fileURLToPath(new URL("./stub-agent.mjs", import.meta.url));

const stubPids = (): string[] => {
  try {
    return execFileSync("pgrep", ["-f", stub], { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
};

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    // Linux CI runs Electron as a non-root user without a SUID chrome-sandbox helper
    args: process.env.CI ? [".", "--no-sandbox"] : ["."],
    cwd: appDir,
    env: {
      ...process.env,
      LOOM_PROJECT_DIR: mkdtempSync(join(tmpdir(), "loom-e2e-")),
      LOOM_AGENT_COMMAND: `node ${stub}`,
    },
  });
  const page = await app.firstWindow();
  return { app, page };
}

async function send(page: Page, text: string): Promise<void> {
  const composer = page.getByLabel("Сообщение");
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  await composer.fill(text);
  await composer.press("Enter");
}

test("chat round trip with a permission, and no agent left after quit", async () => {
  const { app, page } = await launch();
  await send(page, "привет");
  await expect(page.getByText("привет", { exact: true })).toBeVisible();

  const card = page.locator('[data-permission="pending"]');
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Разрешить" }).click();
  await expect(page.locator('[data-permission="allow"]')).toBeVisible();

  // both chunks land in one bubble
  await expect(page.getByText("эхо: привет", { exact: true })).toHaveCount(1);
  expect(stubPids().length).toBeGreaterThan(0);

  await app.close();
  await expect.poll(stubPids, { timeout: 15_000 }).toEqual([]);
});

test("reloading the window cancels the pending permission of the running turn", async () => {
  const { app, page } = await launch();
  await send(page, "жду");
  await expect(page.locator('[data-permission="pending"]')).toBeVisible();

  await page.reload();
  await expect(page.locator('[data-permission="cancelled"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Сообщение")).toBeEnabled({ timeout: 30_000 });

  await app.close();
  await expect.poll(stubPids, { timeout: 15_000 }).toEqual([]);
});

test("the window cannot open or navigate to a foreign page", async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    res.end("<title>foreign</title>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const foreign = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`;
  try {
    await blockedThenChat(foreign, requests);
  } finally {
    server.close();
  }
});

async function blockedThenChat(foreign: string, requests: readonly string[]): Promise<void> {
  const { app, page } = await launch();
  await expect(page.getByLabel("Сообщение")).toBeEnabled({ timeout: 30_000 });
  const before = page.url();

  const wasOpened = await page.evaluate((url) => window.open(url) !== null, foreign);
  expect(wasOpened).toBe(false);
  await page.evaluate((url) => {
    location.href = url;
  }, foreign);
  await page.waitForTimeout(1000);

  expect(page.url()).toBe(before);
  expect(requests).toEqual([]);
  expect(app.windows()).toHaveLength(1);
  // the blocked attempt must not cost the page its connection. Playwright locators keep waiting
  // for the cancelled navigation, so the page is driven through the DOM here.
  await page.evaluate(() => {
    const box = document.querySelector<HTMLTextAreaElement>('[aria-label="Сообщение"]');
    if (!box) throw new Error("no composer");
    // React tracks the value through the prototype setter
    Reflect.set(HTMLTextAreaElement.prototype, "value", "привет", box);
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  const allowButton = (): Promise<boolean> =>
    page.evaluate(() => {
      const buttons = document.querySelectorAll<HTMLButtonElement>(
        '[data-permission="pending"] button',
      );
      const allow = Array.from(buttons).find((b) => b.textContent === "Разрешить");
      allow?.click();
      return allow !== undefined;
    });
  await expect.poll(allowButton, { timeout: 30_000 }).toBe(true);
  const replied = (): Promise<boolean> =>
    page.evaluate(() => document.body.innerText.includes("эхо: привет"));
  await expect.poll(replied, { timeout: 30_000 }).toBe(true);
  await app.close();
}
