import { LoomError } from "../core/errors.js";
import type { HookRef, Next, PluginContext, TapOptions } from "../core/types.js";
import { channelOf, disconnected } from "./endpoint.js";
import type { RpcChannel, RpcEndpoint } from "./endpoint.js";
import { DEFAULT_TAP_TIMEOUT_MS, deserializeError, describe, hookTarget, remoteError } from "./protocol.js";
import type { TapMessage, TapRequest } from "./protocol.js";
import { settleOutcome } from "./remote-hooks.js";

type TapFn = (ctx: unknown, next: Next<unknown, unknown>) => unknown;

interface LocalTap {
  readonly owner: string;
  readonly fn: TapFn;
  readonly match: ((ctx: unknown) => boolean) | undefined;
}

interface Waiter {
  resolve(value: unknown): void;
  reject(error: LoomError): void;
}

interface TapLink {
  readonly channel: RpcChannel;
  readonly taps: Map<number, LocalTap>;
  /** next() calls awaiting the exposing side, keyed by its invocation id. */
  readonly waiting: Map<number, Waiter>;
}

const links = new WeakMap<RpcChannel, TapLink>();

const passThrough: TapFn = (ctx, next) => next(ctx);
/** Stands in for a tap removed here while the exposing side still invokes it. */
const UNTAPPED: LocalTap = { owner: "", fn: passThrough, match: undefined };

/** Runs the tap fn for one tap-invoke; an unknown tap (already untapped) or a failed `match` passes through. */
function serve(link: TapLink, msg: Extract<TapMessage, { type: "tap-invoke" }>): void {
  const { channel, waiting } = link;
  const tap = link.taps.get(msg.tapId) ?? UNTAPPED;
  let called = false;
  const next: Next<unknown, unknown> = (c) => {
    if (called) {
      const message = `Remote tap of "${tap.owner}" called next() more than once`;
      return Promise.reject(new LoomError("TAP_FAILED", message, { pluginIds: [tap.owner] }));
    }
    called = true;
    return new Promise<unknown>((resolve, reject) => {
      waiting.set(msg.id, { resolve, reject });
      try {
        channel.send({ type: "tap-next", id: msg.id, ctx: c });
      } catch (e) {
        waiting.delete(msg.id);
        reject(remoteError(`Cannot send hook context: ${describe(e)}`, e));
      }
    });
  };
  const run = Promise.resolve().then(() => {
    const fn = tap.match === undefined || tap.match(msg.ctx) ? tap.fn : passThrough;
    return fn(msg.ctx, next);
  });
  settleOutcome(run, channel, msg.id, "tap");
}

function linkOf(channel: RpcChannel): TapLink {
  const found = links.get(channel);
  if (found) return found;
  const link: TapLink = { channel, taps: new Map(), waiting: new Map() };
  links.set(channel, link);
  channel.onTapMessage((msg) => {
    if (msg.type === "tap-invoke") serve(link, msg);
    else if (msg.type === "tap-result" && msg.for === "next") {
      const waiter = link.waiting.get(msg.id);
      link.waiting.delete(msg.id);
      if (msg.outcome.ok) waiter?.resolve(msg.outcome.value);
      else waiter?.reject(deserializeError(msg.outcome.error));
    }
  });
  channel.onClose(() => {
    for (const waiter of [...link.waiting.values()]) waiter.reject(disconnected("Remote next() failed"));
    link.waiting.clear();
    link.taps.clear();
  });
  return link;
}

function request(tapId: number, owner: string, opts: TapOptions<unknown> & { timeoutMs?: number }): TapRequest {
  return {
    tapId,
    owner,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TAP_TIMEOUT_MS,
    ...(opts.priority === undefined ? {} : { priority: opts.priority }),
    ...(opts.before === undefined ? {} : { before: [...opts.before] }),
    ...(opts.after === undefined ? {} : { after: [...opts.after] }),
  };
}

function report(ctx: PluginContext, error: unknown): void {
  try {
    ctx.emit("kernel.error", error);
  } catch {
    // the plugin is already disposed: its tap is gone with it
  }
}

/**
 * Taps `hook` of the kernel on the other side of `endpoint` (which must `exposeHooks` it) on
 * behalf of the plugin owning `ctx`. Registration is asynchronous; a failed registration is
 * emitted as `kernel.error` here. `fn` and `opts.match` run on this side; the context and
 * results cross the wire through `structuredClone`. The exposing side waits `timeoutMs`
 * (default 5000) per invocation before continuing without this tap. Disposing the plugin
 * removes the remote tap. Sync hooks throw TAP_FAILED.
 */
export function tapRemote<C, R>(
  ctx: PluginContext,
  endpoint: RpcEndpoint,
  hook: HookRef<C, R>,
  opts: TapOptions<C> & { timeoutMs?: number },
  fn: (c: C, next: Next<C, R>) => R,
): void {
  if (hook.mode === "sync") {
    throw new LoomError("TAP_FAILED", `Sync hook "${hook.id}" cannot be tapped remotely`, { pluginIds: [ctx.id] });
  }
  const channel = channelOf(endpoint);
  const link = linkOf(channel);
  const tapId = channel.nextId();
  const target = hookTarget(hook.id);
  const match = opts.match as ((c: unknown) => boolean) | undefined;
  link.taps.set(tapId, { owner: ctx.id, fn: fn as unknown as TapFn, match });
  let registered = true;
  endpoint.call(target, "tap", [request(tapId, ctx.id, opts as TapOptions<unknown>)]).catch((error: unknown) => {
    registered = false;
    link.taps.delete(tapId);
    report(ctx, error);
  });
  ctx.onDispose(async () => {
    link.taps.delete(tapId);
    if (!registered) return;
    try {
      await endpoint.call(target, "untap", [{ tapId }]);
    } catch (error) {
      if (!(error instanceof LoomError && error.code === "RPC_DISCONNECTED")) throw error;
    }
  });
}
