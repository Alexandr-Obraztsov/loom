import { LoomError } from "../core/errors.js";
import type { LoomErrorCode } from "../core/errors.js";
import { clone } from "./platform.js";

/** A LoomError as it travels: `details` only when it survives `structuredClone`. */
export interface SerializedError {
  readonly code: LoomErrorCode;
  readonly message: string;
  readonly pluginIds: readonly string[];
  readonly details?: unknown;
}

export type Outcome = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: SerializedError };

/**
 * Wire messages. `call`/`result`/`error`/`cancel` carry request ids of the calling endpoint.
 * Remote taps: the exposing side sends `tap-invoke` (id = its invocation id); the tapping side
 * answers `tap-next` (its fn called next) and finally `tap-result` with `for: "tap"`; the exposing
 * side resolves each `tap-next` with `tap-result` `for: "next"` under the same invocation id.
 */
export type RpcMessage =
  | { readonly type: "call"; readonly id: number; readonly target: string; readonly method: string; readonly args: readonly unknown[] }
  | { readonly type: "result"; readonly id: number; readonly value: unknown }
  | { readonly type: "error"; readonly id: number; readonly error: SerializedError }
  | { readonly type: "cancel"; readonly id: number }
  | { readonly type: "tap-invoke"; readonly id: number; readonly tapId: number; readonly ctx: unknown }
  | { readonly type: "tap-next"; readonly id: number; readonly ctx: unknown }
  | { readonly type: "tap-result"; readonly id: number; readonly for: "next" | "tap"; readonly outcome: Outcome };

export type TapMessage = Extract<RpcMessage, { type: "tap-invoke" | "tap-next" | "tap-result" }>;

export interface Transport {
  /** May throw synchronously (e.g. DataCloneError); the endpoint turns that into RPC_REMOTE_ERROR. */
  send(msg: RpcMessage): void;
  onMessage(cb: (msg: RpcMessage) => void): () => void;
  onClose(cb: () => void): () => void;
}

export function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function cloneable(value: unknown): boolean {
  try {
    clone(value);
    return true;
  } catch {
    return false;
  }
}

export function serializeError(e: unknown): SerializedError {
  if (!(e instanceof LoomError)) return { code: "RPC_REMOTE_ERROR", message: describe(e), pluginIds: [] };
  const base = { code: e.code, message: e.message, pluginIds: [...e.pluginIds] };
  return e.details !== undefined && cloneable(e.details) ? { ...base, details: e.details } : base;
}

export function deserializeError(s: SerializedError): LoomError {
  return new LoomError(s.code, s.message, {
    pluginIds: s.pluginIds,
    ...(s.details === undefined ? {} : { details: s.details }),
  });
}

export function remoteError(message: string, cause?: unknown): LoomError {
  return new LoomError("RPC_REMOTE_ERROR", message, cause === undefined ? {} : { cause });
}

/** The RPC target under which `exposeHooks` serves tap/untap requests for one hook. */
export function hookTarget(hookId: string): string {
  return `loom:hook:${hookId}`;
}

/** Remote tap registration, sent as the single argument of a `tap` call to `hookTarget`. */
export interface TapRequest {
  readonly tapId: number;
  /** Plugin id on the tapping side; the exposing side registers the tap as `remote:<owner>`. */
  readonly owner: string;
  readonly timeoutMs: number;
  readonly priority?: number;
  readonly before?: readonly string[];
  readonly after?: readonly string[];
}

export const DEFAULT_TAP_TIMEOUT_MS = 5000;
