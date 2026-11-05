import type { ZodType } from "zod";
import type { LoomError } from "./errors.js";

export interface ServiceRef<T> {
  readonly id: string;
  readonly kind: "service";
  readonly __type?: T;
}

/** R is the complete return type; async hooks are declared `HookRef<C, Promise<X>>`. */
export interface HookRef<C, R> {
  readonly id: string;
  readonly kind: "hook";
  readonly mode: "sync" | "async";
  readonly __types?: [C, R];
}

export type Next<C, R> = (ctx: C) => R;

export interface TapOptions<C> {
  priority?: number;
  before?: readonly string[];
  after?: readonly string[];
  match?: (ctx: C) => boolean;
}

export interface InputSpec {
  multiple?: boolean;
  required?: boolean;
  schema?: ZodType;
}

export interface ResolvedNode<O = unknown> {
  readonly id: string;
  readonly pluginId: string;
  readonly value: O | undefined;
  readonly inputs: Readonly<Record<string, ResolvedNode | readonly ResolvedNode[] | undefined>>;
  /** Every error of this node, in the order found; empty when the node is healthy. */
  readonly errors: readonly LoomError[];
}

export interface ExtensionContext<I> {
  inputs: I;
  use<T>(ref: ServiceRef<T>): T;
  config: unknown;
}

export interface ExtensionDefinition<O = unknown> {
  id: string;
  attachTo?: { id: string; input: string };
  inputs?: Record<string, InputSpec>;
  order?: number;
  factory(ctx: ExtensionContext<Record<string, ResolvedNode | ResolvedNode[] | undefined>>): O;
}

export interface PluginContext {
  readonly id: string;
  readonly config: unknown;
  readonly state: Record<string, unknown>;
  provide<T extends object>(ref: ServiceRef<T>, impl: T): void;
  override<T extends object>(ref: ServiceRef<T>, impl: T): void;
  decorate<T extends object>(ref: ServiceRef<T>, fn: (prev: T) => T): void;
  use<T extends object>(ref: ServiceRef<T>): T;
  tap<C, R>(hook: HookRef<C, R>, opts: TapOptions<C>, fn: (ctx: C, next: Next<C, R>) => R): void;
  run<C, R>(hook: HookRef<C, R>, ctx: C, fallback: (ctx: C) => R): R;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- payload type is the caller's contract
  on<P>(type: string, listener: (p: P) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- payload type is the caller's contract
  emit<P>(type: string, payload: P): void;
  onDispose(fn: () => void | Promise<void>): void;
}

export interface PluginDefinition {
  id: string;
  version: string;
  dependsOn?: Record<string, string>;
  optionalDependsOn?: Record<string, string>;
  startup?: Record<string, unknown>;
  setup?(ctx: PluginContext): void | Promise<void>;
  extensions?: readonly ExtensionDefinition[];
  overrides?: readonly ExtensionDefinition[];
}
