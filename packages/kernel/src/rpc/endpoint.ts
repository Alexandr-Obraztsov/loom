import { LoomError } from "../core/errors.js";
import type { AbortControllerLike, AbortSignalLike } from "./platform.js";
import { createAbortController, microtask } from "./platform.js";
import type { RpcMessage, TapMessage, Transport } from "./protocol.js";
import { cancelled, describe, deserializeError, disconnected, isRpcMessage, remoteError, serializeError } from "./protocol.js";
import { ProtocolSinks } from "./protocol-sinks.js";

export type RpcHandler = (method: string, args: unknown[], signal: AbortSignalLike) => Promise<unknown>;

export interface RpcEndpoint {
  /**
   * Calls `method` on the peer's handler for `target`. Rejects with RPC_DISCONNECTED once closed,
   * with RPC_CANCELLED when `signal` aborts (a `cancel` is sent; a late result is ignored), with
   * RPC_REMOTE_ERROR when the message cannot be sent, and with the peer's error otherwise.
   */
  call(target: string, method: string, args: unknown[], signal?: AbortSignalLike): Promise<unknown>;
  /** Serves calls for `target`; a second handler for the same target throws SERVICE_CONFLICT. */
  handle(target: string, impl: RpcHandler): () => void;
  /**
   * Sends `bye` and detaches: pending calls reject with RPC_DISCONNECTED and in-flight handlers
   * abort here; the peer handles `bye` like a transport close.
   */
  close(): void;
}

export interface RpcEndpointOptions {
  /** Receives malformed or unhandleable incoming messages (RPC_REMOTE_ERROR, `details.message`); they are dropped. */
  onProtocolError?(error: LoomError): void;
}

/** Low-level access for remote hooks: tap-* messages, a shared id counter and close notification. */
export interface RpcChannel {
  readonly isClosed: boolean;
  nextId(): number;
  /** Sends unless closed; throws what the transport throws. */
  send(msg: RpcMessage): void;
  /** Sends a reply nobody awaits: a failure is reported to the protocol-error sinks and the dead endpoint is shut down. */
  sendReply(msg: RpcMessage): void;
  onTapMessage(cb: (msg: TapMessage) => void): void;
  /** Runs `cb` once on close (immediately if already closed). */
  onClose(cb: () => void): () => void;
  /**
   * Adds a protocol error sink; sinks registered under the same `key` share one registration,
   * and of the different keys only the oldest reports (all belong to the one kernel of this side).
   */
  onProtocolError(key: object, cb: (error: LoomError) => void): () => void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: LoomError): void;
}

type Settlement = { readonly value: unknown } | { readonly error: unknown };

const channels = new WeakMap<RpcEndpoint, RpcChannel>();

export function channelOf(endpoint: RpcEndpoint): RpcChannel {
  const channel = channels.get(endpoint);
  if (!channel) throw remoteError("Not an endpoint created by createRpcEndpoint");
  return channel;
}

class Endpoint implements RpcEndpoint, RpcChannel {
  isClosed = false;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, RpcHandler>();
  private readonly incoming = new Map<number, AbortControllerLike>();
  private readonly tapListeners = new Set<(msg: TapMessage) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly protocolSinks = new ProtocolSinks();
  private readonly off: readonly (() => void)[];

  constructor(
    private readonly transport: Transport,
    private readonly options: RpcEndpointOptions,
  ) {
    this.off = [
      transport.onMessage((msg) => {
        this.accept(msg);
      }),
      transport.onClose(() => {
        this.shutdown();
      }),
    ];
  }

  // eslint-disable-next-line max-params -- implements the four-slot RpcEndpoint.call that every caller uses
  call(target: string, method: string, args: unknown[], signal?: AbortSignalLike): Promise<unknown> {
    if (this.isClosed) return Promise.reject(disconnected(`Call to "${target}.${method}" failed`));
    if (signal?.aborted) return Promise.reject(cancelled(target, method));
    const id = this.nextId();
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        // settling removes this listener, so the call is still pending here
        this.pending.delete(id);
        reject(cancelled(target, method));
        try {
          this.send({ type: "cancel", id });
        } catch {
          // best effort: the call is already rejected, and a throw here would escape into the signal's dispatch
        }
      };
      const done = (): void => {
        signal?.removeEventListener("abort", onAbort);
      };
      this.pending.set(id, {
        resolve: (v) => {
          done();
          resolve(v);
        },
        reject: (e) => {
          done();
          reject(e);
        },
      });
      signal?.addEventListener("abort", onAbort);
      try {
        this.send({ type: "call", id, target, method, args });
      } catch (e) {
        this.settle(id, { error: remoteError(`Cannot send call to "${target}.${method}": ${describe(e)}`, e) });
      }
    });
  }

  handle(target: string, impl: RpcHandler): () => void {
    if (this.handlers.has(target)) {
      throw new LoomError("SERVICE_CONFLICT", `RPC target "${target}" already has a handler`, { details: { target } });
    }
    this.handlers.set(target, impl);
    return () => {
      if (this.handlers.get(target) === impl) this.handlers.delete(target);
    };
  }

  close(): void {
    if (this.isClosed) return;
    try {
      this.send({ type: "bye" });
    } catch {
      // a transport that cannot even send `bye` is gone; detaching is all that is left
    }
    this.shutdown();
  }

  nextId(): number {
    return ++this.seq;
  }

  send(msg: RpcMessage): void {
    if (!this.isClosed) this.transport.send(msg);
  }

  sendReply(msg: RpcMessage): void {
    try {
      this.send(msg);
    } catch (e) {
      this.protocolError(`Cannot send RPC reply: ${describe(e)}`, msg);
      this.shutdown();
    }
  }

  onTapMessage(cb: (msg: TapMessage) => void): void {
    this.tapListeners.add(cb);
  }

  onClose(cb: () => void): () => void {
    if (this.isClosed) {
      cb();
      return () => undefined;
    }
    this.closeListeners.add(cb);
    return () => {
      this.closeListeners.delete(cb);
    };
  }

  onProtocolError(key: object, cb: (error: LoomError) => void): () => void {
    return this.protocolSinks.add(key, cb);
  }

  /** Transport callback: validates, dispatches, and never throws. */
  private accept(raw: unknown): void {
    try {
      if (isRpcMessage(raw)) this.receive(raw);
      else this.protocolError("Malformed RPC message dropped", raw);
    } catch (e) {
      this.protocolError(`Failed to handle RPC message: ${describe(e)}`, raw);
    }
  }

  private protocolError(text: string, raw: unknown): void {
    const error = new LoomError("RPC_REMOTE_ERROR", text, { details: { message: raw } });
    if (!this.protocolSinks.report(error, this.options)) {
      // nobody listens: surface the problem instead of dropping the message silently
      microtask(() => {
        throw error;
      });
    }
  }

  private receive(msg: RpcMessage): void {
    if (this.isClosed) return;
    switch (msg.type) {
      case "bye":
        this.shutdown();
        return;
      case "call":
        this.serve(msg);
        return;
      case "result":
        this.settle(msg.id, { value: msg.value });
        return;
      case "error":
        this.settle(msg.id, { error: deserializeError(msg.error) });
        return;
      case "cancel":
        this.incoming.get(msg.id)?.abort();
        this.incoming.delete(msg.id);
        return;
      case "tap-invoke":
      case "tap-next":
      case "tap-result":
        for (const cb of [...this.tapListeners]) cb(msg);
    }
  }

  private serve(msg: Extract<RpcMessage, { type: "call" }>): void {
    const controller = createAbortController();
    this.incoming.set(msg.id, controller);
    const impl = this.handlers.get(msg.target);
    if (!impl) {
      this.reply(msg.id, { error: remoteError(`No handler for RPC target "${msg.target}"`) });
      return;
    }
    Promise.resolve()
      .then(() => impl(msg.method, [...msg.args], controller.signal))
      .then(
        (value: unknown) => {
          this.reply(msg.id, { value });
        },
        (error: unknown) => {
          this.reply(msg.id, { error });
        },
      );
  }

  /** Answers an incoming call unless it was cancelled; an unsendable result becomes RPC_REMOTE_ERROR. */
  private reply(id: number, outcome: Settlement): void {
    if (!this.incoming.delete(id)) return;
    if ("error" in outcome) {
      this.sendReply({ type: "error", id, error: serializeError(outcome.error) });
      return;
    }
    try {
      this.send({ type: "result", id, value: outcome.value });
    } catch (e) {
      this.sendReply({ type: "error", id, error: serializeError(remoteError(`Cannot send result: ${describe(e)}`)) });
    }
  }

  private settle(id: number, outcome: { value: unknown } | { error: LoomError }): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if ("error" in outcome) p.reject(outcome.error);
    else p.resolve(outcome.value);
  }

  private shutdown(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const off of this.off) off();
    for (const p of [...this.pending.values()]) p.reject(disconnected("Call failed"));
    this.pending.clear();
    for (const controller of [...this.incoming.values()]) controller.abort();
    this.incoming.clear();
    this.tapListeners.clear();
    const listeners = [...this.closeListeners];
    this.closeListeners.clear();
    for (const cb of listeners) cb();
  }
}

export function createRpcEndpoint(transport: Transport, options: RpcEndpointOptions = {}): RpcEndpoint {
  const endpoint = new Endpoint(transport, options);
  const facade: RpcEndpoint = {
    call: (...args) => endpoint.call(...args),
    handle: (target, impl) => endpoint.handle(target, impl),
    close: () => {
      endpoint.close();
    },
  };
  channels.set(facade, endpoint);
  return facade;
}
