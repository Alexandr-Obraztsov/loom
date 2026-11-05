import type { PlaywrightTestConfig } from "@playwright/test";
import { defineConfig } from "@playwright/test";

const config: PlaywrightTestConfig = defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  workers: 1,
  reporter: "list",
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});

export default config;
