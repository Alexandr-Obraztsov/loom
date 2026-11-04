import type { ExtensionContext, ExtensionDefinition, ResolvedNode } from "../../src/core/types.js";

export type Entry = { pluginId: string; ext: ExtensionDefinition; override: boolean };
export type Ctx = ExtensionContext<Record<string, ResolvedNode | ResolvedNode[] | undefined>>;

export const use = ((): never => {
  throw new Error("unused");
}) as ExtensionContext<never>["use"];

export function ext(id: string, rest: Partial<ExtensionDefinition> = {}): ExtensionDefinition {
  return { id, factory: () => id, ...rest };
}
export const at = (id: string, input: string): { id: string; input: string } => ({ id, input });
export const e = (pluginId: string, def: ExtensionDefinition, override = false): Entry => ({ pluginId, ext: def, override });
export const slot = { slot: { multiple: true } };

export function childIds(node: ResolvedNode | undefined, input: string): string[] {
  const v = node?.inputs[input];
  return (Array.isArray(v) ? (v as ResolvedNode[]) : []).map((n) => n.id);
}
