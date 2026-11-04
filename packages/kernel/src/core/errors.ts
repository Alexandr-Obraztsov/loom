export type LoomErrorCode =
  | "MANIFEST_INVALID"
  | "DEPENDENCY_MISSING"
  | "DEPENDENCY_VERSION"
  | "DEPENDENCY_CYCLE"
  | "UNTRUSTED"
  | "SERVICE_CONFLICT"
  | "SERVICE_MISSING"
  | "UNDECLARED_DEPENDENCY"
  | "EXTENSION_CONFLICT"
  | "EXTENSION_INPUT_MISMATCH"
  | "EXTENSION_FACTORY_FAILED"
  | "SETUP_FAILED"
  | "TAP_FAILED"
  | "HOOK_TIMEOUT"
  | "INSTALL_DENIED"
  | "RPC_DISCONNECTED"
  | "RPC_REMOTE_ERROR"
  | "RPC_CANCELLED"
  | "DISPOSED";

export interface LoomErrorOptions {
  readonly pluginIds?: readonly string[];
  readonly details?: unknown;
  readonly cause?: unknown;
}

export class LoomError extends Error {
  readonly code: LoomErrorCode;
  readonly pluginIds: readonly string[];
  readonly details?: unknown;

  constructor(code: LoomErrorCode, message: string, options: LoomErrorOptions = {}) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.name = "LoomError";
    this.code = code;
    this.pluginIds = options.pluginIds ?? [];
    if ("details" in options) this.details = options.details;
  }
}
