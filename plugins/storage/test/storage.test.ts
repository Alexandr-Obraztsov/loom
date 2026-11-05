import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createKernel, createMemoryTransportPair, createRpcEndpoint } from "@loom/kernel";
import type { Kernel } from "@loom/kernel";
import { HostRef, definePlugin } from "@loom/sdk";
import storage from "../src/main.js";
import { StorageRef } from "../src/api.js";
import type { Storage } from "../src/api.js";

const kernels: Kernel[] = [];
afterEach(async () => {
  await Promise.all(kernels.splice(0).map((k) => k.dispose()));
});

interface Corrupt {
  ns: string;
  backup: string;
}

interface Rig {
  storage: Storage;
  dataDir: string;
  corrupt: Corrupt[];
}

async function boot(dataDir: string = mkdtempSync(join(tmpdir(), "storage-"))): Promise<Rig> {
  const corrupt: Corrupt[] = [];
  const [transport] = createMemoryTransportPair();
  const kernel = createKernel({
    hostServices: [
      [
        HostRef,
        { process: "main", projectDir: dataDir, dataDir, endpoint: createRpcEndpoint(transport) },
      ],
    ],
  });
  kernels.push(kernel);
  const watcher = definePlugin({
    id: "watcher",
    version: "1.0.0",
    dependsOn: { storage: "^0.1.0" },
    setup(ctx) {
      ctx.on<Corrupt>("storage.corrupt", (p) => corrupt.push(p));
    },
  });
  await kernel.reconcile([storage, watcher]);
  return { storage: kernel.services.use(StorageRef), dataDir, corrupt };
}

const fileOf = (rig: Rig, ns: string): string => join(rig.dataDir, "storage", `${ns}.json`);

describe("storage plugin", () => {
  it("set then get round-trips", async () => {
    const r = await boot();
    const ns = r.storage.scope("settings");
    await ns.set("window", { width: 800, height: 600 });
    await expect(ns.get<{ width: number }>("window")).resolves.toEqual({ width: 800, height: 600 });
    await expect(ns.get("missing")).resolves.toBeUndefined();

    const raw = JSON.parse(readFileSync(fileOf(r, "settings"), "utf8")) as Record<string, unknown>;
    expect(raw["window"]).toEqual({ width: 800, height: 600 });

    // a fresh boot on the same dataDir reads the same data back
    const again = await boot(r.dataDir);
    await expect(again.storage.scope("settings").get("window")).resolves.toEqual({
      width: 800,
      height: 600,
    });
  });

  it("concurrent sets to one ns serialize", async () => {
    const r = await boot();
    const ns = r.storage.scope("kv");
    await Promise.all(Array.from({ length: 50 }, (_, i) => ns.set(`k${String(i)}`, i)));
    expect(await ns.keys()).toHaveLength(50);

    // repeated writes to one key: the last issued write wins
    const same = r.storage.scope("same");
    await Promise.all(Array.from({ length: 50 }, (_, i) => same.set("k", i)));
    await expect(same.get<number>("k")).resolves.toBe(49);

    const stored = JSON.parse(readFileSync(fileOf(r, "kv"), "utf8")) as Record<string, number>;
    expect(Object.keys(stored)).toHaveLength(50);
    // atomic writes leave no temp files behind
    expect(readdirSync(join(r.dataDir, "storage")).sort()).toEqual(["kv.json", "same.json"]);
  });

  it("corrupt file is backed up and starts empty", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "storage-"));
    mkdirSync(join(dataDir, "storage"), { recursive: true });
    writeFileSync(join(dataDir, "storage", "settings.json"), "{not json");
    writeFileSync(join(dataDir, "storage", "array.json"), "[1,2]");
    const r = await boot(dataDir);

    await expect(r.storage.scope("settings").keys()).resolves.toEqual([]);
    await expect(r.storage.scope("array").keys()).resolves.toEqual([]);

    expect(r.corrupt.map((c) => c.ns).sort()).toEqual(["array", "settings"]);
    for (const c of r.corrupt) {
      expect(c.backup).toMatch(/\.json\.corrupt-\d+$/);
      expect(existsSync(c.backup)).toBe(true);
      expect(readFileSync(c.backup, "utf8")).toContain(c.ns === "settings" ? "{not json" : "[1,2]");
      expect(existsSync(join(dataDir, "storage", `${c.ns}.json`))).toBe(false);
    }

    // the namespace is usable again after the backup
    await r.storage.scope("settings").set("a", 1);
    await expect(r.storage.scope("settings").get("a")).resolves.toBe(1);
  });

  it("keys lists stored keys", async () => {
    const r = await boot();
    const ns = r.storage.scope("ui");
    await ns.set("b", 2);
    await ns.set("a", 1);
    await ns.set("c", 3);
    await ns.delete("b");
    await expect(ns.keys()).resolves.toEqual(["a", "c"]);
    await expect(r.storage.scope("empty").keys()).resolves.toEqual([]);
  });

  it("rejects invalid namespaces and creates no directory until the first write", async () => {
    const r = await boot();
    for (const bad of ["Bad NS", "../escape", "", "a/b"]) {
      expect(() => r.storage.scope(bad), bad).toThrow(/Invalid storage namespace/);
    }
    // reads of a never-written namespace do not create anything on disk
    await r.storage.scope("ok").keys();
    expect(existsSync(join(r.dataDir, "storage"))).toBe(false);

    await r.storage.scope("ok").set("x", 1);
    expect(existsSync(fileOf(r, "ok"))).toBe(true);
  });

  it("delete of a missing key writes nothing", async () => {
    const r = await boot();
    await r.storage.scope("gone").delete("nope");
    expect(existsSync(join(r.dataDir, "storage"))).toBe(false);
  });

  it("fs errors reject the call and a failed write does not stall the queue", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "storage-"));
    writeFileSync(join(dataDir, "storage"), "not a directory");
    const r = await boot(dataDir);
    const ns = r.storage.scope("kv");

    // reads fail with something other than "missing"
    await expect(ns.keys()).rejects.toMatchObject({ code: "ENOTDIR" });
    // writes fail, and the queue keeps accepting jobs afterwards
    await expect(ns.set("a", 1)).rejects.toMatchObject({ code: "ENOTDIR" });
    await expect(ns.set("b", 2)).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});
