import { validRange, valid } from "semver";
import { z } from "zod";
import { LoomError } from "./errors.js";
import type { ExtensionDefinition, PluginDefinition } from "./types.js";

const fn = z.custom<(...args: never[]) => unknown>((v) => typeof v === "function", "must be a function");

const rangeMap = z.record(
  z.string(),
  z.string().refine((r) => validRange(r) !== null, "invalid semver range"),
);

const inputSpec = z.object({
  multiple: z.boolean().optional(),
  required: z.boolean().optional(),
  schema: z.custom((v) => typeof v === "object" && v !== null, "must be a zod schema").optional(),
});

const extension = z.object({
  id: z.string().min(1),
  attachTo: z.object({ id: z.string().min(1), input: z.string().min(1) }).optional(),
  inputs: z.record(z.string(), inputSpec).optional(),
  order: z.number().optional(),
  factory: fn,
});

function uniqueIds(list: readonly ExtensionDefinition[] | undefined, key: string, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  list?.forEach((e, index) => {
    if (seen.has(e.id)) {
      ctx.addIssue({ code: "custom", path: [key, index, "id"], message: `duplicate ${key} id "${e.id}"` });
    }
    seen.add(e.id);
  });
}

const schema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*(\/[a-z0-9-]+)?$/, "invalid plugin id"),
    version: z.string().refine((v) => valid(v) !== null, "invalid semver version"),
    scope: z.enum(["builtin", "user", "project"]).optional(),
    dependsOn: rangeMap.optional(),
    optionalDependsOn: rangeMap.optional(),
    startup: z.record(z.string(), z.unknown()).optional(),
    setup: fn.optional(),
    extensions: z.array(extension).optional(),
    overrides: z.array(extension).optional(),
  })
  .superRefine((p, ctx) => {
    for (const key of ["dependsOn", "optionalDependsOn"] as const) {
      if (p[key] && Object.hasOwn(p[key], p.id)) {
        ctx.addIssue({ code: "custom", path: [key, p.id], message: "plugin cannot depend on itself" });
      }
    }
    for (const dep of Object.keys(p.dependsOn ?? {})) {
      if (p.optionalDependsOn && Object.hasOwn(p.optionalDependsOn, dep)) {
        ctx.addIssue({ code: "custom", path: ["optionalDependsOn", dep], message: `"${dep}" is both required and optional` });
      }
    }
    uniqueIds(p.extensions as ExtensionDefinition[] | undefined, "extensions", ctx);
    uniqueIds(p.overrides as ExtensionDefinition[] | undefined, "overrides", ctx);
  });

export function validatePlugin(def: unknown): PluginDefinition {
  const result = schema.safeParse(def);
  if (result.success) return def as PluginDefinition;
  const issues = result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
  const id = typeof (def as { id?: unknown } | null)?.id === "string" ? (def as { id: string }).id : undefined;
  const summary = issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ");
  throw new LoomError("MANIFEST_INVALID", `Invalid plugin manifest${id ? ` "${id}"` : ""}: ${summary}`, {
    ...(id ? { pluginIds: [id] } : {}),
    details: { issues },
  });
}
